'use strict';

// routes/shipping.routes.js
// Module 6 — Fulfillment & Shipping

const { Router } = require('express');
const { query, pool } = require('../db/pool');
const { z } = require('zod');
const { validate } = require('../middleware/validate');

const router = Router();

// ── Schemas ───────────────────────────────────────────────────────────────────
const UUID = z.string().uuid();

const RateQuoteSchema = z.object({
    weight_lb:   z.coerce.number().positive(),
    from_zip:    z.string().trim().min(3),
    to_zip:      z.string().trim().min(3),
    shipment_id: UUID.optional(),
});

const AddTrackingSchema = z.object({
    carrier:         z.string().trim().min(2),
    service_level:   z.string().trim().optional(),
    tracking_number: z.string().trim().min(4),
    freight_cost:    z.coerce.number().nonnegative().optional(),
    weight_lb:       z.coerce.number().positive().optional(),
    shipped_by:      UUID.optional(),
});

// ── Mock rate engine ──────────────────────────────────────────────────────────
// Rates are illustrative; in production swap with carrier SDK calls.
function mockRates(weightLb, fromZip, toZip) {
    const zone = Math.abs(parseInt(fromZip, 10) - parseInt(toZip, 10));
    const zoneFactor = zone > 50000 ? 1.6 : zone > 20000 ? 1.3 : zone > 5000 ? 1.1 : 1.0;

    const baseRates = [
        { carrier: 'UPS',   service_level: 'UPS Ground',          base: 8.50,  days: 5 },
        { carrier: 'UPS',   service_level: 'UPS 3 Day Select',    base: 18.00, days: 3 },
        { carrier: 'UPS',   service_level: 'UPS 2nd Day Air',     base: 29.00, days: 2 },
        { carrier: 'UPS',   service_level: 'UPS Next Day Air',    base: 52.00, days: 1 },
        { carrier: 'FEDEX', service_level: 'FedEx Ground',        base: 8.25,  days: 5 },
        { carrier: 'FEDEX', service_level: 'FedEx Express Saver', base: 22.00, days: 3 },
        { carrier: 'FEDEX', service_level: 'FedEx 2Day',          base: 31.00, days: 2 },
        { carrier: 'FEDEX', service_level: 'FedEx Overnight',     base: 55.00, days: 1 },
        { carrier: 'USPS',  service_level: 'USPS Ground Advantage',base: 6.80, days: 7 },
        { carrier: 'USPS',  service_level: 'USPS Priority Mail',  base: 9.35,  days: 3 },
        { carrier: 'USPS',  service_level: 'USPS Priority Express',base: 28.75,days: 1 },
        { carrier: 'DHL',   service_level: 'DHL Express Worldwide',base: 38.00,days: 2 },
    ];

    return baseRates.map(r => ({
        carrier:        r.carrier,
        service_level:  r.service_level,
        estimated_days: r.days,
        rate: parseFloat(
            (r.base * zoneFactor + weightLb * (r.carrier === 'USPS' ? 0.35 : 0.55))
                .toFixed(2)
        ),
    })).sort((a, b) => a.rate - b.rate);
}

// ── GET /api/shipping/carriers ────────────────────────────────────────────────
router.get('/carriers', async (_req, res) => {
    try {
        const { rows } = await query(
            `SELECT * FROM shipping_carriers WHERE is_active = true ORDER BY code`
        );
        res.json({ success: true, data: rows });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── POST /api/shipping/rate-quote ─────────────────────────────────────────────
router.post('/rate-quote', validate(RateQuoteSchema), async (req, res) => {
    const { weight_lb, from_zip, to_zip, shipment_id } = req.body;
    try {
        const rates = mockRates(weight_lb, from_zip, to_zip);

        // Persist quotes so they appear on the shipment record
        if (shipment_id) {
            const client = await pool.connect();
            try {
                for (const r of rates) {
                    await client.query(
                        `INSERT INTO shipping_rate_quotes
                            (shipment_id, carrier, service_level, estimated_days, rate, weight_lb, from_zip, to_zip)
                         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
                        [shipment_id, r.carrier, r.service_level,
                         r.estimated_days, r.rate, weight_lb, from_zip, to_zip]
                    );
                }
            } finally { client.release(); }
        }

        res.json({ success: true, data: rates });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── PATCH /api/shipping/shipments/:id/tracking ────────────────────────────────
router.patch('/shipments/:id/tracking', validate(AddTrackingSchema), async (req, res) => {
    const { carrier, service_level, tracking_number,
            freight_cost, weight_lb, shipped_by } = req.body;
    try {
        const { rows } = await query(
            `UPDATE shipments
             SET carrier         = $1,
                 service_level   = COALESCE($2, service_level),
                 tracking_number = $3,
                 freight_cost    = COALESCE($4, freight_cost),
                 weight_lb       = COALESCE($5, weight_lb),
                 shipped_by      = COALESCE($6, shipped_by),
                 updated_at      = NOW()
             WHERE id = $7
             RETURNING *`,
            [carrier, service_level || null, tracking_number,
             freight_cost ?? null, weight_lb ?? null,
             shipped_by || null, req.params.id]
        );
        if (!rows.length)
            return res.status(404).json({ success: false, error: 'Shipment not found' });
        res.json({ success: true, data: rows[0] });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── GET /api/shipping/shipments/:id/quotes ────────────────────────────────────
router.get('/shipments/:id/quotes', async (req, res) => {
    try {
        const { rows } = await query(
            `SELECT * FROM shipping_rate_quotes
             WHERE shipment_id = $1 ORDER BY rate ASC`,
            [req.params.id]
        );
        res.json({ success: true, data: rows });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

module.exports = router;
