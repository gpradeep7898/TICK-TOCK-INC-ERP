'use strict';

// routes/print.routes.js
// Print data endpoints — JSON (legacy) + HTML print views

const { Router } = require('express');
const { query }  = require('../db/pool');

const router = Router();

// ── Shared HTML shell ─────────────────────────────────────────────────────────
function printPage(title, body) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — Tick Tock Inc.</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', Arial, sans-serif; font-size: 13px; color: #1a1a2e; background: #f8f9fa; }
  .page { max-width: 860px; margin: 24px auto; background: #fff; border: 1px solid #dee2e6; border-radius: 6px; padding: 40px 48px; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 32px; border-bottom: 2px solid #0d1b3e; padding-bottom: 20px; }
  .company h1 { font-size: 22px; font-weight: 700; color: #0d1b3e; letter-spacing: 1px; }
  .company p  { font-size: 11px; color: #6c757d; margin-top: 2px; }
  .doc-meta   { text-align: right; }
  .doc-meta .doc-number { font-size: 20px; font-weight: 700; color: #0d1b3e; }
  .doc-meta .doc-label  { font-size: 10px; text-transform: uppercase; letter-spacing: 1px; color: #6c757d; }
  .doc-meta .badge { display: inline-block; margin-top: 6px; padding: 3px 10px; border-radius: 12px; font-size: 11px; font-weight: 600; background: #e7f3fe; color: #0d6efd; }
  .parties { display: grid; grid-template-columns: 1fr 1fr; gap: 32px; margin-bottom: 28px; }
  .party h3 { font-size: 10px; text-transform: uppercase; letter-spacing: 1px; color: #6c757d; margin-bottom: 6px; }
  .party p  { font-size: 13px; line-height: 1.6; }
  .meta-row { display: flex; gap: 32px; margin-bottom: 24px; flex-wrap: wrap; }
  .meta-item label { font-size: 10px; text-transform: uppercase; letter-spacing: 1px; color: #6c757d; display: block; }
  .meta-item span  { font-size: 13px; font-weight: 500; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
  thead th { background: #0d1b3e; color: #fff; padding: 9px 12px; text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
  thead th.r { text-align: right; }
  tbody tr:nth-child(even) { background: #f8f9fa; }
  tbody td { padding: 9px 12px; border-bottom: 1px solid #e9ecef; vertical-align: top; }
  tbody td.r { text-align: right; }
  tfoot td { padding: 8px 12px; font-weight: 600; border-top: 2px solid #dee2e6; }
  tfoot td.r { text-align: right; }
  .totals { margin-left: auto; width: 280px; border-collapse: collapse; }
  .totals td { padding: 5px 8px; }
  .totals .label { color: #6c757d; }
  .totals .grand { font-size: 15px; font-weight: 700; color: #0d1b3e; border-top: 2px solid #0d1b3e; }
  .notes { background: #f8f9fa; border-left: 3px solid #0d1b3e; padding: 12px 16px; border-radius: 0 4px 4px 0; margin-top: 16px; font-size: 12px; color: #495057; }
  .footer { text-align: center; margin-top: 32px; font-size: 11px; color: #adb5bd; border-top: 1px solid #dee2e6; padding-top: 16px; }
  .print-btn { position: fixed; top: 20px; right: 20px; padding: 10px 20px; background: #0d1b3e; color: #fff; border: none; border-radius: 6px; font-size: 14px; font-weight: 600; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.3); }
  .print-btn:hover { background: #1a3060; }
  @media print {
    .print-btn { display: none; }
    body { background: #fff; }
    .page { margin: 0; border: none; border-radius: 0; padding: 20px; max-width: 100%; box-shadow: none; }
  }
</style>
</head>
<body>
<button class="print-btn no-print" onclick="window.print()">🖨 Print</button>
<div class="page">${body}</div>
<script>
  // Auto-print if ?autoprint=1
  if (new URLSearchParams(location.search).get('autoprint') === '1') window.print();
</script>
</body>
</html>`;
}

function fmtMoney(v) { return v == null ? '—' : '$' + parseFloat(v).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
function fmtDate(d)  { if (!d) return '—'; const dt = new Date(d); return (dt.getMonth()+1)+'/'+(dt.getDate())+'/'+(dt.getFullYear()); }
function esc(s)      { return s == null ? '' : String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function addrBlock(a) {
    if (!a) return '';
    if (typeof a === 'string') try { a = JSON.parse(a); } catch { return esc(a); }
    return [a.line1, a.line2, a.city && (a.city + (a.state ? ', ' + a.state : '') + (a.zip ? ' ' + a.zip : '')), a.country]
        .filter(Boolean).join('<br>');
}

// ── Invoice JSON (legacy) ─────────────────────────────────────────────────────
router.get('/invoice/:id', async (req, res) => {
    if (req.query.format !== 'html') {
        // original JSON response
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
            return res.json({ invoice: inv, lines });
        } catch (err) { return res.status(500).json({ error: err.message }); }
    }

    // HTML print view
    try {
        const { rows: [inv] } = await query(
            `SELECT si.*, p.name AS customer_name, p.code AS customer_code,
                    p.email AS customer_email, p.phone AS customer_phone,
                    p.contact_name AS customer_contact,
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
            `SELECT sol.line_number, sl.qty_shipped AS qty, sol.unit_price,
                    sol.discount_pct, sol.line_total,
                    i.code AS item_code, i.name AS item_name, i.unit_of_measure
             FROM shipment_lines sl
             JOIN sales_order_lines sol ON sol.id = sl.sales_order_line_id
             JOIN items i ON i.id = sl.item_id
             WHERE sl.shipment_id = $1
             ORDER BY sol.line_number`, [inv.shipment_id]
        );

        const lineRows = lines.map(l => `
            <tr>
              <td>${esc(l.line_number)}</td>
              <td>${esc(l.item_code)}</td>
              <td>${esc(l.item_name)}</td>
              <td class="r">${esc(l.qty)} ${esc(l.unit_of_measure)}</td>
              <td class="r">${fmtMoney(l.unit_price)}</td>
              <td class="r">${l.discount_pct > 0 ? l.discount_pct + '%' : '—'}</td>
              <td class="r">${fmtMoney(l.line_total)}</td>
            </tr>`).join('');

        const html = `
<div class="header">
  <div class="company"><h1>Tick Tock Inc.</h1><p>Wholesale Watch Distributor</p></div>
  <div class="doc-meta">
    <div class="doc-label">Invoice</div>
    <div class="doc-number">${esc(inv.number)}</div>
    <div class="badge">${esc(inv.status.toUpperCase())}</div>
  </div>
</div>
<div class="parties">
  <div class="party"><h3>Bill To</h3><p><strong>${esc(inv.customer_name)}</strong><br>${addrBlock(inv.billing_address)}</p></div>
  <div class="party"><h3>Ship To</h3><p><strong>${esc(inv.customer_name)}</strong><br>${addrBlock(inv.shipping_address)}</p></div>
</div>
<div class="meta-row">
  <div class="meta-item"><label>Invoice Date</label><span>${fmtDate(inv.invoice_date)}</span></div>
  <div class="meta-item"><label>Due Date</label><span>${fmtDate(inv.due_date)}</span></div>
  <div class="meta-item"><label>Order #</label><span>${esc(inv.order_number) || '—'}</span></div>
  <div class="meta-item"><label>Shipment #</label><span>${esc(inv.shipment_number) || '—'}</span></div>
  ${inv.carrier ? `<div class="meta-item"><label>Carrier</label><span>${esc(inv.carrier)}</span></div>` : ''}
  ${inv.tracking_number ? `<div class="meta-item"><label>Tracking</label><span>${esc(inv.tracking_number)}</span></div>` : ''}
</div>
<table>
  <thead><tr><th>#</th><th>SKU</th><th>Description</th><th class="r">Qty</th><th class="r">Unit Price</th><th class="r">Disc</th><th class="r">Total</th></tr></thead>
  <tbody>${lineRows}</tbody>
</table>
<table class="totals">
  <tr><td class="label">Subtotal</td><td class="r">${fmtMoney(inv.subtotal)}</td></tr>
  <tr><td class="label">Tax</td><td class="r">${fmtMoney(inv.tax_amount)}</td></tr>
  <tr class="grand"><td class="label"><strong>Total Due</strong></td><td class="r"><strong>${fmtMoney(inv.balance_due)}</strong></td></tr>
</table>
${inv.notes ? `<div class="notes"><strong>Notes:</strong> ${esc(inv.notes)}</div>` : ''}
<div class="footer">Tick Tock Inc. &bull; Thank you for your business!</div>`;

        res.setHeader('Content-Type', 'text/html');
        res.send(printPage(`Invoice ${inv.number}`, html));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Pick-list / Shipment JSON (legacy) ────────────────────────────────────────
router.get('/picklist/:shipmentId', async (req, res) => {
    if (req.query.format !== 'html') {
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
            return res.json({ shipment: shp, lines });
        } catch (err) { return res.status(500).json({ error: err.message }); }
    }

    // HTML pick-list
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

        const lineRows = lines.map(l => `
            <tr>
              <td>${esc(l.line_number)}</td>
              <td>${esc(l.item_code)}</td>
              <td>${esc(l.item_name)}</td>
              <td class="r">${esc(l.qty_shipped)} ${esc(l.unit_of_measure)}</td>
              <td>${esc(l.upc_code) || '—'}</td>
              <td style="width:80px;border-bottom:1px solid #ccc;">&nbsp;</td>
            </tr>`).join('');

        const html = `
<div class="header">
  <div class="company"><h1>Tick Tock Inc.</h1><p>Warehouse Pick List</p></div>
  <div class="doc-meta">
    <div class="doc-label">Shipment</div>
    <div class="doc-number">${esc(shp.number)}</div>
  </div>
</div>
<div class="parties">
  <div class="party"><h3>Ship To</h3><p><strong>${esc(shp.customer_name)}</strong><br>${addrBlock(shp.shipping_address)}</p></div>
  <div class="party"><h3>Warehouse</h3><p><strong>${esc(shp.warehouse_name)}</strong> (${esc(shp.warehouse_code)})</p></div>
</div>
<div class="meta-row">
  <div class="meta-item"><label>Ship Date</label><span>${fmtDate(shp.ship_date)}</span></div>
  <div class="meta-item"><label>Order #</label><span>${esc(shp.order_number)}</span></div>
  ${shp.carrier ? `<div class="meta-item"><label>Carrier</label><span>${esc(shp.carrier)}</span></div>` : ''}
</div>
<table>
  <thead><tr><th>#</th><th>SKU</th><th>Item Name</th><th class="r">Qty</th><th>UPC</th><th>Picked ✓</th></tr></thead>
  <tbody>${lineRows}</tbody>
</table>
${shp.order_notes ? `<div class="notes"><strong>Notes:</strong> ${esc(shp.order_notes)}</div>` : ''}
<div class="footer">Tick Tock Inc. &bull; Pick List</div>`;

        res.setHeader('Content-Type', 'text/html');
        res.send(printPage(`Pick List ${shp.number}`, html));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Purchase Order ────────────────────────────────────────────────────────────
router.get('/purchase-order/:id', async (req, res) => {
    try {
        const { rows: [po] } = await query(
            `SELECT po.*, v.name AS vendor_name, v.code AS vendor_code,
                    v.email AS vendor_email, v.phone AS vendor_phone,
                    v.contact_name AS vendor_contact,
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

        if (req.query.format !== 'html') return res.json({ po, lines });

        const lineRows = lines.map(l => `
            <tr>
              <td>${esc(l.line_number)}</td>
              <td>${esc(l.item_code)}</td>
              <td>${esc(l.item_name)} ${l.description ? '<br><small style="color:#6c757d">'+esc(l.description)+'</small>' : ''}</td>
              <td class="r">${esc(l.qty_ordered)} ${esc(l.unit_of_measure)}</td>
              <td class="r">${fmtMoney(l.unit_cost)}</td>
              <td class="r">${fmtMoney(l.line_total)}</td>
            </tr>`).join('');

        const html = `
<div class="header">
  <div class="company"><h1>Tick Tock Inc.</h1><p>Purchase Order</p></div>
  <div class="doc-meta">
    <div class="doc-label">PO Number</div>
    <div class="doc-number">${esc(po.number)}</div>
    <div class="badge">${esc(po.status.toUpperCase())}</div>
  </div>
</div>
<div class="parties">
  <div class="party"><h3>Vendor</h3><p><strong>${esc(po.vendor_name)}</strong>${po.vendor_contact ? '<br>'+esc(po.vendor_contact) : ''}<br>${po.vendor_email || ''}<br>${po.vendor_phone || ''}<br>${addrBlock(po.vendor_address)}</p></div>
  <div class="party"><h3>Ship To (Warehouse)</h3><p><strong>${esc(po.warehouse_name)}</strong>${po.warehouse_address ? '<br>'+esc(po.warehouse_address) : ''}</p></div>
</div>
<div class="meta-row">
  <div class="meta-item"><label>Order Date</label><span>${fmtDate(po.order_date)}</span></div>
  <div class="meta-item"><label>Expected</label><span>${fmtDate(po.expected_date)}</span></div>
  ${po.created_by_name ? `<div class="meta-item"><label>Created By</label><span>${esc(po.created_by_name)}</span></div>` : ''}
</div>
<table>
  <thead><tr><th>#</th><th>SKU</th><th>Description</th><th class="r">Qty</th><th class="r">Unit Cost</th><th class="r">Total</th></tr></thead>
  <tbody>${lineRows}</tbody>
</table>
<table class="totals">
  <tr class="grand"><td class="label"><strong>Total</strong></td><td class="r"><strong>${fmtMoney(po.total)}</strong></td></tr>
</table>
${po.notes ? `<div class="notes"><strong>Notes:</strong> ${esc(po.notes)}</div>` : ''}
<div class="footer">Tick Tock Inc. &bull; Purchase Order</div>`;

        res.setHeader('Content-Type', 'text/html');
        res.send(printPage(`PO ${po.number}`, html));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Sales Order ───────────────────────────────────────────────────────────────
router.get('/sales-order/:id', async (req, res) => {
    try {
        const { rows: [order] } = await query(
            `SELECT so.*, p.name AS customer_name, p.code AS customer_code,
                    p.email AS customer_email, p.phone AS customer_phone,
                    p.contact_name AS customer_contact,
                    p.billing_address, p.shipping_address,
                    w.name AS warehouse_name, w.code AS warehouse_code,
                    u.name AS created_by_name
             FROM sales_orders so
             JOIN parties p ON p.id = so.customer_id
             JOIN warehouses w ON w.id = so.warehouse_id
             LEFT JOIN users u ON u.id = so.created_by
             WHERE so.id = $1`, [req.params.id]
        );
        if (!order) return res.status(404).json({ error: 'Sales order not found' });
        const { rows: lines } = await query(
            `SELECT sol.line_number, sol.qty_ordered, sol.qty_shipped, sol.unit_price,
                    sol.discount_pct, sol.line_total, sol.description,
                    i.code AS item_code, i.name AS item_name, i.unit_of_measure, i.upc_code
             FROM sales_order_lines sol
             JOIN items i ON i.id = sol.item_id
             WHERE sol.sales_order_id = $1
             ORDER BY sol.line_number`, [req.params.id]
        );

        if (req.query.format !== 'html') return res.json({ order, lines });

        const lineRows = lines.map(l => `
            <tr>
              <td>${esc(l.line_number)}</td>
              <td>${esc(l.item_code)}</td>
              <td>${esc(l.item_name)}</td>
              <td class="r">${esc(l.qty_ordered)} ${esc(l.unit_of_measure)}</td>
              <td class="r">${fmtMoney(l.unit_price)}</td>
              <td class="r">${l.discount_pct > 0 ? l.discount_pct + '%' : '—'}</td>
              <td class="r">${fmtMoney(l.line_total)}</td>
            </tr>`).join('');

        const html = `
<div class="header">
  <div class="company"><h1>Tick Tock Inc.</h1><p>Sales Order</p></div>
  <div class="doc-meta">
    <div class="doc-label">Order Number</div>
    <div class="doc-number">${esc(order.number)}</div>
    <div class="badge">${esc(order.status.toUpperCase())}</div>
  </div>
</div>
<div class="parties">
  <div class="party"><h3>Bill To</h3><p><strong>${esc(order.customer_name)}</strong>${order.customer_contact ? '<br>'+esc(order.customer_contact) : ''}<br>${order.customer_email || ''}<br>${addrBlock(order.billing_address)}</p></div>
  <div class="party"><h3>Ship To</h3><p><strong>${esc(order.customer_name)}</strong><br>${addrBlock(order.shipping_address)}</p></div>
</div>
<div class="meta-row">
  <div class="meta-item"><label>Order Date</label><span>${fmtDate(order.order_date)}</span></div>
  <div class="meta-item"><label>Req. Ship Date</label><span>${fmtDate(order.requested_ship_date)}</span></div>
  <div class="meta-item"><label>Warehouse</label><span>${esc(order.warehouse_name)}</span></div>
  ${order.created_by_name ? `<div class="meta-item"><label>Created By</label><span>${esc(order.created_by_name)}</span></div>` : ''}
</div>
<table>
  <thead><tr><th>#</th><th>SKU</th><th>Description</th><th class="r">Qty</th><th class="r">Unit Price</th><th class="r">Disc</th><th class="r">Total</th></tr></thead>
  <tbody>${lineRows}</tbody>
</table>
<table class="totals">
  <tr><td class="label">Subtotal</td><td class="r">${fmtMoney(order.subtotal)}</td></tr>
  <tr><td class="label">Tax (${order.tax_rate > 0 ? (order.tax_rate * 100).toFixed(2) + '%' : '0%'})</td><td class="r">${fmtMoney(order.tax_amount)}</td></tr>
  <tr class="grand"><td class="label"><strong>Order Total</strong></td><td class="r"><strong>${fmtMoney(order.total)}</strong></td></tr>
</table>
${order.notes ? `<div class="notes"><strong>Notes:</strong> ${esc(order.notes)}</div>` : ''}
<div class="footer">Tick Tock Inc. &bull; Sales Order</div>`;

        res.setHeader('Content-Type', 'text/html');
        res.send(printPage(`SO ${order.number}`, html));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Adjustment ────────────────────────────────────────────────────────────────
router.get('/adjustment/:id', async (req, res) => {
    try {
        const { rows: [adj] } = await query(
            `SELECT sa.*, w.name AS warehouse_name, w.code AS warehouse_code,
                    u.name AS created_by_name
             FROM stock_adjustments sa
             JOIN warehouses w ON w.id = sa.warehouse_id
             LEFT JOIN users u ON u.id = sa.created_by
             WHERE sa.id = $1`, [req.params.id]
        );
        if (!adj) return res.status(404).json({ error: 'Adjustment not found' });
        const { rows: lines } = await query(
            `SELECT sal.*, i.code AS item_code, i.name AS item_name, i.unit_of_measure
             FROM stock_adjustment_lines sal
             JOIN items i ON i.id = sal.item_id
             WHERE sal.adjustment_id = $1
             ORDER BY i.code`, [req.params.id]
        );

        if (req.query.format !== 'html') return res.json({ adjustment: adj, lines });

        const lineRows = lines.map(l => `
            <tr>
              <td>${esc(l.item_code)}</td>
              <td>${esc(l.item_name)}</td>
              <td class="r">${esc(l.qty_system)} ${esc(l.unit_of_measure)}</td>
              <td class="r">${esc(l.qty_actual)} ${esc(l.unit_of_measure)}</td>
              <td class="r" style="font-weight:600;color:${(l.qty_actual - l.qty_system) >= 0 ? '#198754' : '#dc3545'}">${(l.qty_actual - l.qty_system) >= 0 ? '+' : ''}${(l.qty_actual - l.qty_system).toFixed(4)}</td>
              <td class="r">${fmtMoney(l.cost_per_unit)}</td>
              <td>${esc(l.notes) || '—'}</td>
            </tr>`).join('');

        const html = `
<div class="header">
  <div class="company"><h1>Tick Tock Inc.</h1><p>Inventory Adjustment</p></div>
  <div class="doc-meta">
    <div class="doc-label">Adjustment</div>
    <div class="doc-number">${esc(adj.number || adj.id)}</div>
    <div class="badge">${esc(adj.status.toUpperCase())}</div>
  </div>
</div>
<div class="meta-row">
  <div class="meta-item"><label>Date</label><span>${fmtDate(adj.adjustment_date)}</span></div>
  <div class="meta-item"><label>Warehouse</label><span>${esc(adj.warehouse_name)} (${esc(adj.warehouse_code)})</span></div>
  ${adj.created_by_name ? `<div class="meta-item"><label>Created By</label><span>${esc(adj.created_by_name)}</span></div>` : ''}
  ${adj.reason ? `<div class="meta-item"><label>Reason</label><span>${esc(adj.reason)}</span></div>` : ''}
</div>
<table>
  <thead><tr><th>SKU</th><th>Item Name</th><th class="r">System Qty</th><th class="r">Actual Qty</th><th class="r">Variance</th><th class="r">Cost/Unit</th><th>Notes</th></tr></thead>
  <tbody>${lineRows}</tbody>
</table>
${adj.notes ? `<div class="notes"><strong>Notes:</strong> ${esc(adj.notes)}</div>` : ''}
<div class="footer">Tick Tock Inc. &bull; Inventory Adjustment</div>`;

        res.setHeader('Content-Type', 'text/html');
        res.send(printPage(`Adjustment ${adj.number || adj.id}`, html));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
