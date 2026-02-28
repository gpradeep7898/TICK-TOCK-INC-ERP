'use strict';

// middleware/validate.js
// Zod-based request body and query validation middleware factory.
//
// Usage:
//   const { validate } = require('../middleware/validate');
//   router.post('/items', validate(ItemSchema), handler);
//
// On failure returns 400 JSON with field-level error details.

const { z } = require('zod');

/**
 * Returns an Express middleware that validates req.body against the given Zod schema.
 * @param {z.ZodTypeAny} schema
 */
function validate(schema) {
    return (req, res, next) => {
        const result = schema.safeParse(req.body);
        if (!result.success) {
            const errors = result.error.issues.map(issue => ({
                field:   issue.path.join('.'),
                message: issue.message,
            }));
            return res.status(400).json({ success: false, error: 'Validation failed', errors });
        }
        req.body = result.data;   // replace with coerced/defaults-applied data
        next();
    };
}

/**
 * Returns an Express middleware that validates req.query against the given Zod schema.
 * @param {z.ZodTypeAny} schema
 */
function validateQuery(schema) {
    return (req, res, next) => {
        const result = schema.safeParse(req.query);
        if (!result.success) {
            const errors = result.error.issues.map(issue => ({
                field:   issue.path.join('.'),
                message: issue.message,
            }));
            return res.status(400).json({ success: false, error: 'Validation failed', errors });
        }
        req.query = result.data;
        next();
    };
}

module.exports = { validate, validateQuery, z };
