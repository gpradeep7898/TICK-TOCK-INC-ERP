'use strict';

// lib/pagination.js
// Shared pagination utilities.
//
// Usage:
//   const { parsePage, paginate } = require('../lib/pagination');
//   const { limit, offset, page } = parsePage(req.query);
//   const rows = await query(`SELECT ... LIMIT $1 OFFSET $2`, [limit, offset]);
//   res.json(paginate(rows, total, page, limit));

const { z } = require('zod');

/** Zod schema for page/limit query params — coerce strings to numbers. */
const PageSchema = z.object({
    page:  z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(200).default(25),
});

/**
 * Parse pagination params from req.query.
 * Returns { page, limit, offset }.
 */
function parsePage(q = {}) {
    const { page, limit } = PageSchema.parse({ page: q.page, limit: q.limit });
    return { page, limit, offset: (page - 1) * limit };
}

/**
 * Wrap rows + metadata into a standard paginated response shape.
 * `total` is the total row count (from COUNT(*) query).
 */
function paginate(rows, total, page, limit) {
    const totalPages = Math.ceil(total / limit);
    return {
        data:        rows,
        meta: {
            total:       Number(total),
            page,
            limit,
            total_pages: totalPages,
            has_next:    page < totalPages,
        },
    };
}

module.exports = { PageSchema, parsePage, paginate };
