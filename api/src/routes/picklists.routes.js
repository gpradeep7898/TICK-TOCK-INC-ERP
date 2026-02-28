'use strict';

// routes/picklists.routes.js
// Pick List Workflow — Task 9

const { Router } = require('express');
const { query, pool } = require('../db/pool');
const { validate } = require('../middleware/validate');
const { parsePage, paginate } = require('../lib/pagination');
const { z } = require('zod');

const router = Router();

// ── Schemas ───────────────────────────────────────────────────────────────────
const UUID = z.string().uuid();

const CreatePickListSchema = z.object({
    sales_order_id: UUID,
    assigned_to:    UUID.optional(),
    notes:          z.string().trim().optional(),
    created_by:     UUID.optional(),
});

const UpdatePickLineSchema = z.object({
    qty_picked:  z.coerce.number().nonnegative(),
    status:      z.enum(['open','picked','short','skipped']).optional(),
    bin_location:z.string().trim().optional(),
    notes:       z.string().trim().optional(),
});

// ── Number generator ──────────────────────────────────────────────────────────
async function nextPickNumber(client) {
    const year = new Date().getFullYear();
    const pfx  = `PL-${year}-`;
    const { rows } = await client.query(
        `SELECT number FROM pick_lists WHERE number LIKE $1 ORDER BY number DESC LIMIT 1`,
        [`${pfx}%`]
    );
    const seq = rows.length === 0 ? 1 : parseInt(rows[0].number.split('-').pop(), 10) + 1;
    return `${pfx}${String(seq).padStart(5, '0')}`;
}

