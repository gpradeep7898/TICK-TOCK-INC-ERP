'use strict';

// routes/sales.routes.js
// Customers, Sales Orders, Shipments, Invoices, AR Payments, AR Aging

const { Router } = require('express');
const { query, pool }         = require('../db/pool');
const { validate }            = require('../middleware/validate');
const { parsePage, paginate } = require('../lib/pagination');
const {
    CreateCustomerSchema, PatchCustomerSchema,
    CreateSOSchema, CreateShipmentSchema, CreatePaymentSchema,
} = require('../lib/schemas');

const router = Router();

// ── Number generator ──────────────────────────────────────────────────────────
async function nextDocNumber(client, table, col, prefix) {
    const year = new Date().getFullYear();
    const pfx  = `${prefix}-${year}-`;
    const { rows } = await client.query(
        `SELECT ${col} FROM ${table} WHERE ${col} LIKE $1 ORDER BY ${col} DESC LIMIT 1`,
        [`${pfx}%`]
    );
    const seq = rows.length === 0 ? 1 : parseInt(rows[0][col].split('-').pop(), 10) + 1;
    return `${pfx}${String(seq).padStart(5, '0')}`;
}

// ── Tax helper ────────────────────────────────────────────────────────────────
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

// ── Customers ─────────────────────────────────────────────────────────────────

router.get('/customers', async (req, res) => {
    try {
        const { page, limit, offset } = parsePage(req.query);
        const { rows: [{ count }] } = await query(
            `SELECT COUNT(*) FROM parties WHERE type IN ('customer','both')`
        );
        const { rows } = await query(
            `SELECT p.*,
                    COALESCE(ar.total_due,0) AS ar_balance
             FROM   parties p
             LEFT JOIN v_ar_aging ar ON ar.customer_id = p.id
             WHERE  p.type IN ('customer','both')
             ORDER  BY p.name
             LIMIT $1 OFFSET $2`,
            [limit, offset]
        );
        res.json(paginate(rows, parseInt(count, 10), page, limit));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/customers/:id', async (req, res) => {
    try {
        const { rows: [cust] } = await query(
            `SELECT p.*, COALESCE(ar.total_due,0) AS ar_balance,
                    ar.current_due, ar.days_1_30, ar.days_31_60, ar.days_61_90, ar.days_90plus
             FROM   parties p
             LEFT JOIN v_ar_aging ar ON ar.customer_id = p.id
             WHERE  p.id = $1`, [req.params.id]
        );
        if (!cust) return res.status(404).json({ error: 'Customer not found' });

        const { rows: openInvoices } = await query(
            `SELECT * FROM sales_invoices
             WHERE customer_id = $1 AND status NOT IN ('paid','void')
             ORDER BY due_date`, [req.params.id]
        );
        const { rows: recentOrders } = await query(
            `SELECT * FROM v_open_sales_orders WHERE customer_id = $1
             ORDER BY created_at DESC LIMIT 10`, [req.params.id]
        );
        res.json({ ...cust, open_invoices: openInvoices, recent_orders: recentOrders });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/customers', validate(CreateCustomerSchema), async (req, res) => {
    const { code, name, contact_name, email, phone, fax, website,
            billing_address, shipping_address,
            city, state_province, postal_code, country,
            payment_terms_days, payment_terms_label, credit_limit, currency, notes,
            tax_exempt, tax_exempt_certificate, tax_exempt_expiry,
            state_code, vip_tier } = req.body;
    try {
        const { rows } = await query(
            `INSERT INTO parties
                (type,code,name,contact_name,email,phone,fax,website,
                 billing_address,shipping_address,
                 city,state_province,postal_code,country,
                 payment_terms_days,payment_terms_label,credit_limit,currency,notes,
                 tax_exempt,tax_exempt_certificate,tax_exempt_expiry,state_code,vip_tier)
             VALUES ('customer',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
             RETURNING *`,
            [code, name, contact_name || null, email || null, phone || null, fax || null, website || null,
             billing_address ? JSON.stringify(billing_address) : null,
             shipping_address ? JSON.stringify(shipping_address) : null,
             city || null, state_province || null, postal_code || null, country || 'US',
             payment_terms_days, payment_terms_label || 'NET30', credit_limit, currency, notes || null,
             tax_exempt, tax_exempt_certificate || null, tax_exempt_expiry || null,
             state_code || null, vip_tier]
        );
        res.status(201).json(rows[0]);
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: 'Customer code already exists' });
        res.status(500).json({ error: err.message });
    }
});

