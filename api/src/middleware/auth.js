'use strict';

// middleware/auth.js
// JWT authentication middleware — used as the global /api/* gate in server.js.

const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../config/env');

function requireAuth(req, res, next) {
    const header = req.headers['authorization'] || '';
    const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ success: false, error: 'Authentication required' });
    try {
        const payload = jwt.verify(token, JWT_SECRET);
        // Normalise payload — supports old tokens (no companyId) during migration
        req.user = {
            userId:          payload.userId,
            email:           payload.email,
            role:            payload.role,
            name:            payload.name,
            companyId:       payload.companyId       || null,
            isPlatformAdmin: payload.isPlatformAdmin || false,
        };
        next();
    } catch {
        res.status(401).json({ success: false, error: 'Token expired or invalid' });
    }
}

module.exports = { requireAuth };
