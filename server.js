require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Redis = require('ioredis');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const { generateAnonymousId, getColorForIdentity } = require('./utils/id-generator');
const { checkRateLimit, clearRateLimit } = require('./utils/security');
const { getOrCreateBot, removeBot, DEFAULT_THEME } = require('./bot-handler');

const app = express();
const server = http.createServer(app);

const PORT = parseInt(process.env.PORT) || 3001;
const SESSION_TTL = parseInt(process.env.SESSION_TTL) || 14400;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const MAX_PARTICIPANTS = 10;

// CORS
app.use(cors({ origin: FRONTEND_URL, credentials: true }));
app.use(express.json());

// Handle /brainstorm-api prefix mismatch from frontend
app.use((req, res, next) => {
    if (req.url.startsWith('/brainstorm-api')) {
        req.url = req.url.replace('/brainstorm-api', '/api');
    }
    next();
});

// ============================================
// STORAGE LAYER (Redis or In-Memory fallback)
// ============================================

class MemoryStore {
    constructor() {
        this.data = new Map();
        this.lists = new Map();
        this.timers = new Map();
    }
    async get(key) { return this.data.get(key) || null; }
    async setex(key, ttl, value) {
        this.data.set(key, value);
        if (this.timers.has(key)) clearTimeout(this.timers.get(key));
        this.timers.set(key, setTimeout(() => { this.data.delete(key); this.timers.delete(key); }, ttl * 1000));
    }
    async rpush(key, value) {
        if (!this.lists.has(key)) this.lists.set(key, []);
        this.lists.get(key).push(value);
    }
    async lrange(key, start, end) {
        const list = this.lists.get(key) || [];
        return end === -1 ? list.slice(start) : list.slice(start, end + 1);
    }
    async expire(key, ttl) {
        if (this.timers.has(key)) clearTimeout(this.timers.get(key));
        this.timers.set(key, setTimeout(() => {
            this.data.delete(key); this.lists.delete(key); this.timers.delete(key);
        }, ttl * 1000));
    }
}

let store;

function initStore() {
    return new Promise((resolve) => {
        try {
            const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
                maxRetriesPerRequest: 1,
                lazyConnect: true,
                connectTimeout: 2000,
                retryStrategy: () => null // Don't retry
            });

            // Prevent unhandled error crashes when Redis is unavailable
            redis.on('error', () => { });

            const timeout = setTimeout(() => {
                redis.disconnect();
                console.log('⚠️  Redis not available — using in-memory storage (data resets on restart)');
                store = new MemoryStore();
                resolve();
            }, 2500);

            redis.connect().then(() => {
                clearTimeout(timeout);
                console.log('✅ Connected to Redis');
                store = redis;
                resolve();
            }).catch(() => {
                clearTimeout(timeout);
                redis.disconnect();
                console.log('⚠️  Redis not available — using in-memory storage (data resets on restart)');
                store = new MemoryStore();
                resolve();
            });
        } catch {
            console.log('⚠️  Redis init failed — using in-memory storage');
            store = new MemoryStore();
            resolve();
        }
    });
}

// Socket.io
const io = new Server(server, {
    cors: {
        origin: FRONTEND_URL,
        methods: ['GET', 'POST'],
        credentials: true
    }
});

// Track active connections per session
const sessionUsers = new Map();
const callParticipants = new Map(); // sessionId -> Set<socketId>
const sessionThemes = new Map();    // sessionId -> theme object

// ============================================
// REST API ENDPOINTS
// ============================================

app.post('/api/session/create', async (req, res) => {
    try {
        const sessionId = uuidv4().slice(0, 8);
        const inviteToken = uuidv4();

        const sessionData = {
            id: sessionId,
            createdAt: Date.now(),
            expiresAt: Date.now() + (SESSION_TTL * 1000),
            maxParticipants: MAX_PARTICIPANTS,
            inviteToken,
            creatorSocketId: null
        };

        await store.setex(
            `session:${sessionId}`,
            SESSION_TTL,
            JSON.stringify(sessionData)
        );

        console.log(`📦 Session created: ${sessionId}`);
        res.json({
            sessionId,
            inviteToken,
            expiresAt: sessionData.expiresAt,
            inviteUrl: `${FRONTEND_URL}/brainstorm/${sessionId}?token=${inviteToken}`
        });
    } catch (error) {
        console.error('Session creation error:', error);
        res.status(500).json({ error: 'Failed to create session' });
    }
});

