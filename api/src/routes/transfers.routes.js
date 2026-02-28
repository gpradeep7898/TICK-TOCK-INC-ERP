'use strict';

// routes/transfers.routes.js
// Stock Transfers between warehouses — Task 7

const { Router } = require('express');
const { query, pool } = require('../db/pool');
const { validate } = require('../middleware/validate');
const { parsePage, paginate } = require('../lib/pagination');
const { z } = require('zod');

const router = Router();

// ── Schemas ───────────────────────────────────────────────────────────────────
const UUID   = z.string().uuid();
const PosNum = z.coerce.number().nonnegative();
const PosInt = z.coerce.number().int().nonnegative();

const TransferLineSchema = z.object({
    item_id:       UUID,
    qty:           z.coerce.number().positive(),
    cost_per_unit: PosNum.optional(),
    notes:         z.string().trim().optional(),
});

const CreateTransferSchema = z.object({
    from_warehouse_id: UUID,
    to_warehouse_id:   UUID,
    transfer_date:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    notes:             z.string().trim().optional(),
    lines:             z.array(TransferLineSchema).min(1),
    created_by:        UUID.optional(),
}).refine(d => d.from_warehouse_id !== d.to_warehouse_id,
    { message: 'Source and destination warehouses must be different' });

// ── Number generator ──────────────────────────────────────────────────────────
async function nextTransferNumber(client) {
    const year = new Date().getFullYear();
    const pfx  = `TRF-${year}-`;
    const { rows } = await client.query(
        `SELECT number FROM stock_transfers WHERE number LIKE $1 ORDER BY number DESC LIMIT 1`,
        [`${pfx}%`]
    );
    const seq = rows.length === 0 ? 1 : parseInt(rows[0].number.split('-').pop(), 10) + 1;
    return `${pfx}${String(seq).padStart(5, '0')}`;
}

