'use strict';

// routes/purchasing.routes.js
// Vendors, Purchase Orders, Receipts, Vendor Invoices, AP Payments, AP Aging, Reorder Suggestions

const { Router } = require('express');
const { query, pool } = require('../db/pool');

const router = Router();

// ── Number generator ──────────────────────────────────────────────────────────
async function nextDocNumber(client, table, col, prefix) {
    const year = new Date().getFullYear();
    const pfx  = `${prefix}-${year}-`;
    const { rows } = await client.query(
        `SELECT ${col} FROM ${table} WHERE ${col} LIKE $1 ORDER BY ${col} DESC LIMIT 1`,
        [`${pfx}%`]
    );
    const seq = rows.length === 0 ? 1 : parseInt(rows[0][col].split('-').pop(), 10) + 1;
    return `${pfx}${String(seq).padStart(5, '0')}`;
}

// ── Backorder helper ──────────────────────────────────────────────────────────
async function checkBackordersForAllItems(client, itemIds) {
    for (const itemId of itemIds) {
        await client.query(
            `UPDATE sales_order_lines sol
             SET status = CASE
                 WHEN sol.qty_shipped >= sol.qty_ordered THEN 'fulfilled'
                 WHEN sol.qty_shipped > 0                THEN 'partial'
                 ELSE 'open' END
             FROM sales_orders so
             WHERE sol.sales_order_id = so.id
               AND sol.item_id = $1
               AND so.status NOT IN ('closed','cancelled')
               AND sol.status NOT IN ('fulfilled','cancelled')`,
            [itemId]
        );
    }
}

// ── Vendors ───────────────────────────────────────────────────────────────────

