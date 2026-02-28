'use strict';

// routes/adjustments.routes.js
// Stock adjustments CRUD + post action

const { Router } = require('express');
const { query, pool } = require('../db/pool');

const router = Router();

// Generate next adjustment number (ADJ-YYYYMMDD-NNN)
async function nextAdjNumber(client) {
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const prefix  = `ADJ-${dateStr}-`;
    const res = await client.query(
        `SELECT number FROM stock_adjustments WHERE number LIKE $1 ORDER BY number DESC LIMIT 1`,
        [`${prefix}%`]
    );
    const seq = res.rows.length === 0
        ? 1
        : parseInt(res.rows[0].number.split('-').pop(), 10) + 1;
    return `${prefix}${String(seq).padStart(3, '0')}`;
}

// GET /api/adjustments
router.get('/', async (req, res) => {
    try {
        const status = req.query.status;
        const params = [];
        let where = '';
        if (status) { params.push(status); where = `WHERE sa.status = $${params.length}`; }
        const { rows } = await query(
            `SELECT sa.*, w.code AS warehouse_code, w.name AS warehouse_name,
                    u.name AS created_by_name,
                    (SELECT COUNT(*) FROM stock_adjustment_lines sal WHERE sal.adjustment_id = sa.id) AS line_count
             FROM   stock_adjustments sa
             JOIN   warehouses w ON w.id = sa.warehouse_id
             LEFT JOIN users u ON u.id = sa.created_by
             ${where}
             ORDER  BY sa.created_at DESC`,
            params
        );
        res.json({ success: true, data: rows });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// POST /api/adjustments
router.post('/', async (req, res) => {
    const { warehouse_id, adjustment_date, reason, notes, lines = [], created_by } = req.body;

    if (!warehouse_id) return res.status(400).json({ error: 'warehouse_id is required' });
    if (!Array.isArray(lines) || lines.length === 0)
        return res.status(400).json({ error: 'At least one line is required' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const number = await nextAdjNumber(client);

        const { rows: [adj] } = await client.query(
            `INSERT INTO stock_adjustments
                (number, warehouse_id, adjustment_date, reason, notes, created_by)
             VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
            [number, warehouse_id, adjustment_date || new Date().toISOString().slice(0,10),
             reason, notes, created_by || null]
        );

        for (const line of lines) {
            const { item_id, qty_actual, cost_per_unit, notes: lnotes } = line;
            if (!item_id || qty_actual == null)
                throw new Error('Each line requires item_id and qty_actual');

            const { rows: soh } = await client.query(
                `SELECT COALESCE(qty_on_hand, 0) AS qty_on_hand
                 FROM   v_stock_on_hand
                 WHERE  item_id = $1 AND warehouse_id = $2`,
                [item_id, warehouse_id]
            );
            const qty_system = soh.length ? parseFloat(soh[0].qty_on_hand) : 0;

            const { rows: [itemRow] } = await client.query(
                `SELECT standard_cost FROM items WHERE id = $1`, [item_id]
            );
            const cpu = cost_per_unit != null ? cost_per_unit
                       : (itemRow ? itemRow.standard_cost : 0);

            await client.query(
                `INSERT INTO stock_adjustment_lines
                    (adjustment_id, item_id, qty_system, qty_actual, cost_per_unit, notes)
                 VALUES ($1,$2,$3,$4,$5,$6)`,
                [adj.id, item_id, qty_system, qty_actual, cpu, lnotes || null]
            );
        }

        await client.query('COMMIT');
        res.status(201).json(adj);
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: err.message });
    } finally {
        client.release();
    }
});

// POST /api/adjustments/:id/post
router.post('/:id/post', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const { rows: [adj] } = await client.query(
            `SELECT * FROM stock_adjustments WHERE id = $1 FOR UPDATE`,
            [req.params.id]
        );
        if (!adj)           throw Object.assign(new Error('Adjustment not found'), { status: 404 });
        if (adj.status !== 'draft')
            throw Object.assign(new Error(`Adjustment is already ${adj.status}`), { status: 400 });

        const { rows: lines } = await client.query(
            `SELECT * FROM stock_adjustment_lines WHERE adjustment_id = $1`,
            [adj.id]
        );
        if (!lines.length) throw Object.assign(new Error('No lines to post'), { status: 400 });

        for (const line of lines) {
            const diff = parseFloat(line.qty_difference);
            if (diff === 0) continue;

            await client.query(
                `INSERT INTO stock_ledger
                    (item_id, warehouse_id, transaction_type, reference_type,
                     reference_id, qty, cost_per_unit, notes, posting_date, created_by)
                 VALUES ($1,$2,'adjustment','stock_adjustment',$3,$4,$5,$6,$7,$8)`,
                [
                    line.item_id, adj.warehouse_id, adj.id,
                    diff,
                    line.cost_per_unit,
                    `Stock adjustment ${adj.number}`,
                    adj.adjustment_date,
                    req.body.posted_by || null
                ]
            );
        }

        const { rows: [updated] } = await client.query(
            `UPDATE stock_adjustments
             SET status = 'posted', posted_at = NOW()
             WHERE id = $1 RETURNING *`,
            [adj.id]
        );

        await client.query('COMMIT');

        try {
            await query(`INSERT INTO audit_log (action, table_name, record_id, new_values) VALUES ('post_adjustment','stock_adjustments',$1,$2)`,
                [adj.id, JSON.stringify({ status: 'posted', posted_at: new Date() })]);
        } catch { /* non-fatal */ }

        res.json({ success: true, data: updated });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(err.status || 500).json({ success: false, error: err.message });
    } finally {
        client.release();
    }
});

// DELETE /api/adjustments/:id
router.delete('/:id', async (req, res) => {
    try {
        const { rows: [adj] } = await query(
            `SELECT status FROM stock_adjustments WHERE id = $1`, [req.params.id]
        );
        if (!adj) return res.status(404).json({ success: false, error: 'Adjustment not found' });
        if (adj.status === 'posted') return res.status(400).json({ success: false, error: 'Cannot delete a posted adjustment' });
        await query(`DELETE FROM stock_adjustments WHERE id = $1`, [req.params.id]);
        res.json({ success: true, data: { id: req.params.id } });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
