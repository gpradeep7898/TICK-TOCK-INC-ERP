'use strict';

// routes/gl.routes.js
// Module 7 — General Ledger: Chart of Accounts, Journal Entries, Trial Balance, P&L, Balance Sheet

const { Router } = require('express');
const { query, pool } = require('../db/pool');
const { z } = require('zod');
const { validate } = require('../middleware/validate');
const { parsePage, paginate } = require('../lib/pagination');

const router = Router();

// ── Schemas ───────────────────────────────────────────────────────────────────
const UUID = z.string().uuid();

const CreateAccountSchema = z.object({
    account_number: z.string().trim().min(1).max(10),
    name:           z.string().trim().min(1).max(100),
    type:           z.enum(['asset','liability','equity','revenue','expense','cogs']),
    sub_type:       z.string().trim().optional(),
    parent_id:      UUID.optional(),
    normal_balance: z.enum(['debit','credit']).optional(),
    description:    z.string().trim().optional(),
});

const JELineSchema = z.object({
    account_id:  UUID,
    description: z.string().trim().optional(),
    debit:       z.coerce.number().nonnegative().default(0),
    credit:      z.coerce.number().nonnegative().default(0),
}).refine(l => l.debit > 0 || l.credit > 0, { message: 'Each line must have a non-zero debit or credit' })
  .refine(l => !(l.debit > 0 && l.credit > 0), { message: 'A line cannot have both debit and credit' });

const CreateJESchema = z.object({
    entry_date:  z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    description: z.string().trim().min(1),
    reference:   z.string().trim().optional(),
    created_by:  UUID.optional(),
    lines:       z.array(JELineSchema).min(2),
}).refine(d => {
    const totalDebit  = d.lines.reduce((s, l) => s + (l.debit  || 0), 0);
    const totalCredit = d.lines.reduce((s, l) => s + (l.credit || 0), 0);
    return Math.abs(totalDebit - totalCredit) < 0.005;
}, { message: 'Journal entry must balance: total debits must equal total credits' });

// ── Number generator ──────────────────────────────────────────────────────────
async function nextJENumber(client) {
    const { rows } = await client.query(
        `SELECT number FROM journal_entries ORDER BY created_at DESC LIMIT 1`
    );
    if (!rows.length) return 'JE-00002'; // 00001 is opening balance
    const last = parseInt(rows[0].number.split('-').pop(), 10);
    return `JE-${String(last + 1).padStart(5, '0')}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Chart of Accounts
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/gl/accounts
router.get('/accounts', async (_req, res) => {
    try {
        const { rows } = await query(
            `SELECT a.*,
                    p.name AS parent_name,
                    p.account_number AS parent_number,
                    (SELECT COALESCE(SUM(jel.debit - jel.credit), 0)
                     FROM journal_entry_lines jel
                     JOIN journal_entries je ON je.id = jel.journal_entry_id
                     WHERE jel.account_id = a.id AND je.status = 'posted') AS balance
             FROM   gl_accounts a
             LEFT JOIN gl_accounts p ON p.id = a.parent_id
             ORDER  BY a.account_number`
        );
        res.json({ success: true, data: rows });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// POST /api/gl/accounts
router.post('/accounts', validate(CreateAccountSchema), async (req, res) => {
    const { account_number, name, type, sub_type, parent_id, normal_balance, description } = req.body;
    // default normal_balance by type
    const nb = normal_balance || (['asset','expense','cogs'].includes(type) ? 'debit' : 'credit');
    try {
        const { rows: [acct] } = await query(
            `INSERT INTO gl_accounts (account_number, name, type, sub_type, parent_id, normal_balance, description)
             VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
            [account_number, name, type, sub_type || null, parent_id || null, nb, description || null]
        );
        res.status(201).json({ success: true, data: acct });
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ success: false, error: 'Account number already exists' });
        res.status(500).json({ success: false, error: err.message });
    }
});