router.get('/vendors', async (_req, res) => {
    try {
        const { rows } = await query(
            `SELECT p.*,
                    COALESCE(ap.total_due, 0) AS ap_balance
             FROM   parties p
             LEFT JOIN v_ap_aging ap ON ap.vendor_id = p.id
             WHERE  p.type IN ('vendor','both')
             ORDER  BY p.name`
        );
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/vendors/:id', async (req, res) => {
    try {
        const { rows: [vendor] } = await query(
            `SELECT p.*, COALESCE(ap.total_due,0) AS ap_balance,
                    ap.current_due, ap.days_1_30, ap.days_31_60, ap.days_61_90, ap.days_90plus
             FROM   parties p
             LEFT JOIN v_ap_aging ap ON ap.vendor_id = p.id
             WHERE  p.id = $1`, [req.params.id]
        );
        if (!vendor) return res.status(404).json({ error: 'Vendor not found' });

        const { rows: openInvoices } = await query(
            `SELECT * FROM vendor_invoices
             WHERE vendor_id = $1 AND status NOT IN ('paid','void')
             ORDER BY due_date`, [req.params.id]
        );
        const { rows: recentPOs } = await query(
            `SELECT * FROM v_purchase_order_status WHERE vendor_id = $1
             ORDER BY created_at DESC LIMIT 10`, [req.params.id]
        );
        res.json({ ...vendor, open_invoices: openInvoices, recent_pos: recentPOs });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/vendors', async (req, res) => {
    const { code, name, email, phone, billing_address,
            payment_terms_days = 30, currency = 'USD', notes } = req.body;
    if (!code || !name) return res.status(400).json({ error: 'code and name are required' });
    try {
        const { rows } = await query(
            `INSERT INTO parties (type,code,name,email,phone,billing_address,
                                  payment_terms_days,currency,notes)
             VALUES ('vendor',$1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
            [code, name, email, phone,
             billing_address ? JSON.stringify(billing_address) : null,
             payment_terms_days, currency, notes]
        );
        res.status(201).json(rows[0]);
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: 'Vendor code already exists' });
        res.status(500).json({ error: err.message });
    }
});

// ── Vendors AP aging ──────────────────────────────────────────────────────────

router.get('/vendors/:id/ap', async (req, res) => {
    try {
        const { rows: [aging] } = await query(
            `SELECT * FROM v_ap_aging WHERE vendor_id = $1`, [req.params.id]
        );
        const { rows: invoices } = await query(
            `SELECT * FROM vendor_invoices WHERE vendor_id = $1 AND status NOT IN ('paid','void')
             ORDER BY due_date`, [req.params.id]
        );
        res.json({ aging: aging || null, open_invoices: invoices });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Purchase Orders ───────────────────────────────────────────────────────────

router.get('/purchase-orders/dashboard', async (_req, res) => {
    try {
        const [stats, recentPOs, apData] = await Promise.all([
            query(
                `SELECT
                    COUNT(*) FILTER (WHERE status NOT IN ('cancelled'))               AS total_pos,
                    COUNT(*) FILTER (WHERE status IN ('sent','partially_received'))    AS open_pos,
                    COUNT(*) FILTER (WHERE status IN ('fully_received'))               AS received_pos,
                    COALESCE(SUM(vi.balance_due),0)                                   AS total_ap
                 FROM purchase_orders po
                 CROSS JOIN (SELECT COALESCE(SUM(balance_due),0) AS balance_due FROM vendor_invoices
                             WHERE status NOT IN ('paid','void')) vi`
            ),
            query(`SELECT * FROM v_purchase_order_status ORDER BY created_at DESC LIMIT 5`),
            query(`SELECT COALESCE(SUM(total_due),0) AS ap_total FROM v_ap_aging`)
        ]);
        res.json({
            ...stats.rows[0],
            total_ap:   parseFloat(apData.rows[0].ap_total),
            recent_pos: recentPOs.rows
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/purchase-orders', async (req, res) => {
    const { status } = req.query;
    try {
        const cond   = status ? `WHERE po.status = $1` : '';
        const params = status ? [status] : [];
        const { rows } = await query(
            `SELECT pos.*
             FROM   v_purchase_order_status pos
             ${cond}
             ORDER  BY pos.created_at DESC`,
            params
        );
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/purchase-orders/:id', async (req, res) => {
    try {
        const { rows: [po] } = await query(
            `SELECT pos.* FROM v_purchase_order_status pos WHERE pos.id = $1`, [req.params.id]
        );
        if (!po) return res.status(404).json({ error: 'PO not found' });

        const { rows: lines } = await query(
            `SELECT pol.*, i.code AS item_code, i.name AS item_name, i.unit_of_measure
             FROM   purchase_order_lines pol
             JOIN   items i ON i.id = pol.item_id
             WHERE  pol.purchase_order_id = $1
             ORDER  BY pol.line_number`, [req.params.id]
        );
        const { rows: receipts } = await query(
            `SELECT * FROM purchase_receipts WHERE purchase_order_id = $1 ORDER BY receipt_date DESC`,
            [req.params.id]
        );
        const { rows: invoices } = await query(
            `SELECT * FROM vendor_invoices WHERE purchase_order_id = $1 ORDER BY invoice_date DESC`,
            [req.params.id]
        );
        res.json({ ...po, lines, receipts, invoices });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/purchase-orders', async (req, res) => {
    const { vendor_id, warehouse_id, order_date, expected_date, notes,
            lines = [], created_by } = req.body;
    if (!vendor_id || !warehouse_id) return res.status(400).json({ error: 'vendor_id and warehouse_id required' });
    if (!lines.length) return res.status(400).json({ error: 'At least one line required' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const number = await nextDocNumber(client, 'purchase_orders', 'number', 'PO');

        const { rows: [po] } = await client.query(
            `INSERT INTO purchase_orders
                (number, vendor_id, warehouse_id, order_date, expected_date, notes, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
            [number, vendor_id, warehouse_id,
             order_date || new Date().toISOString().slice(0,10),
             expected_date || null, notes || null, created_by || null]
        );

        for (let idx = 0; idx < lines.length; idx++) {
            const { item_id, qty_ordered, unit_cost, description } = lines[idx];
            if (!item_id || !qty_ordered) throw new Error('Each line requires item_id and qty_ordered');

            let cost = unit_cost;
            if (cost == null) {
                const { rows: [item] } = await client.query(
                    `SELECT standard_cost FROM items WHERE id = $1`, [item_id]
                );
                cost = item ? parseFloat(item.standard_cost) : 0;
            }

            await client.query(
                `INSERT INTO purchase_order_lines
                    (purchase_order_id, line_number, item_id, description, qty_ordered, unit_cost)
                 VALUES ($1,$2,$3,$4,$5,$6)`,
                [po.id, idx + 1, item_id, description || null, qty_ordered, cost]
            );
        }

        await client.query('COMMIT');

        const { rows: [full] } = await query(
            `SELECT * FROM v_purchase_order_status WHERE id = $1`, [po.id]
        );
        res.status(201).json(full);
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: err.message });
    } finally { client.release(); }
});

router.post('/purchase-orders/:id/send', async (req, res) => {
    try {
        const { rows } = await query(
            `UPDATE purchase_orders SET status='sent', updated_at=NOW()
             WHERE id=$1 AND status='draft' RETURNING *`, [req.params.id]
        );
        if (!rows.length) return res.status(400).json({ error: 'PO not found or not in draft' });
        const { rows: [full] } = await query(
            `SELECT * FROM v_purchase_order_status WHERE id = $1`, [rows[0].id]
        );
        res.json(full);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/purchase-orders/:id/cancel', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows: [po] } = await client.query(
            `SELECT * FROM purchase_orders WHERE id = $1 FOR UPDATE`, [req.params.id]
        );
        if (!po) throw Object.assign(new Error('PO not found'), { status: 404 });
        if (['fully_received','closed','cancelled'].includes(po.status))
            throw Object.assign(new Error(`Cannot cancel a ${po.status} PO`), { status: 400 });

        await client.query(
            `UPDATE purchase_orders SET status='cancelled', updated_at=NOW() WHERE id=$1`, [po.id]
        );
        await client.query(
            `UPDATE purchase_order_lines SET status='cancelled' WHERE purchase_order_id=$1`, [po.id]
        );
        await client.query('COMMIT');
        res.json({ id: po.id, status: 'cancelled' });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(err.status || 500).json({ error: err.message });
    } finally { client.release(); }
});

