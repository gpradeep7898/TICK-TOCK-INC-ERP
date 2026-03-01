'use strict';

// routes/demand.routes.js
// Module 8 — Demand Planning: velocity, forecasting, replenishment suggestions

const { Router } = require('express');
const { query, pool } = require('../db/pool');
const { parsePage, paginate } = require('../lib/pagination');

const router = Router();

// ── GET /api/demand/velocity ───────────────────────────────────────────────────
// Returns 30/60/90-day rolling velocity + days-of-stock for every active item
router.get('/velocity', async (req, res) => {
    const { urgency, sort = 'days_of_stock', order = 'asc' } = req.query;
    try {
        const { page, limit, offset } = parsePage(req.query);

        const allowed = ['days_of_stock','velocity_30d','velocity_60d','velocity_90d',
                         'qty_available','sold_90d','item_name','code','urgency'];
        const sortCol = allowed.includes(sort) ? sort : 'days_of_stock';
        const sortDir = order === 'desc' ? 'DESC' : 'ASC';
        // NULLs last when sorting ASC (items with no velocity float to bottom)
        const nullsClause = sortCol === 'days_of_stock' ? 'NULLS LAST' : '';

        const urgencyCond = urgency
            ? `AND urgency = '${urgency.replace(/[^a-z]/g, '')}'`
            : '';

        const { rows: [{ count }] } = await query(
            `SELECT COUNT(*) FROM v_sales_velocity WHERE 1=1 ${urgencyCond}`
        );
        const { rows } = await query(
            `SELECT * FROM v_sales_velocity
             WHERE 1=1 ${urgencyCond}
             ORDER BY ${sortCol} ${sortDir} ${nullsClause}
             LIMIT $1 OFFSET $2`,
            [limit, offset]
        );
        res.json(paginate(rows, parseInt(count, 10), page, limit));
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── GET /api/demand/velocity/:itemId ──────────────────────────────────────────
router.get('/velocity/:itemId', async (req, res) => {
    try {
        const { rows: [v] } = await query(
            `SELECT * FROM v_sales_velocity WHERE item_id = $1`, [req.params.itemId]
        );
        if (!v) return res.status(404).json({ success: false, error: 'Item not found' });

        // Monthly sales history — last 12 months
        const { rows: history } = await query(
            `SELECT
                TO_CHAR(DATE_TRUNC('month', posting_date), 'YYYY-MM') AS month,
                ABS(SUM(qty)) AS qty_sold
             FROM   stock_ledger
             WHERE  item_id = $1
               AND  transaction_type = 'shipment'
               AND  qty < 0
               AND  posting_date >= DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '11 months'
             GROUP  BY 1
             ORDER  BY 1`,
            [req.params.itemId]
        );

        res.json({ success: true, data: { ...v, monthly_history: history } });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── POST /api/demand/refresh ───────────────────────────────────────────────────
// Recomputes replenishment suggestions for all items below threshold
router.post('/refresh', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Archive existing pending suggestions
        await client.query(
            `UPDATE replenishment_suggestions SET status = 'dismissed'
             WHERE status = 'pending'`
        );

        // Compute new suggestions from velocity view (urgency != 'ok')
        const { rows: items } = await client.query(
            `SELECT * FROM v_sales_velocity WHERE urgency IN ('critical','high','normal')`
        );

        let inserted = 0;
        for (const item of items) {
            // Suggested qty: cover lead_time + 30-day safety buffer using 30d velocity
            const velocity  = parseFloat(item.velocity_30d) || parseFloat(item.velocity_90d) || 0;
            const leadDays  = parseInt(item.lead_time_days, 10) || 14;
            const coverDays = leadDays + 30;              // lead time + safety stock
            const rawQty    = velocity > 0
                ? Math.ceil(velocity * coverDays - parseFloat(item.qty_available))
                : parseFloat(item.reorder_qty || 1);
            const suggestedQty = Math.max(rawQty, parseFloat(item.reorder_qty || 1));
            const unitCost     = parseFloat(item.standard_cost) || 0;

            await client.query(
                `INSERT INTO replenishment_suggestions
                    (item_id, vendor_id, suggested_qty, urgency, days_of_stock,
                     daily_velocity, unit_cost, estimated_value, status, notes)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9)`,
                [
                    item.item_id,
                    item.vendor_id || null,
                    suggestedQty,
                    item.urgency,
                    item.days_of_stock,
                    velocity,
                    unitCost,
                    (suggestedQty * unitCost).toFixed(2),
                    velocity > 0
                        ? `${coverDays}d coverage at ${velocity.toFixed(2)} units/day`
                        : 'Below reorder point — no recent sales history',
                ]
            );
            inserted++;
        }

        await client.query('COMMIT');
        res.json({ success: true, data: { suggestions_created: inserted } });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ success: false, error: err.message });
    } finally { client.release(); }
});

// ── GET /api/demand/suggestions ───────────────────────────────────────────────
router.get('/suggestions', async (req, res) => {
    const { status = 'pending', urgency } = req.query;
    try {
        const { page, limit, offset } = parsePage(req.query);
        const conds  = [`rs.status = $1`];
        const params = [status];
        if (urgency) { params.push(urgency); conds.push(`rs.urgency = $${params.length}`); }
        const where = `WHERE ${conds.join(' AND ')}`;

        const { rows: [{ count }] } = await query(
            `SELECT COUNT(*) FROM replenishment_suggestions rs ${where}`, params
        );
        const { rows } = await query(
            `SELECT rs.*,
                    i.code AS item_code, i.name AS item_name, i.unit_of_measure,
                    p.name AS vendor_name, p.code AS vendor_code
             FROM   replenishment_suggestions rs
             JOIN   items i ON i.id = rs.item_id
             LEFT JOIN parties p ON p.id = rs.vendor_id
             ${where}
             ORDER  BY
                CASE rs.urgency WHEN 'critical' THEN 1 WHEN 'high' THEN 2 ELSE 3 END,
                rs.days_of_stock NULLS LAST
             LIMIT $${params.length+1} OFFSET $${params.length+2}`,
            [...params, limit, offset]
        );
        res.json(paginate(rows, parseInt(count, 10), page, limit));
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── PATCH /api/demand/suggestions/:id/approve ─────────────────────────────────
// Creates a draft PO from the suggestion
router.patch('/suggestions/:id/approve', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const { rows: [sug] } = await client.query(
            `SELECT rs.*, i.code AS item_code, i.name AS item_name
             FROM replenishment_suggestions rs
             JOIN items i ON i.id = rs.item_id
             WHERE rs.id = $1 AND rs.status = 'pending' FOR UPDATE`,
            [req.params.id]
        );
        if (!sug) throw Object.assign(
            new Error('Suggestion not found or already actioned'), { status: 404 }
        );
        if (!sug.vendor_id) throw Object.assign(
            new Error('No vendor associated — assign a vendor before approving'), { status: 400 }
        );

        // Generate PO number
        const year = new Date().getFullYear();
        const pfx  = `PO-${year}-`;
        const { rows: last } = await client.query(
            `SELECT number FROM purchase_orders WHERE number LIKE $1 ORDER BY number DESC LIMIT 1`,
            [`${pfx}%`]
        );
        const seq    = last.length ? parseInt(last[0].number.split('-').pop(), 10) + 1 : 1;
        const poNum  = `${pfx}${String(seq).padStart(5, '0')}`;

        // Warehouse — use first available
        const { rows: [wh] } = await client.query(
            `SELECT id FROM warehouses ORDER BY created_at LIMIT 1`
        );

        const { rows: [po] } = await client.query(
            `INSERT INTO purchase_orders
                (number, vendor_id, warehouse_id, status, order_date, notes, created_by)
             VALUES ($1,$2,$3,'draft',CURRENT_DATE,$4,$5) RETURNING *`,
            [poNum, sug.vendor_id, wh.id,
             `Auto-generated from demand planning — ${sug.item_name}`,
             req.body.created_by || null]
        );

        await client.query(
            `INSERT INTO purchase_order_lines
                (purchase_order_id, line_number, item_id, qty_ordered, unit_cost)
             VALUES ($1,1,$2,$3,$4)`,
            [po.id, sug.item_id, sug.suggested_qty, sug.unit_cost || 0]
        );

        await client.query(
            `UPDATE replenishment_suggestions
             SET status = 'converted', po_id = $2 WHERE id = $1`,
            [sug.id, po.id]
        );

        await client.query('COMMIT');
        res.json({ success: true, data: { suggestion_id: sug.id, po_id: po.id, po_number: poNum } });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(err.status || 500).json({ success: false, error: err.message });
    } finally { client.release(); }
});

// ── PATCH /api/demand/suggestions/:id/dismiss ─────────────────────────────────
router.patch('/suggestions/:id/dismiss', async (req, res) => {
    try {
        const { rows } = await query(
            `UPDATE replenishment_suggestions SET status='dismissed'
             WHERE id=$1 AND status='pending' RETURNING *`, [req.params.id]
        );
        if (!rows.length) return res.status(404).json({ success: false, error: 'Suggestion not found or already actioned' });
        res.json({ success: true, data: rows[0] });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── GET /api/demand/summary ───────────────────────────────────────────────────
router.get('/summary', async (_req, res) => {
    try {
        const { rows: [stats] } = await query(
            `SELECT
                COUNT(*) FILTER (WHERE urgency = 'critical') AS critical_count,
                COUNT(*) FILTER (WHERE urgency = 'high')     AS high_count,
                COUNT(*) FILTER (WHERE urgency = 'normal')   AS normal_count,
                COUNT(*) FILTER (WHERE urgency = 'ok')       AS ok_count,
                COUNT(*) FILTER (WHERE qty_available <= 0)   AS stockout_count,
                ROUND(AVG(days_of_stock) FILTER (WHERE days_of_stock IS NOT NULL), 1) AS avg_days_of_stock
             FROM v_sales_velocity`
        );
        const { rows: [pending] } = await query(
            `SELECT
                COUNT(*) AS pending_suggestions,
                COALESCE(SUM(estimated_value), 0) AS pending_value
             FROM replenishment_suggestions WHERE status='pending'`
        );
        res.json({ success: true, data: { ...stats, ...pending } });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

module.exports = router;
