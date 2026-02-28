'use strict';

// config/env.js
// Centralised access to validated environment variables.
// Import this instead of reading process.env directly throughout the codebase.

module.exports = {
    PORT:           process.env.PORT           || 3001,
    JWT_SECRET:     process.env.JWT_SECRET     || 'ticktock-fallback-secret',
    JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '8h',
    DATABASE_URL:   process.env.DATABASE_URL,
    APP_VERSION:    process.env.APP_VERSION    || '1.0.0',
    NODE_ENV:       process.env.NODE_ENV       || 'development',
};