// ── Receipts ──────────────────────────────────────────────────────────────────

router.get('/receipts', async (_req, res) => {
    try {
        const { rows } = await query(
            `SELECT pr.*, po.number AS po_number,
                    p.code AS vendor_code, p.name AS vendor_name,
                    w.code AS warehouse_code
             FROM   purchase_receipts pr
             JOIN   purchase_orders po ON po.id = pr.purchase_order_id
             JOIN   parties p ON p.id = po.vendor_id
             JOIN   warehouses w ON w.id = pr.warehouse_id
             ORDER  BY pr.created_at DESC`
        );
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/receipts/:id', async (req, res) => {
    try {
        const { rows: [rcv] } = await query(
            `SELECT pr.*, po.number AS po_number,
                    p.code AS vendor_code, p.name AS vendor_name,
                    w.code AS warehouse_code
             FROM   purchase_receipts pr
             JOIN   purchase_orders po ON po.id = pr.purchase_order_id
             JOIN   parties p ON p.id = po.vendor_id
             JOIN   warehouses w ON w.id = pr.warehouse_id
             WHERE  pr.id = $1`, [req.params.id]
        );
        if (!rcv) return res.status(404).json({ error: 'Receipt not found' });

        const { rows: lines } = await query(
            `SELECT prl.*, i.code AS item_code, i.name AS item_name, i.unit_of_measure
             FROM   purchase_receipt_lines prl
             JOIN   items i ON i.id = prl.item_id
             WHERE  prl.receipt_id = $1`, [req.params.id]
        );
        res.json({ ...rcv, lines });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/receipts', async (req, res) => {
    const { purchase_order_id, receipt_date, vendor_ref, notes,
            lines = [], created_by } = req.body;
    if (!purchase_order_id) return res.status(400).json({ error: 'purchase_order_id required' });
    if (!lines.length) return res.status(400).json({ error: 'At least one line required' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const { rows: [po] } = await client.query(
            `SELECT * FROM purchase_orders WHERE id = $1 FOR UPDATE`, [purchase_order_id]
        );
        if (!po) throw Object.assign(new Error('PO not found'), { status: 404 });
        if (!['sent','partially_received'].includes(po.status))
            throw Object.assign(new Error(`Cannot receive against PO in status "${po.status}"`), { status: 400 });

        const number = await nextDocNumber(client, 'purchase_receipts', 'number', 'RCV');

        const { rows: [rcv] } = await client.query(
            `INSERT INTO purchase_receipts
                (number, purchase_order_id, warehouse_id, receipt_date, vendor_ref, notes, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
            [number, purchase_order_id, po.warehouse_id,
             receipt_date || new Date().toISOString().slice(0,10),
             vendor_ref || null, notes || null, created_by || null]
        );

        for (const line of lines) {
            const { purchase_order_line_id, qty_received, actual_cost } = line;
            const { rows: [pol] } = await client.query(
                `SELECT * FROM purchase_order_lines WHERE id = $1`, [purchase_order_line_id]
            );
            if (!pol) throw new Error(`PO line ${purchase_order_line_id} not found`);
            if (parseFloat(qty_received) > parseFloat(pol.qty_remaining))
                throw new Error(`Cannot receive ${qty_received} — only ${pol.qty_remaining} remaining on line ${pol.line_number}`);

            await client.query(
                `INSERT INTO purchase_receipt_lines
                    (receipt_id, purchase_order_line_id, item_id, qty_received, actual_cost)
                 VALUES ($1,$2,$3,$4,$5)`,
                [rcv.id, purchase_order_line_id, pol.item_id,
                 qty_received, actual_cost != null ? actual_cost : pol.unit_cost]
            );
        }

        await client.query('COMMIT');
        res.status(201).json(rcv);
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(err.status || 400).json({ error: err.message });
    } finally { client.release(); }
});

router.post('/receipts/:id/post', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const { rows: [rcv] } = await client.query(
            `SELECT * FROM purchase_receipts WHERE id = $1 FOR UPDATE`, [req.params.id]
        );
        if (!rcv) throw Object.assign(new Error('Receipt not found'), { status: 404 });
        if (rcv.status !== 'draft')
            throw Object.assign(new Error(`Receipt already ${rcv.status}`), { status: 400 });

        const { rows: lines } = await client.query(
            `SELECT prl.*, pol.unit_cost AS po_unit_cost
             FROM purchase_receipt_lines prl
             JOIN purchase_order_lines pol ON pol.id = prl.purchase_order_line_id
             WHERE prl.receipt_id = $1`, [rcv.id]
        );
        if (!lines.length) throw Object.assign(new Error('No lines to post'), { status: 400 });

        const { rows: [po] } = await client.query(
            `SELECT * FROM purchase_orders WHERE id = $1 FOR UPDATE`, [rcv.purchase_order_id]
        );

        for (const line of lines) {
            await client.query(
                `INSERT INTO stock_ledger
                    (item_id, warehouse_id, transaction_type, reference_type, reference_id,
                     qty, cost_per_unit, notes, posting_date, created_by)
                 VALUES ($1,$2,'receipt','purchase_receipt',$3,$4,$5,$6,$7,$8)`,
                [
                    line.item_id, rcv.warehouse_id, rcv.id,
                    parseFloat(line.qty_received),
                    parseFloat(line.actual_cost),
                    `${rcv.number} — PO ${po.number}`,
                    rcv.receipt_date,
                    req.body.posted_by || null
                ]
            );

            await client.query(
                `UPDATE purchase_order_lines
                 SET qty_received = qty_received + $1,
                     status = CASE
                         WHEN qty_received + $1 >= qty_ordered THEN 'received'
                         WHEN qty_received + $1 > 0             THEN 'partial'
                         ELSE status END
                 WHERE id = $2`,
                [line.qty_received, line.purchase_order_line_id]
            );

            // Weighted average cost update
            const { rows: [itemData] } = await client.query(
                `SELECT i.cost_method, i.standard_cost,
                        COALESCE(SUM(sl.qty),0) AS current_qty
                 FROM items i
                 LEFT JOIN stock_ledger sl ON sl.item_id = i.id
                 WHERE i.id = $1
                 GROUP BY i.id, i.cost_method, i.standard_cost`, [line.item_id]
            );

            if (itemData && itemData.cost_method === 'avg') {
                const prevQty  = Math.max(0, parseFloat(itemData.current_qty) - parseFloat(line.qty_received));
                const prevCost = parseFloat(itemData.standard_cost);
                const rcvQty   = parseFloat(line.qty_received);
                const rcvCost  = parseFloat(line.actual_cost);
                const totalQty = prevQty + rcvQty;
                const newAvgCost = totalQty > 0
                    ? ((prevQty * prevCost) + (rcvQty * rcvCost)) / totalQty
                    : rcvCost;
                await client.query(
                    `UPDATE items SET standard_cost = $1, updated_at = NOW() WHERE id = $2`,
                    [parseFloat(newAvgCost.toFixed(4)), line.item_id]
                );
            }
        }

        const { rows: [poLines] } = await client.query(
            `SELECT
                COUNT(*) FILTER (WHERE status='received')  AS received,
                COUNT(*) FILTER (WHERE status='cancelled') AS cancelled,
                COUNT(*)                                   AS total
             FROM purchase_order_lines WHERE purchase_order_id = $1`, [po.id]
        );
        const allDone = parseInt(poLines.received) + parseInt(poLines.cancelled)
                      === parseInt(poLines.total);
        const newPOStatus = allDone ? 'fully_received' : 'partially_received';

        await client.query(
            `UPDATE purchase_orders SET status=$1, updated_at=NOW() WHERE id=$2`,
            [newPOStatus, po.id]
        );

        await client.query(
            `UPDATE purchase_receipts SET status='posted' WHERE id=$1`, [rcv.id]
        );

        await checkBackordersForAllItems(client, lines.map(l => l.item_id));

        await client.query(
            `INSERT INTO audit_log (action, table_name, record_id, new_values)
             VALUES ('post_receipt','purchase_receipts',$1,$2)`,
            [rcv.id, JSON.stringify({ receipt: rcv.number, po: po.number })]
        );

        await client.query('COMMIT');
        res.json({ receipt: rcv, po_status: newPOStatus });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(err.status || 500).json({ error: err.message });
    } finally { client.release(); }
});

// ── Vendor Invoices ───────────────────────────────────────────────────────────

router.get('/vendor-invoices', async (req, res) => {
    const { status } = req.query;
    try {
        const cond   = status ? `AND vi.status = $1` : '';
        const params = status ? [status] : [];
        const { rows } = await query(
            `SELECT vi.*, p.code AS vendor_code, p.name AS vendor_name,
                    po.number AS po_number
             FROM   vendor_invoices vi
             JOIN   parties p ON p.id = vi.vendor_id
             LEFT JOIN purchase_orders po ON po.id = vi.purchase_order_id
             WHERE 1=1 ${cond}
             ORDER  BY vi.invoice_date DESC`, params
        );
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/vendor-invoices/:id', async (req, res) => {
    try {
        const { rows: [inv] } = await query(
            `SELECT vi.*, p.code AS vendor_code, p.name AS vendor_name,
                    po.number AS po_number, rcv.number AS receipt_number
             FROM   vendor_invoices vi
             JOIN   parties p ON p.id = vi.vendor_id
             LEFT JOIN purchase_orders po ON po.id = vi.purchase_order_id
             LEFT JOIN purchase_receipts rcv ON rcv.id = vi.receipt_id
             WHERE  vi.id = $1`, [req.params.id]
        );
        if (!inv) return res.status(404).json({ error: 'Vendor invoice not found' });
        const { rows: payments } = await query(
            `SELECT pd.*, pm.payment_date, pm.method, pm.reference_number
             FROM payment_disbursements pd
             JOIN payments_made pm ON pm.id = pd.payment_id
             WHERE pd.vendor_invoice_id = $1
             ORDER BY pm.payment_date`, [req.params.id]
        );
        res.json({ ...inv, payments });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/vendor-invoices', async (req, res) => {
    const { vendor_id, purchase_order_id, receipt_id, invoice_date,
            subtotal, tax_amount = 0, notes, vendor_invoice_number } = req.body;
    if (!vendor_id || !subtotal) return res.status(400).json({ error: 'vendor_id and subtotal required' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const { rows: [vendor] } = await client.query(
            `SELECT payment_terms_days FROM parties WHERE id = $1`, [vendor_id]
        );
        const terms   = vendor ? vendor.payment_terms_days : 30;
        const invDate = invoice_date ? new Date(invoice_date) : new Date();
        const dueDate = new Date(invDate);
        dueDate.setDate(dueDate.getDate() + terms);

        const number = await nextDocNumber(client, 'vendor_invoices', 'number', 'VINV');
        const total  = parseFloat(subtotal) + parseFloat(tax_amount);

        const { rows: [inv] } = await client.query(
            `INSERT INTO vendor_invoices
                (number, vendor_id, purchase_order_id, receipt_id,
                 invoice_date, due_date, subtotal, tax_amount, total,
                 vendor_invoice_number, notes)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
            [number, vendor_id, purchase_order_id || null, receipt_id || null,
             invDate.toISOString().slice(0,10), dueDate.toISOString().slice(0,10),
             subtotal, tax_amount, total.toFixed(4),
             vendor_invoice_number || null, notes || null]
        );

        await client.query('COMMIT');
        res.status(201).json(inv);
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: err.message });
    } finally { client.release(); }
});

router.post('/vendor-invoices/:id/match', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const { rows: [inv] } = await client.query(
            `SELECT * FROM vendor_invoices WHERE id = $1 FOR UPDATE`, [req.params.id]
        );
        if (!inv) throw Object.assign(new Error('Invoice not found'), { status: 404 });

        let matchStatus = 'matched';
        const notes    = [];

        if (inv.po_id) {
            const { rows: [poTotals] } = await client.query(
                `SELECT COALESCE(SUM(line_total), 0) AS po_total
                 FROM purchase_order_lines WHERE purchase_order_id = $1`, [inv.po_id]
            );
            const poTotal  = parseFloat(poTotals.po_total);
            const invTotal = parseFloat(inv.total);
            const variance = Math.abs(invTotal - poTotal) / (poTotal || 1);

            if (variance > 0.01) {
                matchStatus = 'disputed';
                notes.push(`Price mismatch: invoice total ${invTotal.toFixed(2)} vs PO total ${poTotal.toFixed(2)} (${(variance*100).toFixed(2)}% variance, exceeds 1%)`);
            } else {
                notes.push(`PO price match: OK (variance ${(variance*100).toFixed(2)}%)`);
            }
        } else {
            notes.push('No PO linked — PO match skipped');
        }

        if (inv.receipt_id) {
            const { rows: [rcvTotals] } = await client.query(
                `SELECT COALESCE(SUM(qty_received * actual_cost), 0) AS rcv_total
                 FROM purchase_receipt_lines WHERE receipt_id = $1`, [inv.receipt_id]
            );
            const rcvTotal = parseFloat(rcvTotals.rcv_total);
            const invTotal = parseFloat(inv.total);
            if (Math.abs(invTotal - rcvTotal) > 0.01) {
                matchStatus = 'disputed';
                notes.push(`Receipt qty mismatch: invoice ${invTotal.toFixed(2)} vs receipt ${rcvTotal.toFixed(2)}`);
            } else {
                notes.push('Receipt qty match: OK');
            }
        } else {
            notes.push('No receipt linked — qty match skipped');
        }

        const newStatus = matchStatus === 'matched' ? 'approved' : 'disputed';
        const { rows: [updated] } = await client.query(
            `UPDATE vendor_invoices SET match_status=$1, status=$2,
                    three_way_match_notes=$3, updated_at=NOW()
             WHERE id=$4 RETURNING *`,
            [matchStatus, newStatus, notes.join(' | '), inv.id]
        );

        await client.query('COMMIT');
        res.json(updated);
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(err.status || 500).json({ error: err.message });
    } finally { client.release(); }
});

