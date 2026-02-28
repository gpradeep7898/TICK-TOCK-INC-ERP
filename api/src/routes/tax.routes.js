'use strict';

// routes/tax.routes.js
// State tax rates CRUD + tax calculation

const { Router } = require('express');
const { query }  = require('../db/pool');

const router = Router();

// ── Helper ────────────────────────────────────────────────────────────────────
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
        tax_amount: parseFloat((subtotal * rate).toFixed(4)),
        rate,
        state_code: cust.state_code,
        exempt:     false
    };
}

// GET /api/tax/rates
router.get('/rates', async (_req, res) => {
    try {
        const { rows } = await query(`SELECT * FROM state_tax_rates ORDER BY state_name`);
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/tax/rates/:stateCode
router.get('/rates/:stateCode', async (req, res) => {
    try {
        const { rows } = await query(
            `SELECT * FROM state_tax_rates WHERE state_code = $1`,
            [req.params.stateCode.toUpperCase()]
        );
        if (!rows.length) return res.status(404).json({ error: 'State not found' });
        res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/tax/rates/:stateCode
router.put('/rates/:stateCode', async (req, res) => {
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

// GET /api/tax/calculate?customerId=X&subtotal=Y
router.get('/calculate', async (req, res) => {
    const { customerId, subtotal } = req.query;
    if (!customerId || subtotal == null) return res.status(400).json({ error: 'customerId and subtotal required' });
    try {
        const taxInfo = await calculateInvoiceTax(customerId, parseFloat(subtotal));
        res.json({ ...taxInfo, subtotal: parseFloat(subtotal),
                   total: parseFloat(subtotal) + taxInfo.tax_amount });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
