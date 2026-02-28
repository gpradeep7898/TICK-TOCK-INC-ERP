'use strict';

// routes/financials.routes.js
// Financial dashboard: KPIs, revenue by month, top customers/items, cash position, P&L

const { Router } = require('express');
const { query }  = require('../db/pool');

const router = Router();

// GET /api/financials/summary
router.get('/summary', async (_req, res) => {
    try {
        const { rows: [r] } = await query(`
            SELECT
                (SELECT COALESCE(SUM(total),0) FROM sales_invoices
                 WHERE date_trunc('month', invoice_date) = date_trunc('month', CURRENT_DATE))   AS revenue_mtd,
                (SELECT COALESCE(SUM(total),0) FROM sales_invoices
                 WHERE date_trunc('year',  invoice_date) = date_trunc('year',  CURRENT_DATE))   AS revenue_ytd,
                (SELECT COALESCE(SUM(balance_due),0) FROM sales_invoices
                 WHERE status NOT IN ('paid','void'))                                            AS ar_open,
                (SELECT COALESCE(SUM(balance_due),0) FROM sales_invoices
                 WHERE status NOT IN ('paid','void') AND due_date < CURRENT_DATE)               AS ar_overdue,
                (SELECT COALESCE(SUM(prl.actual_cost * prl.qty_received),0)
                 FROM purchase_receipt_lines prl
                 JOIN purchase_receipts pr ON pr.id = prl.receipt_id
                 WHERE date_trunc('year', pr.receipt_date) = date_trunc('year', CURRENT_DATE))  AS cogs_ytd,
                (SELECT COALESCE(SUM(balance_due),0) FROM vendor_invoices
                 WHERE status NOT IN ('paid','void'))                                            AS ap_open,
                (SELECT COALESCE(SUM(balance_due),0) FROM vendor_invoices
                 WHERE status NOT IN ('paid','void') AND due_date < CURRENT_DATE)               AS ap_overdue,
                (SELECT COUNT(*) FROM sales_orders    WHERE status NOT IN ('closed','cancelled')) AS open_so_count,
                (SELECT COUNT(*) FROM purchase_orders WHERE status NOT IN ('closed','cancelled')) AS open_po_count,
                (SELECT COALESCE(SUM(sl_agg.net_qty * i.standard_cost),0)
                 FROM (SELECT item_id, SUM(qty) AS net_qty FROM stock_ledger GROUP BY item_id) sl_agg
                 JOIN items i ON i.id = sl_agg.item_id
                 WHERE sl_agg.net_qty > 0)                                                      AS inventory_value
        `);
        res.json(r);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/financials/revenue-by-month
router.get('/revenue-by-month', async (_req, res) => {
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

// GET /api/financials/top-customers
router.get('/top-customers', async (_req, res) => {
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

// GET /api/financials/top-items
router.get('/top-items', async (_req, res) => {
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

// GET /api/financials/cash-position
router.get('/cash-position', async (_req, res) => {
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

// GET /api/financials/pl-detail
router.get('/pl-detail', async (_req, res) => {
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

module.exports = router;