router.post('/vendor-invoices/:id/approve', async (req, res) => {
    try {
        const { rows } = await query(
            `UPDATE vendor_invoices
             SET status='approved', match_status='approved', updated_at=NOW()
             WHERE id=$1 AND status IN ('pending','disputed') RETURNING *`,
            [req.params.id]
        );
        if (!rows.length) return res.status(400).json({ error: 'Invoice not found or cannot approve' });
        res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/vendor-invoices/:id/void', async (req, res) => {
    try {
        const { rows } = await query(
            `UPDATE vendor_invoices
             SET status='void', updated_at=NOW()
             WHERE id=$1 AND status NOT IN ('paid','void') RETURNING *`,
            [req.params.id]
        );
        if (!rows.length) return res.status(400).json({ error: 'Invoice not found or already paid/void' });
        res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── AP Payments ───────────────────────────────────────────────────────────────

router.post('/vendor-payments', async (req, res) => {
    const { vendor_id, payment_date, amount, method = 'check',
            reference_number, notes, applications = [] } = req.body;
    if (!vendor_id || !amount) return res.status(400).json({ error: 'vendor_id and amount required' });

    const totalApplied = applications.reduce((s, a) => s + parseFloat(a.amount_applied || 0), 0);
    if (totalApplied > parseFloat(amount))
        return res.status(400).json({ error: 'Total applied exceeds payment amount' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const { rows: [pmt] } = await client.query(
            `INSERT INTO payments_made
                (vendor_id, payment_date, amount, method, reference_number, notes)
             VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
            [vendor_id, payment_date || new Date().toISOString().slice(0,10),
             amount, method, reference_number || null, notes || null]
        );

        for (const app of applications) {
            await client.query(
                `INSERT INTO payment_disbursements (payment_id, vendor_invoice_id, amount_applied)
                 VALUES ($1,$2,$3)`,
                [pmt.id, app.vendor_invoice_id, app.amount_applied]
            );

            const { rows: [totals] } = await client.query(
                `SELECT vi.total, COALESCE(SUM(pd.amount_applied),0) AS paid_total
                 FROM vendor_invoices vi
                 JOIN payment_disbursements pd ON pd.vendor_invoice_id = vi.id
                 WHERE vi.id = $1
                 GROUP BY vi.total`, [app.vendor_invoice_id]
            );

            if (totals) {
                const paidTotal = parseFloat(totals.paid_total);
                const invTotal  = parseFloat(totals.total);
                const newStatus = paidTotal >= invTotal ? 'paid' : 'approved';
                await client.query(
                    `UPDATE vendor_invoices SET amount_paid=$1, status=$2, updated_at=NOW()
                     WHERE id=$3`,
                    [paidTotal, newStatus, app.vendor_invoice_id]
                );
            }
        }

        await client.query('COMMIT');
        res.status(201).json(pmt);
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: err.message });
    } finally { client.release(); }
});

// ── AP Aging ──────────────────────────────────────────────────────────────────

router.get('/ap-aging', async (_req, res) => {
    try {
        const { rows } = await query(`SELECT * FROM v_ap_aging ORDER BY total_due DESC`);
        const { rows: [totals] } = await query(
            `SELECT COALESCE(SUM(current_due),0) AS current_due,
                    COALESCE(SUM(days_1_30),0)   AS days_1_30,
                    COALESCE(SUM(days_31_60),0)  AS days_31_60,
                    COALESCE(SUM(days_61_90),0)  AS days_61_90,
                    COALESCE(SUM(days_90plus),0) AS days_90plus,
                    COALESCE(SUM(total_due),0)   AS total_due
             FROM v_ap_aging`
        );
        res.json({ vendors: rows, totals });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Reorder Suggestions ───────────────────────────────────────────────────────

router.get('/reorder-suggestions', async (_req, res) => {
    try {
        const { rows } = await query(
            `SELECT * FROM v_reorder_suggestions ORDER BY effective_qty - reorder_point ASC`
        );
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/reorder-suggestions/generate-pos', async (req, res) => {
    const { warehouse_id, created_by } = req.body;
    if (!warehouse_id) return res.status(400).json({ error: 'warehouse_id required' });

    const { rows: suggestions } = await query(
        `SELECT * FROM v_reorder_suggestions WHERE suggested_order_qty > 0`
    );
    if (!suggestions.length) return res.json({ pos_created: 0, message: 'No items need reordering' });

    const byVendor = {};
    for (const s of suggestions) {
        const vendorKey = s.preferred_vendor_id || `no-vendor-${s.item_id}`;
        if (!byVendor[vendorKey]) {
            byVendor[vendorKey] = { vendor_id: s.preferred_vendor_id, items: [] };
        }
        byVendor[vendorKey].items.push(s);
    }

    const client = await pool.connect();
    const createdPOs = [];
    try {
        await client.query('BEGIN');

        for (const [, group] of Object.entries(byVendor)) {
            if (!group.vendor_id) continue;

            const number = await nextDocNumber(client, 'purchase_orders', 'number', 'PO');
            const { rows: [po] } = await client.query(
                `INSERT INTO purchase_orders
                    (number, vendor_id, warehouse_id, notes, created_by)
                 VALUES ($1,$2,$3,$4,$5) RETURNING *`,
                [number, group.vendor_id, warehouse_id,
                 'Auto-generated from reorder suggestions', created_by || null]
            );

            for (let idx = 0; idx < group.items.length; idx++) {
                const s = group.items[idx];
                await client.query(
                    `INSERT INTO purchase_order_lines
                        (purchase_order_id, line_number, item_id, qty_ordered, unit_cost)
                     VALUES ($1,$2,$3,$4,$5)`,
                    [po.id, idx + 1, s.item_id, s.suggested_order_qty, s.standard_cost]
                );
            }

            createdPOs.push({ po_number: number, vendor: group.items[0].preferred_vendor_name,
                              line_count: group.items.length });
        }

        await client.query('COMMIT');
        res.status(201).json({ pos_created: createdPOs.length, purchase_orders: createdPOs });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally { client.release(); }
});

module.exports = router;