app.get('/api/session/:sessionId/validate', async (req, res) => {
    try {
        const { sessionId } = req.params;
        const { token } = req.query;

        const sessionRaw = await store.get(`session:${sessionId}`);
        if (!sessionRaw) {
            return res.status(404).json({ valid: false, error: 'Session not found or expired' });
        }

        const session = JSON.parse(sessionRaw);
        if (session.inviteToken !== token) {
            return res.status(403).json({ valid: false, error: 'Invalid invite token' });
        }

        const participantCount = sessionUsers.has(sessionId) ? sessionUsers.get(sessionId).size : 0;

        res.json({
            valid: true,
            expiresAt: session.expiresAt,
            participantCount,
            maxParticipants: session.maxParticipants
        });
    } catch (error) {
        console.error('Validation error:', error);
        res.status(500).json({ valid: false, error: 'Validation failed' });
    }
});

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
});

// ============================================
// SOCKET.IO HANDLERS
// ============================================

io.on('connection', (socket) => {
    console.log(`🔌 Socket connected: ${socket.id}`);

    socket.on('join-session', async ({ sessionId, inviteToken }) => {
        try {
            const sessionRaw = await store.get(`session:${sessionId}`);
            if (!sessionRaw) {
                socket.emit('error-message', { message: 'Session not found or expired' });
                return;
            }

            const session = JSON.parse(sessionRaw);

            if (session.inviteToken !== inviteToken) {
                socket.emit('error-message', { message: 'Invalid invite token' });
                return;
            }

            if (!sessionUsers.has(sessionId)) {
                sessionUsers.set(sessionId, new Map());
            }
            const users = sessionUsers.get(sessionId);

            if (users.size >= MAX_PARTICIPANTS) {
                socket.emit('error-message', { message: 'Session is full (max 10 participants)' });
                return;
            }

            const existingIds = Array.from(users.values()).map(u => u.userId);
            const userId = generateAnonymousId(existingIds);
            const userColor = getColorForIdentity(userId);

            const userData = { userId, color: userColor, joinedAt: Date.now(), socketId: socket.id };
            users.set(socket.id, userData);
            socket.userId = userId;
            socket.userColor = userColor;
            socket.sessionId = sessionId;

            socket.join(sessionId);

            socket.emit('joined', {
                userId,
                color: userColor,
                sessionId,
                expiresAt: session.expiresAt,
                botUsage: getOrCreateBot(sessionId).getUsageInfo()
            });

            const messagesRaw = await store.lrange(`messages:${sessionId}`, 0, -1);
            const messages = messagesRaw.map(m => JSON.parse(m));
            socket.emit('message-history', messages);

            const participantList = Array.from(users.values()).map(u => ({
                userId: u.userId, color: u.color, joinedAt: u.joinedAt
            }));
            io.to(sessionId).emit('participant-list', participantList);

            const systemMessage = {
                id: uuidv4(), userId: 'System',
                text: `${userId} joined the session`,
                timestamp: Date.now(), isBot: false, isSystem: true
            };
            socket.to(sessionId).emit('new-message', systemMessage);
            await storeMessage(sessionId, systemMessage);

            console.log(`👤 ${userId} joined session ${sessionId} (${users.size}/${MAX_PARTICIPANTS})`);

            // Send current theme if one exists
            const currentTheme = sessionThemes.get(sessionId);
            if (currentTheme) {
                socket.emit('theme-update', currentTheme);
            }
        } catch (error) {
            console.error('Join error:', error);
            socket.emit('error-message', { message: 'Failed to join session' });
        }
    });

    socket.on('send-message', async ({ text }) => {
        const { userId, userColor, sessionId } = socket;
        if (!userId || !sessionId) return;

        const rateCheck = checkRateLimit(socket.id);
        if (!rateCheck.allowed) {
            socket.emit('error-message', {
                message: `Slow down! Try again in ${Math.ceil(rateCheck.retryAfterMs / 1000)}s`
            });
            return;
        }

        if (!text || !text.trim()) return;
        const cleanText = text.trim().slice(0, 2000);

        const messageObj = {
            id: uuidv4(), userId, color: userColor,
            text: cleanText, timestamp: Date.now(),
            isBot: false, isSystem: false
        };

        await storeMessage(sessionId, messageObj);
        io.to(sessionId).emit('new-message', messageObj);

        const bot = getOrCreateBot(sessionId);
        bot.processMessage(messageObj);

        if (cleanText.toLowerCase().includes('@bot')) {
            const question = cleanText.replace(/@bot/gi, '').trim();
            await handleBotResponse(sessionId, bot, question, userId);
        }

        if (cleanText.trim().toLowerCase() === '/summary') {
            await handleSummaryRequest(sessionId, bot);
        }

        // /theme command
        const themeMatch = cleanText.match(/^\/(theme|vibe|mood)\s+(.+)/i);
        if (themeMatch) {
            const themePrompt = themeMatch[2].trim();
            await handleThemeRequest(sessionId, bot, themePrompt, userId);
        }

        if (cleanText.trim().toLowerCase() === '/theme reset' || cleanText.trim().toLowerCase() === '/vibe reset') {
            sessionThemes.delete(sessionId);
            io.to(sessionId).emit('theme-update', DEFAULT_THEME);
            const sysMsg = {
                id: uuidv4(), userId: '🤖 AI Bot',
                text: '🎨 Theme reset to default Matrix style.',
                timestamp: Date.now(), isBot: true, isSystem: false
            };
            io.to(sessionId).emit('new-message', sysMsg);
            await storeMessage(sessionId, sysMsg);
        }
    });

    socket.on('typing', () => {
        const { userId, sessionId } = socket;
        if (!userId || !sessionId) return;
        socket.to(sessionId).emit('typing-indicator', { userId, isTyping: true });
    });

    socket.on('stop-typing', () => {
        const { userId, sessionId } = socket;
        if (!userId || !sessionId) return;
        socket.to(sessionId).emit('typing-indicator', { userId, isTyping: false });
    });

    socket.on('request-summary', async () => {
        const { sessionId } = socket;
        if (!sessionId) return;
        const bot = getOrCreateBot(sessionId);
        await handleSummaryRequest(sessionId, bot);
    });

    // Canvas (Pressure Slate) handlers
    socket.on('canvas-draw', (data) => {
        if (!socket.sessionId) return;
        socket.to(socket.sessionId).emit('canvas-draw', data);
    });

    socket.on('canvas-clear', () => {
        if (!socket.sessionId) return;
        socket.to(socket.sessionId).emit('canvas-clear');
    });

    // Voice Call (WebRTC Signaling) handlers
    socket.on('join-call', () => {
        const { sessionId, userId } = socket;
        if (!sessionId) return;
        if (!callParticipants.has(sessionId)) callParticipants.set(sessionId, new Set());
        callParticipants.get(sessionId).add(socket.id);
        socket.to(sessionId).emit('user-joined-call', { socketId: socket.id, callUserId: userId });
        const list = getCallList(sessionId);
        io.to(sessionId).emit('call-participants', list);
        console.log(`🎙️ ${userId} joined call in ${sessionId}`);
    });

    socket.on('leave-call', () => {
        const { sessionId, userId } = socket;
        if (!sessionId) return;
        const cp = callParticipants.get(sessionId);
        if (cp) { cp.delete(socket.id); if (cp.size === 0) callParticipants.delete(sessionId); }
        socket.to(sessionId).emit('user-left-call', { socketId: socket.id });
        io.to(sessionId).emit('call-participants', getCallList(sessionId));
        console.log(`🔇 ${userId} left call in ${sessionId}`);
    });

    socket.on('voice-offer', ({ target, offer }) => {
        io.to(target).emit('voice-offer', { from: socket.id, offer, callUserId: socket.userId });
    });

    socket.on('voice-answer', ({ target, answer }) => {
        io.to(target).emit('voice-answer', { from: socket.id, answer });
    });

    socket.on('voice-ice', ({ target, candidate }) => {
        io.to(target).emit('voice-ice', { from: socket.id, candidate });
    });

    // ICE restart relay for auto-reconnection
    socket.on('voice-restart', ({ target, offer }) => {
        io.to(target).emit('voice-restart', { from: socket.id, offer });
    });

    // Keep-alive ping (no-op, keeps socket active for long sessions)
    socket.on('voice-ping', () => { });

    // Disconnect
    socket.on('disconnect', async () => {
        const { userId, sessionId } = socket;
        if (!userId || !sessionId) return;

        clearRateLimit(socket.id);

        // Clean up voice call
        const cp = callParticipants.get(sessionId);
        if (cp) {
            cp.delete(socket.id);
            socket.to(sessionId).emit('user-left-call', { socketId: socket.id });
            io.to(sessionId).emit('call-participants', getCallList(sessionId));
            if (cp.size === 0) callParticipants.delete(sessionId);
        }

        const users = sessionUsers.get(sessionId);
        if (users) {
            users.delete(socket.id);

            const systemMessage = {
                id: uuidv4(), userId: 'System',
                text: `${userId} left the session`,
                timestamp: Date.now(), isBot: false, isSystem: true
            };
            io.to(sessionId).emit('new-message', systemMessage);
            await storeMessage(sessionId, systemMessage);

            const participantList = Array.from(users.values()).map(u => ({
                userId: u.userId, color: u.color, joinedAt: u.joinedAt
            }));
            io.to(sessionId).emit('participant-list', participantList);

            if (users.size === 0) {
                sessionUsers.delete(sessionId);
                removeBot(sessionId);
                callParticipants.delete(sessionId);
                console.log(`🧹 Session ${sessionId} cleaned up`);
            }

            console.log(`👋 ${userId} left session ${sessionId}`);
        }
    });
});

