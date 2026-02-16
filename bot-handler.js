// Supports both OpenRouter and Anthropic API keys
// OpenRouter: set OPENROUTER_API_KEY in .env
// Anthropic: set ANTHROPIC_API_KEY in .env

let aiClient = null;
let provider = null;

function initAI() {
    // Priority: OpenRouter > Anthropic
    const openrouterKey = process.env.OPENROUTER_API_KEY;
    const anthropicKey = process.env.ANTHROPIC_API_KEY;

    if (openrouterKey && openrouterKey !== 'your_key_here') {
        provider = 'openrouter';
        aiClient = { apiKey: openrouterKey };
        console.log('✅ AI Bot initialized (OpenRouter)');
        return;
    }

    if (anthropicKey && anthropicKey !== 'your_key_here') {
        try {
            const Anthropic = require('@anthropic-ai/sdk');
            provider = 'anthropic';
            aiClient = new Anthropic({ apiKey: anthropicKey });
            console.log('✅ AI Bot initialized (Anthropic)');
            return;
        } catch (err) {
            console.log('⚠️  Failed to initialize Anthropic:', err.message);
        }
    }

    console.log('⚠️  No AI API key found — bot responses disabled');
    console.log('   Set OPENROUTER_API_KEY or ANTHROPIC_API_KEY in backend/.env');
}

initAI();

// OpenRouter call via fetch (OpenAI-compatible)
async function callOpenRouter(systemPrompt, userPrompt, maxTokens = 400) {
    const model = process.env.AI_MODEL || 'anthropic/claude-sonnet-4';

    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${aiClient.apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': process.env.FRONTEND_URL || 'http://localhost:5173',
            'X-Title': 'Brainstorm Bot'
        },
        body: JSON.stringify({
            model,
            max_tokens: maxTokens,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ]
        })
    });

    if (!res.ok) {
        const err = await res.text();
        throw new Error(`OpenRouter error ${res.status}: ${err}`);
    }

    const data = await res.json();
    return data.choices[0].message.content;
}

// Anthropic call via SDK
async function callAnthropic(systemPrompt, userPrompt, maxTokens = 400) {
    const response = await aiClient.messages.create({
        model: process.env.AI_MODEL || 'claude-sonnet-4-20250514',
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
    });
    return response.content[0].text;
}

// Unified call
async function callAI(systemPrompt, userPrompt, maxTokens = 400) {
    if (provider === 'openrouter') return callOpenRouter(systemPrompt, userPrompt, maxTokens);
    if (provider === 'anthropic') return callAnthropic(systemPrompt, userPrompt, maxTokens);
    return null;
}

class SessionBot {
    constructor(sessionId) {
        this.sessionId = sessionId;
        this.messages = [];
        this.mentionCount = 0;
        this.summaryCount = 0;
        this.maxMentions = 15;
        this.maxSummaries = 1;
    }

    processMessage(message) {
        if (message.isBot) return;
        this.messages.push({
            userId: message.userId,
            text: message.text,
            timestamp: message.timestamp
        });
        if (this.messages.length > 30) {
            this.messages = this.messages.slice(-30);
        }
    }

    hasMentionsRemaining() { return this.mentionCount < this.maxMentions; }
    hasSummaryRemaining() { return this.summaryCount < this.maxSummaries; }

    getUsageInfo() {
        return {
            mentionsUsed: this.mentionCount,
            mentionsMax: this.maxMentions,
            summariesUsed: this.summaryCount,
            summariesMax: this.maxSummaries
        };
    }

    async answerQuestion(question, userId) {
        if (!aiClient) {
            return '🤖 AI bot is not configured. Add OPENROUTER_API_KEY or ANTHROPIC_API_KEY to enable me!';
        }

        if (!this.hasMentionsRemaining()) {
            return `🤖 I've reached my limit of ${this.maxMentions} responses for this session. You can still use \`/summary\` to get a conversation summary!`;
        }

        this.mentionCount++;

        const context = this.messages.slice(-15).map(m => `${m.userId}: ${m.text}`).join('\n');

        try {
            return await callAI(
                'You are a helpful brainstorming assistant in an anonymous group chat. Keep responses concise (2-4 sentences max). Be encouraging and build on ideas. The participants are anonymous and using animal-themed names. Don\'t mention your response limits.',
                `Here's the recent conversation:\n\n${context}\n\n${userId} asks: ${question}\n\nProvide a helpful, concise response.`,
                400
            );
        } catch (error) {
            console.error('Bot answer error:', error.message);
            return '🤖 Sorry, I encountered an error processing your request. Please try again.';
        }
    }

