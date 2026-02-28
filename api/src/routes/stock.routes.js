'use strict';

// routes/stock.routes.js
// Warehouses, stock views, reorder alerts

const { Router } = require('express');
const { query, pool } = require('../db/pool');

const router = Router();

// ── Warehouses ─────────────────────────────────────────────────────────────────

// GET /api/warehouses
router.get('/warehouses', async (_req, res) => {
    try {
        const { rows } = await query(`SELECT * FROM warehouses WHERE is_active = true ORDER BY code`);
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Stock views ────────────────────────────────────────────────────────────────

// GET /api/stock
router.get('/', async (_req, res) => {
    try {
        const { rows } = await query(
            `SELECT * FROM v_stock_availability ORDER BY category, item_code, warehouse_code`
        );
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/stock/dashboard
router.get('/dashboard', async (_req, res) => {
    try {
        const [items, stock, alerts, warehouses] = await Promise.all([
            query(`SELECT COUNT(*) AS cnt FROM items WHERE is_active = true`),
            query(`SELECT COALESCE(SUM(total_cost_value),0) AS total_value FROM v_stock_on_hand`),
            query(`SELECT COUNT(*) AS cnt FROM v_reorder_alerts`),
            query(`SELECT COUNT(*) AS cnt FROM warehouses WHERE is_active = true`)
        ]);
        res.json({
            total_items:         parseInt(items.rows[0].cnt, 10),
            total_value:         parseFloat(stock.rows[0].total_value),
            reorder_alert_count: parseInt(alerts.rows[0].cnt, 10),
            warehouse_count:     parseInt(warehouses.rows[0].cnt, 10)
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/stock/reorder-alerts
router.get('/reorder-alerts', async (_req, res) => {
    try {
        const { rows } = await query(`
            SELECT
                i.id            AS item_id,
                i.code          AS item_code,
                i.name          AS item_name,
                i.category,
                i.unit_of_measure,
                i.reorder_point,
                i.reorder_qty,
                COALESCE(SUM(soh.qty_on_hand),  0) AS qty_on_hand,
                COALESCE(SUM(soh.qty_committed), 0) AS qty_committed,
                COALESCE(SUM(soh.qty_available), 0) AS qty_available,
                (i.reorder_point - COALESCE(SUM(soh.qty_available), 0)) AS shortfall,
                STRING_AGG(DISTINCT w.name, ', ') AS warehouse_names
            FROM items i
            LEFT JOIN v_stock_availability soh ON soh.item_id = i.id
            LEFT JOIN warehouses w ON w.id = soh.warehouse_id
            WHERE i.is_active = true
              AND i.reorder_point > 0
            GROUP BY i.id, i.code, i.name, i.category, i.unit_of_measure, i.reorder_point, i.reorder_qty
            HAVING COALESCE(SUM(soh.qty_available), 0) < i.reorder_point
            ORDER BY (i.reorder_point - COALESCE(SUM(soh.qty_available), 0)) DESC, i.code
        `);
        res.json({ success: true, data: rows });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// GET /api/stock/:itemId/availability
router.get('/:itemId/availability', async (req, res) => {
    try {
        const { rows } = await query(
            `SELECT * FROM v_stock_availability WHERE item_id = $1 ORDER BY warehouse_code`,
            [req.params.itemId]
        );
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/stock/:itemId/history
router.get('/:itemId/history', async (req, res) => {
    try {
        const { rows } = await query(
            `SELECT sl.*, w.code AS warehouse_code, w.name AS warehouse_name,
                    u.name AS created_by_name
             FROM   stock_ledger sl
             JOIN   warehouses w ON w.id = sl.warehouse_id
             LEFT JOIN users  u ON u.id = sl.created_by
             WHERE  sl.item_id = $1
             ORDER  BY sl.posting_date DESC, sl.created_at DESC
             LIMIT  200`,
            [req.params.itemId]
        );
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