// ============================================
// HELPER FUNCTIONS
// ============================================

function getCallList(sessionId) {
    const cp = callParticipants.get(sessionId);
    if (!cp) return [];
    const users = sessionUsers.get(sessionId);
    return Array.from(cp).map(sid => {
        const u = users?.get(sid);
        return u ? u.userId : 'Unknown';
    });
}

async function storeMessage(sessionId, message) {
    try {
        await store.rpush(`messages:${sessionId}`, JSON.stringify(message));
        await store.expire(`messages:${sessionId}`, SESSION_TTL);
    } catch (err) {
        console.error('Failed to store message:', err.message);
    }
}

async function handleBotResponse(sessionId, bot, question, askerId) {
    io.to(sessionId).emit('typing-indicator', { userId: '🤖 AI Bot', isTyping: true });
    try {
        const answer = await bot.answerQuestion(question, askerId);
        const botMessage = {
            id: uuidv4(), userId: '🤖 AI Bot', color: '#00ff41',
            text: answer, timestamp: Date.now(), isBot: true, isSystem: false
        };
        await storeMessage(sessionId, botMessage);
        io.to(sessionId).emit('new-message', botMessage);
        io.to(sessionId).emit('bot-usage-update', bot.getUsageInfo());
    } finally {
        io.to(sessionId).emit('typing-indicator', { userId: '🤖 AI Bot', isTyping: false });
    }
}

