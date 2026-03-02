'use strict';

// routes/admin.routes.js
// Module 10 — Admin & Settings: users, warehouses, company settings, audit log

const { Router } = require('express');
const { query, pool } = require('../db/pool');
const { z } = require('zod');
const { validate } = require('../middleware/validate');
const { parsePage, paginate } = require('../lib/pagination');
const bcrypt = require('bcryptjs');

const router = Router();

// ── Audit helper ──────────────────────────────────────────────────────────────
async function logAudit(client, { userId, action, tableName, recordId, entityLabel, oldValues, newValues, ip }) {
    await client.query(
        `INSERT INTO audit_log (user_id, action, table_name, record_id, entity_label, old_values, new_values, ip_address)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [userId || null, action, tableName, recordId || null, entityLabel || null,
         oldValues ? JSON.stringify(oldValues) : null,
         newValues ? JSON.stringify(newValues) : null,
         ip || null]
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Users
// ─────────────────────────────────────────────────────────────────────────────

const CreateUserSchema = z.object({
    name:     z.string().trim().min(1).max(100),
    email:    z.string().email(),
    role:     z.enum(['admin', 'warehouse', 'sales']),
    password: z.string().min(6),
});

const UpdateUserSchema = z.object({
    name:      z.string().trim().min(1).max(100).optional(),
    role:      z.enum(['admin', 'warehouse', 'sales']).optional(),
    is_active: z.boolean().optional(),
});

// GET /api/admin/users
router.get('/users', async (req, res) => {
    try {
        const { page, limit, offset } = parsePage(req.query);
        const { rows: [{ count }] } = await query(`SELECT COUNT(*) FROM users`);
        const { rows } = await query(
            `SELECT id, name, email, role, is_active, created_at
             FROM users ORDER BY name LIMIT $1 OFFSET $2`,
            [limit, offset]
        );
        res.json(paginate(rows, parseInt(count, 10), page, limit));
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// POST /api/admin/users
router.post('/users', validate(CreateUserSchema), async (req, res) => {
    const { name, email, role, password } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const hash = await bcrypt.hash(password, 10);
        const { rows: [user] } = await client.query(
            `INSERT INTO users (name, email, role, password_hash, is_active)
             VALUES ($1,$2,$3,$4,true) RETURNING id, name, email, role, is_active, created_at`,
            [name, email, role, hash]
        );
        await logAudit(client, {
            userId: req.user?.id, action: 'user.created', tableName: 'users',
            recordId: user.id, entityLabel: `${name} (${email})`,
            newValues: { name, email, role }, ip: req.ip
        });
        await client.query('COMMIT');
        res.status(201).json({ success: true, data: user });
    } catch (err) {
        await client.query('ROLLBACK');
        if (err.constraint === 'users_email_key') {
            return res.status(409).json({ success: false, error: 'Email already in use' });
        }
        res.status(500).json({ success: false, error: err.message });
    } finally { client.release(); }
});

// PATCH /api/admin/users/:id
router.patch('/users/:id', validate(UpdateUserSchema), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows: [before] } = await client.query(
            `SELECT id, name, role, is_active FROM users WHERE id = $1`, [req.params.id]
        );
        if (!before) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, error: 'User not found' }); }

        const sets = []; const params = [req.params.id];
        if (req.body.name      !== undefined) { params.push(req.body.name);      sets.push(`name = $${params.length}`); }
        if (req.body.role      !== undefined) { params.push(req.body.role);      sets.push(`role = $${params.length}`); }
        if (req.body.is_active !== undefined) { params.push(req.body.is_active); sets.push(`is_active = $${params.length}`); }
        if (!sets.length) { await client.query('ROLLBACK'); return res.status(400).json({ success: false, error: 'Nothing to update' }); }

        const { rows: [user] } = await client.query(
            `UPDATE users SET ${sets.join(',')} WHERE id = $1 RETURNING id, name, email, role, is_active`, params
        );
        await logAudit(client, {
            userId: req.user?.id, action: 'user.updated', tableName: 'users',
            recordId: user.id, entityLabel: user.name,
            oldValues: { name: before.name, role: before.role, is_active: before.is_active },
            newValues: req.body, ip: req.ip
        });
        await client.query('COMMIT');
        res.json({ success: true, data: user });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ success: false, error: err.message });
    } finally { client.release(); }
});

// POST /api/admin/users/:id/reset-password
router.post('/users/:id/reset-password', validate(z.object({ password: z.string().min(6) })), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows: [u] } = await client.query(`SELECT id, name, email FROM users WHERE id = $1`, [req.params.id]);
        if (!u) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, error: 'User not found' }); }
        const hash = await bcrypt.hash(req.body.password, 10);
        await client.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [u.id, hash]);
        await logAudit(client, {
            userId: req.user?.id, action: 'user.password_reset', tableName: 'users',
            recordId: u.id, entityLabel: u.name, ip: req.ip
        });
        await client.query('COMMIT');
        res.json({ success: true, message: 'Password updated' });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ success: false, error: err.message });
    } finally { client.release(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Warehouses
// ─────────────────────────────────────────────────────────────────────────────

const WarehouseSchema = z.object({
    code:      z.string().trim().min(1).max(20).optional(),
    name:      z.string().trim().min(1).max(100),
    address:   z.string().trim().optional(),
    is_active: z.boolean().optional(),
});

// GET /api/admin/warehouses
router.get('/warehouses', async (req, res) => {
    try {
        const { page, limit, offset } = parsePage(req.query);
        const { rows: [{ count }] } = await query(`SELECT COUNT(*) FROM warehouses`);
        const { rows } = await query(
            `SELECT w.*, COUNT(sl.id)::INT AS ledger_entries
             FROM   warehouses w
             LEFT JOIN stock_ledger sl ON sl.warehouse_id = w.id
             GROUP BY w.id
             ORDER BY w.code
             LIMIT $1 OFFSET $2`,
            [limit, offset]
        );
        res.json(paginate(rows, parseInt(count, 10), page, limit));
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// POST /api/admin/warehouses
router.post('/warehouses', validate(WarehouseSchema), async (req, res) => {
    const { code, name, address } = req.body;
    if (!code) return res.status(400).json({ success: false, error: 'code is required' });
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows: [wh] } = await client.query(
            `INSERT INTO warehouses (code, name, address, is_active) VALUES ($1,$2,$3,true) RETURNING *`,
            [code.toUpperCase(), name, address || null]
        );
        await logAudit(client, {
            userId: req.user?.id, action: 'warehouse.created', tableName: 'warehouses',
            recordId: wh.id, entityLabel: `${wh.code} — ${wh.name}`,
            newValues: { code, name, address }, ip: req.ip
        });
        await client.query('COMMIT');
        res.status(201).json({ success: true, data: wh });
    } catch (err) {
        await client.query('ROLLBACK');
        if (err.constraint?.includes('unique')) return res.status(409).json({ success: false, error: 'Warehouse code already exists' });
        res.status(500).json({ success: false, error: err.message });
    } finally { client.release(); }
});

// PATCH /api/admin/warehouses/:id
router.patch('/warehouses/:id', validate(WarehouseSchema), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows: [before] } = await client.query(`SELECT * FROM warehouses WHERE id = $1`, [req.params.id]);
        if (!before) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, error: 'Warehouse not found' }); }

        const sets = []; const params = [req.params.id];
        if (req.body.name      !== undefined) { params.push(req.body.name);      sets.push(`name = $${params.length}`); }
        if (req.body.address   !== undefined) { params.push(req.body.address);   sets.push(`address = $${params.length}`); }
        if (req.body.is_active !== undefined) { params.push(req.body.is_active); sets.push(`is_active = $${params.length}`); }
        if (!sets.length) { await client.query('ROLLBACK'); return res.status(400).json({ success: false, error: 'Nothing to update' }); }

        const { rows: [wh] } = await client.query(
            `UPDATE warehouses SET ${sets.join(',')} WHERE id = $1 RETURNING *`, params
        );
        await logAudit(client, {
            userId: req.user?.id, action: 'warehouse.updated', tableName: 'warehouses',
            recordId: wh.id, entityLabel: `${wh.code} — ${wh.name}`,
            oldValues: { name: before.name, address: before.address, is_active: before.is_active },
            newValues: req.body, ip: req.ip
        });
        await client.query('COMMIT');
        res.json({ success: true, data: wh });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ success: false, error: err.message });
    } finally { client.release(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Company Settings
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/admin/settings
router.get('/settings', async (_req, res) => {
    try {
        const { rows } = await query(`SELECT key, value, description, updated_at FROM company_settings ORDER BY key`);
        // Return as object map for easy consumption
        const settings = Object.fromEntries(rows.map(r => [r.key, { value: r.value, description: r.description, updated_at: r.updated_at }]));
        res.json({ success: true, data: settings });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// PATCH /api/admin/settings
router.patch('/settings', async (req, res) => {
    const updates = req.body; // { key: value, ... }
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
        return res.status(400).json({ success: false, error: 'Body must be a key:value object' });
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        for (const [key, value] of Object.entries(updates)) {
            await client.query(
                `UPDATE company_settings SET value = $2, updated_at = NOW(), updated_by = $3
                 WHERE key = $1`,
                [key, String(value), req.user?.id || null]
            );
        }
        await logAudit(client, {
            userId: req.user?.id, action: 'settings.updated', tableName: 'company_settings',
            entityLabel: 'Company Settings', newValues: updates, ip: req.ip
        });
        await client.query('COMMIT');
        res.json({ success: true, message: 'Settings saved' });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ success: false, error: err.message });
    } finally { client.release(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Audit Log
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/admin/audit-log
router.get('/audit-log', async (req, res) => {
    const { action, table_name } = req.query;
    try {
        const { page, limit, offset } = parsePage(req.query);
        const conds = []; const params = [];
        if (action)     { params.push(`%${action}%`);     conds.push(`al.action ILIKE $${params.length}`); }
        if (table_name) { params.push(table_name); conds.push(`al.table_name = $${params.length}`); }
        const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

        const { rows: [{ count }] } = await query(
            `SELECT COUNT(*) FROM audit_log al ${where}`, params
        );
        const { rows } = await query(
            `SELECT al.*, u.name AS user_name
             FROM   audit_log al
             LEFT JOIN users u ON u.id = al.user_id
             ${where}
             ORDER  BY al.created_at DESC
             LIMIT $${params.length+1} OFFSET $${params.length+2}`,
            [...params, limit, offset]
        );
        res.json(paginate(rows, parseInt(count, 10), page, limit));
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

module.exports = router;
