'use strict';

// routes/items.routes.js
// Items, Warehouses, UPC barcode lookup, Item search

const { Router } = require('express');
const { query }  = require('../db/pool');

const router = Router();

// GET /api/items
router.get('/', async (_req, res) => {
    try {
        const { rows } = await query(`SELECT * FROM items ORDER BY category, code`);
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/items/search  (must be before /:id to avoid param collision)
router.get('/search', async (req, res) => {
    const q = (req.query.q || '').trim();
    if (!q) return res.json({ success: true, data: [] });
    try {
        const { rows } = await query(`
            SELECT id, code, name, category, sale_price, standard_cost, upc_code, unit_of_measure, is_active
            FROM items
            WHERE is_active = true
              AND (
                  code ILIKE $1 OR
                  name ILIKE $1 OR
                  category ILIKE $1 OR
                  upc_code ILIKE $1
              )
            ORDER BY name
            LIMIT 25
        `, [`%${q}%`]);
        res.json({ success: true, data: rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET /api/items/by-upc/:upc  (must be before /:id)
router.get('/by-upc/:upc', async (req, res) => {
    try {
        const { rows } = await query(
            `SELECT * FROM items WHERE upc_code = $1`, [req.params.upc]
        );
        if (!rows.length) return res.status(404).json({ error: 'No item found with that UPC' });
        res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/items/:id
router.get('/:id', async (req, res) => {
    try {
        const { rows } = await query(`SELECT * FROM items WHERE id = $1`, [req.params.id]);
        if (!rows.length) return res.status(404).json({ error: 'Item not found' });
        res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/items
router.post('/', async (req, res) => {
    const {
        code, name, description, unit_of_measure = 'EA',
        cost_method = 'avg', standard_cost = 0, sale_price = 0,
        reorder_point = 0, reorder_qty = 0, lead_time_days = 0, category
    } = req.body;

    if (!code || !name) return res.status(400).json({ error: 'code and name are required' });

    try {
        const { rows } = await query(
            `INSERT INTO items
                (code, name, description, unit_of_measure, cost_method, standard_cost,
                 sale_price, reorder_point, reorder_qty, lead_time_days, category)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
             RETURNING *`,
            [code, name, description, unit_of_measure, cost_method,
             standard_cost, sale_price, reorder_point, reorder_qty, lead_time_days, category]
        );
        res.status(201).json(rows[0]);
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: 'Item code already exists' });
        res.status(500).json({ error: err.message });
    }
});

// PATCH /api/items/:id
router.patch('/:id', async (req, res) => {
    const allowed = ['name','description','unit_of_measure','cost_method',
                     'standard_cost','sale_price','reorder_point','reorder_qty',
                     'lead_time_days','category','is_active',
                     'upc_code','weight_lb','country_of_origin'];
    const fields  = Object.keys(req.body).filter(k => allowed.includes(k));
    if (!fields.length) return res.status(400).json({ error: 'No valid fields to update' });

    const sets   = fields.map((f, i) => `${f} = $${i + 2}`).join(', ');
    const values = fields.map(f => req.body[f]);

    try {
        const { rows } = await query(
            `UPDATE items SET ${sets}, updated_at = NOW() WHERE id = $1 RETURNING *`,
            [req.params.id, ...values]
        );
        if (!rows.length) return res.status(404).json({ error: 'Item not found' });
        res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/items/:id — soft-delete (set is_active = false) if has stock history
router.delete('/:id', async (req, res) => {
    try {
        const { rows: stockRows } = await query(
            `SELECT COUNT(*) AS cnt FROM stock_ledger WHERE item_id = $1`, [req.params.id]
        );
        if (parseInt(stockRows[0].cnt, 10) > 0) {
            const { rows } = await query(
                `UPDATE items SET is_active = false, updated_at = NOW() WHERE id = $1 RETURNING id, code, name`,
                [req.params.id]
            );
            if (!rows.length) return res.status(404).json({ success: false, error: 'Item not found' });
            return res.json({ success: true, data: rows[0], message: 'Item deactivated (has stock history)' });
        }
        const { rows } = await query(`DELETE FROM items WHERE id = $1 RETURNING id`, [req.params.id]);
        if (!rows.length) return res.status(404).json({ success: false, error: 'Item not found' });
        res.json({ success: true, data: { id: req.params.id } });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