async function handleSummaryRequest(sessionId, bot) {
    io.to(sessionId).emit('typing-indicator', { userId: '🤖 AI Bot', isTyping: true });
    try {
        const summary = await bot.generateSummary();
        const botMessage = {
            id: uuidv4(), userId: '🤖 AI Bot', color: '#00ff41',
            text: `📊 **Session Summary**\n\n${summary}`,
            timestamp: Date.now(), isBot: true, isSystem: false
        };
        await storeMessage(sessionId, botMessage);
        io.to(sessionId).emit('new-message', botMessage);
        io.to(sessionId).emit('bot-usage-update', bot.getUsageInfo());
    } finally {
        io.to(sessionId).emit('typing-indicator', { userId: '🤖 AI Bot', isTyping: false });
    }
}

async function handleThemeRequest(sessionId, bot, prompt, requesterId) {
    io.to(sessionId).emit('typing-indicator', { userId: '🤖 AI Bot', isTyping: true });
    try {
        const theme = await bot.generateTheme(prompt);
        if (theme) {
            sessionThemes.set(sessionId, theme);
            io.to(sessionId).emit('theme-update', theme);

            const botMessage = {
                id: uuidv4(), userId: '🤖 AI Bot', color: '#00ff41',
                text: `🎨 Theme changed to **"${theme.name || prompt}"** by ${requesterId}! Type \`/theme reset\` to go back to default.`,
                timestamp: Date.now(), isBot: true, isSystem: false
            };
            await storeMessage(sessionId, botMessage);
            io.to(sessionId).emit('new-message', botMessage);
        } else {
            const errMsg = {
                id: uuidv4(), userId: '🤖 AI Bot', color: '#00ff41',
                text: '🎨 Could not generate theme. Try a different description like `/theme ocean sunset` or `/theme cyberpunk neon`.',
                timestamp: Date.now(), isBot: true, isSystem: false
            };
            io.to(sessionId).emit('new-message', errMsg);
        }
    } finally {
        io.to(sessionId).emit('typing-indicator', { userId: '🤖 AI Bot', isTyping: false });
    }
}

// ============================================
// START SERVER
// ============================================

async function start() {
    await initStore();
    server.listen(PORT, '0.0.0.0', () => {
        console.log(`\n🚀 Brainstorm server running on port ${PORT}`);
        console.log(`🌐 Frontend Allowed Origin: ${FRONTEND_URL}`);
        console.log(`⏱️  Session TTL: ${SESSION_TTL / 3600} hours\n`);
    });
}

start();
