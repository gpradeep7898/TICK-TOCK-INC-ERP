'use strict';

// routes/analytics.routes.js
// Module 11 — Advanced Analytics: aggregated KPIs and chart data

const { Router } = require('express');
const { query }  = require('../db/pool');

const router = Router();

// ── GET /api/analytics/overview ───────────────────────────────────────────────
// Combined top-level KPIs for the analytics page header
router.get('/overview', async (_req, res) => {
    try {
        const [revenue, ar, ap, items, orders, customers] = await Promise.all([
            query(`SELECT COALESCE(SUM(subtotal), 0) AS revenue_30d
                   FROM sales_orders
                   WHERE status NOT IN ('cancelled','draft')
                     AND order_date >= CURRENT_DATE - 30`),
            query(`SELECT COALESCE(SUM(balance_due), 0) AS ar_balance
                   FROM sales_invoices WHERE status IN ('sent','partial')`),
            query(`SELECT COALESCE(SUM(amount_due - amount_paid), 0) AS ap_balance
                   FROM vendor_invoices WHERE status IN ('received','partial')`),
            query(`SELECT COUNT(*) AS item_count FROM items WHERE is_active = true`),
            query(`SELECT COUNT(*) AS order_count FROM sales_orders
                   WHERE status NOT IN ('cancelled','draft') AND order_date >= CURRENT_DATE - 30`),
            query(`SELECT COUNT(DISTINCT customer_id) AS customer_count
                   FROM sales_orders
                   WHERE status NOT IN ('cancelled','draft') AND order_date >= CURRENT_DATE - 30`),
        ]);
        res.json({ success: true, data: {
            revenue_30d:     parseFloat(revenue.rows[0].revenue_30d),
            ar_balance:      parseFloat(ar.rows[0].ar_balance),
            ap_balance:      parseFloat(ap.rows[0].ap_balance),
            item_count:      parseInt(items.rows[0].item_count, 10),
            orders_30d:      parseInt(orders.rows[0].order_count, 10),
            customers_30d:   parseInt(customers.rows[0].customer_count, 10),
        }});
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── GET /api/analytics/revenue-trend ──────────────────────────────────────────
// Monthly revenue for the last 13 months (for a 12-month trailing chart)
router.get('/revenue-trend', async (_req, res) => {
    try {
        const { rows } = await query(`
            SELECT
                TO_CHAR(DATE_TRUNC('month', order_date), 'YYYY-MM') AS month,
                COALESCE(SUM(subtotal), 0)::NUMERIC(14,2)           AS revenue,
                COUNT(*)::INT                                         AS order_count
            FROM   sales_orders
            WHERE  status NOT IN ('cancelled','draft')
              AND  order_date >= DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '11 months'
            GROUP  BY 1
            ORDER  BY 1
        `);
        res.json({ success: true, data: rows });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── GET /api/analytics/top-customers ──────────────────────────────────────────
// Top 10 customers by 12-month revenue
router.get('/top-customers', async (_req, res) => {
    try {
        const { rows } = await query(`
            SELECT
                p.name     AS customer_name,
                p.code     AS customer_code,
                p.vip_tier,
                COALESCE(SUM(so.subtotal), 0)::NUMERIC(14,2) AS revenue_12m,
                COUNT(DISTINCT so.id)::INT                    AS order_count,
                MAX(so.order_date)                            AS last_order_date
            FROM   sales_orders so
            JOIN   parties p ON p.id = so.customer_id
            WHERE  so.status NOT IN ('cancelled','draft')
              AND  so.order_date >= CURRENT_DATE - 365
            GROUP  BY p.id, p.name, p.code, p.vip_tier
            ORDER  BY revenue_12m DESC
            LIMIT  10
        `);
        res.json({ success: true, data: rows });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── GET /api/analytics/top-items ──────────────────────────────────────────────
// Top 10 items by 12-month revenue value
router.get('/top-items', async (_req, res) => {
    try {
        const { rows } = await query(`
            SELECT
                i.code           AS item_code,
                i.name           AS item_name,
                i.category,
                SUM(ABS(sl.qty))::NUMERIC(14,2)                   AS qty_sold_12m,
                COALESCE(SUM(ABS(sl.qty) * i.sale_price), 0)::NUMERIC(14,2) AS revenue_12m
            FROM   stock_ledger sl
            JOIN   items i ON i.id = sl.item_id
            WHERE  sl.transaction_type = 'shipment'
              AND  sl.qty < 0
              AND  sl.posting_date >= CURRENT_DATE - 365
            GROUP  BY i.id, i.code, i.name, i.category
            ORDER  BY revenue_12m DESC
            LIMIT  10
        `);
        res.json({ success: true, data: rows });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── GET /api/analytics/inventory-health ───────────────────────────────────────
// Urgency distribution from v_sales_velocity
router.get('/inventory-health', async (_req, res) => {
    try {
        const { rows } = await query(`
            SELECT
                urgency,
                COUNT(*)::INT                                       AS item_count,
                COALESCE(SUM(qty_available * standard_cost), 0)::NUMERIC(14,2) AS value_at_cost
            FROM   v_sales_velocity
            GROUP  BY urgency
            ORDER  BY CASE urgency WHEN 'critical' THEN 1 WHEN 'high' THEN 2
                                   WHEN 'normal' THEN 3 ELSE 4 END
        `);
        res.json({ success: true, data: rows });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── GET /api/analytics/cash-flow ──────────────────────────────────────────────
// AR collections vs AP payments, last 6 months by month
router.get('/cash-flow', async (_req, res) => {
    try {
        const [collections, payments] = await Promise.all([
            query(`
                SELECT
                    TO_CHAR(DATE_TRUNC('month', payment_date), 'YYYY-MM') AS month,
                    COALESCE(SUM(amount), 0)::NUMERIC(14,2)               AS collected
                FROM   payments_received
                WHERE  payment_date >= DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '5 months'
                GROUP  BY 1 ORDER BY 1
            `),
            query(`
                SELECT
                    TO_CHAR(DATE_TRUNC('month', payment_date), 'YYYY-MM') AS month,
                    COALESCE(SUM(amount), 0)::NUMERIC(14,2)               AS paid_out
                FROM   vendor_payments
                WHERE  payment_date >= DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '5 months'
                GROUP  BY 1 ORDER BY 1
            `),
        ]);

        // Merge into a map by month
        const months = new Set([
            ...collections.rows.map(r => r.month),
            ...payments.rows.map(r => r.month),
        ]);
        const cMap = Object.fromEntries(collections.rows.map(r => [r.month, r.collected]));
        const pMap = Object.fromEntries(payments.rows.map(r => [r.month, r.paid_out]));
        const data = [...months].sort().map(m => ({
            month:     m,
            collected: parseFloat(cMap[m] || 0),
            paid_out:  parseFloat(pMap[m] || 0),
        }));
        res.json({ success: true, data });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── GET /api/analytics/pipeline ───────────────────────────────────────────────
// CRM opportunity pipeline by stage
router.get('/pipeline', async (_req, res) => {
    try {
        const { rows } = await query(`
            SELECT
                stage,
                COUNT(*)::INT                                          AS count,
                COALESCE(SUM(estimated_value), 0)::NUMERIC(14,2)      AS total_value,
                COALESCE(SUM(estimated_value * probability / 100), 0)::NUMERIC(14,2) AS weighted_value
            FROM   opportunities
            WHERE  stage NOT IN ('won','lost')
            GROUP  BY stage
            ORDER  BY CASE stage WHEN 'lead' THEN 1 WHEN 'qualified' THEN 2
                                 WHEN 'proposal' THEN 3 ELSE 4 END
        `);
        res.json({ success: true, data: rows });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── GET /api/analytics/category-mix ──────────────────────────────────────────
// Revenue split by item category, last 12 months
router.get('/category-mix', async (_req, res) => {
    try {
        const { rows } = await query(`
            SELECT
                COALESCE(i.category, 'Uncategorized') AS category,
                SUM(ABS(sl.qty))::NUMERIC(14,2)       AS qty_sold,
                COALESCE(SUM(ABS(sl.qty) * i.sale_price), 0)::NUMERIC(14,2) AS revenue
            FROM   stock_ledger sl
            JOIN   items i ON i.id = sl.item_id
            WHERE  sl.transaction_type = 'shipment'
              AND  sl.qty < 0
              AND  sl.posting_date >= CURRENT_DATE - 365
            GROUP  BY 1
            ORDER  BY revenue DESC
        `);
        res.json({ success: true, data: rows });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

module.exports = router;