// ── GET /api/transfers ────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
    const { status } = req.query;
    try {
        const { page, limit, offset } = parsePage(req.query);
        const cond   = status ? `WHERE st.status = $1` : '';
        const params = status ? [status] : [];

        const { rows: [{ count }] } = await query(
            `SELECT COUNT(*) FROM stock_transfers st ${cond}`, params
        );
        const { rows } = await query(
            `SELECT st.*,
                    fw.code AS from_warehouse_code, fw.name AS from_warehouse_name,
                    tw.code AS to_warehouse_code,   tw.name AS to_warehouse_name,
                    (SELECT COUNT(*) FROM stock_transfer_lines WHERE transfer_id = st.id) AS line_count
             FROM   stock_transfers st
             JOIN   warehouses fw ON fw.id = st.from_warehouse_id
             JOIN   warehouses tw ON tw.id = st.to_warehouse_id
             ${cond}
             ORDER  BY st.created_at DESC
             LIMIT $${params.length+1} OFFSET $${params.length+2}`,
            [...params, limit, offset]
        );
        res.json(paginate(rows, parseInt(count, 10), page, limit));
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── GET /api/transfers/:id ────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
    try {
        const { rows: [transfer] } = await query(
            `SELECT st.*,
                    fw.code AS from_warehouse_code, fw.name AS from_warehouse_name,
                    tw.code AS to_warehouse_code,   tw.name AS to_warehouse_name
             FROM   stock_transfers st
             JOIN   warehouses fw ON fw.id = st.from_warehouse_id
             JOIN   warehouses tw ON tw.id = st.to_warehouse_id
             WHERE  st.id = $1`, [req.params.id]
        );
        if (!transfer) return res.status(404).json({ success: false, error: 'Transfer not found' });

        const { rows: lines } = await query(
            `SELECT stl.*, i.code AS item_code, i.name AS item_name,
                    i.unit_of_measure,
                    COALESCE(av.qty_available, 0) AS from_stock_available
             FROM   stock_transfer_lines stl
             JOIN   items i ON i.id = stl.item_id
             LEFT JOIN v_stock_availability av
                    ON av.item_id = stl.item_id AND av.warehouse_id = $2
             WHERE  stl.transfer_id = $1
             ORDER  BY stl.line_number`,
            [req.params.id, transfer.from_warehouse_id]
        );
        res.json({ success: true, data: { ...transfer, lines } });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── POST /api/transfers ───────────────────────────────────────────────────────
router.post('/', validate(CreateTransferSchema), async (req, res) => {
    const { from_warehouse_id, to_warehouse_id, transfer_date,
            notes, lines, created_by } = req.body;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const number = await nextTransferNumber(client);

        const { rows: [transfer] } = await client.query(
            `INSERT INTO stock_transfers
                (number, from_warehouse_id, to_warehouse_id, transfer_date, notes, created_by)
             VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
            [number, from_warehouse_id, to_warehouse_id,
             transfer_date || new Date().toISOString().slice(0, 10),
             notes || null, created_by || null]
        );

        for (let idx = 0; idx < lines.length; idx++) {
            const { item_id, qty, cost_per_unit, notes: lineNotes } = lines[idx];

            let cost = cost_per_unit;
            if (cost == null) {
                const { rows: [item] } = await client.query(
                    `SELECT standard_cost FROM items WHERE id = $1`, [item_id]
                );
                cost = item ? parseFloat(item.standard_cost) : 0;
            }

            await client.query(
                `INSERT INTO stock_transfer_lines
                    (transfer_id, line_number, item_id, qty, cost_per_unit, notes)
                 VALUES ($1,$2,$3,$4,$5,$6)`,
                [transfer.id, idx + 1, item_id, qty, cost, lineNotes || null]
            );
        }

        await client.query('COMMIT');
        res.status(201).json({ success: true, data: transfer });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(400).json({ success: false, error: err.message });
    } finally { client.release(); }
});

// ── POST /api/transfers/:id/post ──────────────────────────────────────────────
router.post('/:id/post', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const { rows: [transfer] } = await client.query(
            `SELECT * FROM stock_transfers WHERE id = $1 FOR UPDATE`, [req.params.id]
        );
        if (!transfer) throw Object.assign(new Error('Transfer not found'), { status: 404 });
        if (transfer.status !== 'draft')
            throw Object.assign(new Error(`Transfer is already ${transfer.status}`), { status: 400 });

        const { rows: lines } = await client.query(
            `SELECT * FROM stock_transfer_lines WHERE transfer_id = $1`, [transfer.id]
        );
        if (!lines.length) throw Object.assign(new Error('No lines to post'), { status: 400 });

        const postedBy = req.body.posted_by || null;

        for (const line of lines) {
            // Check source stock availability
            const { rows: [stockCheck] } = await client.query(
                `SELECT check_stock_availability($1, $2, $3) AS shortfall`,
                [line.item_id, transfer.from_warehouse_id, parseFloat(line.qty)]
            );
            if (parseFloat(stockCheck.shortfall) < 0) {
                const { rows: [avail] } = await client.query(
                    `SELECT COALESCE(qty_available,0) AS qty_available
                     FROM v_stock_availability WHERE item_id=$1 AND warehouse_id=$2`,
                    [line.item_id, transfer.from_warehouse_id]
                );
                throw Object.assign(
                    new Error(`Insufficient stock for item ${line.item_id} in source warehouse: need ${line.qty}, available ${avail ? avail.qty_available : 0}`),
                    { status: 400 }
                );
            }

            // TRANSFER_OUT from source warehouse
            await client.query(
                `INSERT INTO stock_ledger
                    (item_id, warehouse_id, transaction_type, reference_type, reference_id,
                     qty, cost_per_unit, notes, posting_date, created_by)
                 VALUES ($1,$2,'transfer_out','stock_transfer',$3,$4,$5,$6,$7,$8)`,
                [line.item_id, transfer.from_warehouse_id, transfer.id,
                 -parseFloat(line.qty),
                 parseFloat(line.cost_per_unit),
                 `${transfer.number} — OUT`,
                 transfer.transfer_date, postedBy]
            );

            // TRANSFER_IN to destination warehouse
            await client.query(
                `INSERT INTO stock_ledger
                    (item_id, warehouse_id, transaction_type, reference_type, reference_id,
                     qty, cost_per_unit, notes, posting_date, created_by)
                 VALUES ($1,$2,'transfer_in','stock_transfer',$3,$4,$5,$6,$7,$8)`,
                [line.item_id, transfer.to_warehouse_id, transfer.id,
                 parseFloat(line.qty),
                 parseFloat(line.cost_per_unit),
                 `${transfer.number} — IN`,
                 transfer.transfer_date, postedBy]
            );
        }

        await client.query(
            `UPDATE stock_transfers SET status='posted', updated_at=NOW() WHERE id=$1`, [transfer.id]
        );

        await client.query(
            `INSERT INTO audit_log (action, table_name, record_id, new_values)
             VALUES ('post_transfer','stock_transfers',$1,$2)`,
            [transfer.id, JSON.stringify({
                number: transfer.number,
                from_warehouse: transfer.from_warehouse_id,
                to_warehouse:   transfer.to_warehouse_id,
                line_count: lines.length
            })]
        );

        await client.query('COMMIT');
        res.json({ success: true, data: { id: transfer.id, number: transfer.number, status: 'posted' } });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(err.status || 500).json({ success: false, error: err.message });
    } finally { client.release(); }
});

// ── POST /api/transfers/:id/cancel ───────────────────────────────────────────
router.post('/:id/cancel', async (req, res) => {
    try {
        const { rows } = await query(
            `UPDATE stock_transfers SET status='cancelled', updated_at=NOW()
             WHERE id=$1 AND status='draft' RETURNING *`, [req.params.id]
        );
        if (!rows.length) return res.status(400).json({ success: false, error: 'Transfer not found or not in draft' });
        res.json({ success: true, data: rows[0] });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

module.exports = router;