router.patch('/customers/:id', validate(PatchCustomerSchema), async (req, res) => {
    const fields = Object.keys(req.body).filter(k => req.body[k] !== undefined);
    if (!fields.length) return res.status(400).json({ error: 'No valid fields' });
    const sets   = fields.map((f, i) => `${f} = $${i + 2}`).join(', ');
    const values = fields.map(f => {
        const v = req.body[f];
        return (f === 'billing_address' || f === 'shipping_address') && typeof v === 'object'
            ? JSON.stringify(v) : v;
    });
    try {
        const { rows } = await query(
            `UPDATE parties SET ${sets}, updated_at = NOW() WHERE id = $1 RETURNING *`,
            [req.params.id, ...values]
        );
        if (!rows.length) return res.status(404).json({ error: 'Customer not found' });
        res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Sales Orders ──────────────────────────────────────────────────────────────

router.get('/sales-orders/dashboard', async (_req, res) => {
    try {
        const { rows: [stats] } = await query(
            `SELECT
                COUNT(*) FILTER (WHERE status NOT IN ('cancelled'))                  AS total_orders,
                COUNT(*) FILTER (WHERE status IN ('confirmed','partially_shipped'))  AS open_orders,
                COUNT(*) FILTER (WHERE status IN ('fully_shipped','invoiced'))       AS shipped_orders,
                COALESCE(SUM(total) FILTER (
                    WHERE status NOT IN ('draft','cancelled')
                    AND DATE_TRUNC('month',order_date)=DATE_TRUNC('month',CURRENT_DATE)),0) AS revenue_mtd,
                COALESCE(SUM(total) FILTER (WHERE status NOT IN ('draft','cancelled')),0) AS revenue_total
             FROM sales_orders`
        );
        const { rows: recentOrders } = await query(
            `SELECT * FROM v_open_sales_orders ORDER BY created_at DESC LIMIT 5`
        );
        res.json({ ...stats, recent_orders: recentOrders });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/sales-orders', async (req, res) => {
    const { status } = req.query;
    try {
        const { page, limit, offset } = parsePage(req.query);
        const cond   = status ? `WHERE so.status = $1` : '';
        const params = status ? [status] : [];

        const { rows: [{ count }] } = await query(
            `SELECT COUNT(*) FROM sales_orders so ${cond}`, params
        );
        const { rows } = await query(
            `SELECT so.id, so.number, so.status, so.order_date, so.requested_ship_date,
                    so.subtotal, so.tax_amount, so.total, so.created_at, so.notes,
                    p.code AS customer_code, p.name AS customer_name,
                    w.code AS warehouse_code,
                    (SELECT COUNT(*) FROM sales_order_lines sol WHERE sol.sales_order_id = so.id) AS line_count
             FROM   sales_orders so
             JOIN   parties p ON p.id = so.customer_id
             JOIN   warehouses w ON w.id = so.warehouse_id
             ${cond}
             ORDER  BY so.created_at DESC
             LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
            [...params, limit, offset]
        );
        res.json(paginate(rows, parseInt(count, 10), page, limit));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/sales-orders/:id', async (req, res) => {
    try {
        const { rows: [order] } = await query(
            `SELECT so.*, p.code AS customer_code, p.name AS customer_name,
                    p.email AS customer_email, p.phone AS customer_phone,
                    p.billing_address, p.shipping_address, p.payment_terms_days,
                    w.code AS warehouse_code
             FROM   sales_orders so
             JOIN   parties p ON p.id = so.customer_id
             JOIN   warehouses w ON w.id = so.warehouse_id
             WHERE  so.id = $1`, [req.params.id]
        );
        if (!order) return res.status(404).json({ error: 'Order not found' });

        const { rows: lines } = await query(
            `SELECT sol.*, i.code AS item_code, i.name AS item_name,
                    i.unit_of_measure, i.category,
                    COALESCE(av.qty_available,0) AS stock_available
             FROM   sales_order_lines sol
             JOIN   items i ON i.id = sol.item_id
             LEFT JOIN v_stock_availability av
                    ON av.item_id = sol.item_id AND av.warehouse_id = $2
             WHERE  sol.sales_order_id = $1
             ORDER  BY sol.line_number`,
            [req.params.id, order.warehouse_id]
        );

        const { rows: shipsData } = await query(
            `SELECT s.*, u.name AS created_by_name
             FROM   shipments s
             LEFT JOIN users u ON u.id = s.created_by
             WHERE  s.sales_order_id = $1
             ORDER  BY s.created_at DESC`,
            [req.params.id]
        );

        const { rows: invoices } = await query(
            `SELECT * FROM sales_invoices WHERE sales_order_id = $1`, [req.params.id]
        );

        res.json({ ...order, lines, shipments: shipsData, invoices });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/sales-orders', validate(CreateSOSchema), async (req, res) => {
    const { customer_id, warehouse_id, price_list_id, order_date, requested_ship_date,
            tax_rate, notes, lines, created_by } = req.body;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const number = await nextDocNumber(client, 'sales_orders', 'number', 'SO');

        const { rows: [order] } = await client.query(
            `INSERT INTO sales_orders
                (number, customer_id, warehouse_id, price_list_id, order_date,
                 requested_ship_date, tax_rate, notes, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
            [number, customer_id, warehouse_id, price_list_id || null,
             order_date || new Date().toISOString().slice(0, 10),
             requested_ship_date || null, tax_rate, notes || null, created_by || null]
        );

        let subtotal = 0;
        for (let idx = 0; idx < lines.length; idx++) {
            const { item_id, qty_ordered, unit_price, discount_pct = 0, description } = lines[idx];
            if (!item_id || !qty_ordered) throw new Error('Each line requires item_id and qty_ordered');

            let price = unit_price;
            if (price == null) {
                const { rows: [item] } = await client.query(
                    `SELECT sale_price FROM items WHERE id = $1`, [item_id]
                );
                price = item ? parseFloat(item.sale_price) : 0;
            }

            const { rows: [sol] } = await client.query(
                `INSERT INTO sales_order_lines
                    (sales_order_id, line_number, item_id, description,
                     qty_ordered, unit_price, discount_pct)
                 VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
                [order.id, idx + 1, item_id, description || null,
                 qty_ordered, price, discount_pct]
            );
            subtotal += parseFloat(sol.line_total);
        }

        await client.query(
            `UPDATE sales_orders SET subtotal = $1, updated_at = NOW() WHERE id = $2`,
            [subtotal, order.id]
        );

        await client.query('COMMIT');
        const { rows: [full] } = await query(
            `SELECT so.*, p.name AS customer_name, p.code AS customer_code, w.code AS warehouse_code
             FROM sales_orders so JOIN parties p ON p.id=so.customer_id JOIN warehouses w ON w.id=so.warehouse_id
             WHERE so.id = $1`, [order.id]
        );
        res.status(201).json(full);
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: err.message });
    } finally { client.release(); }
});

router.post('/sales-orders/:id/confirm', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows: [order] } = await client.query(
            `SELECT * FROM sales_orders WHERE id = $1 FOR UPDATE`, [req.params.id]
        );
        if (!order) throw Object.assign(new Error('Order not found'), { status: 404 });
        if (order.status !== 'draft')
            throw Object.assign(new Error(`Order is already ${order.status}`), { status: 400 });

        const { rows: lines } = await client.query(
            `SELECT sol.*, i.code, i.name FROM sales_order_lines sol
             JOIN items i ON i.id = sol.item_id
             WHERE sol.sales_order_id = $1`, [order.id]
        );

        for (const line of lines) {
            const { rows: [avail] } = await client.query(
                `SELECT COALESCE(qty_available,0) AS qty_available FROM v_stock_availability
                 WHERE item_id = $1 AND warehouse_id = $2`,
                [line.item_id, order.warehouse_id]
            );
            const available = avail ? parseFloat(avail.qty_available) : 0;
            if (available < parseFloat(line.qty_ordered)) {
                throw Object.assign(
                    new Error(`Insufficient stock for ${line.code} — need ${line.qty_ordered}, available ${available}`),
                    { status: 400 }
                );
            }
            await client.query(
                `INSERT INTO stock_reservations
                    (item_id, warehouse_id, reference_type, reference_id, qty_reserved, status)
                 VALUES ($1,$2,'sales_order',$3,$4,'active')`,
                [line.item_id, order.warehouse_id, order.id, line.qty_ordered]
            );
        }

        await client.query(
            `UPDATE sales_orders SET status='confirmed', updated_at=NOW() WHERE id=$1`, [order.id]
        );
        await client.query('COMMIT');

        const { rows: [full] } = await query(
            `SELECT so.*, p.name AS customer_name, p.code AS customer_code, w.code AS warehouse_code
             FROM sales_orders so JOIN parties p ON p.id=so.customer_id JOIN warehouses w ON w.id=so.warehouse_id
             WHERE so.id = $1`, [order.id]
        );
        res.json(full);
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(err.status || 500).json({ error: err.message });
    } finally { client.release(); }
});

router.post('/sales-orders/:id/cancel', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows: [order] } = await client.query(
            `SELECT * FROM sales_orders WHERE id = $1 FOR UPDATE`, [req.params.id]
        );
        if (!order) throw Object.assign(new Error('Order not found'), { status: 404 });
        if (['fully_shipped','invoiced','closed','cancelled'].includes(order.status))
            throw Object.assign(new Error(`Cannot cancel a ${order.status} order`), { status: 400 });

        await client.query(
            `UPDATE stock_reservations SET status='cancelled', updated_at=NOW()
             WHERE reference_type='sales_order' AND reference_id=$1 AND status='active'`,
            [order.id]
        );
        await client.query(
            `UPDATE sales_orders SET status='cancelled', updated_at=NOW() WHERE id=$1`, [order.id]
        );
        await client.query('COMMIT');

        const { rows: [full] } = await query(
            `SELECT so.*, p.name AS customer_name, w.code AS warehouse_code
             FROM sales_orders so JOIN parties p ON p.id=so.customer_id JOIN warehouses w ON w.id=so.warehouse_id
             WHERE so.id=$1`, [order.id]
        );
        res.json(full);
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(err.status || 500).json({ error: err.message });
    } finally { client.release(); }
});

// ── Shipments ─────────────────────────────────────────────────────────────────

router.get('/shipments', async (req, res) => {
    try {
        const { page, limit, offset } = parsePage(req.query);
        const { rows: [{ count }] } = await query(`SELECT COUNT(*) FROM shipments`);
        const { rows } = await query(
            `SELECT s.*, so.number AS order_number, p.name AS customer_name,
                    w.code AS warehouse_code,
                    sc.name AS carrier_name
             FROM   shipments s
             JOIN   sales_orders so ON so.id = s.sales_order_id
             JOIN   parties p ON p.id = so.customer_id
             JOIN   warehouses w ON w.id = s.warehouse_id
             LEFT JOIN shipping_carriers sc ON sc.code = s.carrier
             ORDER  BY s.created_at DESC
             LIMIT $1 OFFSET $2`,
            [limit, offset]
        );
        res.json(paginate(rows, parseInt(count, 10), page, limit));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/shipments/:id', async (req, res) => {
    try {
        const { rows: [shp] } = await query(
            `SELECT s.*, so.number AS order_number, p.name AS customer_name
             FROM shipments s
             JOIN sales_orders so ON so.id = s.sales_order_id
             JOIN parties p ON p.id = so.customer_id
             WHERE s.id = $1`, [req.params.id]
        );
        if (!shp) return res.status(404).json({ error: 'Shipment not found' });
        const { rows: lines } = await query(
            `SELECT sl.*, i.code AS item_code, i.name AS item_name
             FROM shipment_lines sl JOIN items i ON i.id = sl.item_id
             WHERE sl.shipment_id = $1`, [req.params.id]
        );
        res.json({ ...shp, lines });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/shipments', validate(CreateShipmentSchema), async (req, res) => {
    const { sales_order_id, ship_date, carrier, tracking_number, notes, lines, created_by } = req.body;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows: [order] } = await client.query(
            `SELECT * FROM sales_orders WHERE id = $1 FOR UPDATE`, [sales_order_id]
        );
        if (!order) throw Object.assign(new Error('Sales order not found'), { status: 404 });
        if (!['confirmed','partially_shipped'].includes(order.status))
            throw Object.assign(new Error(`Cannot ship order in status "${order.status}"`), { status: 400 });

        const number = await nextDocNumber(client, 'shipments', 'number', 'SHP');

        const { rows: [shp] } = await client.query(
            `INSERT INTO shipments (number, sales_order_id, warehouse_id, ship_date, carrier, tracking_number, notes, status, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,'draft',$8) RETURNING *`,
            [number, sales_order_id, order.warehouse_id,
             ship_date || new Date().toISOString().slice(0,10),
             carrier || null, tracking_number || null, notes || null, created_by || null]
        );

        for (const line of lines) {
            const { order_line_id, qty_shipped } = line;
            const { rows: [sol] } = await client.query(
                `SELECT sol.*, i.standard_cost FROM sales_order_lines sol
                 JOIN items i ON i.id = sol.item_id
                 WHERE sol.id = $1`, [order_line_id]
            );
            if (!sol) throw new Error(`Order line ${order_line_id} not found`);
            if (parseFloat(qty_shipped) > parseFloat(sol.qty_backordered))
                throw new Error(`Cannot ship ${qty_shipped} — only ${sol.qty_backordered} remaining for line ${sol.line_number}`);

            await client.query(
                `INSERT INTO shipment_lines (shipment_id, sales_order_line_id, item_id, qty_shipped, cost_per_unit)
                 VALUES ($1,$2,$3,$4,$5)`,
                [shp.id, order_line_id, sol.item_id, qty_shipped, sol.standard_cost]
            );
        }

        await client.query('COMMIT');
        res.status(201).json(shp);
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(err.status || 400).json({ error: err.message });
    } finally { client.release(); }
});

router.post('/shipments/:id/post', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const { rows: [shp] } = await client.query(
            `SELECT * FROM shipments WHERE id = $1 FOR UPDATE`, [req.params.id]
        );
        if (!shp) throw Object.assign(new Error('Shipment not found'), { status: 404 });
        if (shp.status !== 'draft')
            throw Object.assign(new Error(`Shipment already ${shp.status}`), { status: 400 });

        const { rows: lines } = await client.query(
            `SELECT sl.*, sol.unit_price, sol.discount_pct, sol.sales_order_id,
                    sol.line_total AS sol_line_total
             FROM shipment_lines sl
             JOIN sales_order_lines sol ON sol.id = sl.sales_order_line_id
             WHERE sl.shipment_id = $1`, [shp.id]
        );
        if (!lines.length) throw Object.assign(new Error('No lines to post'), { status: 400 });

        const { rows: [order] } = await client.query(
            `SELECT * FROM sales_orders WHERE id = $1 FOR UPDATE`, [lines[0].sales_order_id]
        );

        let invoiceSubtotal = 0;

        // ── Task 4: Negative Stock Prevention ────────────────────────────────
        for (const line of lines) {
            const { rows: [stockCheck] } = await client.query(
                `SELECT check_stock_availability($1, $2, $3) AS shortfall`,
                [line.item_id, shp.warehouse_id, parseFloat(line.qty_shipped)]
            );
            const shortfall = parseFloat(stockCheck.shortfall);
            if (shortfall < 0) {
                const { rows: [avail] } = await client.query(
                    `SELECT COALESCE(qty_available,0) AS qty_available
                     FROM v_stock_availability WHERE item_id=$1 AND warehouse_id=$2`,
                    [line.item_id, shp.warehouse_id]
                );
                throw Object.assign(
                    new Error(`Insufficient stock for item ${line.item_id}: need ${line.qty_shipped}, available ${avail ? avail.qty_available : 0}`),
                    { status: 400, available: avail ? avail.qty_available : 0, requested: line.qty_shipped }
                );
            }
        }

        for (const line of lines) {
            await client.query(
                `INSERT INTO stock_ledger
                    (item_id, warehouse_id, transaction_type, reference_type, reference_id,
                     qty, cost_per_unit, notes, posting_date, created_by)
                 VALUES ($1,$2,'shipment','shipment',$3,$4,$5,$6,$7,$8)`,
                [
                    line.item_id, shp.warehouse_id, shp.id,
                    -parseFloat(line.qty_shipped),
                    parseFloat(line.cost_per_unit),
                    `${shp.number} — SO ${order.number}`,
                    shp.ship_date,
                    req.body.posted_by || null
                ]
            );

            await client.query(
                `UPDATE sales_order_lines
                 SET qty_shipped = qty_shipped + $1,
                     status = CASE
                         WHEN qty_shipped + $1 >= qty_ordered THEN 'fulfilled'
                         WHEN qty_shipped + $1 > 0             THEN 'partial'
                         ELSE status END
                 WHERE id = $2`,
                [line.qty_shipped, line.sales_order_line_id]
            );

            await client.query(
                `UPDATE stock_reservations
                 SET status='fulfilled', updated_at=NOW()
                 WHERE item_id=$1 AND warehouse_id=$2
                   AND reference_type='sales_order' AND reference_id=$3 AND status='active'`,
                [line.item_id, shp.warehouse_id, order.id]
            );

            invoiceSubtotal += parseFloat(line.qty_shipped)
                             * parseFloat(line.unit_price)
                             * (1 - parseFloat(line.discount_pct));
        }

        const { rows: [orderLines] } = await client.query(
            `SELECT
                COUNT(*) FILTER (WHERE status='fulfilled')  AS fulfilled,
                COUNT(*) FILTER (WHERE status='cancelled')  AS cancelled,
                COUNT(*)                                    AS total
             FROM sales_order_lines WHERE sales_order_id = $1`, [order.id]
        );
        const allDone = parseInt(orderLines.fulfilled) + parseInt(orderLines.cancelled)
                      === parseInt(orderLines.total);
        const newOrderStatus = allDone ? 'fully_shipped' : 'partially_shipped';

        await client.query(
            `UPDATE sales_orders SET status=$1, updated_at=NOW() WHERE id=$2`,
            [newOrderStatus, order.id]
        );

        await client.query(
            `UPDATE shipments SET status='shipped' WHERE id=$1`, [shp.id]
        );

        // Auto-generate invoice with state-based tax
        const taxInfo   = await calculateInvoiceTax(order.customer_id, invoiceSubtotal);
        const invTotal  = invoiceSubtotal + taxInfo.tax_amount;
        const invNumber = await nextDocNumber(client, 'sales_invoices', 'number', 'INV');
        const { rows: [cust] } = await client.query(
            `SELECT payment_terms_days FROM parties WHERE id = $1`, [order.customer_id]
        );
        const dueDate = new Date(shp.ship_date);
        dueDate.setDate(dueDate.getDate() + (cust ? cust.payment_terms_days : 30));

        const { rows: [invoice] } = await client.query(
            `INSERT INTO sales_invoices
                (number, customer_id, sales_order_id, shipment_id, status,
                 invoice_date, due_date, subtotal, tax_amount, total,
                 tax_rate, state_code, tax_exempt)
             VALUES ($1,$2,$3,$4,'sent',$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
            [invNumber, order.customer_id, order.id, shp.id,
             shp.ship_date, dueDate.toISOString().slice(0,10),
             invoiceSubtotal.toFixed(4), taxInfo.tax_amount.toFixed(4), invTotal.toFixed(4),
             taxInfo.rate, taxInfo.state_code || null, taxInfo.exempt]
        );

        await client.query(
            `INSERT INTO audit_log (action, table_name, record_id, new_values)
             VALUES ('post_shipment','shipments',$1,$2)`,
            [shp.id, JSON.stringify({ shipment: shp.number, order: order.number, invoice: invNumber })]
        );

        await client.query(
            `UPDATE sales_order_lines sol
             SET status = CASE
                 WHEN sol.qty_shipped >= sol.qty_ordered THEN 'fulfilled'
                 WHEN sol.qty_shipped > 0                THEN 'partial'
                 ELSE 'open' END
             FROM sales_orders so
             WHERE sol.sales_order_id = so.id
               AND so.status NOT IN ('closed','cancelled')
               AND sol.status NOT IN ('fulfilled','cancelled')`
        );

        // ── Task 5: Create / update backorder records for unfulfilled lines ──
        if (!allDone) {
            const { rows: openLines } = await client.query(
                `SELECT sol.*, sl_shipped.qty_this_ship
                 FROM sales_order_lines sol
                 LEFT JOIN LATERAL (
                     SELECT SUM(sl.qty_shipped) AS qty_this_ship
                     FROM shipment_lines sl WHERE sl.shipment_id = $1 AND sl.sales_order_line_id = sol.id
                 ) sl_shipped ON true
                 WHERE sol.sales_order_id = $2 AND sol.status IN ('open','partial')`,
                [shp.id, order.id]
            );
            for (const sol of openLines) {
                const qtyBack = parseFloat(sol.qty_ordered) - parseFloat(sol.qty_shipped);
                if (qtyBack <= 0) continue;
                // Upsert backorder (one record per order line)
                await client.query(
                    `INSERT INTO backorders
                        (sales_order_id, sales_order_line_id, item_id, warehouse_id,
                         qty_backordered, qty_fulfilled, status)
                     VALUES ($1,$2,$3,$4,$5, COALESCE(
                         (SELECT qty_fulfilled FROM backorders
                          WHERE sales_order_line_id = $2 LIMIT 1), 0), 'open')
                     ON CONFLICT (sales_order_line_id)
                     DO UPDATE SET
                         qty_backordered = EXCLUDED.qty_backordered,
                         status = CASE WHEN backorders.qty_fulfilled > 0 THEN 'partial' ELSE 'open' END,
                         updated_at = NOW()`,
                    [order.id, sol.id, sol.item_id, order.warehouse_id, qtyBack]
                );
            }
        } else {
            // All fulfilled — close any open backorders for this order
            await client.query(
                `UPDATE backorders SET status='fulfilled', updated_at=NOW()
                 WHERE sales_order_id=$1 AND status IN ('open','partial')`,
                [order.id]
            );
        }

        await client.query('COMMIT');
        res.json({ shipment: shp, invoice, order_status: newOrderStatus });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(err.status || 500).json({ error: err.message });
    } finally { client.release(); }
});

// ── Invoices ──────────────────────────────────────────────────────────────────

router.get('/invoices', async (req, res) => {
    try {
        const { page, limit, offset } = parsePage(req.query);
        const { rows: [{ count }] } = await query(`SELECT COUNT(*) FROM sales_invoices`);
        const { rows } = await query(
            `SELECT si.*, p.name AS customer_name, p.code AS customer_code,
                    so.number AS order_number
             FROM   sales_invoices si
             JOIN   parties p ON p.id = si.customer_id
             LEFT JOIN sales_orders so ON so.id = si.sales_order_id
             ORDER  BY si.invoice_date DESC
             LIMIT $1 OFFSET $2`,
            [limit, offset]
        );
        res.json(paginate(rows, parseInt(count, 10), page, limit));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/invoices/:id', async (req, res) => {
    try {
        const { rows: [inv] } = await query(
            `SELECT si.*, p.name AS customer_name, p.code AS customer_code,
                    so.number AS order_number, shp.number AS shipment_number
             FROM   sales_invoices si
             JOIN   parties p ON p.id = si.customer_id
             LEFT JOIN sales_orders so  ON so.id  = si.sales_order_id
             LEFT JOIN shipments shp    ON shp.id = si.shipment_id
             WHERE  si.id = $1`, [req.params.id]
        );
        if (!inv) return res.status(404).json({ error: 'Invoice not found' });
        const { rows: payments } = await query(
            `SELECT pa.*, pr.payment_date, pr.method, pr.reference_number
             FROM payment_applications pa
             JOIN payments_received pr ON pr.id = pa.payment_id
             WHERE pa.invoice_id = $1
             ORDER BY pr.payment_date`, [req.params.id]
        );
        res.json({ ...inv, payments });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/invoices/:id/send', async (req, res) => {
    try {
        const { rows } = await query(
            `UPDATE sales_invoices SET status='sent', updated_at=NOW()
             WHERE id=$1 AND status='draft' RETURNING *`, [req.params.id]
        );
        if (!rows.length) return res.status(400).json({ error: 'Invoice not found or not in draft' });
        res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Task 6: Direct invoice payment (creates payment + applies it to this invoice)
router.post('/invoices/:id/payment', async (req, res) => {
    const { amount, method, reference_number, payment_date, notes } = req.body;
    if (!amount || parseFloat(amount) <= 0)
        return res.status(400).json({ error: 'amount is required and must be positive' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const { rows: [inv] } = await client.query(
            `SELECT * FROM sales_invoices WHERE id = $1 FOR UPDATE`, [req.params.id]
        );
        if (!inv) throw Object.assign(new Error('Invoice not found'), { status: 404 });
        if (['paid','void'].includes(inv.status))
            throw Object.assign(new Error(`Invoice is already ${inv.status}`), { status: 400 });

        const applyAmt = Math.min(parseFloat(amount), parseFloat(inv.balance_due));

        const { rows: [pmt] } = await client.query(
            `INSERT INTO payments_received
                (customer_id, payment_date, amount, method, reference_number, notes)
             VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
            [inv.customer_id,
             payment_date || new Date().toISOString().slice(0, 10),
             applyAmt,
             method || 'check',
             reference_number || null,
             notes || null]
        );

        await client.query(
            `INSERT INTO payment_applications (payment_id, invoice_id, amount_applied)
             VALUES ($1,$2,$3)`,
            [pmt.id, inv.id, applyAmt]
        );

        const newPaid   = parseFloat(inv.amount_paid) + applyAmt;
        const invTotal  = parseFloat(inv.total);
        const newStatus = newPaid >= invTotal ? 'paid'
                        : newPaid > 0         ? 'partial_paid'
                        : 'sent';

        const { rows: [updated] } = await client.query(
            `UPDATE sales_invoices
             SET amount_paid = $1, status = $2,
                 last_payment_date = $3, last_payment_method = $4,
                 last_payment_reference = $5, updated_at = NOW()
             WHERE id = $6 RETURNING *`,
            [newPaid, newStatus,
             pmt.payment_date, pmt.method, pmt.reference_number,
             inv.id]
        );

        await client.query('COMMIT');
        res.status(201).json({ invoice: updated, payment: pmt, amount_applied: applyAmt });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(err.status || 400).json({ error: err.message });
    } finally { client.release(); }
});

// ── AR Payments ───────────────────────────────────────────────────────────────

router.post('/payments', validate(CreatePaymentSchema), async (req, res) => {
    const { customer_id, payment_date, amount, method,
            reference_number, notes, applications } = req.body;

    const totalApplied = applications.reduce((s, a) => s + parseFloat(a.amount_applied || 0), 0);
    if (totalApplied > parseFloat(amount))
        return res.status(400).json({ error: 'Total applied exceeds payment amount' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const { rows: [pmt] } = await client.query(
            `INSERT INTO payments_received
                (customer_id, payment_date, amount, method, reference_number, notes)
             VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
            [customer_id, payment_date || new Date().toISOString().slice(0,10),
             amount, method, reference_number || null, notes || null]
        );

        for (const app of applications) {
            await client.query(
                `INSERT INTO payment_applications (payment_id, invoice_id, amount_applied)
                 VALUES ($1,$2,$3)`,
                [pmt.id, app.invoice_id, app.amount_applied]
            );

            const { rows: [totals] } = await client.query(
                `SELECT si.total, COALESCE(SUM(pa.amount_applied),0) AS paid_total
                 FROM sales_invoices si
                 JOIN payment_applications pa ON pa.invoice_id = si.id
                 WHERE si.id = $1
                 GROUP BY si.total`, [app.invoice_id]
            );

            if (totals) {
                const paidTotal = parseFloat(totals.paid_total);
                const invTotal  = parseFloat(totals.total);
                const newStatus = paidTotal >= invTotal ? 'paid'
                                : paidTotal > 0         ? 'partial_paid'
                                : 'sent';
                await client.query(
                    `UPDATE sales_invoices SET amount_paid=$1, status=$2, updated_at=NOW()
                     WHERE id=$3`,
                    [paidTotal, newStatus, app.invoice_id]
                );
            }
        }

        await client.query('COMMIT');
        res.status(201).json(pmt);
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: err.message });
    } finally { client.release(); }
});

// ── AR Aging ──────────────────────────────────────────────────────────────────

router.get('/customers/:id/ar', async (req, res) => {
    try {
        const { rows: [aging] } = await query(
            `SELECT * FROM v_ar_aging WHERE customer_id = $1`, [req.params.id]
        );
        const { rows: invoices } = await query(
            `SELECT * FROM sales_invoices WHERE customer_id = $1 AND status NOT IN ('paid','void')
             ORDER BY due_date`, [req.params.id]
        );
        res.json({ aging: aging || null, open_invoices: invoices });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/ar-aging', async (_req, res) => {
    try {
        const { rows } = await query(`SELECT * FROM v_ar_aging ORDER BY total_due DESC`);
        const { rows: [totals] } = await query(
            `SELECT COALESCE(SUM(current_due),0) AS current_due,
                    COALESCE(SUM(days_1_30),0)   AS days_1_30,
                    COALESCE(SUM(days_31_60),0)  AS days_31_60,
                    COALESCE(SUM(days_61_90),0)  AS days_61_90,
                    COALESCE(SUM(days_90plus),0) AS days_90plus,
                    COALESCE(SUM(total_due),0)   AS total_due
             FROM v_ar_aging`
        );
        res.json({ customers: rows, totals });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Backorders ────────────────────────────────────────────────────────────────

router.get('/backorders', async (req, res) => {
    const { status, customer_id, item_id } = req.query;
    try {
        const { page, limit, offset } = parsePage(req.query);
        const conds  = [`b.status != 'fulfilled'`];
        const params = [];
        if (status)      { params.push(status);      conds.push(`b.status = $${params.length}`); }
        if (customer_id) { params.push(customer_id); conds.push(`so.customer_id = $${params.length}`); }
        if (item_id)     { params.push(item_id);     conds.push(`b.item_id = $${params.length}`); }

        const where = `WHERE ${conds.join(' AND ')}`;

        const { rows: [{ count }] } = await query(
            `SELECT COUNT(*) FROM backorders b
             JOIN sales_orders so ON so.id = b.sales_order_id ${where}`, params
        );
        const { rows } = await query(
            `SELECT b.*,
                    so.number AS order_number,
                    p.name AS customer_name, p.code AS customer_code,
                    i.code AS item_code, i.name AS item_name,
                    w.code AS warehouse_code
             FROM backorders b
             JOIN sales_orders so ON so.id = b.sales_order_id
             JOIN parties p ON p.id = so.customer_id
             JOIN items i ON i.id = b.item_id
             JOIN warehouses w ON w.id = b.warehouse_id
             ${where}
             ORDER BY b.created_at DESC
             LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
            [...params, limit, offset]
        );
        res.json(paginate(rows, parseInt(count, 10), page, limit));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
