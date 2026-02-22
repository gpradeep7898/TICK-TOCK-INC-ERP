'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const { Pool } = require('pg');

// ─── DB Pool ─────────────────────────────────────────────────────────────────
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

pool.on('error', (err) => {
    console.error('Unexpected DB error:', err.message);
});

// ─── App ──────────────────────────────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Serve frontend
const WEB_DIR = path.join(__dirname, '..', '..', 'web');
app.use(express.static(WEB_DIR));
app.get('/', (_req, res) => res.sendFile(path.join(WEB_DIR, 'inventory.html')));
app.get('/sales', (_req, res) => res.sendFile(path.join(WEB_DIR, 'sales.html')));

// Simple request logger
app.use((req, _res, next) => {
    console.log(`${new Date().toISOString()}  ${req.method}  ${req.path}`);
    next();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
const query = (text, params) => pool.query(text, params);

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

// ─── Routes ───────────────────────────────────────────────────────────────────

// Health
app.get('/health', async (_req, res) => {
    try {
        await query('SELECT 1');
        res.json({ status: 'ok', db: 'connected', ts: new Date().toISOString() });
    } catch (err) {
        res.status(503).json({ status: 'error', message: err.message });
    }
});

// ── Items ──────────────────────────────────────────────────────────────────────

app.get('/api/items', async (_req, res) => {
    try {
        const { rows } = await query(
            `SELECT * FROM items ORDER BY category, code`
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/items/:id', async (req, res) => {
    try {
        const { rows } = await query(
            `SELECT * FROM items WHERE id = $1`,
            [req.params.id]
        );
        if (!rows.length) return res.status(404).json({ error: 'Item not found' });
        res.json(rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/items', async (req, res) => {
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

app.patch('/api/items/:id', async (req, res) => {
    const allowed = ['name','description','unit_of_measure','cost_method',
                     'standard_cost','sale_price','reorder_point','reorder_qty',
                     'lead_time_days','category','is_active'];
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
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Warehouses ─────────────────────────────────────────────────────────────────

app.get('/api/warehouses', async (_req, res) => {
    try {
        const { rows } = await query(`SELECT * FROM warehouses WHERE is_active = true ORDER BY code`);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Stock ──────────────────────────────────────────────────────────────────────

// All stock availability (all items × warehouses that have ledger entries)
app.get('/api/stock', async (_req, res) => {
    try {
        const { rows } = await query(
            `SELECT * FROM v_stock_availability ORDER BY category, item_code, warehouse_code`
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Dashboard summary
app.get('/api/stock/dashboard', async (_req, res) => {
    try {
        const [items, stock, alerts, warehouses] = await Promise.all([
            query(`SELECT COUNT(*) AS cnt FROM items WHERE is_active = true`),
            query(`SELECT COALESCE(SUM(total_cost_value),0) AS total_value FROM v_stock_on_hand`),
            query(`SELECT COUNT(*) AS cnt FROM v_reorder_alerts`),
            query(`SELECT COUNT(*) AS cnt FROM warehouses WHERE is_active = true`)
        ]);
        res.json({
            total_items:        parseInt(items.rows[0].cnt, 10),
            total_value:        parseFloat(stock.rows[0].total_value),
            reorder_alert_count: parseInt(alerts.rows[0].cnt, 10),
            warehouse_count:    parseInt(warehouses.rows[0].cnt, 10)
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Reorder alerts
app.get('/api/stock/reorder-alerts', async (_req, res) => {
    try {
        const { rows } = await query(
            `SELECT * FROM v_reorder_alerts ORDER BY category, item_code`
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Availability for a single item (all warehouses)
app.get('/api/stock/:itemId/availability', async (req, res) => {
    try {
        const { rows } = await query(
            `SELECT * FROM v_stock_availability WHERE item_id = $1 ORDER BY warehouse_code`,
            [req.params.itemId]
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Movement history for a single item
app.get('/api/stock/:itemId/history', async (req, res) => {
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
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Adjustments ────────────────────────────────────────────────────────────────

app.get('/api/adjustments', async (_req, res) => {
    try {
        const { rows } = await query(
            `SELECT sa.*, w.code AS warehouse_code, w.name AS warehouse_name,
                    u.name AS created_by_name,
                    (SELECT COUNT(*) FROM stock_adjustment_lines sal WHERE sal.adjustment_id = sa.id) AS line_count
             FROM   stock_adjustments sa
             JOIN   warehouses w ON w.id = sa.warehouse_id
             LEFT JOIN users u ON u.id = sa.created_by
             ORDER  BY sa.created_at DESC`
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/adjustments', async (req, res) => {
    const { warehouse_id, adjustment_date, reason, notes, lines = [], created_by } = req.body;

    if (!warehouse_id) return res.status(400).json({ error: 'warehouse_id is required' });
    if (!Array.isArray(lines) || lines.length === 0)
        return res.status(400).json({ error: 'At least one line is required' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const number = await nextAdjNumber(client);

        // Insert header
        const { rows: [adj] } = await client.query(
            `INSERT INTO stock_adjustments
                (number, warehouse_id, adjustment_date, reason, notes, created_by)
             VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
            [number, warehouse_id, adjustment_date || new Date().toISOString().slice(0,10),
             reason, notes, created_by || null]
        );

        // Insert lines (fetch system qty from view)
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

// Post an adjustment → inserts into stock_ledger (append-only)
app.post('/api/adjustments/:id/post', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Lock the adjustment row
        const { rows: [adj] } = await client.query(
            `SELECT * FROM stock_adjustments WHERE id = $1 FOR UPDATE`,
            [req.params.id]
        );
        if (!adj)           throw Object.assign(new Error('Adjustment not found'), { status: 404 });
        if (adj.status !== 'draft')
            throw Object.assign(new Error(`Adjustment is already ${adj.status}`), { status: 400 });

        // Fetch lines
        const { rows: lines } = await client.query(
            `SELECT * FROM stock_adjustment_lines WHERE adjustment_id = $1`,
            [adj.id]
        );
        if (!lines.length)  throw Object.assign(new Error('No lines to post'), { status: 400 });

        // Insert one stock_ledger row per line that has a non-zero difference
        for (const line of lines) {
            const diff = parseFloat(line.qty_difference);
            if (diff === 0) continue;   // no change — skip

            await client.query(
                `INSERT INTO stock_ledger
                    (item_id, warehouse_id, transaction_type, reference_type,
                     reference_id, qty, cost_per_unit, notes, posting_date, created_by)
                 VALUES ($1,$2,'adjustment','stock_adjustment',$3,$4,$5,$6,$7,$8)`,
                [
                    line.item_id, adj.warehouse_id, adj.id,
                    diff,           // positive if actual > system, negative if less
                    line.cost_per_unit,
                    `Stock adjustment ${adj.number}`,
                    adj.adjustment_date,
                    req.body.posted_by || null
                ]
            );
        }

        // Mark as posted
        const { rows: [updated] } = await client.query(
            `UPDATE stock_adjustments
             SET status = 'posted', posted_at = NOW()
             WHERE id = $1 RETURNING *`,
            [adj.id]
        );

        await client.query('COMMIT');
        res.json(updated);
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(err.status || 500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// ════════════════════════════════════════════════════════════════════════════
// SALES ORDER MODULE
// ════════════════════════════════════════════════════════════════════════════

// ── Number generators ─────────────────────────────────────────────────────────
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

// ── Customers (parties) ───────────────────────────────────────────────────────

app.get('/api/customers', async (_req, res) => {
    try {
        const { rows } = await query(
            `SELECT p.*,
                    COALESCE(ar.total_due,0) AS ar_balance
             FROM   parties p
             LEFT JOIN v_ar_aging ar ON ar.customer_id = p.id
             WHERE  p.type IN ('customer','both')
             ORDER  BY p.name`
        );
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/customers/:id', async (req, res) => {
    try {
        const { rows: [cust] } = await query(
            `SELECT p.*, COALESCE(ar.total_due,0) AS ar_balance,
                    ar.current_due, ar.days_1_30, ar.days_31_60, ar.days_61_90, ar.days_90plus
             FROM   parties p
             LEFT JOIN v_ar_aging ar ON ar.customer_id = p.id
             WHERE  p.id = $1`, [req.params.id]
        );
        if (!cust) return res.status(404).json({ error: 'Customer not found' });

        const { rows: openInvoices } = await query(
            `SELECT * FROM sales_invoices
             WHERE customer_id = $1 AND status NOT IN ('paid','void')
             ORDER BY due_date`, [req.params.id]
        );
        const { rows: recentOrders } = await query(
            `SELECT * FROM v_open_sales_orders WHERE customer_id = $1
             ORDER BY created_at DESC LIMIT 10`, [req.params.id]
        );
        res.json({ ...cust, open_invoices: openInvoices, recent_orders: recentOrders });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/customers', async (req, res) => {
    const { code, name, email, phone, billing_address, shipping_address,
            payment_terms_days = 30, credit_limit = 0, currency = 'USD', notes } = req.body;
    if (!code || !name) return res.status(400).json({ error: 'code and name are required' });
    try {
        const { rows } = await query(
            `INSERT INTO parties (type,code,name,email,phone,billing_address,shipping_address,
                                  payment_terms_days,credit_limit,currency,notes)
             VALUES ('customer',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
            [code, name, email, phone,
             billing_address ? JSON.stringify(billing_address) : null,
             shipping_address ? JSON.stringify(shipping_address) : null,
             payment_terms_days, credit_limit, currency, notes]
        );
        res.status(201).json(rows[0]);
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: 'Customer code already exists' });
        res.status(500).json({ error: err.message });
    }
});

app.patch('/api/customers/:id', async (req, res) => {
    const allowed = ['name','email','phone','billing_address','shipping_address',
                     'payment_terms_days','credit_limit','currency','notes','is_active'];
    const fields  = Object.keys(req.body).filter(k => allowed.includes(k));
    if (!fields.length) return res.status(400).json({ error: 'No valid fields' });
    const sets   = fields.map((f, i) => `${f} = $${i + 2}`).join(', ');
    const values = fields.map(f => {
        const v = req.body[f];
        return (f === 'billing_address' || f === 'shipping_address') && typeof v === 'object'
            ? JSON.stringify(v) : v;
    });
    try {
        const { rows } = await query(
            `UPDATE parties SET ${sets}, updated_at = NOW() WHERE id = $1 RETURNING *`,
            [req.params.id, ...values]
        );
        if (!rows.length) return res.status(404).json({ error: 'Customer not found' });
        res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Pricing Engine ────────────────────────────────────────────────────────────
// GET /api/pricing/resolve?customerId=X&itemId=Y&qty=Z&date=D
app.get('/api/pricing/resolve', async (req, res) => {
    const { customerId, itemId, qty = 1, date } = req.query;
    if (!itemId) return res.status(400).json({ error: 'itemId required' });
    const checkDate = date || new Date().toISOString().slice(0, 10);
    try {
        // Check customer-specific price lists by priority
        if (customerId) {
            const { rows } = await query(
                `SELECT pli.price
                 FROM   customer_price_lists cpl
                 JOIN   price_list_items pli ON pli.price_list_id = cpl.price_list_id
                 JOIN   price_lists pl       ON pl.id = cpl.price_list_id
                 WHERE  cpl.customer_id = $1
                   AND  pli.item_id = $2
                   AND  pli.min_qty <= $3
                   AND  (pli.valid_from IS NULL OR pli.valid_from <= $4)
                   AND  (pli.valid_to   IS NULL OR pli.valid_to   >= $4)
                   AND  (pl.valid_from  IS NULL OR pl.valid_from  <= $4)
                   AND  (pl.valid_to    IS NULL OR pl.valid_to    >= $4)
                 ORDER  BY cpl.priority ASC, pli.min_qty DESC
                 LIMIT  1`,
                [customerId, itemId, qty, checkDate]
            );
            if (rows.length) return res.json({ price: rows[0].price, source: 'price_list' });
        }
        // Fall back to items.sale_price
        const { rows: [item] } = await query(
            `SELECT sale_price AS price FROM items WHERE id = $1`, [itemId]
        );
        res.json({ price: item ? item.price : 0, source: 'catalog' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Sales Orders ──────────────────────────────────────────────────────────────

app.get('/api/sales-orders/dashboard', async (_req, res) => {
    try {
        const { rows: [stats] } = await query(
            `SELECT
                COUNT(*) FILTER (WHERE status NOT IN ('cancelled'))                  AS total_orders,
                COUNT(*) FILTER (WHERE status IN ('confirmed','partially_shipped'))  AS open_orders,
                COUNT(*) FILTER (WHERE status IN ('fully_shipped','invoiced'))       AS shipped_orders,
                COALESCE(SUM(total) FILTER (
                    WHERE status NOT IN ('draft','cancelled')
                    AND DATE_TRUNC('month',order_date)=DATE_TRUNC('month',CURRENT_DATE)),0) AS revenue_mtd,
                COALESCE(SUM(total) FILTER (WHERE status NOT IN ('draft','cancelled')),0) AS revenue_total
             FROM sales_orders`
        );
        const { rows: recentOrders } = await query(
            `SELECT * FROM v_open_sales_orders ORDER BY created_at DESC LIMIT 5`
        );
        res.json({ ...stats, recent_orders: recentOrders });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/sales-orders', async (req, res) => {
    const { status } = req.query;
    try {
        const cond = status ? `WHERE status = $1` : '';
        const params = status ? [status] : [];
        const { rows } = await query(
            `SELECT so.id, so.number, so.status, so.order_date, so.requested_ship_date,
                    so.subtotal, so.tax_amount, so.total, so.created_at, so.notes,
                    p.code AS customer_code, p.name AS customer_name,
                    w.code AS warehouse_code,
                    (SELECT COUNT(*) FROM sales_order_lines sol WHERE sol.sales_order_id = so.id) AS line_count
             FROM   sales_orders so
             JOIN   parties p ON p.id = so.customer_id
             JOIN   warehouses w ON w.id = so.warehouse_id
             ${cond}
             ORDER  BY so.created_at DESC`,
            params
        );
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/sales-orders/:id', async (req, res) => {
    try {
        const { rows: [order] } = await query(
            `SELECT so.*, p.code AS customer_code, p.name AS customer_name,
                    p.email AS customer_email, p.phone AS customer_phone,
                    p.billing_address, p.shipping_address, p.payment_terms_days,
                    w.code AS warehouse_code
             FROM   sales_orders so
             JOIN   parties p ON p.id = so.customer_id
             JOIN   warehouses w ON w.id = so.warehouse_id
             WHERE  so.id = $1`, [req.params.id]
        );
        if (!order) return res.status(404).json({ error: 'Order not found' });

        const { rows: lines } = await query(
            `SELECT sol.*, i.code AS item_code, i.name AS item_name,
                    i.unit_of_measure, i.category,
                    COALESCE(av.qty_available,0) AS stock_available
             FROM   sales_order_lines sol
             JOIN   items i ON i.id = sol.item_id
             LEFT JOIN v_stock_availability av
                    ON av.item_id = sol.item_id AND av.warehouse_id = $2
             WHERE  sol.sales_order_id = $1
             ORDER  BY sol.line_number`,
            [req.params.id, order.warehouse_id]
        );

        const { rows: shipsData } = await query(
            `SELECT s.*, u.name AS created_by_name
             FROM   shipments s
             LEFT JOIN users u ON u.id = s.created_by
             WHERE  s.sales_order_id = $1
             ORDER  BY s.created_at DESC`,
            [req.params.id]
        );

        const { rows: invoices } = await query(
            `SELECT * FROM sales_invoices WHERE sales_order_id = $1`, [req.params.id]
        );

        res.json({ ...order, lines, shipments: shipsData, invoices });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/sales-orders', async (req, res) => {
    const { customer_id, warehouse_id, price_list_id, order_date, requested_ship_date,
            tax_rate = 0, notes, lines = [], created_by } = req.body;
    if (!customer_id || !warehouse_id) return res.status(400).json({ error: 'customer_id and warehouse_id required' });
    if (!lines.length) return res.status(400).json({ error: 'At least one line required' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const number = await nextDocNumber(client, 'sales_orders', 'number', 'SO');

        const { rows: [order] } = await client.query(
            `INSERT INTO sales_orders
                (number, customer_id, warehouse_id, price_list_id, order_date,
                 requested_ship_date, tax_rate, notes, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
            [number, customer_id, warehouse_id, price_list_id || null,
             order_date || new Date().toISOString().slice(0, 10),
             requested_ship_date || null, tax_rate, notes || null, created_by || null]
        );

        let subtotal = 0;
        for (let idx = 0; idx < lines.length; idx++) {
            const { item_id, qty_ordered, unit_price, discount_pct = 0, description, notes: ln } = lines[idx];
            if (!item_id || !qty_ordered) throw new Error('Each line requires item_id and qty_ordered');

            let price = unit_price;
            if (price == null) {
                const { rows: [item] } = await client.query(
                    `SELECT sale_price FROM items WHERE id = $1`, [item_id]
                );
                price = item ? parseFloat(item.sale_price) : 0;
            }

            const { rows: [sol] } = await client.query(
                `INSERT INTO sales_order_lines
                    (sales_order_id, line_number, item_id, description,
                     qty_ordered, unit_price, discount_pct)
                 VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
                [order.id, idx + 1, item_id, description || null,
                 qty_ordered, price, discount_pct]
            );
            subtotal += parseFloat(sol.line_total);
        }

        await client.query(
            `UPDATE sales_orders SET subtotal = $1, updated_at = NOW() WHERE id = $2`,
            [subtotal, order.id]
        );

        await client.query('COMMIT');
        const { rows: [full] } = await query(
            `SELECT so.*, p.name AS customer_name, p.code AS customer_code, w.code AS warehouse_code
             FROM sales_orders so JOIN parties p ON p.id=so.customer_id JOIN warehouses w ON w.id=so.warehouse_id
             WHERE so.id = $1`, [order.id]
        );
        res.status(201).json(full);
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: err.message });
    } finally { client.release(); }
});

// ── Confirm → reserve stock ───────────────────────────────────────────────────
app.post('/api/sales-orders/:id/confirm', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows: [order] } = await client.query(
            `SELECT * FROM sales_orders WHERE id = $1 FOR UPDATE`, [req.params.id]
        );
        if (!order)                throw Object.assign(new Error('Order not found'), { status: 404 });
        if (order.status !== 'draft')
            throw Object.assign(new Error(`Order is already ${order.status}`), { status: 400 });

        const { rows: lines } = await client.query(
            `SELECT sol.*, i.code, i.name FROM sales_order_lines sol
             JOIN items i ON i.id = sol.item_id
             WHERE sol.sales_order_id = $1`, [order.id]
        );

        for (const line of lines) {
            const { rows: [avail] } = await client.query(
                `SELECT COALESCE(qty_available,0) AS qty_available FROM v_stock_availability
                 WHERE item_id = $1 AND warehouse_id = $2`,
                [line.item_id, order.warehouse_id]
            );
            const available = avail ? parseFloat(avail.qty_available) : 0;
            if (available < parseFloat(line.qty_ordered)) {
                throw Object.assign(
                    new Error(`Insufficient stock for ${line.code} — need ${line.qty_ordered}, available ${available}`),
                    { status: 400 }
                );
            }
            await client.query(
                `INSERT INTO stock_reservations
                    (item_id, warehouse_id, reference_type, reference_id, qty_reserved, status)
                 VALUES ($1,$2,'sales_order',$3,$4,'active')`,
                [line.item_id, order.warehouse_id, order.id, line.qty_ordered]
            );
        }

        await client.query(
            `UPDATE sales_orders SET status='confirmed', updated_at=NOW() WHERE id=$1`, [order.id]
        );
        await client.query('COMMIT');

        const { rows: [full] } = await query(
            `SELECT so.*, p.name AS customer_name, p.code AS customer_code, w.code AS warehouse_code
             FROM sales_orders so JOIN parties p ON p.id=so.customer_id JOIN warehouses w ON w.id=so.warehouse_id
             WHERE so.id = $1`, [order.id]
        );
        res.json(full);
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(err.status || 500).json({ error: err.message });
    } finally { client.release(); }
});

// ── Cancel order ──────────────────────────────────────────────────────────────
app.post('/api/sales-orders/:id/cancel', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows: [order] } = await client.query(
            `SELECT * FROM sales_orders WHERE id = $1 FOR UPDATE`, [req.params.id]
        );
        if (!order) throw Object.assign(new Error('Order not found'), { status: 404 });
        if (['fully_shipped','invoiced','closed','cancelled'].includes(order.status))
            throw Object.assign(new Error(`Cannot cancel a ${order.status} order`), { status: 400 });

        await client.query(
            `UPDATE stock_reservations SET status='cancelled', updated_at=NOW()
             WHERE reference_type='sales_order' AND reference_id=$1 AND status='active'`,
            [order.id]
        );
        await client.query(
            `UPDATE sales_orders SET status='cancelled', updated_at=NOW() WHERE id=$1`, [order.id]
        );
        await client.query('COMMIT');

        const { rows: [full] } = await query(
            `SELECT so.*, p.name AS customer_name, w.code AS warehouse_code
             FROM sales_orders so JOIN parties p ON p.id=so.customer_id JOIN warehouses w ON w.id=so.warehouse_id
             WHERE so.id=$1`, [order.id]
        );
        res.json(full);
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(err.status || 500).json({ error: err.message });
    } finally { client.release(); }
});

// ── Shipments ─────────────────────────────────────────────────────────────────

app.get('/api/shipments', async (_req, res) => {
    try {
        const { rows } = await query(
            `SELECT s.*, so.number AS order_number, p.name AS customer_name,
                    w.code AS warehouse_code
             FROM   shipments s
             JOIN   sales_orders so ON so.id = s.sales_order_id
             JOIN   parties p ON p.id = so.customer_id
             JOIN   warehouses w ON w.id = s.warehouse_id
             ORDER  BY s.created_at DESC`
        );
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/shipments/:id', async (req, res) => {
    try {
        const { rows: [shp] } = await query(
            `SELECT s.*, so.number AS order_number, p.name AS customer_name
             FROM shipments s
             JOIN sales_orders so ON so.id = s.sales_order_id
             JOIN parties p ON p.id = so.customer_id
             WHERE s.id = $1`, [req.params.id]
        );
        if (!shp) return res.status(404).json({ error: 'Shipment not found' });
        const { rows: lines } = await query(
            `SELECT sl.*, i.code AS item_code, i.name AS item_name
             FROM shipment_lines sl JOIN items i ON i.id = sl.item_id
             WHERE sl.shipment_id = $1`, [req.params.id]
        );
        res.json({ ...shp, lines });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Create shipment (supports partial quantities)
app.post('/api/shipments', async (req, res) => {
    const { sales_order_id, ship_date, carrier, tracking_number, notes, lines = [], created_by } = req.body;
    if (!sales_order_id) return res.status(400).json({ error: 'sales_order_id required' });
    if (!lines.length)   return res.status(400).json({ error: 'At least one line required' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows: [order] } = await client.query(
            `SELECT * FROM sales_orders WHERE id = $1 FOR UPDATE`, [sales_order_id]
        );
        if (!order) throw Object.assign(new Error('Sales order not found'), { status: 404 });
        if (!['confirmed','partially_shipped'].includes(order.status))
            throw Object.assign(new Error(`Cannot ship order in status "${order.status}"`), { status: 400 });

        const number = await nextDocNumber(client, 'shipments', 'number', 'SHP');

        const { rows: [shp] } = await client.query(
            `INSERT INTO shipments (number, sales_order_id, warehouse_id, ship_date, carrier, tracking_number, notes, status, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,'draft',$8) RETURNING *`,
            [number, sales_order_id, order.warehouse_id,
             ship_date || new Date().toISOString().slice(0,10),
             carrier || null, tracking_number || null, notes || null, created_by || null]
        );

        for (const line of lines) {
            const { order_line_id, qty_shipped } = line;
            const { rows: [sol] } = await client.query(
                `SELECT sol.*, i.standard_cost FROM sales_order_lines sol
                 JOIN items i ON i.id = sol.item_id
                 WHERE sol.id = $1`, [order_line_id]
            );
            if (!sol) throw new Error(`Order line ${order_line_id} not found`);
            if (parseFloat(qty_shipped) > parseFloat(sol.qty_backordered))
                throw new Error(`Cannot ship ${qty_shipped} — only ${sol.qty_backordered} remaining for line ${sol.line_number}`);

            await client.query(
                `INSERT INTO shipment_lines (shipment_id, sales_order_line_id, item_id, qty_shipped, cost_per_unit)
                 VALUES ($1,$2,$3,$4,$5)`,
                [shp.id, order_line_id, sol.item_id, qty_shipped, sol.standard_cost]
            );
        }

        await client.query('COMMIT');
        res.status(201).json(shp);
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(err.status || 400).json({ error: err.message });
    } finally { client.release(); }
});

// Post shipment — THE critical transaction
app.post('/api/shipments/:id/post', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const { rows: [shp] } = await client.query(
            `SELECT * FROM shipments WHERE id = $1 FOR UPDATE`, [req.params.id]
        );
        if (!shp) throw Object.assign(new Error('Shipment not found'), { status: 404 });
        if (shp.status !== 'draft')
            throw Object.assign(new Error(`Shipment already ${shp.status}`), { status: 400 });

        const { rows: lines } = await client.query(
            `SELECT sl.*, sol.unit_price, sol.discount_pct, sol.sales_order_id,
                    sol.line_total AS sol_line_total
             FROM shipment_lines sl
             JOIN sales_order_lines sol ON sol.id = sl.sales_order_line_id
             WHERE sl.shipment_id = $1`, [shp.id]
        );
        if (!lines.length) throw Object.assign(new Error('No lines to post'), { status: 400 });

        const { rows: [order] } = await client.query(
            `SELECT * FROM sales_orders WHERE id = $1 FOR UPDATE`, [lines[0].sales_order_id]
        );

        let invoiceSubtotal = 0;

        for (const line of lines) {
            // 1. Stock ledger — outbound
            await client.query(
                `INSERT INTO stock_ledger
                    (item_id, warehouse_id, transaction_type, reference_type, reference_id,
                     qty, cost_per_unit, notes, posting_date, created_by)
                 VALUES ($1,$2,'shipment','shipment',$3,$4,$5,$6,$7,$8)`,
                [
                    line.item_id, shp.warehouse_id, shp.id,
                    -parseFloat(line.qty_shipped),
                    parseFloat(line.cost_per_unit),
                    `${shp.number} — SO ${order.number}`,
                    shp.ship_date,
                    req.body.posted_by || null
                ]
            );

            // 2. Update qty_shipped on order line
            await client.query(
                `UPDATE sales_order_lines
                 SET qty_shipped = qty_shipped + $1,
                     status = CASE
                         WHEN qty_shipped + $1 >= qty_ordered THEN 'fulfilled'
                         WHEN qty_shipped + $1 > 0             THEN 'partial'
                         ELSE status END
                 WHERE id = $2`,
                [line.qty_shipped, line.sales_order_line_id]
            );

            // 3. Fulfil reservation
            await client.query(
                `UPDATE stock_reservations
                 SET status='fulfilled', updated_at=NOW()
                 WHERE item_id=$1 AND warehouse_id=$2
                   AND reference_type='sales_order' AND reference_id=$3 AND status='active'`,
                [line.item_id, shp.warehouse_id, order.id]
            );

            invoiceSubtotal += parseFloat(line.qty_shipped)
                             * parseFloat(line.unit_price)
                             * (1 - parseFloat(line.discount_pct));
        }

        // 4. Update order status
        const { rows: [orderLines] } = await client.query(
            `SELECT
                COUNT(*) FILTER (WHERE status='fulfilled')  AS fulfilled,
                COUNT(*) FILTER (WHERE status='cancelled')  AS cancelled,
                COUNT(*)                                    AS total
             FROM sales_order_lines WHERE sales_order_id = $1`, [order.id]
        );
        const allDone = parseInt(orderLines.fulfilled) + parseInt(orderLines.cancelled)
                      === parseInt(orderLines.total);
        const newOrderStatus = allDone ? 'fully_shipped' : 'partially_shipped';

        await client.query(
            `UPDATE sales_orders SET status=$1, updated_at=NOW() WHERE id=$2`,
            [newOrderStatus, order.id]
        );

        // 5. Mark shipment shipped
        await client.query(
            `UPDATE shipments SET status='shipped' WHERE id=$1`, [shp.id]
        );

        // 6. Auto-generate invoice
        const taxAmount  = invoiceSubtotal * parseFloat(order.tax_rate);
        const invTotal   = invoiceSubtotal + taxAmount;
        const invNumber  = await nextDocNumber(client, 'sales_invoices', 'number', 'INV');
        const { rows: [cust] } = await client.query(
            `SELECT payment_terms_days FROM parties WHERE id = $1`, [order.customer_id]
        );
        const dueDate = new Date(shp.ship_date);
        dueDate.setDate(dueDate.getDate() + (cust ? cust.payment_terms_days : 30));

        const { rows: [invoice] } = await client.query(
            `INSERT INTO sales_invoices
                (number, customer_id, sales_order_id, shipment_id, status,
                 invoice_date, due_date, subtotal, tax_amount, total)
             VALUES ($1,$2,$3,$4,'sent',$5,$6,$7,$8,$9) RETURNING *`,
            [invNumber, order.customer_id, order.id, shp.id,
             shp.ship_date, dueDate.toISOString().slice(0,10),
             invoiceSubtotal.toFixed(4), taxAmount.toFixed(4), invTotal.toFixed(4)]
        );

        // 7. Audit log
        await client.query(
            `INSERT INTO audit_log (action, table_name, record_id, new_values)
             VALUES ('post_shipment','shipments',$1,$2)`,
            [shp.id, JSON.stringify({ shipment: shp.number, order: order.number, invoice: invNumber })]
        );

        // 8. Check backorders — update status of remaining open lines
        await client.query(
            `UPDATE sales_order_lines sol
             SET status = CASE
                 WHEN sol.qty_shipped >= sol.qty_ordered THEN 'fulfilled'
                 WHEN sol.qty_shipped > 0                THEN 'partial'
                 ELSE 'open' END
             FROM sales_orders so
             WHERE sol.sales_order_id = so.id
               AND so.status NOT IN ('closed','cancelled')
               AND sol.status NOT IN ('fulfilled','cancelled')`
        );

        await client.query('COMMIT');
        res.json({ shipment: shp, invoice, order_status: newOrderStatus });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(err.status || 500).json({ error: err.message });
    } finally { client.release(); }
});

// ── Invoices ──────────────────────────────────────────────────────────────────

app.get('/api/invoices', async (_req, res) => {
    try {
        const { rows } = await query(
            `SELECT si.*, p.name AS customer_name, p.code AS customer_code,
                    so.number AS order_number
             FROM   sales_invoices si
             JOIN   parties p ON p.id = si.customer_id
             LEFT JOIN sales_orders so ON so.id = si.sales_order_id
             ORDER  BY si.invoice_date DESC`
        );
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/invoices/:id', async (req, res) => {
    try {
        const { rows: [inv] } = await query(
            `SELECT si.*, p.name AS customer_name, p.code AS customer_code,
                    so.number AS order_number, shp.number AS shipment_number
             FROM   sales_invoices si
             JOIN   parties p ON p.id = si.customer_id
             LEFT JOIN sales_orders so  ON so.id  = si.sales_order_id
             LEFT JOIN shipments shp    ON shp.id = si.shipment_id
             WHERE  si.id = $1`, [req.params.id]
        );
        if (!inv) return res.status(404).json({ error: 'Invoice not found' });
        const { rows: payments } = await query(
            `SELECT pa.*, pr.payment_date, pr.method, pr.reference_number
             FROM payment_applications pa
             JOIN payments_received pr ON pr.id = pa.payment_id
             WHERE pa.invoice_id = $1
             ORDER BY pr.payment_date`, [req.params.id]
        );
        res.json({ ...inv, payments });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/invoices/:id/send', async (req, res) => {
    try {
        const { rows } = await query(
            `UPDATE sales_invoices SET status='sent', updated_at=NOW()
             WHERE id=$1 AND status='draft' RETURNING *`, [req.params.id]
        );
        if (!rows.length) return res.status(400).json({ error: 'Invoice not found or not in draft' });
        res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Payments ──────────────────────────────────────────────────────────────────

app.post('/api/payments', async (req, res) => {
    const { customer_id, payment_date, amount, method = 'check',
            reference_number, notes, applications = [] } = req.body;
    if (!customer_id || !amount) return res.status(400).json({ error: 'customer_id and amount required' });

    const totalApplied = applications.reduce((s, a) => s + parseFloat(a.amount_applied || 0), 0);
    if (totalApplied > parseFloat(amount))
        return res.status(400).json({ error: 'Total applied exceeds payment amount' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const { rows: [pmt] } = await client.query(
            `INSERT INTO payments_received
                (customer_id, payment_date, amount, method, reference_number, notes)
             VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
            [customer_id, payment_date || new Date().toISOString().slice(0,10),
             amount, method, reference_number || null, notes || null]
        );

        for (const app of applications) {
            await client.query(
                `INSERT INTO payment_applications (payment_id, invoice_id, amount_applied)
                 VALUES ($1,$2,$3)`,
                [pmt.id, app.invoice_id, app.amount_applied]
            );

            // Recalculate amount_paid and update invoice status
            const { rows: [totals] } = await client.query(
                `SELECT si.total, COALESCE(SUM(pa.amount_applied),0) AS paid_total
                 FROM sales_invoices si
                 JOIN payment_applications pa ON pa.invoice_id = si.id
                 WHERE si.id = $1
                 GROUP BY si.total`, [app.invoice_id]
            );

            if (totals) {
                const paidTotal = parseFloat(totals.paid_total);
                const invTotal  = parseFloat(totals.total);
                const newStatus = paidTotal >= invTotal ? 'paid'
                                : paidTotal > 0         ? 'partial_paid'
                                : 'sent';
                await client.query(
                    `UPDATE sales_invoices SET amount_paid=$1, status=$2, updated_at=NOW()
                     WHERE id=$3`,
                    [paidTotal, newStatus, app.invoice_id]
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

// ── AR Aging ──────────────────────────────────────────────────────────────────

app.get('/api/customers/:id/ar', async (req, res) => {
    try {
        const { rows: [aging] } = await query(
            `SELECT * FROM v_ar_aging WHERE customer_id = $1`, [req.params.id]
        );
        const { rows: invoices } = await query(
            `SELECT * FROM sales_invoices WHERE customer_id = $1 AND status NOT IN ('paid','void')
             ORDER BY due_date`, [req.params.id]
        );
        res.json({ aging: aging || null, open_invoices: invoices });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/ar-aging', async (_req, res) => {
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
        res.json({ customers: rows, totals });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── 404 fallback ─────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`\n  Tick Tock Inc. API`);
    console.log(`  ─────────────────────────────`);
    console.log(`  Listening on http://localhost:${PORT}`);
    console.log(`  DB: ${process.env.DATABASE_URL}\n`);
});
