'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const { Pool } = require('pg');
const jwt     = require('jsonwebtoken');
const bcrypt  = require('bcryptjs');

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
app.get('/sales',       (_req, res) => res.sendFile(path.join(WEB_DIR, 'sales.html')));
app.get('/purchasing',  (_req, res) => res.sendFile(path.join(WEB_DIR, 'purchasing.html')));
app.get('/financials',  (_req, res) => res.sendFile(path.join(WEB_DIR, 'financials.html')));
app.get('/login',       (_req, res) => res.sendFile(path.join(WEB_DIR, 'login.html')));

// Simple request logger
app.use((req, _res, next) => {
    console.log(`${new Date().toISOString()}  ${req.method}  ${req.path}`);
    next();
});

// ─── Auth Middleware ───────────────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || 'ticktock-fallback-secret';

function requireAuth(req, res, next) {
    const header = req.headers['authorization'] || '';
    const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ success: false, error: 'Authentication required' });
    try {
        req.user = jwt.verify(token, JWT_SECRET);
        next();
    } catch {
        res.status(401).json({ success: false, error: 'Token expired or invalid' });
    }
}

// ─── Auth Routes ──────────────────────────────────────────────────────────────

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ success: false, error: 'Email and password are required' });
    }
    try {
        const { rows } = await query(
            `SELECT id, name, email, role, password_hash, is_active FROM users WHERE email = $1`,
            [email.toLowerCase().trim()]
        );
        if (!rows.length) {
            return res.status(401).json({ success: false, error: 'Invalid email or password' });
        }
        const user = rows[0];
        if (!user.is_active) {
            return res.status(403).json({ success: false, error: 'Account is disabled' });
        }
        const match = await bcrypt.compare(password, user.password_hash || '');
        if (!match) {
            return res.status(401).json({ success: false, error: 'Invalid email or password' });
        }
        const payload = { userId: user.id, email: user.email, role: user.role, name: user.name };
        const token   = jwt.sign(payload, JWT_SECRET, {
            expiresIn: process.env.JWT_EXPIRES_IN || '8h'
        });
        res.json({ success: true, data: { token, user: payload } });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET /api/auth/me — verify token and return user info
app.get('/api/auth/me', requireAuth, (req, res) => {
    res.json({ success: true, data: req.user });
});

// Apply auth to all /api/* except auth and health
app.use('/api', (req, res, next) => {
    if (req.path.startsWith('/auth/') || req.path === '/health') return next();
    requireAuth(req, res, next);
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

const SERVER_START = Date.now();

// Health (public — no auth required)
app.get('/health',     async (_req, res) => {
    try {
        await query('SELECT 1');
        res.json({
            status:  'ok',
            db:      'connected',
            version: process.env.APP_VERSION || '1.0.0',
            uptime:  Math.floor((Date.now() - SERVER_START) / 1000),
            ts:      new Date().toISOString()
        });
    } catch (err) {
        res.status(503).json({ status: 'error', message: err.message });
    }
});

app.get('/api/health', async (_req, res) => {
    try {
        await query('SELECT 1');
        res.json({
            success: true,
            data: {
                status:  'ok',
                db:      'connected',
                version: process.env.APP_VERSION || '1.0.0',
                uptime:  Math.floor((Date.now() - SERVER_START) / 1000),
                ts:      new Date().toISOString()
            }
        });
    } catch (err) {
        res.status(503).json({ success: false, error: err.message });
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

// Look up item by UPC barcode
app.get('/api/items/by-upc/:upc', async (req, res) => {
    try {
        const { rows } = await query(
            `SELECT * FROM items WHERE upc_code = $1`, [req.params.upc]
        );
        if (!rows.length) return res.status(404).json({ error: 'No item found with that UPC' });
        res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/items/:id', async (req, res) => {
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
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/items/:id — soft-delete (set is_active = false)
app.delete('/api/items/:id', async (req, res) => {
    try {
        // Check for stock movements first
        const { rows: stockRows } = await query(
            `SELECT COUNT(*) AS cnt FROM stock_ledger WHERE item_id = $1`, [req.params.id]
        );
        if (parseInt(stockRows[0].cnt, 10) > 0) {
            // Soft delete — can't hard delete items with ledger entries
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

// Reorder alerts — consolidated per item (total stock across all warehouses vs reorder_point)
app.get('/api/stock/reorder-alerts', async (_req, res) => {
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
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
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

app.get('/api/adjustments', async (req, res) => {
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
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
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

        // Audit log entry
        try {
            await query(`INSERT INTO audit_log (action, table_name, record_id, new_values) VALUES ('post_adjustment','stock_adjustments',$1,$2)`,
                [adj.id, JSON.stringify({ status: 'posted', posted_at: new Date() })]);
        } catch {}

        res.json({ success: true, data: updated });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(err.status || 500).json({ success: false, error: err.message });
    } finally {
        client.release();
    }
});

// DELETE /api/adjustments/:id — delete draft adjustment
app.delete('/api/adjustments/:id', async (req, res) => {
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
            payment_terms_days = 30, credit_limit = 0, currency = 'USD', notes,
            tax_exempt = false, tax_exempt_certificate, tax_exempt_expiry,
            state_code, vip_tier = 'standard' } = req.body;
    if (!code || !name) return res.status(400).json({ error: 'code and name are required' });
    try {
        const { rows } = await query(
            `INSERT INTO parties (type,code,name,email,phone,billing_address,shipping_address,
                                  payment_terms_days,credit_limit,currency,notes,
                                  tax_exempt,tax_exempt_certificate,tax_exempt_expiry,state_code,vip_tier)
             VALUES ('customer',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
            [code, name, email, phone,
             billing_address ? JSON.stringify(billing_address) : null,
             shipping_address ? JSON.stringify(shipping_address) : null,
             payment_terms_days, credit_limit, currency, notes,
             tax_exempt, tax_exempt_certificate || null, tax_exempt_expiry || null,
             state_code || null, vip_tier]
        );
        res.status(201).json(rows[0]);
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: 'Customer code already exists' });
        res.status(500).json({ error: err.message });
    }
});

app.patch('/api/customers/:id', async (req, res) => {
    const allowed = ['name','email','phone','billing_address','shipping_address',
                     'payment_terms_days','credit_limit','currency','notes','is_active',
                     'tax_exempt','tax_exempt_certificate','tax_exempt_expiry',
                     'state_code','vip_tier'];
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

// Internal helper: resolve price with lock support
async function resolvePriceForCustomer(customerId, itemId, qty, date) {
    const checkDate = date || new Date().toISOString().slice(0, 10);

    // Priority 1: VIP item lock
    if (customerId) {
        const { rows: locked } = await query(
            `SELECT locked_price, lock_reason FROM customer_item_price_locks
             WHERE customer_id = $1 AND item_id = $2 AND is_active = true`,
            [customerId, itemId]
        );
        if (locked.length) {
            return { price: locked[0].locked_price, source: 'locked',
                     is_locked: true, lock_reason: locked[0].lock_reason };
        }

        // Priority 2: customer price lists by priority
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
        if (rows.length) {
            return { price: rows[0].price, source: 'price_list', is_locked: false };
        }
    }

    // Priority 3: catalog sale_price
    const { rows: [item] } = await query(
        `SELECT sale_price AS price FROM items WHERE id = $1`, [itemId]
    );
    return { price: item ? item.price : 0, source: 'default', is_locked: false };
}

// Internal helper: calculate tax for a customer + subtotal
async function calculateInvoiceTax(customerId, subtotal) {
    const { rows: [cust] } = await query(
        `SELECT tax_exempt, state_code FROM parties WHERE id = $1`, [customerId]
    );
    if (!cust) return { tax_amount: 0, rate: 0, state_code: null, exempt: false };
    if (cust.tax_exempt) return { tax_amount: 0, rate: 0, state_code: cust.state_code, exempt: true };
    if (!cust.state_code) return { tax_amount: 0, rate: 0, state_code: null, exempt: false };

    const { rows: [stateRow] } = await query(
        `SELECT tax_rate FROM state_tax_rates WHERE state_code = $1 AND is_active = true`,
        [cust.state_code]
    );
    const rate = stateRow ? parseFloat(stateRow.tax_rate) : 0;
    return {
        tax_amount:  parseFloat((subtotal * rate).toFixed(4)),
        rate,
        state_code:  cust.state_code,
        exempt:      false
    };
}

// GET /api/pricing/resolve?customerId=X&itemId=Y&qty=Z&date=D
app.get('/api/pricing/resolve', async (req, res) => {
    const { customerId, itemId, qty = 1, date } = req.query;
    if (!itemId) return res.status(400).json({ error: 'itemId required' });
    try {
        const result = await resolvePriceForCustomer(customerId, itemId, qty, date);
        res.json(result);
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

        // 6. Auto-generate invoice with state-based tax
        const taxInfo    = await calculateInvoiceTax(order.customer_id, invoiceSubtotal);
        const invTotal   = invoiceSubtotal + taxInfo.tax_amount;
        const invNumber  = await nextDocNumber(client, 'sales_invoices', 'number', 'INV');
        const { rows: [cust] } = await client.query(
            `SELECT payment_terms_days FROM parties WHERE id = $1`, [order.customer_id]
        );
        const dueDate = new Date(shp.ship_date);
        dueDate.setDate(dueDate.getDate() + (cust ? cust.payment_terms_days : 30));

        const { rows: [invoice] } = await client.query(
            `INSERT INTO sales_invoices
                (number, customer_id, sales_order_id, shipment_id, status,
                 invoice_date, due_date, subtotal, tax_amount, total,
                 tax_rate, state_code, tax_exempt)
             VALUES ($1,$2,$3,$4,'sent',$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
            [invNumber, order.customer_id, order.id, shp.id,
             shp.ship_date, dueDate.toISOString().slice(0,10),
             invoiceSubtotal.toFixed(4), taxInfo.tax_amount.toFixed(4), invTotal.toFixed(4),
             taxInfo.rate, taxInfo.state_code || null, taxInfo.exempt]
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

// ════════════════════════════════════════════════════════════════════════════
// PURCHASING MODULE
// ════════════════════════════════════════════════════════════════════════════

// ── Vendors ───────────────────────────────────────────────────────────────────

app.get('/api/vendors', async (_req, res) => {
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

app.get('/api/vendors/:id', async (req, res) => {
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

app.post('/api/vendors', async (req, res) => {
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

// ── Purchase Orders ───────────────────────────────────────────────────────────

app.get('/api/purchase-orders/dashboard', async (_req, res) => {
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
            total_ap: parseFloat(apData.rows[0].ap_total),
            recent_pos: recentPOs.rows
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/purchase-orders', async (req, res) => {
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

app.get('/api/purchase-orders/:id', async (req, res) => {
    try {
        const { rows: [po] } = await query(
            `SELECT pos.*
             FROM   v_purchase_order_status pos
             WHERE  pos.id = $1`, [req.params.id]
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

app.post('/api/purchase-orders', async (req, res) => {
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

app.post('/api/purchase-orders/:id/send', async (req, res) => {
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

app.post('/api/purchase-orders/:id/cancel', async (req, res) => {
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

app.get('/api/receipts', async (_req, res) => {
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

app.get('/api/receipts/:id', async (req, res) => {
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

app.post('/api/receipts', async (req, res) => {
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

// Post receipt — THE critical purchasing transaction
app.post('/api/receipts/:id/post', async (req, res) => {
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
            // 1. Stock ledger — inbound
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

            // 2. Update PO line qty_received and status
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

            // 3. Weighted average cost update (for avg cost items)
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

        // 4. Update PO status
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

        // 5. Mark receipt posted
        await client.query(
            `UPDATE purchase_receipts SET status='posted' WHERE id=$1`, [rcv.id]
        );

        // 6. Check if any sales backorders can now be fulfilled
        await checkBackordersForAllItems(client, lines.map(l => l.item_id));

        // 7. Audit log
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

app.get('/api/vendor-invoices', async (req, res) => {
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

app.get('/api/vendor-invoices/:id', async (req, res) => {
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

app.post('/api/vendor-invoices', async (req, res) => {
    const { vendor_id, purchase_order_id, receipt_id, invoice_date,
            subtotal, tax_amount = 0, notes, vendor_invoice_number } = req.body;
    if (!vendor_id || !subtotal) return res.status(400).json({ error: 'vendor_id and subtotal required' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Determine due date from vendor payment terms
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

// Three-way match
app.post('/api/vendor-invoices/:id/match', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const { rows: [inv] } = await client.query(
            `SELECT * FROM vendor_invoices WHERE id = $1 FOR UPDATE`, [req.params.id]
        );
        if (!inv) throw Object.assign(new Error('Invoice not found'), { status: 404 });

        let matchStatus = 'matched';
        const notes    = [];

        // Check against PO total
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

        // Check against receipt qty
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

app.post('/api/vendor-invoices/:id/approve', async (req, res) => {
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

app.post('/api/vendor-invoices/:id/void', async (req, res) => {
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

app.post('/api/vendor-payments', async (req, res) => {
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

app.get('/api/ap-aging', async (_req, res) => {
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

app.get('/api/vendors/:id/ap', async (req, res) => {
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

// ── Reorder Suggestions ───────────────────────────────────────────────────────

app.get('/api/reorder-suggestions', async (_req, res) => {
    try {
        const { rows } = await query(
            `SELECT * FROM v_reorder_suggestions ORDER BY effective_qty - reorder_point ASC`
        );
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Auto-generate POs from reorder suggestions
app.post('/api/reorder-suggestions/generate-pos', async (req, res) => {
    const { warehouse_id, created_by } = req.body;
    if (!warehouse_id) return res.status(400).json({ error: 'warehouse_id required' });

    const { rows: suggestions } = await query(
        `SELECT * FROM v_reorder_suggestions WHERE suggested_order_qty > 0`
    );
    if (!suggestions.length) return res.json({ pos_created: 0, message: 'No items need reordering' });

    // Group by preferred_vendor_id (null vendors get their own PO each)
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
            if (!group.vendor_id) continue; // skip items with no preferred vendor

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

// ── Backorder check helper ────────────────────────────────────────────────────
async function checkBackordersForAllItems(client, itemIds) {
    // After receiving stock, update open backorder line statuses
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

// ════════════════════════════════════════════════════════════════════════════
// MODULE 4 — REAL-WORLD LAYER
// ════════════════════════════════════════════════════════════════════════════

// ── Tax Rates ─────────────────────────────────────────────────────────────────

app.get('/api/tax/rates', async (_req, res) => {
    try {
        const { rows } = await query(
            `SELECT * FROM state_tax_rates ORDER BY state_name`
        );
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/tax/rates/:stateCode', async (req, res) => {
    try {
        const { rows } = await query(
            `SELECT * FROM state_tax_rates WHERE state_code = $1`,
            [req.params.stateCode.toUpperCase()]
        );
        if (!rows.length) return res.status(404).json({ error: 'State not found' });
        res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/tax/rates/:stateCode', async (req, res) => {
    const { tax_rate, is_active } = req.body;
    if (tax_rate == null) return res.status(400).json({ error: 'tax_rate required' });
    try {
        const { rows } = await query(
            `UPDATE state_tax_rates
             SET tax_rate = $1, is_active = COALESCE($2, is_active), updated_at = NOW()
             WHERE state_code = $3 RETURNING *`,
            [tax_rate, is_active ?? null, req.params.stateCode.toUpperCase()]
        );
        if (!rows.length) return res.status(404).json({ error: 'State not found' });
        res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/tax/calculate', async (req, res) => {
    const { customerId, subtotal } = req.query;
    if (!customerId || subtotal == null) return res.status(400).json({ error: 'customerId and subtotal required' });
    try {
        const taxInfo = await calculateInvoiceTax(customerId, parseFloat(subtotal));
        res.json({ ...taxInfo, subtotal: parseFloat(subtotal),
                   total: parseFloat(subtotal) + taxInfo.tax_amount });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── VIP Pricing — customer-level routes ───────────────────────────────────────

// All items with their resolved price for a customer (shows locks)
app.get('/api/pricing/customer/:customerId', async (req, res) => {
    try {
        const { rows: items } = await query(
            `SELECT i.id, i.code, i.name, i.sale_price, i.standard_cost, i.category
             FROM items i WHERE i.is_active = true ORDER BY i.category, i.code`
        );
        const { rows: locks } = await query(
            `SELECT item_id, locked_price, lock_reason, locked_at
             FROM customer_item_price_locks
             WHERE customer_id = $1 AND is_active = true`,
            [req.params.customerId]
        );
        const lockMap = {};
        for (const l of locks) lockMap[l.item_id] = l;

        const { rows: priceLists } = await query(
            `SELECT pli.item_id, pli.price
             FROM customer_price_lists cpl
             JOIN price_list_items pli ON pli.price_list_id = cpl.price_list_id
             JOIN price_lists pl ON pl.id = cpl.price_list_id
             WHERE cpl.customer_id = $1
               AND (pl.valid_to IS NULL OR pl.valid_to >= CURRENT_DATE)
             ORDER BY cpl.priority ASC, pli.min_qty ASC`,
            [req.params.customerId]
        );
        const listMap = {};
        for (const p of priceLists) {
            if (!listMap[p.item_id]) listMap[p.item_id] = p.price;
        }

        const result = items.map(item => {
            if (lockMap[item.id]) {
                return { ...item, price: lockMap[item.id].locked_price,
                         source: 'locked', is_locked: true,
                         lock_reason: lockMap[item.id].lock_reason,
                         locked_at: lockMap[item.id].locked_at };
            }
            if (listMap[item.id]) {
                return { ...item, price: listMap[item.id], source: 'price_list', is_locked: false };
            }
            return { ...item, price: item.sale_price, source: 'default', is_locked: false };
        });
        res.json(result);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Lock a VIP price for a customer + item
app.post('/api/pricing/lock', async (req, res) => {
    const { customerId, itemId, lockedPrice, reason, lockedBy } = req.body;
    if (!customerId || !itemId || lockedPrice == null)
        return res.status(400).json({ error: 'customerId, itemId, and lockedPrice required' });
    try {
        const { rows } = await query(
            `INSERT INTO customer_item_price_locks
                (customer_id, item_id, locked_price, lock_reason, locked_by, is_active)
             VALUES ($1,$2,$3,$4,$5,true)
             ON CONFLICT (customer_id, item_id)
             DO UPDATE SET locked_price=$3, lock_reason=$4, locked_by=$5,
                           locked_at=NOW(), is_active=true
             RETURNING *`,
            [customerId, itemId, lockedPrice, reason || null, lockedBy || null]
        );
        res.status(201).json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Unlock a VIP price (revert to standard price list)
app.post('/api/pricing/unlock', async (req, res) => {
    const { customerId, itemId } = req.body;
    if (!customerId || !itemId) return res.status(400).json({ error: 'customerId and itemId required' });
    try {
        const { rows } = await query(
            `UPDATE customer_item_price_locks SET is_active = false
             WHERE customer_id = $1 AND item_id = $2 RETURNING *`,
            [customerId, itemId]
        );
        if (!rows.length) return res.status(404).json({ error: 'No active lock found' });
        res.json({ message: 'Lock removed', ...rows[0] });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Preview a cost update (does NOT apply it)
app.post('/api/pricing/update-cost', async (req, res) => {
    const { itemId, newCost, notes } = req.body;
    if (!itemId || newCost == null) return res.status(400).json({ error: 'itemId and newCost required' });
    try {
        const { rows: [item] } = await query(
            `SELECT id, code, name, standard_cost, sale_price FROM items WHERE id = $1`, [itemId]
        );
        if (!item) return res.status(404).json({ error: 'Item not found' });

        const oldCost      = parseFloat(item.standard_cost);
        const oldSalePrice = parseFloat(item.sale_price);
        const newCostF     = parseFloat(newCost);

        // Maintain margin: new_price = new_cost * (old_price / old_cost)
        const suggested_sale_price = oldCost > 0
            ? parseFloat((newCostF * (oldSalePrice / oldCost)).toFixed(4))
            : oldSalePrice;
        const old_margin_pct = oldCost > 0 ? ((oldSalePrice - oldCost) / oldCost * 100).toFixed(2) : null;

        // Count affected customers
        const { rows: [counts] } = await query(
            `SELECT
                COUNT(*) FILTER (WHERE cipl.is_active = true) AS locked_count,
                COUNT(DISTINCT pli.id) FILTER (WHERE cipl.id IS NULL OR cipl.is_active = false) AS list_count
             FROM price_list_items pli
             LEFT JOIN customer_price_lists cpl ON cpl.price_list_id = pli.price_list_id
             LEFT JOIN customer_item_price_locks cipl
                    ON cipl.customer_id = cpl.customer_id AND cipl.item_id = pli.item_id AND cipl.is_active = true
             WHERE pli.item_id = $1`, [itemId]
        );

        res.json({
            item_id:             item.id,
            item_code:           item.code,
            item_name:           item.name,
            old_cost:            oldCost,
            new_cost:            newCostF,
            old_sale_price:      oldSalePrice,
            suggested_sale_price,
            old_margin_pct,
            customers_affected:  parseInt(counts.list_count || 0),
            customers_locked:    parseInt(counts.locked_count || 0),
            notes
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Confirm and apply the cost update
app.post('/api/pricing/update-cost/:itemId/confirm', async (req, res) => {
    const { newCost, newSalePrice, notes, changedBy } = req.body;
    if (newCost == null) return res.status(400).json({ error: 'newCost required' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const { rows: [item] } = await client.query(
            `SELECT id, standard_cost, sale_price FROM items WHERE id = $1 FOR UPDATE`,
            [req.params.itemId]
        );
        if (!item) throw Object.assign(new Error('Item not found'), { status: 404 });

        const oldCost      = parseFloat(item.standard_cost);
        const oldSalePrice = parseFloat(item.sale_price);
        const newCostF     = parseFloat(newCost);
        const newSaleF     = newSalePrice != null
            ? parseFloat(newSalePrice)
            : (oldCost > 0 ? parseFloat((newCostF * (oldSalePrice / oldCost)).toFixed(4)) : oldSalePrice);

        // Update the item
        await client.query(
            `UPDATE items SET standard_cost=$1, sale_price=$2, updated_at=NOW() WHERE id=$3`,
            [newCostF, newSaleF, req.params.itemId]
        );

        // Update non-locked price list entries
        const { rows: listItems } = await client.query(
            `SELECT pli.id AS pli_id, cpl.customer_id
             FROM price_list_items pli
             JOIN customer_price_lists cpl ON cpl.price_list_id = pli.price_list_id
             LEFT JOIN customer_item_price_locks cipl
                    ON cipl.customer_id = cpl.customer_id AND cipl.item_id = pli.item_id AND cipl.is_active = true
             WHERE pli.item_id = $1 AND cipl.id IS NULL`, [req.params.itemId]
        );

        let customersUpdated = 0;
        const seenPli = new Set();
        for (const row of listItems) {
            if (seenPli.has(row.pli_id)) continue;
            seenPli.add(row.pli_id);
            await client.query(
                `UPDATE price_list_items SET price=$1 WHERE id=$2`, [newSaleF, row.pli_id]
            );
            customersUpdated++;
        }

        // Count locked
        const { rows: [lockCount] } = await client.query(
            `SELECT COUNT(*) AS cnt FROM customer_item_price_locks
             WHERE item_id = $1 AND is_active = true`, [req.params.itemId]
        );

        // Log the change
        await client.query(
            `INSERT INTO price_change_log
                (item_id, old_cost, new_cost, old_sale_price, new_sale_price,
                 customers_updated, customers_locked, changed_by, notes)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [req.params.itemId, oldCost, newCostF, oldSalePrice, newSaleF,
             customersUpdated, parseInt(lockCount.cnt), changedBy || null, notes || null]
        );

        await client.query('COMMIT');
        res.json({ old_cost: oldCost, new_cost: newCostF,
                   old_sale_price: oldSalePrice, new_sale_price: newSaleF,
                   customers_updated: customersUpdated,
                   customers_locked: parseInt(lockCount.cnt) });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(err.status || 500).json({ error: err.message });
    } finally { client.release(); }
});

// Price change history
app.get('/api/pricing/change-log', async (_req, res) => {
    try {
        const { rows } = await query(
            `SELECT pcl.*, i.code AS item_code, i.name AS item_name, u.name AS changed_by_name
             FROM price_change_log pcl
             JOIN items i ON i.id = pcl.item_id
             LEFT JOIN users u ON u.id = pcl.changed_by
             ORDER BY pcl.changed_at DESC LIMIT 100`
        );
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Backup ────────────────────────────────────────────────────────────────────

const { execFile } = require('child_process');
const fs  = require('fs');
const fsp = require('fs').promises;
const zlib = require('zlib');
const BACKUP_DIR = require('path').join(__dirname, '..', '..', 'backups');

app.post('/api/backup/run', async (req, res) => {
    const backupType = req.body.backup_type || 'manual';
    const startedAt  = new Date();

    // Ensure backup dir exists
    fs.mkdirSync(BACKUP_DIR, { recursive: true });

    const ts       = startedAt.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const sqlFile  = require('path').join(BACKUP_DIR, `ticktock_${ts}.sql`);
    const gzFile   = sqlFile + '.gz';

    // Parse DATABASE_URL for pg_dump args
    let pgArgs;
    try {
        const url = new URL(process.env.DATABASE_URL);
        pgArgs = [
            '-h', url.hostname,
            '-p', url.port || '5432',
            '-U', url.username,
            '-F', 'p',   // plain SQL
            '-f', sqlFile,
            url.pathname.slice(1)  // database name
        ];
    } catch {
        return res.status(500).json({ error: 'Invalid DATABASE_URL' });
    }

    // Log as started
    const { rows: [logRow] } = await query(
        `INSERT INTO backup_log (backup_type, file_path, status, started_at)
         VALUES ($1,$2,'failed',$3) RETURNING id`,
        [backupType, gzFile, startedAt]
    );

    const env = { ...process.env, PGPASSWORD: new URL(process.env.DATABASE_URL).password };

    execFile('pg_dump', pgArgs, { env }, async (err) => {
        if (err) {
            await query(
                `UPDATE backup_log SET status='failed', completed_at=NOW(), error_message=$1 WHERE id=$2`,
                [err.message, logRow.id]
            );
            return res.status(500).json({ error: err.message });
        }

        // Gzip compress
        try {
            await new Promise((resolve, reject) => {
                const input  = fs.createReadStream(sqlFile);
                const output = fs.createWriteStream(gzFile);
                const gz     = zlib.createGzip();
                input.pipe(gz).pipe(output);
                output.on('finish', resolve);
                output.on('error', reject);
            });
            fs.unlinkSync(sqlFile); // remove uncompressed copy

            const stat = fs.statSync(gzFile);
            const completedAt = new Date();
            await query(
                `UPDATE backup_log
                 SET status='success', completed_at=$1, file_size_bytes=$2, file_path=$3
                 WHERE id=$4`,
                [completedAt, stat.size, gzFile, logRow.id]
            );

            // Prune old backups (keep 30)
            const files = fs.readdirSync(BACKUP_DIR)
                .filter(f => f.startsWith('ticktock_') && f.endsWith('.sql.gz'))
                .map(f => require('path').join(BACKUP_DIR, f))
                .sort();
            while (files.length > 30) {
                try { fs.unlinkSync(files.shift()); } catch { /* ignore */ }
            }

            res.json({
                file_path:    gzFile,
                file_size:    stat.size,
                duration_ms:  completedAt - startedAt,
                backup_id:    logRow.id
            });
        } catch (gzErr) {
            await query(
                `UPDATE backup_log SET status='failed', completed_at=NOW(), error_message=$1 WHERE id=$2`,
                [gzErr.message, logRow.id]
            );
            res.status(500).json({ error: gzErr.message });
        }
    });
});

app.get('/api/backup/list', async (_req, res) => {
    try {
        const { rows } = await query(
            `SELECT * FROM backup_log ORDER BY started_at DESC LIMIT 50`
        );
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/backup/schedule', async (req, res) => {
    const { cron_expression = '0 2 * * *' } = req.body;
    const configPath = require('path').join(__dirname, '..', 'backup-schedule.json');
    try {
        fs.writeFileSync(configPath, JSON.stringify({ cron_expression, updated_at: new Date() }, null, 2));
        res.json({ message: 'Schedule saved', cron_expression, config_file: configPath });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── CSV / Excel Migration ─────────────────────────────────────────────────────

const XLSX = require('xlsx');

// Column mappings for each importable table
const COLUMN_MAPS = {
    items: {
        'code': 'code', 'sku': 'code', 'item code': 'code', 'item_code': 'code',
        'name': 'name', 'description': 'description', 'uom': 'unit_of_measure',
        'unit_of_measure': 'unit_of_measure', 'cost': 'standard_cost', 'standard_cost': 'standard_cost',
        'price': 'sale_price', 'sale_price': 'sale_price', 'reorder_point': 'reorder_point',
        'reorder point': 'reorder_point', 'reorder_qty': 'reorder_qty', 'category': 'category',
        'upc': 'upc_code', 'upc_code': 'upc_code', 'weight': 'weight_lb', 'weight_lb': 'weight_lb',
        'country': 'country_of_origin', 'country_of_origin': 'country_of_origin'
    },
    customers: {
        'code': 'code', 'customer code': 'code', 'customer_code': 'code',
        'name': 'name', 'company': 'name', 'email': 'email', 'phone': 'phone',
        'terms': 'payment_terms_days', 'payment terms': 'payment_terms_days', 'payment_terms_days': 'payment_terms_days',
        'credit limit': 'credit_limit', 'credit_limit': 'credit_limit',
        'state': 'state_code', 'state_code': 'state_code',
        'vip': 'vip_tier', 'vip_tier': 'vip_tier',
        'tax exempt': 'tax_exempt', 'tax_exempt': 'tax_exempt',
        'tax cert': 'tax_exempt_certificate', 'tax_exempt_certificate': 'tax_exempt_certificate'
    },
    vendors: {
        'code': 'code', 'vendor code': 'code', 'vendor_code': 'code',
        'name': 'name', 'company': 'name', 'email': 'email', 'phone': 'phone',
        'terms': 'payment_terms_days', 'payment_terms_days': 'payment_terms_days',
        'address': 'billing_address_line1', 'city': 'billing_address_city',
        'state': 'billing_address_state', 'zip': 'billing_address_zip'
    }
};

function parseFileContent(fileContent, fileName) {
    // fileContent is base64 encoded
    const buf = Buffer.from(fileContent, 'base64');
    if (fileName && (fileName.endsWith('.xlsx') || fileName.endsWith('.xls'))) {
        const wb = XLSX.read(buf, { type: 'buffer' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        return XLSX.utils.sheet_to_json(ws, { defval: '' });
    }
    // CSV: parse manually
    const text = buf.toString('utf8');
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    if (!lines.length) return [];
    const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g,''));
    return lines.slice(1).map(line => {
        const vals = line.match(/(".*?"|[^,]+|(?<=,)(?=,))/g) || line.split(',');
        const row  = {};
        headers.forEach((h, i) => {
            row[h] = (vals[i] || '').trim().replace(/^"|"$/g,'');
        });
        return row;
    });
}

function mapColumns(rows, table) {
    const map = COLUMN_MAPS[table] || {};
    return rows.map(row => {
        const out = {};
        for (const [k, v] of Object.entries(row)) {
            const mapped = map[k.toLowerCase().trim()];
            if (mapped) out[mapped] = v;
        }
        return out;
    });
}

app.post('/api/migration/preview-csv', async (req, res) => {
    const { table, fileContent, fileName } = req.body;
    if (!table || !fileContent) return res.status(400).json({ error: 'table and fileContent required' });
    if (!['items','customers','vendors'].includes(table))
        return res.status(400).json({ error: 'table must be items, customers, or vendors' });
    try {
        const raw  = parseFileContent(fileContent, fileName);
        const mapped = mapColumns(raw, table);
        const requiredFields = { items: ['code','name'], customers: ['code','name'], vendors: ['code','name'] };
        const required = requiredFields[table];
        let valid = 0, errors = [];
        for (let i = 0; i < mapped.length; i++) {
            const missing = required.filter(f => !mapped[i][f]);
            if (missing.length) errors.push({ row: i + 2, missing, data: mapped[i] });
            else valid++;
        }
        res.json({
            rows_found:      raw.length,
            rows_valid:      valid,
            rows_with_errors: errors.length,
            sample_data:     mapped.slice(0, 10),
            column_mapping:  COLUMN_MAPS[table],
            errors:          errors.slice(0, 20)
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/migration/import-csv', async (req, res) => {
    const { table, fileContent, fileName, skipErrors = true } = req.body;
    if (!table || !fileContent) return res.status(400).json({ error: 'table and fileContent required' });
    if (!['items','customers','vendors'].includes(table))
        return res.status(400).json({ error: 'table must be items, customers, or vendors' });

    const raw    = parseFileContent(fileContent, fileName);
    const mapped = mapColumns(raw, table);

    let imported = 0, skipped = 0;
    const errors = [];

    for (let i = 0; i < mapped.length; i++) {
        const row = mapped[i];
        try {
            if (table === 'items') {
                if (!row.code || !row.name) throw new Error('code and name required');
                await query(
                    `INSERT INTO items (code, name, description, unit_of_measure, standard_cost,
                                        sale_price, reorder_point, reorder_qty, category,
                                        upc_code, weight_lb, country_of_origin)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
                     ON CONFLICT (code) DO UPDATE
                       SET name=EXCLUDED.name, description=EXCLUDED.description,
                           standard_cost=EXCLUDED.standard_cost, sale_price=EXCLUDED.sale_price,
                           upc_code=COALESCE(EXCLUDED.upc_code,items.upc_code),
                           updated_at=NOW()`,
                    [row.code, row.name, row.description || null,
                     row.unit_of_measure || 'EA', parseFloat(row.standard_cost) || 0,
                     parseFloat(row.sale_price) || 0, parseInt(row.reorder_point) || 0,
                     parseInt(row.reorder_qty) || 0, row.category || null,
                     row.upc_code || null, row.weight_lb ? parseFloat(row.weight_lb) : null,
                     row.country_of_origin || null]
                );
            } else if (table === 'customers') {
                if (!row.code || !row.name) throw new Error('code and name required');
                await query(
                    `INSERT INTO parties (type, code, name, email, phone,
                                          payment_terms_days, credit_limit, state_code, vip_tier)
                     VALUES ('customer',$1,$2,$3,$4,$5,$6,$7,$8)
                     ON CONFLICT (code) DO UPDATE
                       SET name=EXCLUDED.name, email=EXCLUDED.email,
                           state_code=COALESCE(EXCLUDED.state_code,parties.state_code),
                           updated_at=NOW()`,
                    [row.code, row.name, row.email || null, row.phone || null,
                     parseInt(row.payment_terms_days) || 30,
                     parseFloat(row.credit_limit) || 0,
                     row.state_code || null, row.vip_tier || 'standard']
                );
            } else if (table === 'vendors') {
                if (!row.code || !row.name) throw new Error('code and name required');
                const addr = (row.billing_address_line1 || row.billing_address_city)
                    ? JSON.stringify({ line1: row.billing_address_line1 || '',
                                       city:  row.billing_address_city || '',
                                       state: row.billing_address_state || '',
                                       zip:   row.billing_address_zip || '' })
                    : null;
                await query(
                    `INSERT INTO parties (type, code, name, email, phone,
                                          payment_terms_days, billing_address)
                     VALUES ('vendor',$1,$2,$3,$4,$5,$6)
                     ON CONFLICT (code) DO UPDATE
                       SET name=EXCLUDED.name, email=EXCLUDED.email, updated_at=NOW()`,
                    [row.code, row.name, row.email || null, row.phone || null,
                     parseInt(row.payment_terms_days) || 30, addr]
                );
            }
            imported++;
        } catch (err) {
            skipped++;
            errors.push({ row: i + 2, error: err.message, data: row });
            if (!skipErrors) break;
        }
    }
    res.json({ imported, skipped, errors: errors.slice(0, 50) });
});

app.get('/api/migration/status', async (_req, res) => {
    try {
        const [items, customers, vendors] = await Promise.all([
            query(`SELECT COUNT(*) AS cnt FROM items WHERE is_active = true`),
            query(`SELECT COUNT(*) AS cnt FROM parties WHERE type IN ('customer','both')`),
            query(`SELECT COUNT(*) AS cnt FROM parties WHERE type IN ('vendor','both')`)
        ]);
        res.json({
            items:     parseInt(items.rows[0].cnt),
            customers: parseInt(customers.rows[0].cnt),
            vendors:   parseInt(vendors.rows[0].cnt)
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Print Data Endpoints ───────────────────────────────────────────────────────

app.get('/api/print/invoice/:id', async (req, res) => {
    try {
        const { rows: [inv] } = await query(
            `SELECT si.*, p.name AS customer_name, p.code AS customer_code,
                    p.email AS customer_email, p.phone AS customer_phone,
                    p.billing_address, p.shipping_address,
                    so.number AS order_number, shp.number AS shipment_number,
                    shp.carrier, shp.tracking_number
             FROM sales_invoices si
             JOIN parties p ON p.id = si.customer_id
             LEFT JOIN sales_orders so ON so.id = si.sales_order_id
             LEFT JOIN shipments shp ON shp.id = si.shipment_id
             WHERE si.id = $1`, [req.params.id]
        );
        if (!inv) return res.status(404).json({ error: 'Invoice not found' });

        const { rows: lines } = await query(
            `SELECT sol.line_number, sol.qty_ordered AS qty, sol.unit_price,
                    sol.discount_pct, sol.line_total,
                    i.code AS item_code, i.name AS item_name, i.unit_of_measure
             FROM shipment_lines sl
             JOIN sales_order_lines sol ON sol.id = sl.sales_order_line_id
             JOIN items i ON i.id = sl.item_id
             WHERE sl.shipment_id = $1
             ORDER BY sol.line_number`, [inv.shipment_id]
        );
        res.json({ invoice: inv, lines });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/print/picklist/:shipmentId', async (req, res) => {
    try {
        const { rows: [shp] } = await query(
            `SELECT s.*, so.number AS order_number, so.notes AS order_notes,
                    p.name AS customer_name, p.shipping_address,
                    w.name AS warehouse_name, w.code AS warehouse_code
             FROM shipments s
             JOIN sales_orders so ON so.id = s.sales_order_id
             JOIN parties p ON p.id = so.customer_id
             JOIN warehouses w ON w.id = s.warehouse_id
             WHERE s.id = $1`, [req.params.shipmentId]
        );
        if (!shp) return res.status(404).json({ error: 'Shipment not found' });

        const { rows: lines } = await query(
            `SELECT sol.line_number, sl.qty_shipped,
                    i.code AS item_code, i.name AS item_name,
                    i.unit_of_measure, i.upc_code
             FROM shipment_lines sl
             JOIN sales_order_lines sol ON sol.id = sl.sales_order_line_id
             JOIN items i ON i.id = sl.item_id
             WHERE sl.shipment_id = $1
             ORDER BY sol.line_number`, [req.params.shipmentId]
        );
        res.json({ shipment: shp, lines });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/print/purchase-order/:id', async (req, res) => {
    try {
        const { rows: [po] } = await query(
            `SELECT po.*, v.name AS vendor_name, v.code AS vendor_code,
                    v.email AS vendor_email, v.phone AS vendor_phone,
                    v.billing_address AS vendor_address,
                    w.name AS warehouse_name, w.address AS warehouse_address,
                    u.name AS created_by_name
             FROM purchase_orders po
             JOIN parties v ON v.id = po.vendor_id
             JOIN warehouses w ON w.id = po.warehouse_id
             LEFT JOIN users u ON u.id = po.created_by
             WHERE po.id = $1`, [req.params.id]
        );
        if (!po) return res.status(404).json({ error: 'PO not found' });

        const { rows: lines } = await query(
            `SELECT pol.line_number, pol.qty_ordered, pol.unit_cost, pol.line_total,
                    pol.description, i.code AS item_code, i.name AS item_name,
                    i.unit_of_measure, i.upc_code
             FROM purchase_order_lines pol
             JOIN items i ON i.id = pol.item_id
             WHERE pol.purchase_order_id = $1
             ORDER BY pol.line_number`, [req.params.id]
        );
        res.json({ po, lines });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Financial Dashboard Endpoints ────────────────────────────────────────────

// GET /api/financials/summary  — KPI cards
app.get('/api/financials/summary', async (_req, res) => {
    try {
        const { rows: [r] } = await query(`
            SELECT
                -- Revenue (use si.total = subtotal + tax)
                (SELECT COALESCE(SUM(total),0) FROM sales_invoices
                 WHERE date_trunc('month', invoice_date) = date_trunc('month', CURRENT_DATE))   AS revenue_mtd,
                (SELECT COALESCE(SUM(total),0) FROM sales_invoices
                 WHERE date_trunc('year',  invoice_date) = date_trunc('year',  CURRENT_DATE))   AS revenue_ytd,
                -- AR open / overdue (balance_due is generated column)
                (SELECT COALESCE(SUM(balance_due),0) FROM sales_invoices
                 WHERE status NOT IN ('paid','void'))                                            AS ar_open,
                (SELECT COALESCE(SUM(balance_due),0) FROM sales_invoices
                 WHERE status NOT IN ('paid','void') AND due_date < CURRENT_DATE)               AS ar_overdue,
                -- COGS via actual receipt cost
                (SELECT COALESCE(SUM(prl.actual_cost * prl.qty_received),0)
                 FROM purchase_receipt_lines prl
                 JOIN purchase_receipts pr ON pr.id = prl.receipt_id
                 WHERE date_trunc('year', pr.receipt_date) = date_trunc('year', CURRENT_DATE))  AS cogs_ytd,
                -- AP open / overdue
                (SELECT COALESCE(SUM(balance_due),0) FROM vendor_invoices
                 WHERE status NOT IN ('paid','void'))                                            AS ap_open,
                (SELECT COALESCE(SUM(balance_due),0) FROM vendor_invoices
                 WHERE status NOT IN ('paid','void') AND due_date < CURRENT_DATE)               AS ap_overdue,
                -- Open order counts
                (SELECT COUNT(*) FROM sales_orders    WHERE status NOT IN ('closed','cancelled')) AS open_so_count,
                (SELECT COUNT(*) FROM purchase_orders WHERE status NOT IN ('closed','cancelled')) AS open_po_count,
                -- Inventory value: sum of (net qty * item standard_cost) from stock_ledger
                (SELECT COALESCE(SUM(sl_agg.net_qty * i.standard_cost),0)
                 FROM (SELECT item_id, SUM(qty) AS net_qty FROM stock_ledger GROUP BY item_id) sl_agg
                 JOIN items i ON i.id = sl_agg.item_id
                 WHERE sl_agg.net_qty > 0)                                                      AS inventory_value
        `);
        res.json(r);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/financials/revenue-by-month  — last 12 months
app.get('/api/financials/revenue-by-month', async (_req, res) => {
    try {
        const { rows } = await query(`
            WITH months AS (
                SELECT generate_series(
                    date_trunc('month', CURRENT_DATE - INTERVAL '11 months'),
                    date_trunc('month', CURRENT_DATE),
                    '1 month'::interval
                ) AS month
            ),
            inv_rev AS (
                SELECT date_trunc('month', invoice_date) AS month,
                       SUM(total) AS revenue
                FROM sales_invoices
                GROUP BY 1
            ),
            cogs_agg AS (
                SELECT date_trunc('month', pr.receipt_date) AS month,
                       SUM(prl.actual_cost * prl.qty_received) AS cogs
                FROM purchase_receipt_lines prl
                JOIN purchase_receipts pr ON pr.id = prl.receipt_id
                GROUP BY 1
            )
            SELECT TO_CHAR(m.month, 'Mon YY')            AS label,
                   COALESCE(r.revenue, 0)::numeric(14,2)  AS revenue,
                   COALESCE(c.cogs,    0)::numeric(14,2)  AS cogs,
                   (COALESCE(r.revenue,0) - COALESCE(c.cogs,0))::numeric(14,2) AS gross_profit
            FROM months m
            LEFT JOIN inv_rev   r ON r.month = m.month
            LEFT JOIN cogs_agg  c ON c.month = m.month
            ORDER BY m.month
        `);
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/financials/top-customers  — top 10 by YTD revenue
app.get('/api/financials/top-customers', async (_req, res) => {
    try {
        const { rows } = await query(`
            SELECT p.name AS customer,
                   COUNT(DISTINCT si.id)               AS invoice_count,
                   SUM(si.total)::numeric(14,2)         AS revenue_ytd,
                   SUM(si.balance_due)::numeric(14,2)   AS open_balance
            FROM sales_invoices si
            JOIN parties p ON p.id = si.customer_id
            WHERE date_trunc('year', si.invoice_date) = date_trunc('year', CURRENT_DATE)
            GROUP BY p.id, p.name
            ORDER BY revenue_ytd DESC
            LIMIT 10
        `);
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/financials/top-items  — top 15 items by YTD revenue + margin
app.get('/api/financials/top-items', async (_req, res) => {
    try {
        const { rows } = await query(`
            SELECT i.code, i.name,
                   SUM(sol.qty_shipped)                                         AS qty_sold,
                   SUM(sol.qty_shipped * sol.unit_price)::numeric(14,2)         AS revenue,
                   SUM(sol.qty_shipped * i.standard_cost)::numeric(14,2)        AS cogs,
                   CASE WHEN SUM(sol.qty_shipped * sol.unit_price) > 0
                        THEN ROUND((1 - SUM(sol.qty_shipped * i.standard_cost)
                                       / NULLIF(SUM(sol.qty_shipped * sol.unit_price),0)) * 100, 1)
                        ELSE 0 END                                               AS margin_pct
            FROM sales_order_lines sol
            JOIN items i ON i.id = sol.item_id
            JOIN sales_orders so ON so.id = sol.sales_order_id
            WHERE date_trunc('year', so.order_date) = date_trunc('year', CURRENT_DATE)
              AND sol.qty_shipped > 0
            GROUP BY i.id, i.code, i.name
            ORDER BY revenue DESC
            LIMIT 15
        `);
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/financials/cash-position  — AR + AP aging buckets
app.get('/api/financials/cash-position', async (_req, res) => {
    try {
        const { rows: ar } = await query(`
            SELECT
                SUM(CASE WHEN due_date >= CURRENT_DATE THEN balance_due ELSE 0 END)::numeric(14,2) AS current_amt,
                SUM(CASE WHEN due_date <  CURRENT_DATE AND due_date >= CURRENT_DATE - 30 THEN balance_due ELSE 0 END)::numeric(14,2) AS overdue_1_30,
                SUM(CASE WHEN due_date <  CURRENT_DATE - 30 AND due_date >= CURRENT_DATE - 60 THEN balance_due ELSE 0 END)::numeric(14,2) AS overdue_31_60,
                SUM(CASE WHEN due_date <  CURRENT_DATE - 60 AND due_date >= CURRENT_DATE - 90 THEN balance_due ELSE 0 END)::numeric(14,2) AS overdue_61_90,
                SUM(CASE WHEN due_date <  CURRENT_DATE - 90 THEN balance_due ELSE 0 END)::numeric(14,2) AS overdue_90_plus
            FROM sales_invoices WHERE status NOT IN ('paid','void')
        `);
        const { rows: ap } = await query(`
            SELECT
                SUM(CASE WHEN due_date >= CURRENT_DATE THEN balance_due ELSE 0 END)::numeric(14,2) AS current_amt,
                SUM(CASE WHEN due_date <  CURRENT_DATE AND due_date >= CURRENT_DATE - 30 THEN balance_due ELSE 0 END)::numeric(14,2) AS overdue_1_30,
                SUM(CASE WHEN due_date <  CURRENT_DATE - 30 AND due_date >= CURRENT_DATE - 60 THEN balance_due ELSE 0 END)::numeric(14,2) AS overdue_31_60,
                SUM(CASE WHEN due_date <  CURRENT_DATE - 60 AND due_date >= CURRENT_DATE - 90 THEN balance_due ELSE 0 END)::numeric(14,2) AS overdue_61_90,
                SUM(CASE WHEN due_date <  CURRENT_DATE - 90 THEN balance_due ELSE 0 END)::numeric(14,2) AS overdue_90_plus
            FROM vendor_invoices WHERE status NOT IN ('paid','void')
        `);
        res.json({ ar: ar[0], ap: ap[0] });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/financials/pl-detail  — monthly P&L last 12 months
app.get('/api/financials/pl-detail', async (_req, res) => {
    try {
        const { rows } = await query(`
            WITH months AS (
                SELECT generate_series(
                    date_trunc('month', CURRENT_DATE - INTERVAL '11 months'),
                    date_trunc('month', CURRENT_DATE),
                    '1 month'::interval
                ) AS month
            ),
            rev AS (
                SELECT date_trunc('month', invoice_date) AS month, SUM(total) AS revenue
                FROM sales_invoices GROUP BY 1
            ),
            cash_in AS (
                SELECT date_trunc('month', payment_date) AS month, SUM(amount) AS collected
                FROM payments_received GROUP BY 1
            ),
            cogs AS (
                SELECT date_trunc('month', pr.receipt_date) AS month,
                       SUM(prl.actual_cost * prl.qty_received) AS cogs
                FROM purchase_receipt_lines prl
                JOIN purchase_receipts pr ON pr.id = prl.receipt_id
                GROUP BY 1
            ),
            cash_out AS (
                SELECT date_trunc('month', payment_date) AS month, SUM(amount) AS paid
                FROM payments_made GROUP BY 1
            )
            SELECT TO_CHAR(m.month, 'Mon YYYY')               AS month,
                   COALESCE(r.revenue,    0)::numeric(14,2)   AS revenue,
                   COALESCE(ci.collected, 0)::numeric(14,2)   AS cash_collected,
                   COALESCE(c.cogs,       0)::numeric(14,2)   AS cogs,
                   (COALESCE(r.revenue,0) - COALESCE(c.cogs,0))::numeric(14,2) AS gross_profit,
                   COALESCE(co.paid,      0)::numeric(14,2)   AS cash_paid,
                   (COALESCE(ci.collected,0) - COALESCE(co.paid,0))::numeric(14,2) AS net_cash
            FROM months m
            LEFT JOIN rev      r  ON r.month  = m.month
            LEFT JOIN cash_in  ci ON ci.month = m.month
            LEFT JOIN cogs     c  ON c.month  = m.month
            LEFT JOIN cash_out co ON co.month = m.month
            ORDER BY m.month
        `);
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Dashboard Stats ───────────────────────────────────────────────────────────
app.get('/api/dashboard/stats', async (_req, res) => {
    try {
        const { rows } = await query(`
            SELECT
                (SELECT COUNT(*) FROM items WHERE is_active = true)::int                                                       AS total_items,
                (SELECT COALESCE(SUM(qty * cost_per_unit),0) FROM stock_ledger WHERE qty > 0)::numeric(14,2)                  AS total_inventory_value,
                (SELECT COUNT(*) FROM (
                    SELECT i.id FROM items i
                    LEFT JOIN v_stock_availability soh ON soh.item_id = i.id
                    WHERE i.is_active = true AND i.reorder_point > 0
                    GROUP BY i.id, i.reorder_point
                    HAVING COALESCE(SUM(soh.qty_available), 0) < i.reorder_point
                ) sub)::int                                                                                                        AS reorder_alert_count,
                (SELECT COUNT(*) FROM warehouses WHERE is_active = true)::int                                                  AS warehouse_count,
                (SELECT COUNT(*) FROM v_stock_availability WHERE qty_available > 0 AND qty_available <= reorder_point)::int    AS low_stock_count,
                (SELECT COUNT(*) FROM v_stock_availability WHERE qty_available <= 0)::int                                      AS out_of_stock_count
        `);
        res.json({ success: true, data: rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─── Item Search ───────────────────────────────────────────────────────────────
app.get('/api/items/search', async (req, res) => {
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

// ─── Global Error Handler ──────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
    console.error('Unhandled error:', err);
    res.status(err.status || 500).json({ success: false, error: err.message || 'Internal server error' });
});

// ─── 404 fallback ─────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ success: false, error: 'Not found' }));

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`\n  Tick Tock Inc. API`);
    console.log(`  ─────────────────────────────`);
    console.log(`  Listening on http://localhost:${PORT}`);
    console.log(`  DB: ${process.env.DATABASE_URL}\n`);
});
