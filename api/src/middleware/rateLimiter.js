'use strict';

// middleware/rateLimiter.js
// Rate limiting configuration using express-rate-limit.

const rateLimit = require('express-rate-limit');

// ── Login: strict — 10 attempts per 15 minutes per IP ─────────────────────────
const loginLimiter = rateLimit({
    windowMs:         15 * 60 * 1000,   // 15 minutes
    max:              10,
    standardHeaders:  true,
    legacyHeaders:    false,
    message: { success: false, error: 'Too many login attempts. Please try again in 15 minutes.' },
    skipSuccessfulRequests: true,        // only count failed attempts
});

// ── General API: relaxed — 300 requests per minute per IP ─────────────────────
const apiLimiter = rateLimit({
    windowMs:        60 * 1000,
    max:             300,
    standardHeaders: true,
    legacyHeaders:   false,
    message: { success: false, error: 'Too many requests. Please slow down.' },
});

// ── Write operations: moderate — 60 per minute per IP ─────────────────────────
const writeLimiter = rateLimit({
    windowMs:        60 * 1000,
    max:             60,
    standardHeaders: true,
    legacyHeaders:   false,
    message: { success: false, error: 'Too many write requests. Please slow down.' },
});

module.exports = { loginLimiter, apiLimiter, writeLimiter };