// PATCH /api/gl/accounts/:id
router.patch('/accounts/:id', async (req, res) => {
    const { name, description, is_active } = req.body;
    const sets = []; const params = [req.params.id];
    if (name        !== undefined) { params.push(name);        sets.push(`name = $${params.length}`); }
    if (description !== undefined) { params.push(description); sets.push(`description = $${params.length}`); }
    if (is_active   !== undefined) { params.push(is_active);   sets.push(`is_active = $${params.length}`); }
    if (!sets.length) return res.status(400).json({ success: false, error: 'Nothing to update' });
    try {
        const { rows } = await query(
            `UPDATE gl_accounts SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params
        );
        if (!rows.length) return res.status(404).json({ success: false, error: 'Account not found' });
        res.json({ success: true, data: rows[0] });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Journal Entries
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/gl/journal-entries
router.get('/journal-entries', async (req, res) => {
    const { status, from_date, to_date } = req.query;
    try {
        const { page, limit, offset } = parsePage(req.query);
        const conds = []; const params = [];
        if (status)    { params.push(status);    conds.push(`je.status = $${params.length}`); }
        if (from_date) { params.push(from_date); conds.push(`je.entry_date >= $${params.length}`); }
        if (to_date)   { params.push(to_date);   conds.push(`je.entry_date <= $${params.length}`); }
        const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

        const { rows: [{ count }] } = await query(
            `SELECT COUNT(*) FROM journal_entries je ${where}`, params
        );
        const { rows } = await query(
            `SELECT je.*,
                    u.name AS created_by_name,
                    (SELECT SUM(debit) FROM journal_entry_lines WHERE journal_entry_id = je.id) AS total_debit,
                    (SELECT COUNT(*) FROM journal_entry_lines WHERE journal_entry_id = je.id) AS line_count
             FROM journal_entries je
             LEFT JOIN users u ON u.id = je.created_by
             ${where}
             ORDER BY je.entry_date DESC, je.number DESC
             LIMIT $${params.length+1} OFFSET $${params.length+2}`,
            [...params, limit, offset]
        );
        res.json(paginate(rows, parseInt(count, 10), page, limit));
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// GET /api/gl/journal-entries/:id
router.get('/journal-entries/:id', async (req, res) => {
    try {
        const { rows: [je] } = await query(
            `SELECT je.*, u.name AS created_by_name
             FROM journal_entries je
             LEFT JOIN users u ON u.id = je.created_by
             WHERE je.id = $1`, [req.params.id]
        );
        if (!je) return res.status(404).json({ success: false, error: 'Journal entry not found' });

        const { rows: lines } = await query(
            `SELECT jel.*, a.account_number, a.name AS account_name, a.type AS account_type
             FROM journal_entry_lines jel
             JOIN gl_accounts a ON a.id = jel.account_id
             WHERE jel.journal_entry_id = $1
             ORDER BY jel.line_number`, [req.params.id]
        );
        res.json({ success: true, data: { ...je, lines } });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// POST /api/gl/journal-entries
router.post('/journal-entries', validate(CreateJESchema), async (req, res) => {
    const { entry_date, description, reference, created_by, lines } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const number = await nextJENumber(client);

        const { rows: [je] } = await client.query(
            `INSERT INTO journal_entries (number, entry_date, description, reference, created_by)
             VALUES ($1,$2,$3,$4,$5) RETURNING *`,
            [number,
             entry_date || new Date().toISOString().slice(0, 10),
             description, reference || null, created_by || null]
        );

        for (let i = 0; i < lines.length; i++) {
            const { account_id, description: ldesc, debit, credit } = lines[i];
            // verify account exists
            const { rows: [acct] } = await client.query(
                `SELECT id FROM gl_accounts WHERE id = $1 AND is_active = true`, [account_id]
            );
            if (!acct) throw Object.assign(
                new Error(`Account ${account_id} not found or inactive`), { status: 400 }
            );
            await client.query(
                `INSERT INTO journal_entry_lines
                    (journal_entry_id, line_number, account_id, description, debit, credit)
                 VALUES ($1,$2,$3,$4,$5,$6)`,
                [je.id, i + 1, account_id, ldesc || null, debit || 0, credit || 0]
            );
        }

        await client.query('COMMIT');
        res.status(201).json({ success: true, data: je });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(err.status || 400).json({ success: false, error: err.message });
    } finally { client.release(); }
});

// POST /api/gl/journal-entries/:id/post
router.post('/journal-entries/:id/post', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows: [je] } = await client.query(
            `SELECT * FROM journal_entries WHERE id = $1 FOR UPDATE`, [req.params.id]
        );
        if (!je) throw Object.assign(new Error('Journal entry not found'), { status: 404 });
        if (je.status !== 'draft')
            throw Object.assign(new Error(`Entry is already ${je.status}`), { status: 400 });

        // Verify balance
        const { rows: [bal] } = await client.query(
            `SELECT SUM(debit) AS total_debit, SUM(credit) AS total_credit
             FROM journal_entry_lines WHERE journal_entry_id = $1`, [je.id]
        );
        if (Math.abs(parseFloat(bal.total_debit) - parseFloat(bal.total_credit)) > 0.005)
            throw Object.assign(new Error('Entry does not balance — cannot post'), { status: 400 });

        const { rows: [posted] } = await client.query(
            `UPDATE journal_entries
             SET status = 'posted', posted_by = $2, posted_at = NOW(), updated_at = NOW()
             WHERE id = $1 RETURNING *`,
            [je.id, req.body.posted_by || null]
        );
        await client.query('COMMIT');
        res.json({ success: true, data: posted });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(err.status || 500).json({ success: false, error: err.message });
    } finally { client.release(); }
});

// POST /api/gl/journal-entries/:id/void
router.post('/journal-entries/:id/void', async (req, res) => {
    try {
        const { rows } = await query(
            `UPDATE journal_entries SET status = 'void', updated_at = NOW()
             WHERE id = $1 AND status = 'draft' RETURNING *`, [req.params.id]
        );
        if (!rows.length) return res.status(400).json({ success: false, error: 'Entry not found or already posted/void' });
        res.json({ success: true, data: rows[0] });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Reports
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/gl/trial-balance?as_of=YYYY-MM-DD
router.get('/trial-balance', async (req, res) => {
    const asOf = req.query.as_of || new Date().toISOString().slice(0, 10);
    try {
        const { rows } = await query(
            `SELECT a.account_number, a.name, a.type, a.sub_type, a.normal_balance,
                    COALESCE(SUM(jel.debit),  0) AS total_debit,
                    COALESCE(SUM(jel.credit), 0) AS total_credit,
                    COALESCE(SUM(jel.debit),  0) - COALESCE(SUM(jel.credit), 0) AS net_balance
             FROM   gl_accounts a
             LEFT JOIN journal_entry_lines jel ON jel.account_id = a.id
             LEFT JOIN journal_entries je ON je.id = jel.journal_entry_id
                    AND je.status = 'posted' AND je.entry_date <= $1
             WHERE  a.is_active = true
             GROUP  BY a.id, a.account_number, a.name, a.type, a.sub_type, a.normal_balance
             HAVING COALESCE(SUM(jel.debit), 0) <> 0 OR COALESCE(SUM(jel.credit), 0) <> 0
             ORDER  BY a.account_number`,
            [asOf]
        );

        const totalDebit  = rows.reduce((s, r) => s + parseFloat(r.total_debit), 0);
        const totalCredit = rows.reduce((s, r) => s + parseFloat(r.total_credit), 0);
        const isBalanced  = Math.abs(totalDebit - totalCredit) < 0.01;

        res.json({ success: true, data: { as_of: asOf, rows, total_debit: totalDebit, total_credit: totalCredit, is_balanced: isBalanced } });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// GET /api/gl/pl?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get('/pl', async (req, res) => {
    const from = req.query.from || new Date(new Date().getFullYear(), 0, 1).toISOString().slice(0, 10);
    const to   = req.query.to   || new Date().toISOString().slice(0, 10);
    try {
        const { rows } = await query(
            `SELECT a.account_number, a.name, a.type,
                    COALESCE(SUM(jel.debit),  0) AS total_debit,
                    COALESCE(SUM(jel.credit), 0) AS total_credit,
                    CASE
                        WHEN a.type IN ('revenue') THEN COALESCE(SUM(jel.credit),0) - COALESCE(SUM(jel.debit),0)
                        ELSE COALESCE(SUM(jel.debit),0) - COALESCE(SUM(jel.credit),0)
                    END AS amount
             FROM   gl_accounts a
             JOIN   journal_entry_lines jel ON jel.account_id = a.id
             JOIN   journal_entries je ON je.id = jel.journal_entry_id
                    AND je.status = 'posted'
                    AND je.entry_date BETWEEN $1 AND $2
             WHERE  a.type IN ('revenue','cogs','expense')
             GROUP  BY a.id, a.account_number, a.name, a.type
             ORDER  BY a.account_number`,
            [from, to]
        );

        const revenue  = rows.filter(r => r.type === 'revenue').reduce((s, r) => s + parseFloat(r.amount), 0);
        const cogs     = rows.filter(r => r.type === 'cogs').reduce((s, r) => s + parseFloat(r.amount), 0);
        const expenses = rows.filter(r => r.type === 'expense').reduce((s, r) => s + parseFloat(r.amount), 0);
        const grossProfit = revenue - cogs;
        const netIncome   = grossProfit - expenses;

        res.json({
            success: true,
            data: {
                period: { from, to },
                accounts: rows,
                summary: { revenue, cogs, gross_profit: grossProfit, expenses, net_income: netIncome },
            },
        });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// GET /api/gl/balance-sheet?as_of=YYYY-MM-DD
router.get('/balance-sheet', async (req, res) => {
    const asOf = req.query.as_of || new Date().toISOString().slice(0, 10);
    try {
        const { rows } = await query(
            `SELECT a.account_number, a.name, a.type, a.sub_type, a.normal_balance,
                    CASE
                        WHEN a.normal_balance = 'debit'
                             THEN COALESCE(SUM(jel.debit),0) - COALESCE(SUM(jel.credit),0)
                        ELSE      COALESCE(SUM(jel.credit),0) - COALESCE(SUM(jel.debit),0)
                    END AS balance
             FROM   gl_accounts a
             JOIN   journal_entry_lines jel ON jel.account_id = a.id
             JOIN   journal_entries je ON je.id = jel.journal_entry_id
                    AND je.status = 'posted' AND je.entry_date <= $1
             WHERE  a.type IN ('asset','liability','equity')
             GROUP  BY a.id, a.account_number, a.name, a.type, a.sub_type, a.normal_balance
             ORDER  BY a.account_number`,
            [asOf]
        );

        // Include net income for current period (retained earnings adjustment)
        const { rows: [plRow] } = await query(
            `SELECT COALESCE(SUM(
                CASE a.type
                    WHEN 'revenue' THEN COALESCE(jel.credit,0) - COALESCE(jel.debit,0)
                    ELSE                COALESCE(jel.debit,0)  - COALESCE(jel.credit,0)
                END
             ), 0) AS net_income
             FROM journal_entry_lines jel
             JOIN gl_accounts a ON a.id = jel.account_id
             JOIN journal_entries je ON je.id = jel.journal_entry_id
                  AND je.status = 'posted' AND je.entry_date <= $1
             WHERE a.type IN ('revenue','cogs','expense')`,
            [asOf]
        );

        const assets      = rows.filter(r => r.type === 'asset');
        const liabilities = rows.filter(r => r.type === 'liability');
        const equity      = rows.filter(r => r.type === 'equity');
        const netIncome   = parseFloat(plRow.net_income);

        const totalAssets      = assets.reduce((s, r) => s + parseFloat(r.balance), 0);
        const totalLiabilities = liabilities.reduce((s, r) => s + parseFloat(r.balance), 0);
        const totalEquity      = equity.reduce((s, r) => s + parseFloat(r.balance), 0) + netIncome;

        res.json({
            success: true,
            data: {
                as_of: asOf,
                assets, liabilities, equity,
                net_income: netIncome,
                summary: {
                    total_assets:      totalAssets,
                    total_liabilities: totalLiabilities,
                    total_equity:      totalEquity,
                    balanced:          Math.abs(totalAssets - (totalLiabilities + totalEquity)) < 0.01,
                },
            },
        });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// GET /api/gl/account-ledger/:id?from=&to=
router.get('/account-ledger/:id', async (req, res) => {
    const from = req.query.from || new Date(new Date().getFullYear(), 0, 1).toISOString().slice(0, 10);
    const to   = req.query.to   || new Date().toISOString().slice(0, 10);
    try {
        const { rows: [acct] } = await query(
            `SELECT * FROM gl_accounts WHERE id = $1`, [req.params.id]
        );
        if (!acct) return res.status(404).json({ success: false, error: 'Account not found' });

        const { rows } = await query(
            `SELECT je.number AS entry_number, je.entry_date, je.description AS entry_desc,
                    jel.description, jel.debit, jel.credit,
                    SUM(jel.debit - jel.credit) OVER (
                        PARTITION BY jel.account_id
                        ORDER BY je.entry_date, je.number
                        ROWS UNBOUNDED PRECEDING
                    ) AS running_balance
             FROM journal_entry_lines jel
             JOIN journal_entries je ON je.id = jel.journal_entry_id
             WHERE jel.account_id = $1
               AND je.status = 'posted'
               AND je.entry_date BETWEEN $2 AND $3
             ORDER BY je.entry_date, je.number`,
            [req.params.id, from, to]
        );

        res.json({ success: true, data: { account: acct, period: { from, to }, lines: rows } });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

module.exports = router;
