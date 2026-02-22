-- ============================================================
-- Tick Tock Inc. — Sales Orders / Invoices / Payments Module
-- 002_sales_orders.sql
-- ============================================================

-- ── Parties (customers & vendors) ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS parties (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type                VARCHAR(10)   NOT NULL DEFAULT 'customer'
                            CHECK (type IN ('customer','vendor','both')),
    code                VARCHAR(20)   NOT NULL UNIQUE,
    name                VARCHAR(150)  NOT NULL,
    email               VARCHAR(150),
    phone               VARCHAR(30),
    billing_address     JSONB,
    shipping_address    JSONB,
    payment_terms_days  INTEGER       NOT NULL DEFAULT 30,
    credit_limit        NUMERIC(14,2) NOT NULL DEFAULT 0,
    currency            VARCHAR(3)    NOT NULL DEFAULT 'USD',
    is_active           BOOLEAN       NOT NULL DEFAULT true,
    notes               TEXT,
    created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- ── Price Lists ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS price_lists (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        VARCHAR(100) NOT NULL,
    currency    VARCHAR(3)   NOT NULL DEFAULT 'USD',
    is_default  BOOLEAN      NOT NULL DEFAULT false,
    valid_from  DATE,
    valid_to    DATE,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS price_list_items (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    price_list_id   UUID          NOT NULL REFERENCES price_lists(id) ON DELETE CASCADE,
    item_id         UUID          NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    min_qty         NUMERIC(14,4) NOT NULL DEFAULT 1,
    price           NUMERIC(14,4) NOT NULL,
    valid_from      DATE,
    valid_to        DATE,
    UNIQUE (price_list_id, item_id, min_qty)
);

CREATE TABLE IF NOT EXISTS customer_price_lists (
    customer_id     UUID    NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
    price_list_id   UUID    NOT NULL REFERENCES price_lists(id) ON DELETE CASCADE,
    priority        INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (customer_id, price_list_id)
);

-- ── Sales Orders ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sales_orders (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    number              VARCHAR(30)   NOT NULL UNIQUE,
    customer_id         UUID          NOT NULL REFERENCES parties(id),
    warehouse_id        UUID          NOT NULL REFERENCES warehouses(id),
    price_list_id       UUID          REFERENCES price_lists(id),
    order_date          DATE          NOT NULL DEFAULT CURRENT_DATE,
    requested_ship_date DATE,
    status              VARCHAR(20)   NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft','confirmed','partially_shipped',
                                              'fully_shipped','invoiced','closed','cancelled')),
    notes               TEXT,
    tax_rate            NUMERIC(6,4)  NOT NULL DEFAULT 0,
    subtotal            NUMERIC(18,4) NOT NULL DEFAULT 0,
    tax_amount          NUMERIC(18,4) GENERATED ALWAYS AS (ROUND(subtotal * tax_rate, 4)) STORED,
    total               NUMERIC(18,4) GENERATED ALWAYS AS (ROUND(subtotal * (1 + tax_rate), 4)) STORED,
    created_by          UUID          REFERENCES users(id),
    created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- ── Sales Order Lines ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sales_order_lines (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sales_order_id  UUID          NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
    line_number     INTEGER       NOT NULL,
    item_id         UUID          NOT NULL REFERENCES items(id),
    description     TEXT,
    qty_ordered     NUMERIC(14,4) NOT NULL CHECK (qty_ordered > 0),
    qty_shipped     NUMERIC(14,4) NOT NULL DEFAULT 0,
    qty_backordered NUMERIC(14,4) GENERATED ALWAYS AS
                        (GREATEST(qty_ordered - qty_shipped, 0)) STORED,
    unit_price      NUMERIC(14,4) NOT NULL DEFAULT 0,
    discount_pct    NUMERIC(6,4)  NOT NULL DEFAULT 0,
    line_total      NUMERIC(18,4) GENERATED ALWAYS AS
                        (ROUND(qty_ordered * unit_price * (1 - discount_pct), 4)) STORED,
    status          VARCHAR(15)   NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open','partial','fulfilled','cancelled')),
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    UNIQUE (sales_order_id, line_number)
);

-- ── Shipments ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shipments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    number          VARCHAR(30)   NOT NULL UNIQUE,
    sales_order_id  UUID          NOT NULL REFERENCES sales_orders(id),
    warehouse_id    UUID          NOT NULL REFERENCES warehouses(id),
    status          VARCHAR(15)   NOT NULL DEFAULT 'shipped'
                        CHECK (status IN ('draft','packed','shipped','delivered')),
    ship_date       DATE          NOT NULL DEFAULT CURRENT_DATE,
    carrier         VARCHAR(80),
    tracking_number VARCHAR(100),
    notes           TEXT,
    created_by      UUID          REFERENCES users(id),
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS shipment_lines (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shipment_id         UUID          NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
    sales_order_line_id UUID          NOT NULL REFERENCES sales_order_lines(id),
    item_id             UUID          NOT NULL REFERENCES items(id),
    qty_shipped         NUMERIC(14,4) NOT NULL CHECK (qty_shipped > 0),
    cost_per_unit       NUMERIC(14,4) NOT NULL DEFAULT 0
);

-- ── Sales Invoices ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sales_invoices (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    number          VARCHAR(30)   NOT NULL UNIQUE,
    customer_id     UUID          NOT NULL REFERENCES parties(id),
    sales_order_id  UUID          REFERENCES sales_orders(id),
    shipment_id     UUID          REFERENCES shipments(id),
    status          VARCHAR(15)   NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','sent','partial_paid','paid','void')),
    invoice_date    DATE          NOT NULL DEFAULT CURRENT_DATE,
    due_date        DATE          NOT NULL,
    subtotal        NUMERIC(18,4) NOT NULL DEFAULT 0,
    tax_amount      NUMERIC(18,4) NOT NULL DEFAULT 0,
    total           NUMERIC(18,4) NOT NULL DEFAULT 0,
    amount_paid     NUMERIC(18,4) NOT NULL DEFAULT 0,
    balance_due     NUMERIC(18,4) GENERATED ALWAYS AS
                        (GREATEST(ROUND(total - amount_paid, 4), 0)) STORED,
    notes           TEXT,
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- ── Payments ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payments_received (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id      UUID          NOT NULL REFERENCES parties(id),
    payment_date     DATE          NOT NULL DEFAULT CURRENT_DATE,
    amount           NUMERIC(14,4) NOT NULL CHECK (amount > 0),
    method           VARCHAR(15)   NOT NULL DEFAULT 'check'
                         CHECK (method IN ('check','wire','ach','credit_card','cash')),
    reference_number VARCHAR(100),
    notes            TEXT,
    created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payment_applications (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_id      UUID          NOT NULL REFERENCES payments_received(id) ON DELETE CASCADE,
    invoice_id      UUID          NOT NULL REFERENCES sales_invoices(id),
    amount_applied  NUMERIC(14,4) NOT NULL CHECK (amount_applied > 0),
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- ── Indexes ───────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_so_customer   ON sales_orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_so_status     ON sales_orders(status);
CREATE INDEX IF NOT EXISTS idx_sol_order     ON sales_order_lines(sales_order_id);
CREATE INDEX IF NOT EXISTS idx_sol_item      ON sales_order_lines(item_id);
CREATE INDEX IF NOT EXISTS idx_shp_order     ON shipments(sales_order_id);
CREATE INDEX IF NOT EXISTS idx_inv_customer  ON sales_invoices(customer_id);
CREATE INDEX IF NOT EXISTS idx_inv_status    ON sales_invoices(status);
CREATE INDEX IF NOT EXISTS idx_pay_customer  ON payments_received(customer_id);

-- ── Views ─────────────────────────────────────────────────────────────────────

-- AR Aging: open invoices bucketed by days overdue
CREATE OR REPLACE VIEW v_ar_aging AS
SELECT
    p.id            AS customer_id,
    p.code          AS customer_code,
    p.name          AS customer_name,
    COALESCE(SUM(si.balance_due) FILTER (
        WHERE si.due_date >= CURRENT_DATE), 0)                              AS current_due,
    COALESCE(SUM(si.balance_due) FILTER (
        WHERE si.due_date < CURRENT_DATE
          AND si.due_date >= CURRENT_DATE - INTERVAL '30 days'), 0)         AS days_1_30,
    COALESCE(SUM(si.balance_due) FILTER (
        WHERE si.due_date < CURRENT_DATE - INTERVAL '30 days'
          AND si.due_date >= CURRENT_DATE - INTERVAL '60 days'), 0)         AS days_31_60,
    COALESCE(SUM(si.balance_due) FILTER (
        WHERE si.due_date < CURRENT_DATE - INTERVAL '60 days'
          AND si.due_date >= CURRENT_DATE - INTERVAL '90 days'), 0)         AS days_61_90,
    COALESCE(SUM(si.balance_due) FILTER (
        WHERE si.due_date < CURRENT_DATE - INTERVAL '90 days'), 0)          AS days_90plus,
    COALESCE(SUM(si.balance_due), 0)                                        AS total_due
FROM parties p
LEFT JOIN sales_invoices si ON si.customer_id = p.id
    AND si.status NOT IN ('paid','void')
    AND si.balance_due > 0
WHERE p.type IN ('customer','both') AND p.is_active = true
GROUP BY p.id, p.code, p.name;

-- Open Sales Orders
CREATE OR REPLACE VIEW v_open_sales_orders AS
SELECT
    so.id, so.number, so.status, so.order_date, so.requested_ship_date,
    so.subtotal, so.tax_amount, so.total, so.created_at, so.updated_at,
    p.id    AS customer_id,
    p.code  AS customer_code,
    p.name  AS customer_name,
    w.code  AS warehouse_code,
    (SELECT COUNT(*)        FROM sales_order_lines sol WHERE sol.sales_order_id = so.id)    AS line_count,
    (SELECT COALESCE(SUM(qty_backordered),0) FROM sales_order_lines sol WHERE sol.sales_order_id = so.id) AS total_backorder_qty
FROM sales_orders so
JOIN parties    p ON p.id = so.customer_id
JOIN warehouses w ON w.id = so.warehouse_id
WHERE so.status NOT IN ('closed','cancelled');

-- Backorders: lines with remaining qty to ship
CREATE OR REPLACE VIEW v_backorders AS
SELECT
    sol.id AS line_id, sol.sales_order_id, sol.line_number,
    sol.qty_ordered, sol.qty_shipped, sol.qty_backordered,
    sol.unit_price, sol.status AS line_status,
    so.number AS order_number, so.order_date, so.requested_ship_date,
    p.name AS customer_name, p.code AS customer_code,
    i.code AS item_code, i.name AS item_name,
    w.code AS warehouse_code
FROM sales_order_lines sol
JOIN sales_orders so ON so.id = sol.sales_order_id
JOIN parties     p  ON p.id  = so.customer_id
JOIN items       i  ON i.id  = sol.item_id
JOIN warehouses  w  ON w.id  = so.warehouse_id
WHERE sol.qty_backordered > 0
  AND so.status NOT IN ('closed','cancelled')
  AND sol.status NOT IN ('fulfilled','cancelled');

-- ── Seed Data ─────────────────────────────────────────────────────────────────

-- Customers (parties)
INSERT INTO parties (id, type, code, name, email, phone,
    billing_address, shipping_address, payment_terms_days, credit_limit) VALUES
(
    'd0000001-0000-0000-0000-000000000001','customer','CUST-001',
    'Metro Grocery Distributors','orders@metrogrocery.com','212-555-0101',
    '{"line1":"500 Market St","city":"New York","state":"NY","zip":"10005","country":"US"}',
    '{"line1":"500 Market St","city":"New York","state":"NY","zip":"10005","country":"US"}',
    30, 25000.00
),(
    'd0000001-0000-0000-0000-000000000002','customer','CUST-002',
    'Sunrise Wholesale Group','purchasing@sunrise.com','305-555-0202',
    '{"line1":"1200 Biscayne Blvd","city":"Miami","state":"FL","zip":"33132","country":"US"}',
    '{"line1":"1200 Biscayne Blvd","city":"Miami","state":"FL","zip":"33132","country":"US"}',
    15, 15000.00
),(
    'd0000001-0000-0000-0000-000000000003','customer','CUST-003',
    'Pacific Rim Trading Co.','procurement@pacrim.com','310-555-0303',
    '{"line1":"888 Harbor Blvd","city":"Los Angeles","state":"CA","zip":"90021","country":"US"}',
    '{"line1":"888 Harbor Blvd","city":"Los Angeles","state":"CA","zip":"90021","country":"US"}',
    45, 50000.00
),(
    'd0000001-0000-0000-0000-000000000004','customer','CUST-004',
    'Central Valley Supplies','buying@centralvalley.com','559-555-0404',
    '{"line1":"340 Fresno Ave","city":"Fresno","state":"CA","zip":"93650","country":"US"}',
    '{"line1":"340 Fresno Ave","city":"Fresno","state":"CA","zip":"93650","country":"US"}',
    30, 10000.00
),(
    'd0000001-0000-0000-0000-000000000005','customer','CUST-005',
    'Tri-State Retail Partners','orders@tristate.com','718-555-0505',
    '{"line1":"99 Commerce Dr","city":"Newark","state":"NJ","zip":"07102","country":"US"}',
    '{"line1":"99 Commerce Dr","city":"Newark","state":"NJ","zip":"07102","country":"US"}',
    60, 35000.00
)
ON CONFLICT (code) DO NOTHING;

-- Default price list
INSERT INTO price_lists (id, name, currency, is_default, valid_from) VALUES
    ('f0000001-0000-0000-0000-000000000001', 'Standard Retail', 'USD', true, '2026-01-01')
ON CONFLICT DO NOTHING;

-- Price list items for watch SKUs (1.3x standard cost)
INSERT INTO price_list_items (price_list_id, item_id, min_qty, price)
SELECT 'f0000001-0000-0000-0000-000000000001', id, 1,
       ROUND(standard_cost * 1.30, 4)
FROM items WHERE code IN ('WCH-001','WCH-002','WCH-003','WCH-004',
                          'STR-001','STR-002','BOX-001','ACC-001')
ON CONFLICT (price_list_id, item_id, min_qty) DO NOTHING;

-- Assign price list to all customers
INSERT INTO customer_price_lists (customer_id, price_list_id, priority)
SELECT id, 'f0000001-0000-0000-0000-000000000001', 1
FROM parties WHERE type = 'customer'
ON CONFLICT DO NOTHING;

-- Sample Sales Order 1 — Draft
INSERT INTO sales_orders (id, number, customer_id, warehouse_id, price_list_id,
    order_date, requested_ship_date, status, tax_rate, subtotal, notes, created_by)
VALUES (
    'e0000001-0000-0000-0000-000000000001',
    'SO-2026-00001',
    'd0000001-0000-0000-0000-000000000001',
    'b0000001-0000-0000-0000-000000000001',
    'f0000001-0000-0000-0000-000000000001',
    '2026-01-15','2026-01-22','draft', 0.08, 0, 'New year opening order',
    'a0000001-0000-0000-0000-000000000003'
) ON CONFLICT (number) DO NOTHING;

INSERT INTO sales_order_lines (sales_order_id, line_number, item_id, qty_ordered, unit_price, discount_pct)
SELECT 'e0000001-0000-0000-0000-000000000001', 1, id, 10, sale_price, 0.05
FROM items WHERE code = 'WCH-001' ON CONFLICT DO NOTHING;

INSERT INTO sales_order_lines (sales_order_id, line_number, item_id, qty_ordered, unit_price)
SELECT 'e0000001-0000-0000-0000-000000000001', 2, id, 5, sale_price
FROM items WHERE code = 'WCH-002' ON CONFLICT DO NOTHING;

UPDATE sales_orders SET subtotal =
    (SELECT COALESCE(SUM(line_total),0) FROM sales_order_lines WHERE sales_order_id = 'e0000001-0000-0000-0000-000000000001')
WHERE id = 'e0000001-0000-0000-0000-000000000001';

-- Sample Sales Order 2 — Confirmed
INSERT INTO sales_orders (id, number, customer_id, warehouse_id, price_list_id,
    order_date, requested_ship_date, status, tax_rate, subtotal, created_by)
VALUES (
    'e0000001-0000-0000-0000-000000000002',
    'SO-2026-00002',
    'd0000001-0000-0000-0000-000000000002',
    'b0000001-0000-0000-0000-000000000001',
    'f0000001-0000-0000-0000-000000000001',
    '2026-01-10','2026-01-20','confirmed', 0.08, 0,
    'a0000001-0000-0000-0000-000000000003'
) ON CONFLICT (number) DO NOTHING;

INSERT INTO sales_order_lines (sales_order_id, line_number, item_id, qty_ordered, unit_price)
SELECT 'e0000001-0000-0000-0000-000000000002', 1, id, 20, sale_price
FROM items WHERE code = 'STR-001' ON CONFLICT DO NOTHING;

INSERT INTO sales_order_lines (sales_order_id, line_number, item_id, qty_ordered, unit_price)
SELECT 'e0000001-0000-0000-0000-000000000002', 2, id, 15, sale_price
FROM items WHERE code = 'BOX-001' ON CONFLICT DO NOTHING;

UPDATE sales_orders SET subtotal =
    (SELECT COALESCE(SUM(line_total),0) FROM sales_order_lines WHERE sales_order_id = 'e0000001-0000-0000-0000-000000000002')
WHERE id = 'e0000001-0000-0000-0000-000000000002';

-- Add reservations for confirmed order
INSERT INTO stock_reservations (item_id, warehouse_id, reference_type, reference_id, qty_reserved, status)
SELECT sol.item_id, so.warehouse_id, 'sales_order', so.id, sol.qty_ordered, 'active'
FROM sales_order_lines sol
JOIN sales_orders so ON so.id = sol.sales_order_id
WHERE so.id = 'e0000001-0000-0000-0000-000000000002'
ON CONFLICT DO NOTHING;

-- Sample Sales Order 3 — Fully Shipped + Invoiced
INSERT INTO sales_orders (id, number, customer_id, warehouse_id,
    order_date, requested_ship_date, status, tax_rate, subtotal, created_by)
VALUES (
    'e0000001-0000-0000-0000-000000000003',
    'SO-2026-00003',
    'd0000001-0000-0000-0000-000000000003',
    'b0000001-0000-0000-0000-000000000001',
    '2026-01-05','2026-01-12','fully_shipped', 0.08, 0,
    'a0000001-0000-0000-0000-000000000003'
) ON CONFLICT (number) DO NOTHING;

INSERT INTO sales_order_lines (sales_order_id, line_number, item_id, qty_ordered, qty_shipped, unit_price, status)
SELECT 'e0000001-0000-0000-0000-000000000003', 1, id, 8, 8, sale_price, 'fulfilled'
FROM items WHERE code = 'WCH-003' ON CONFLICT DO NOTHING;

UPDATE sales_orders SET subtotal =
    (SELECT COALESCE(SUM(line_total),0) FROM sales_order_lines WHERE sales_order_id = 'e0000001-0000-0000-0000-000000000003')
WHERE id = 'e0000001-0000-0000-0000-000000000003';

-- Shipment for SO-2026-00003
INSERT INTO shipments (id, number, sales_order_id, warehouse_id, status, ship_date)
VALUES (
    'g0000001-0000-0000-0000-000000000001',
    'SHP-2026-00001',
    'e0000001-0000-0000-0000-000000000003',
    'b0000001-0000-0000-0000-000000000001',
    'delivered', '2026-01-11'
) ON CONFLICT (number) DO NOTHING;

INSERT INTO shipment_lines (shipment_id, sales_order_line_id, item_id, qty_shipped, cost_per_unit)
SELECT
    'g0000001-0000-0000-0000-000000000001',
    sol.id,
    sol.item_id,
    8,
    i.standard_cost
FROM sales_order_lines sol
JOIN items i ON i.id = sol.item_id
WHERE sol.sales_order_id = 'e0000001-0000-0000-0000-000000000003'
ON CONFLICT DO NOTHING;

-- Auto-generated invoice for SO-2026-00003
INSERT INTO sales_invoices (id, number, customer_id, sales_order_id, shipment_id,
    status, invoice_date, due_date, subtotal, tax_amount, total)
SELECT
    'h0000001-0000-0000-0000-000000000001',
    'INV-2026-00001',
    so.customer_id,
    so.id,
    'g0000001-0000-0000-0000-000000000001',
    'sent',
    '2026-01-11',
    '2026-01-11'::date + INTERVAL '45 days',
    so.subtotal,
    so.tax_amount,
    so.total
FROM sales_orders so
WHERE so.id = 'e0000001-0000-0000-0000-000000000003'
ON CONFLICT (number) DO NOTHING;

-- Partial payment on invoice
INSERT INTO payments_received (id, customer_id, payment_date, amount, method, reference_number)
VALUES (
    'i0000001-0000-0000-0000-000000000001',
    'd0000001-0000-0000-0000-000000000003',
    '2026-01-20', 1200.00, 'wire', 'WIRE-2026-0120'
) ON CONFLICT DO NOTHING;

INSERT INTO payment_applications (payment_id, invoice_id, amount_applied)
VALUES (
    'i0000001-0000-0000-0000-000000000001',
    'h0000001-0000-0000-0000-000000000001',
    1200.00
) ON CONFLICT DO NOTHING;

UPDATE sales_invoices SET
    amount_paid = 1200.00,
    status = 'partial_paid',
    updated_at = NOW()
WHERE id = 'h0000001-0000-0000-0000-000000000001';
