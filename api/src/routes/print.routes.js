'use strict';

// routes/print.routes.js
// Print data endpoints for invoice, picklist, purchase order templates

const { Router } = require('express');
const { query }  = require('../db/pool');

const router = Router();

// GET /api/print/invoice/:id
router.get('/invoice/:id', async (req, res) => {
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

// GET /api/print/picklist/:shipmentId
router.get('/picklist/:shipmentId', async (req, res) => {
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

// GET /api/print/purchase-order/:id
router.get('/purchase-order/:id', async (req, res) => {
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

module.exports = router;
