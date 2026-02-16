// Simple in-memory rate limiter
const rateLimits = new Map();

function checkRateLimit(socketId, maxMessages = 5, windowMs = 10000) {
    const now = Date.now();
    const userLimits = rateLimits.get(socketId) || [];

    // Remove timestamps outside the window
    const recentMessages = userLimits.filter(ts => now - ts < windowMs);

    if (recentMessages.length >= maxMessages) {
        return { allowed: false, retryAfterMs: windowMs - (now - recentMessages[0]) };
    }

    recentMessages.push(now);
    rateLimits.set(socketId, recentMessages);
    return { allowed: true };
}

function clearRateLimit(socketId) {
    rateLimits.delete(socketId);
}

// Cleanup stale entries every 60 seconds
setInterval(() => {
    const now = Date.now();
    for (const [key, timestamps] of rateLimits.entries()) {
        const recent = timestamps.filter(ts => now - ts < 60000);
        if (recent.length === 0) {
            rateLimits.delete(key);
        } else {
            rateLimits.set(key, recent);
        }
    }
}, 60000);

module.exports = { checkRateLimit, clearRateLimit };
