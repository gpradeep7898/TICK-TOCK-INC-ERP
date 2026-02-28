'use strict';

// routes/reports.routes.js
// Tasks 6 + 8: AR aging report, invoice payment, and 4 key reports
// All endpoints support ?format=csv for CSV download

const { Router } = require('express');
const { query, pool } = require('../db/pool');
const { parsePage, paginate } = require('../lib/pagination');

const router = Router();

// ── CSV helper ────────────────────────────────────────────────────────────────
function toCSV(rows) {
    if (!rows.length) return '';
    const headers = Object.keys(rows[0]);
    const escape  = v => (v == null ? '' : '"' + String(v).replace(/"/g, '""') + '"');
    return [
        headers.join(','),
        ...rows.map(r => headers.map(h => escape(r[h])).join(','))
    ].join('\n');
}

function sendCSV(res, filename, rows) {
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(toCSV(rows));
}

// ── Task 6: AR Aging ──────────────────────────────────────────────────────────
router.get('/ar-aging', async (req, res) => {
    try {
        const { rows } = await query(`SELECT * FROM v_ar_aging ORDER BY total_due DESC`);
        const { rows: [totals] } = await query(
            `SELECT COALESCE(SUM(current_due),0) AS current_due,
                    COALESCE(SUM(days_1_30),0)   AS days_1_30,
                    COALESCE(SUM(days_31_60),0)  AS days_31_60,
                    COALESCE(SUM(days_61_90),0)  AS days_61_90,
                    COALESCE(SUM(days_90plus),0) AS days_90plus,
                    COALESCE(SUM(total_due),0)   AS total_due
             FROM v_ar_aging`
        );
        if (req.query.format === 'csv') return sendCSV(res, 'ar_aging.csv', rows);
        res.json({ success: true, data: { customers: rows, totals } });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── Task 8: Inventory Valuation ───────────────────────────────────────────────
router.get('/inventory-valuation', async (req, res) => {
    const { warehouse_id, category } = req.query;
    try {
        const conds  = [];
        const params = [];
        if (warehouse_id) { params.push(warehouse_id); conds.push(`soh.warehouse_id = $${params.length}`); }
        if (category)     { params.push(category);     conds.push(`i.category = $${params.length}`); }
        const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

        const { rows } = await query(
            `SELECT i.code AS item_code, i.name AS item_name,
                    i.category, i.unit_of_measure,
                    i.standard_cost,
                    SUM(soh.qty_on_hand) AS total_qty_on_hand,
                    SUM(soh.qty_on_hand * i.standard_cost) AS total_value,
                    w.code AS warehouse_code, w.name AS warehouse_name
             FROM v_stock_on_hand soh
             JOIN items i ON i.id = soh.item_id
             JOIN warehouses w ON w.id = soh.warehouse_id
             ${where}
             GROUP BY i.id, i.code, i.name, i.category, i.unit_of_measure,
                      i.standard_cost, w.id, w.code, w.name
             ORDER BY total_value DESC`,
            params
        );

        const { rows: [summary] } = await query(
            `SELECT COALESCE(SUM(soh.qty_on_hand * i.standard_cost),0) AS grand_total
             FROM v_stock_on_hand soh
             JOIN items i ON i.id = soh.item_id`,
            []
        );

        if (req.query.format === 'csv') return sendCSV(res, 'inventory_valuation.csv', rows);
        res.json({ success: true, data: { rows, grand_total: summary.grand_total } });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── Task 8: Stock Movement ────────────────────────────────────────────────────
router.get('/stock-movement', async (req, res) => {
    const { item_id, warehouse_id, from_date, to_date } = req.query;
    try {
        const { page, limit, offset } = parsePage(req.query);
        const conds  = [];
        const params = [];
        if (item_id)     { params.push(item_id);     conds.push(`sl.item_id = $${params.length}`); }
        if (warehouse_id){ params.push(warehouse_id); conds.push(`sl.warehouse_id = $${params.length}`); }
        if (from_date)   { params.push(from_date);   conds.push(`sl.posting_date >= $${params.length}`); }
        if (to_date)     { params.push(to_date);     conds.push(`sl.posting_date <= $${params.length}`); }
        const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

        const { rows: [{ count }] } = await query(
            `SELECT COUNT(*) FROM stock_ledger sl ${where}`, params
        );
        const { rows } = await query(
            `SELECT sl.posting_date, sl.transaction_type, sl.reference_type, sl.reference_id,
                    sl.qty, sl.cost_per_unit,
                    ROUND(sl.qty * sl.cost_per_unit, 4) AS line_value,
                    sl.notes,
                    i.code AS item_code, i.name AS item_name,
                    w.code AS warehouse_code
             FROM   stock_ledger sl
             JOIN   items i ON i.id = sl.item_id
             JOIN   warehouses w ON w.id = sl.warehouse_id
             ${where}
             ORDER  BY sl.posting_date DESC, sl.created_at DESC
             LIMIT $${params.length+1} OFFSET $${params.length+2}`,
            [...params, limit, offset]
        );

        if (req.query.format === 'csv') return sendCSV(res, 'stock_movement.csv', rows);
        res.json(paginate(rows, parseInt(count, 10), page, limit));
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── Task 8: Reorder Recommendations ──────────────────────────────────────────
router.get('/reorder-recommendations', async (_req, res) => {
    try {
        const { rows } = await query(
            `SELECT ra.*,
                    p.name AS preferred_vendor_name
             FROM v_reorder_alerts ra
             LEFT JOIN items i ON i.code = ra.item_code
             LEFT JOIN parties p ON p.id = i.preferred_vendor_id
             ORDER BY ra.qty_available ASC`
        );
        if (_req.query.format === 'csv') return sendCSV(_req.res, 'reorder_recommendations.csv', rows);
        res.json({ success: true, data: rows });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── Task 8: Stock Summary (by warehouse) ─────────────────────────────────────
router.get('/stock-summary', async (_req, res) => {
    try {
        const { rows } = await query(
            `SELECT w.code AS warehouse_code, w.name AS warehouse_name,
                    COUNT(DISTINCT soh.item_id) AS item_count,
                    SUM(soh.qty_on_hand) AS total_qty,
                    SUM(soh.qty_on_hand * i.standard_cost) AS total_value,
                    SUM(sa.qty_available) AS qty_available,
                    SUM(sa.qty_committed) AS qty_committed
             FROM warehouses w
             LEFT JOIN v_stock_on_hand soh ON soh.warehouse_id = w.id
             LEFT JOIN v_stock_availability sa ON sa.warehouse_id = w.id
             LEFT JOIN items i ON i.id = soh.item_id
             WHERE w.is_active = true
             GROUP BY w.id, w.code, w.name
             ORDER BY w.name`
        );
        const { rows: topItems } = await query(
            `SELECT i.code AS item_code, i.name AS item_name,
                    SUM(soh.qty_on_hand) AS total_qty,
                    SUM(soh.qty_on_hand * i.standard_cost) AS total_value
             FROM v_stock_on_hand soh
             JOIN items i ON i.id = soh.item_id
             GROUP BY i.id, i.code, i.name
             ORDER BY total_value DESC
             LIMIT 10`
        );
        if (_req.query.format === 'csv') return sendCSV(_req.res, 'stock_summary.csv', rows);
        res.json({ success: true, data: { by_warehouse: rows, top_items: topItems } });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

module.exports = router;
