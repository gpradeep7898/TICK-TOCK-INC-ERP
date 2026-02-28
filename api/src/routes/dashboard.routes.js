'use strict';

// routes/dashboard.routes.js
// Dashboard stats endpoint (health checks are handled in server.js)

const { Router } = require('express');
const { query }  = require('../db/pool');

const router = Router();

// GET /api/dashboard/stats
router.get('/stats', async (_req, res) => {
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

module.exports = router;