    async generateSummary() {
        if (!aiClient) {
            return '🤖 AI bot is not configured. Add OPENROUTER_API_KEY or ANTHROPIC_API_KEY to enable summaries!';
        }

        if (!this.hasSummaryRemaining()) {
            return `🤖 Summary limit reached for this session (${this.maxSummaries}/${this.maxSummaries} used).`;
        }

        if (this.messages.length < 3) {
            return '🤖 Not enough conversation yet to generate a meaningful summary. Keep brainstorming!';
        }

        this.summaryCount++;

        const conversationText = this.messages.map(m => `${m.userId}: ${m.text}`).join('\n');

        try {
            return await callAI(
                'You are a meeting summarizer. Create clear, structured summaries with key points, decisions, and action items. Use bullet points and emoji for readability. Keep it concise.',
                `Summarize this brainstorming session:\n\n${conversationText}\n\nFormat:\n📌 **Key Points**\n- ...\n\n✅ **Decisions Made**\n- ...\n\n📋 **Action Items**\n- ...\n\nIf no decisions or action items exist yet, mention that and encourage the group.`,
                600
            );
        } catch (error) {
            console.error('Bot summary error:', error.message);
            return '🤖 Sorry, I couldn\'t generate a summary right now. Please try again.';
        }
    }

    async generateTheme(prompt) {
        if (!aiClient) return null;

        try {
            const raw = await callAI(
                `You are a UI theme generator. Given a theme description, generate a JSON object of CSS color values. Return ONLY valid JSON, no markdown, no explanation.

The JSON must have exactly these keys:
{
  "name": "short theme name",
  "effect": "particle effect to show (one of: bubbles, snow, rain, stars, fireflies, leaves, hearts, matrix, sparkles, petals, none)",
  "bgPrimary": "main background color",
  "bgSecondary": "card/panel background",
  "bgMessage": "message bubble background",
  "bgMessageOwn": "own message bubble background",
  "textPrimary": "main text color",
  "textSecondary": "muted/secondary text",
  "textAccent": "accent highlight color",
  "accent": "primary accent (buttons, links)",
  "accentGlow": "accent with alpha for glow effects",
  "border": "border color with alpha",
  "botBg": "bot message background gradient start",
  "botBorder": "bot message border color",
  "headerBg": "header background with alpha",
  "inputBg": "input field background",
  "scrollThumb": "scrollbar thumb color"
}

Choose an "effect" that visually matches the theme (e.g. "bubbles" for water/ocean, "snow" for winter, "fireflies" for forest/night, "stars" for space, "rain" for moody/dark, "petals" for spring/cherry, "sparkles" for magical, "hearts" for love, "leaves" for autumn, "matrix" for hacker/tech, "none" if no effect fits).
Use rich, vibrant, harmonious colors. Make sure text is readable against backgrounds. Use hex, rgb(), rgba(), or hsl() values.`,
                `Generate a theme for: "${prompt}"`,
                500
            );

            // Parse JSON from response
            const jsonMatch = raw.match(/\{[\s\S]*\}/);
            if (!jsonMatch) return null;
            const theme = JSON.parse(jsonMatch[0]);
            return theme;
        } catch (error) {
            console.error('Theme generation error:', error.message);
            return null;
        }
    }
}

const DEFAULT_THEME = {
    name: 'Matrix',
    bgPrimary: '#000000',
    bgSecondary: 'rgba(255,255,255,0.02)',
    bgMessage: 'rgba(255,255,255,0.05)',
    bgMessageOwn: 'rgba(59,130,246,0.15)',
    textPrimary: 'rgba(255,255,255,0.85)',
    textSecondary: 'rgba(255,255,255,0.4)',
    textAccent: '#00ff41',
    accent: '#00ff41',
    accentGlow: 'rgba(0,255,65,0.2)',
    border: 'rgba(255,255,255,0.05)',
    botBg: 'rgba(0,255,65,0.08)',
    botBorder: 'rgba(0,255,65,0.2)',
    headerBg: 'rgba(3,7,18,0.9)',
    inputBg: 'rgba(255,255,255,0.05)',
    scrollThumb: 'rgba(255,255,255,0.08)'
};

const activeBots = new Map();

function getOrCreateBot(sessionId) {
    if (!activeBots.has(sessionId)) {
        activeBots.set(sessionId, new SessionBot(sessionId));
    }
    return activeBots.get(sessionId);
}

function removeBot(sessionId) {
    activeBots.delete(sessionId);
}

module.exports = { getOrCreateBot, removeBot, SessionBot, DEFAULT_THEME };