// ── GET /api/picklists ────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
    const { status, sales_order_id } = req.query;
    try {
        const { page, limit, offset } = parsePage(req.query);
        const conds  = [];
        const params = [];
        if (status)         { params.push(status);         conds.push(`pl.status = $${params.length}`); }
        if (sales_order_id) { params.push(sales_order_id); conds.push(`pl.sales_order_id = $${params.length}`); }
        const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

        const { rows: [{ count }] } = await query(
            `SELECT COUNT(*) FROM pick_lists pl ${where}`, params
        );
        const { rows } = await query(
            `SELECT pl.*,
                    so.number AS order_number,
                    p.name AS customer_name,
                    w.code AS warehouse_code,
                    u.name AS assigned_to_name,
                    (SELECT COUNT(*) FROM pick_list_lines pll WHERE pll.pick_list_id = pl.id) AS line_count,
                    (SELECT COUNT(*) FROM pick_list_lines pll WHERE pll.pick_list_id = pl.id AND pll.status = 'picked') AS lines_picked
             FROM   pick_lists pl
             JOIN   sales_orders so ON so.id = pl.sales_order_id
             JOIN   parties p ON p.id = so.customer_id
             JOIN   warehouses w ON w.id = pl.warehouse_id
             LEFT JOIN users u ON u.id = pl.assigned_to
             ${where}
             ORDER  BY pl.created_at DESC
             LIMIT $${params.length+1} OFFSET $${params.length+2}`,
            [...params, limit, offset]
        );
        res.json(paginate(rows, parseInt(count, 10), page, limit));
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── GET /api/picklists/:id ────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
    try {
        const { rows: [pl] } = await query(
            `SELECT pl.*,
                    so.number AS order_number,
                    p.name AS customer_name, p.code AS customer_code,
                    w.code AS warehouse_code, w.name AS warehouse_name
             FROM   pick_lists pl
             JOIN   sales_orders so ON so.id = pl.sales_order_id
             JOIN   parties p ON p.id = so.customer_id
             JOIN   warehouses w ON w.id = pl.warehouse_id
             WHERE  pl.id = $1`, [req.params.id]
        );
        if (!pl) return res.status(404).json({ success: false, error: 'Pick list not found' });

        const { rows: lines } = await query(
            `SELECT pll.*, i.code AS item_code, i.name AS item_name,
                    i.unit_of_measure, i.upc_code,
                    COALESCE(av.qty_available, 0) AS stock_available
             FROM   pick_list_lines pll
             JOIN   items i ON i.id = pll.item_id
             LEFT JOIN v_stock_availability av
                    ON av.item_id = pll.item_id AND av.warehouse_id = $2
             WHERE  pll.pick_list_id = $1
             ORDER  BY pll.line_number`,
            [req.params.id, pl.warehouse_id]
        );
        res.json({ success: true, data: { ...pl, lines } });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── POST /api/picklists — auto-generate from SO ───────────────────────────────
router.post('/', validate(CreatePickListSchema), async (req, res) => {
    const { sales_order_id, assigned_to, notes, created_by } = req.body;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const { rows: [order] } = await client.query(
            `SELECT * FROM sales_orders WHERE id = $1`, [sales_order_id]
        );
        if (!order) throw Object.assign(new Error('Sales order not found'), { status: 404 });
        if (!['confirmed','partially_shipped'].includes(order.status))
            throw Object.assign(new Error(`Cannot create pick list for order in status "${order.status}"`), { status: 400 });

        // Check for existing open pick list for this order
        const { rows: existing } = await client.query(
            `SELECT id FROM pick_lists
             WHERE sales_order_id=$1 AND status IN ('open','in_progress')`,
            [sales_order_id]
        );
        if (existing.length)
            throw Object.assign(
                new Error(`An open pick list already exists for this order: ${existing[0].id}`),
                { status: 409 }
            );

        const { rows: openLines } = await client.query(
            `SELECT sol.*, i.code AS item_code
             FROM sales_order_lines sol
             JOIN items i ON i.id = sol.item_id
             WHERE sol.sales_order_id = $1 AND sol.status IN ('open','partial')
             ORDER BY sol.line_number`,
            [sales_order_id]
        );
        if (!openLines.length)
            throw Object.assign(new Error('No open lines to pick for this order'), { status: 400 });

        const number = await nextPickNumber(client);

        const { rows: [pl] } = await client.query(
            `INSERT INTO pick_lists
                (number, sales_order_id, warehouse_id, assigned_to, notes, created_by)
             VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
            [number, sales_order_id, order.warehouse_id,
             assigned_to || null, notes || null, created_by || null]
        );

        for (let idx = 0; idx < openLines.length; idx++) {
            const sol = openLines[idx];
            const qtyToPick = parseFloat(sol.qty_ordered) - parseFloat(sol.qty_shipped);
            if (qtyToPick <= 0) continue;
            await client.query(
                `INSERT INTO pick_list_lines
                    (pick_list_id, sales_order_line_id, item_id, line_number, qty_to_pick)
                 VALUES ($1,$2,$3,$4,$5)`,
                [pl.id, sol.id, sol.item_id, idx + 1, qtyToPick]
            );
        }

        await client.query('COMMIT');
        res.status(201).json({ success: true, data: pl });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(err.status || 400).json({ success: false, error: err.message });
    } finally { client.release(); }
});

// ── PATCH /api/picklists/:id/lines/:lineId ────────────────────────────────────
router.patch('/:id/lines/:lineId', validate(UpdatePickLineSchema), async (req, res) => {
    const { qty_picked, status, bin_location, notes } = req.body;
    try {
        const { rows: [line] } = await query(
            `UPDATE pick_list_lines
             SET qty_picked    = $1,
                 status        = COALESCE($2, CASE WHEN $1 >= qty_to_pick THEN 'picked' WHEN $1 > 0 THEN 'picked' ELSE status END),
                 bin_location  = COALESCE($3, bin_location),
                 notes         = COALESCE($4, notes)
             WHERE id = $5 AND pick_list_id = $6
             RETURNING *`,
            [qty_picked, status || null, bin_location || null, notes || null,
             req.params.lineId, req.params.id]
        );
        if (!line) return res.status(404).json({ success: false, error: 'Pick line not found' });

        // Update pick list status based on lines
        await query(
            `UPDATE pick_lists SET status = (
                SELECT CASE
                    WHEN COUNT(*) FILTER (WHERE status IN ('picked')) = COUNT(*) THEN 'completed'
                    WHEN COUNT(*) FILTER (WHERE status IN ('picked','short','skipped')) > 0 THEN 'in_progress'
                    ELSE 'open'
                END
                FROM pick_list_lines WHERE pick_list_id = $1
             ), updated_at = NOW()
             WHERE id = $1`,
            [req.params.id]
        );

        res.json({ success: true, data: line });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── PATCH /api/picklists/:id — update status / assign ────────────────────────
router.patch('/:id', async (req, res) => {
    const { status, assigned_to, notes } = req.body;
    try {
        const sets   = [];
        const params = [req.params.id];
        if (status      !== undefined) { params.push(status);      sets.push(`status = $${params.length}`); }
        if (assigned_to !== undefined) { params.push(assigned_to); sets.push(`assigned_to = $${params.length}`); }
        if (notes       !== undefined) { params.push(notes);       sets.push(`notes = $${params.length}`); }
        if (!sets.length) return res.status(400).json({ success: false, error: 'No fields to update' });

        const { rows } = await query(
            `UPDATE pick_lists SET ${sets.join(', ')}, updated_at=NOW() WHERE id=$1 RETURNING *`,
            params
        );
        if (!rows.length) return res.status(404).json({ success: false, error: 'Pick list not found' });
        res.json({ success: true, data: rows[0] });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── GET /api/picklists/:id/print ──────────────────────────────────────────────
router.get('/:id/print', async (req, res) => {
    try {
        const { rows: [pl] } = await query(
            `SELECT pl.*,
                    so.number AS order_number,
                    p.name AS customer_name, p.shipping_address,
                    w.code AS warehouse_code, w.name AS warehouse_name
             FROM   pick_lists pl
             JOIN   sales_orders so ON so.id = pl.sales_order_id
             JOIN   parties p ON p.id = so.customer_id
             JOIN   warehouses w ON w.id = pl.warehouse_id
             WHERE  pl.id = $1`, [req.params.id]
        );
        if (!pl) return res.status(404).json({ success: false, error: 'Pick list not found' });

        const { rows: lines } = await query(
            `SELECT pll.line_number, pll.qty_to_pick, pll.qty_picked, pll.status,
                    pll.bin_location, i.code AS item_code, i.name AS item_name,
                    i.unit_of_measure, i.upc_code
             FROM   pick_list_lines pll
             JOIN   items i ON i.id = pll.item_id
             WHERE  pll.pick_list_id = $1
             ORDER  BY pll.line_number`, [req.params.id]
        );

        if (req.query.format !== 'html') return res.json({ pick_list: pl, lines });

        function esc(s) { return s == null ? '' : String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
        function fmtDate(d) { if (!d) return '—'; const dt = new Date(d); return (dt.getMonth()+1)+'/'+(dt.getDate())+'/'+(dt.getFullYear()); }

        const lineRows = lines.map(l => `
            <tr>
              <td>${esc(l.line_number)}</td>
              <td>${esc(l.item_code)}</td>
              <td>${esc(l.item_name)}</td>
              <td>${esc(l.bin_location) || '—'}</td>
              <td>${esc(l.upc_code) || '—'}</td>
              <td style="text-align:right">${esc(l.qty_to_pick)} ${esc(l.unit_of_measure)}</td>
              <td style="width:70px;border-bottom:1px solid #ccc">&nbsp;</td>
            </tr>`).join('');

        const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Pick List ${esc(pl.number)}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin:0; padding:0; }
  body { font-family: Arial, sans-serif; font-size: 13px; background:#fff; }
  .page { max-width:860px; margin:20px auto; padding:32px 40px; }
  .header { display:flex; justify-content:space-between; border-bottom:2px solid #0d1b3e; padding-bottom:16px; margin-bottom:24px; }
  .company h1 { font-size:20px; font-weight:700; color:#0d1b3e; }
  .doc-meta { text-align:right; }
  .doc-number { font-size:18px; font-weight:700; color:#0d1b3e; }
  .meta-row { display:flex; gap:24px; margin-bottom:20px; flex-wrap:wrap; }
  .meta-item label { font-size:10px; text-transform:uppercase; color:#6c757d; display:block; }
  table { width:100%; border-collapse:collapse; margin-top:12px; }
  thead th { background:#0d1b3e; color:#fff; padding:8px 10px; text-align:left; font-size:11px; }
  tbody td { padding:8px 10px; border-bottom:1px solid #e9ecef; }
  .print-btn { position:fixed; top:16px; right:16px; padding:8px 16px; background:#0d1b3e; color:#fff; border:none; border-radius:4px; cursor:pointer; font-size:13px; }
  @media print { .print-btn { display:none; } }
</style></head><body>
<button class="print-btn" onclick="window.print()">🖨 Print</button>
<div class="page">
<div class="header">
  <div class="company"><h1>Tick Tock Inc.</h1><p>Pick List</p></div>
  <div class="doc-meta"><div class="doc-number">${esc(pl.number)}</div><div style="font-size:11px;color:#6c757d">${esc(pl.status.toUpperCase())}</div></div>
</div>
<div class="meta-row">
  <div class="meta-item"><label>Order #</label><span>${esc(pl.order_number)}</span></div>
  <div class="meta-item"><label>Customer</label><span>${esc(pl.customer_name)}</span></div>
  <div class="meta-item"><label>Warehouse</label><span>${esc(pl.warehouse_name)}</span></div>
  <div class="meta-item"><label>Created</label><span>${fmtDate(pl.created_at)}</span></div>
</div>
<table>
  <thead><tr><th>#</th><th>SKU</th><th>Item Name</th><th>Bin</th><th>UPC</th><th>Qty to Pick</th><th>Picked ✓</th></tr></thead>
  <tbody>${lineRows}</tbody>
</table>
</div></body></html>`;

        res.setHeader('Content-Type', 'text/html');
        res.send(html);
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

module.exports = router;
