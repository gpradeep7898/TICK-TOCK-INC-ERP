'use strict';

// middleware/error.js
// Global error handler — must be registered LAST, after all routes.

// eslint-disable-next-line no-unused-vars
function errorHandler(err, _req, res, _next) {
    console.error('Unhandled error:', err);
    res.status(err.status || 500).json({
        success: false,
        error: err.message || 'Internal server error',
    });
}

function notFoundHandler(_req, res) {
    res.status(404).json({ success: false, error: 'Not found' });
}

module.exports = { errorHandler, notFoundHandler };
