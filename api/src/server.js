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

// ─── 404 fallback ─────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`\n  Tick Tock Inc. API`);
    console.log(`  ─────────────────────────────`);
    console.log(`  Listening on http://localhost:${PORT}`);
    console.log(`  DB: ${process.env.DATABASE_URL}\n`);
});
