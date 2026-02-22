-- ============================================================
-- Tick Tock Inc. — Purchasing / Receiving / AP Module
-- 003_purchasing.sql
-- ============================================================

-- ── Extend items with vendor info ─────────────────────────────────────────────
ALTER TABLE items ADD COLUMN IF NOT EXISTS preferred_vendor_id UUID REFERENCES parties(id);
ALTER TABLE items ADD COLUMN IF NOT EXISTS vendor_item_code    VARCHAR(50);

-- ── Purchase Orders ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS purchase_orders (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    number          VARCHAR(30)   NOT NULL UNIQUE,
    vendor_id       UUID          NOT NULL REFERENCES parties(id),
    warehouse_id    UUID          NOT NULL REFERENCES warehouses(id),
    status          VARCHAR(20)   NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','sent','partially_received',
                                          'fully_received','closed','cancelled')),
    order_date      DATE          NOT NULL DEFAULT CURRENT_DATE,
    expected_date   DATE,
    notes           TEXT,
    created_by      UUID          REFERENCES users(id),
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS purchase_order_lines (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    purchase_order_id   UUID          NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
    line_number         INTEGER       NOT NULL,
    item_id             UUID          NOT NULL REFERENCES items(id),
    description         TEXT,
    qty_ordered         NUMERIC(14,4) NOT NULL CHECK (qty_ordered > 0),
    qty_received        NUMERIC(14,4) NOT NULL DEFAULT 0,
    qty_remaining       NUMERIC(14,4) GENERATED ALWAYS AS
                            (GREATEST(qty_ordered - qty_received, 0)) STORED,
    unit_cost           NUMERIC(14,4) NOT NULL DEFAULT 0,
    line_total          NUMERIC(18,4) GENERATED ALWAYS AS
                            (ROUND(qty_ordered * unit_cost, 4)) STORED,
    status              VARCHAR(15)   NOT NULL DEFAULT 'open'
                            CHECK (status IN ('open','partial','received','cancelled')),
    created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    UNIQUE (purchase_order_id, line_number)
);

-- ── Receipts ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS purchase_receipts (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    number              VARCHAR(30)   NOT NULL UNIQUE,
    purchase_order_id   UUID          NOT NULL REFERENCES purchase_orders(id),
    warehouse_id        UUID          NOT NULL REFERENCES warehouses(id),
    status              VARCHAR(15)   NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft','posted')),
    receipt_date        DATE          NOT NULL DEFAULT CURRENT_DATE,
    vendor_ref          VARCHAR(100),
    notes               TEXT,
    created_by          UUID          REFERENCES users(id),
    created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS purchase_receipt_lines (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    receipt_id              UUID          NOT NULL REFERENCES purchase_receipts(id) ON DELETE CASCADE,
    purchase_order_line_id  UUID          NOT NULL REFERENCES purchase_order_lines(id),
    item_id                 UUID          NOT NULL REFERENCES items(id),
    qty_received            NUMERIC(14,4) NOT NULL CHECK (qty_received > 0),
    actual_cost             NUMERIC(14,4) NOT NULL DEFAULT 0
);

-- ── Vendor Invoices ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vendor_invoices (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    number              VARCHAR(30)   NOT NULL UNIQUE,
    vendor_id           UUID          NOT NULL REFERENCES parties(id),
    purchase_order_id   UUID          REFERENCES purchase_orders(id),
    receipt_id          UUID          REFERENCES purchase_receipts(id),
    status              VARCHAR(15)   NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','approved','disputed','paid','void')),
    match_status        VARCHAR(15)   NOT NULL DEFAULT 'unmatched'
                            CHECK (match_status IN ('unmatched','matched','approved','disputed')),
    invoice_date        DATE          NOT NULL DEFAULT CURRENT_DATE,
    due_date            DATE          NOT NULL,
    subtotal            NUMERIC(18,4) NOT NULL DEFAULT 0,
    tax_amount          NUMERIC(18,4) NOT NULL DEFAULT 0,
    total               NUMERIC(18,4) NOT NULL DEFAULT 0,
    amount_paid         NUMERIC(18,4) NOT NULL DEFAULT 0,
    balance_due         NUMERIC(18,4) GENERATED ALWAYS AS
                            (GREATEST(ROUND(total - amount_paid, 4), 0)) STORED,
    three_way_match_notes TEXT,
    notes               TEXT,
    vendor_invoice_number VARCHAR(100),
    created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- ── AP Payments ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payments_made (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vendor_id        UUID          NOT NULL REFERENCES parties(id),
    payment_date     DATE          NOT NULL DEFAULT CURRENT_DATE,
    amount           NUMERIC(14,4) NOT NULL CHECK (amount > 0),
    method           VARCHAR(15)   NOT NULL DEFAULT 'check'
                         CHECK (method IN ('check','wire','ach','credit_card','cash')),
    reference_number VARCHAR(100),
    notes            TEXT,
    created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payment_disbursements (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_id          UUID          NOT NULL REFERENCES payments_made(id) ON DELETE CASCADE,
    vendor_invoice_id   UUID          NOT NULL REFERENCES vendor_invoices(id),
    amount_applied      NUMERIC(14,4) NOT NULL CHECK (amount_applied > 0),
    created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- ── Indexes ───────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_po_vendor    ON purchase_orders(vendor_id);
CREATE INDEX IF NOT EXISTS idx_po_status    ON purchase_orders(status);
CREATE INDEX IF NOT EXISTS idx_pol_po       ON purchase_order_lines(purchase_order_id);
CREATE INDEX IF NOT EXISTS idx_pol_item     ON purchase_order_lines(item_id);
CREATE INDEX IF NOT EXISTS idx_rcv_po       ON purchase_receipts(purchase_order_id);
CREATE INDEX IF NOT EXISTS idx_rcvl_rcv     ON purchase_receipt_lines(receipt_id);
CREATE INDEX IF NOT EXISTS idx_vinv_vendor  ON vendor_invoices(vendor_id);
CREATE INDEX IF NOT EXISTS idx_vinv_status  ON vendor_invoices(status);
CREATE INDEX IF NOT EXISTS idx_pmnt_vendor  ON payments_made(vendor_id);

-- ── Views ─────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW v_purchase_order_status AS
SELECT
    po.id, po.number, po.status, po.order_date, po.expected_date, po.notes,
    po.created_at, po.updated_at,
    p.id   AS vendor_id,
    p.code AS vendor_code,
    p.name AS vendor_name,
    w.code AS warehouse_code,
    w.id   AS warehouse_id,
    (SELECT COUNT(*)
       FROM purchase_order_lines WHERE purchase_order_id = po.id)                AS line_count,
    (SELECT COALESCE(SUM(qty_ordered),0)
       FROM purchase_order_lines WHERE purchase_order_id = po.id)                AS total_qty_ordered,
    (SELECT COALESCE(SUM(qty_received),0)
       FROM purchase_order_lines WHERE purchase_order_id = po.id)                AS total_qty_received,
    (SELECT COALESCE(SUM(qty_remaining),0)
       FROM purchase_order_lines WHERE purchase_order_id = po.id)                AS total_qty_remaining,
    (SELECT COALESCE(SUM(line_total),0)
       FROM purchase_order_lines WHERE purchase_order_id = po.id)                AS po_total
FROM purchase_orders po
JOIN parties    p ON p.id = po.vendor_id
JOIN warehouses w ON w.id = po.warehouse_id;

-- Items qty currently on open POs
CREATE OR REPLACE VIEW v_stock_on_order AS
SELECT
    i.id   AS item_id,
    i.code AS item_code,
    i.name AS item_name,
    COALESCE(SUM(pol.qty_remaining), 0)                   AS qty_on_order,
    COALESCE(SUM(pol.qty_remaining * pol.unit_cost), 0)   AS value_on_order
FROM items i
LEFT JOIN purchase_order_lines pol ON pol.item_id = i.id
LEFT JOIN purchase_orders po       ON po.id = pol.purchase_order_id
    AND po.status IN ('sent','partially_received')
GROUP BY i.id, i.code, i.name;

-- AP Aging: vendor invoices bucketed by days overdue
CREATE OR REPLACE VIEW v_ap_aging AS
SELECT
    p.id            AS vendor_id,
    p.code          AS vendor_code,
    p.name          AS vendor_name,
    COALESCE(SUM(vi.balance_due) FILTER (
        WHERE vi.due_date >= CURRENT_DATE), 0)                                   AS current_due,
    COALESCE(SUM(vi.balance_due) FILTER (
        WHERE vi.due_date <  CURRENT_DATE
          AND vi.due_date >= CURRENT_DATE - INTERVAL '30 days'), 0)              AS days_1_30,
    COALESCE(SUM(vi.balance_due) FILTER (
        WHERE vi.due_date <  CURRENT_DATE - INTERVAL '30 days'
          AND vi.due_date >= CURRENT_DATE - INTERVAL '60 days'), 0)              AS days_31_60,
    COALESCE(SUM(vi.balance_due) FILTER (
        WHERE vi.due_date <  CURRENT_DATE - INTERVAL '60 days'
          AND vi.due_date >= CURRENT_DATE - INTERVAL '90 days'), 0)              AS days_61_90,
    COALESCE(SUM(vi.balance_due) FILTER (
        WHERE vi.due_date <  CURRENT_DATE - INTERVAL '90 days'), 0)              AS days_90plus,
    COALESCE(SUM(vi.balance_due), 0)                                             AS total_due
FROM parties p
LEFT JOIN vendor_invoices vi ON vi.vendor_id = p.id
    AND vi.status NOT IN ('paid','void')
    AND vi.balance_due > 0
WHERE p.type IN ('vendor','both') AND p.is_active = true
GROUP BY p.id, p.code, p.name;

-- Reorder suggestions: items at or below reorder point after netting on-order qty
CREATE OR REPLACE VIEW v_reorder_suggestions AS
SELECT
    i.id              AS item_id,
    i.code            AS item_code,
    i.name            AS item_name,
    i.category,
    i.reorder_point,
    i.reorder_qty,
    i.standard_cost,
    i.lead_time_days,
    COALESCE(soh_agg.qty_on_hand, 0)  AS qty_on_hand,
    COALESCE(soo.qty_on_order,   0)   AS qty_on_order,
    COALESCE(soh_agg.qty_on_hand, 0)
        + COALESCE(soo.qty_on_order, 0)                   AS effective_qty,
    GREATEST(
        i.reorder_qty - COALESCE(soo.qty_on_order, 0), 0
    )                                                      AS suggested_order_qty,
    pv.id   AS preferred_vendor_id,
    pv.code AS preferred_vendor_code,
    pv.name AS preferred_vendor_name
FROM items i
LEFT JOIN (
    SELECT item_id, SUM(qty_on_hand) AS qty_on_hand
    FROM   v_stock_on_hand
    GROUP  BY item_id
) soh_agg ON soh_agg.item_id = i.id
LEFT JOIN v_stock_on_order soo ON soo.item_id = i.id
LEFT JOIN parties pv           ON pv.id = i.preferred_vendor_id
WHERE i.is_active    = true
  AND i.reorder_point > 0
  AND (COALESCE(soh_agg.qty_on_hand, 0) + COALESCE(soo.qty_on_order, 0)) < i.reorder_point;

-- ── Seed: 3 Vendors ───────────────────────────────────────────────────────────
INSERT INTO parties (id, type, code, name, email, phone, billing_address, payment_terms_days, currency)
VALUES
(
    'd0000001-0000-0000-0000-000000000006',
    'vendor', 'VEND-001', 'Swiss Time Imports AG',
    'orders@swisstime.ch', '+41-32-555-0601',
    '{"line1":"Hauptstrasse 42","city":"Biel","state":"BE","zip":"2500","country":"CH"}',
    30, 'USD'
),(
    'd0000001-0000-0000-0000-000000000007',
    'vendor', 'VEND-002', 'Orient Watch Manufacturing',
    'supply@orientwatch.jp', '+81-3-555-0702',
    '{"line1":"3-7-1 Shinjuku","city":"Tokyo","state":"Tokyo","zip":"160-0022","country":"JP"}',
    45, 'USD'
),(
    'd0000001-0000-0000-0000-000000000008',
    'vendor', 'VEND-003', 'Global Accessories Ltd.',
    'procurement@globalacc.com', '212-555-0803',
    '{"line1":"200 Fifth Ave","city":"New York","state":"NY","zip":"10010","country":"US"}',
    15, 'USD'
)
ON CONFLICT (code) DO NOTHING;

-- Set preferred vendors on some items
UPDATE items SET preferred_vendor_id = 'd0000001-0000-0000-0000-000000000006'
WHERE code IN ('WCH-001','WCH-002','WCH-003','WCH-004');

UPDATE items SET preferred_vendor_id = 'd0000001-0000-0000-0000-000000000007'
WHERE code IN ('STR-001','STR-002');

UPDATE items SET preferred_vendor_id = 'd0000001-0000-0000-0000-000000000008'
WHERE code IN ('BOX-001','ACC-001');

-- ── Seed: 3 Purchase Orders ───────────────────────────────────────────────────

-- PO 1 — Draft: WCH-001 + STR-001 from VEND-001
INSERT INTO purchase_orders (id, number, vendor_id, warehouse_id, status, order_date, expected_date, notes)
VALUES (
    '00000011-0000-0000-0000-000000000001',
    'PO-2026-00001',
    'd0000001-0000-0000-0000-000000000006',
    'b0000001-0000-0000-0000-000000000001',
    'draft', '2026-02-01', '2026-02-20',
    'Q1 restock — Swiss watches and straps'
) ON CONFLICT (number) DO NOTHING;

INSERT INTO purchase_order_lines (purchase_order_id, line_number, item_id, qty_ordered, unit_cost)
SELECT '00000011-0000-0000-0000-000000000001', 1, id, 50, standard_cost
FROM items WHERE code = 'WCH-001' ON CONFLICT DO NOTHING;

INSERT INTO purchase_order_lines (purchase_order_id, line_number, item_id, qty_ordered, unit_cost)
SELECT '00000011-0000-0000-0000-000000000001', 2, id, 100, standard_cost
FROM items WHERE code = 'STR-001' ON CONFLICT DO NOTHING;

-- PO 2 — Sent: WCH-002 + WCH-004 from VEND-002
INSERT INTO purchase_orders (id, number, vendor_id, warehouse_id, status, order_date, expected_date)
VALUES (
    '00000011-0000-0000-0000-000000000002',
    'PO-2026-00002',
    'd0000001-0000-0000-0000-000000000007',
    'b0000001-0000-0000-0000-000000000001',
    'sent', '2026-01-20', '2026-02-10'
) ON CONFLICT (number) DO NOTHING;

INSERT INTO purchase_order_lines (purchase_order_id, line_number, item_id, qty_ordered, unit_cost)
SELECT '00000011-0000-0000-0000-000000000002', 1, id, 30, standard_cost
FROM items WHERE code = 'WCH-002' ON CONFLICT DO NOTHING;

INSERT INTO purchase_order_lines (purchase_order_id, line_number, item_id, qty_ordered, unit_cost)
SELECT '00000011-0000-0000-0000-000000000002', 2, id, 20, standard_cost
FROM items WHERE code = 'WCH-004' ON CONFLICT DO NOTHING;

-- PO 3 — Partially Received: BOX-001 + ACC-001 from VEND-003
-- (100 of 200 BOX-001 received)
INSERT INTO purchase_orders (id, number, vendor_id, warehouse_id, status, order_date, expected_date)
VALUES (
    '00000011-0000-0000-0000-000000000003',
    'PO-2026-00003',
    'd0000001-0000-0000-0000-000000000008',
    'b0000001-0000-0000-0000-000000000001',
    'partially_received', '2026-01-15', '2026-02-01'
) ON CONFLICT (number) DO NOTHING;

INSERT INTO purchase_order_lines (id, purchase_order_id, line_number, item_id, qty_ordered, qty_received, unit_cost, status)
SELECT
    '00000012-0000-0000-0000-000000000001',
    '00000011-0000-0000-0000-000000000003', 1, id, 200, 100, standard_cost, 'partial'
FROM items WHERE code = 'BOX-001' ON CONFLICT DO NOTHING;

INSERT INTO purchase_order_lines (id, purchase_order_id, line_number, item_id, qty_ordered, qty_received, unit_cost, status)
SELECT
    '00000012-0000-0000-0000-000000000002',
    '00000011-0000-0000-0000-000000000003', 2, id, 100, 0, standard_cost, 'open'
FROM items WHERE code = 'ACC-001' ON CONFLICT DO NOTHING;

-- ── Seed: 1 Posted Receipt for PO-2026-00003 ────────────────────────────────
INSERT INTO purchase_receipts (id, number, purchase_order_id, warehouse_id, status, receipt_date, vendor_ref)
VALUES (
    '00000013-0000-0000-0000-000000000001',
    'RCV-2026-00001',
    '00000011-0000-0000-0000-000000000003',
    'b0000001-0000-0000-0000-000000000001',
    'posted', '2026-01-28',
    'GLACC-INV-2026-0188'
) ON CONFLICT (number) DO NOTHING;

INSERT INTO purchase_receipt_lines (receipt_id, purchase_order_line_id, item_id, qty_received, actual_cost)
SELECT
    '00000013-0000-0000-0000-000000000001',
    '00000012-0000-0000-0000-000000000001',
    i.id,
    100,
    i.standard_cost
FROM items i WHERE i.code = 'BOX-001'
ON CONFLICT DO NOTHING;

-- Insert stock_ledger entry for the posted receipt (100 × BOX-001)
INSERT INTO stock_ledger
    (item_id, warehouse_id, transaction_type, reference_type, reference_id,
     qty, cost_per_unit, notes, posting_date)
SELECT
    i.id,
    'b0000001-0000-0000-0000-000000000001',
    'receipt',
    'purchase_receipt',
    '00000013-0000-0000-0000-000000000001',
    100,
    i.standard_cost,
    'RCV-2026-00001 — PO-2026-00003',
    '2026-01-28'
FROM items i WHERE i.code = 'BOX-001'
ON CONFLICT DO NOTHING;

-- ── Seed: Vendor Invoices ─────────────────────────────────────────────────────

-- VINV-2026-00001 — Approved (matches receipt exactly)
INSERT INTO vendor_invoices (
    id, number, vendor_id, purchase_order_id, receipt_id, status, match_status,
    invoice_date, due_date, subtotal, tax_amount, total, vendor_invoice_number,
    three_way_match_notes
)
SELECT
    '00000014-0000-0000-0000-000000000001',
    'VINV-2026-00001',
    'd0000001-0000-0000-0000-000000000008',
    '00000011-0000-0000-0000-000000000003',
    '00000013-0000-0000-0000-000000000001',
    'approved', 'approved',
    '2026-01-28',
    '2026-01-28'::date + INTERVAL '15 days',
    ROUND(100 * standard_cost, 4),
    0,
    ROUND(100 * standard_cost, 4),
    'GLACC-INV-2026-0188',
    'Three-way match passed: qty=100, unit_cost matches PO within tolerance'
FROM items WHERE code = 'BOX-001'
ON CONFLICT (number) DO NOTHING;

-- VINV-2026-00002 — Disputed (vendor overcharged: $5.50 vs PO $5.00, >1%)
INSERT INTO vendor_invoices (
    id, number, vendor_id, purchase_order_id, receipt_id, status, match_status,
    invoice_date, due_date, subtotal, tax_amount, total, vendor_invoice_number,
    three_way_match_notes
)
SELECT
    '00000014-0000-0000-0000-000000000002',
    'VINV-2026-00002',
    'd0000001-0000-0000-0000-000000000008',
    '00000011-0000-0000-0000-000000000003',
    '00000013-0000-0000-0000-000000000001',
    'disputed', 'disputed',
    '2026-01-29',
    '2026-01-29'::date + INTERVAL '15 days',
    ROUND(100 * (standard_cost * 1.10), 4),
    0,
    ROUND(100 * (standard_cost * 1.10), 4),
    'GLACC-INV-2026-0189',
    'Price mismatch: vendor billed ' || ROUND(standard_cost * 1.10, 4) || ', PO cost ' || standard_cost || ' — variance exceeds 1% tolerance'
FROM items WHERE code = 'BOX-001'
ON CONFLICT (number) DO NOTHING;

-- ── Seed: Payment on approved invoice ────────────────────────────────────────
INSERT INTO payments_made (id, vendor_id, payment_date, amount, method, reference_number)
SELECT
    '00000015-0000-0000-0000-000000000001',
    'd0000001-0000-0000-0000-000000000008',
    '2026-02-05',
    ROUND(100 * standard_cost, 4),
    'wire',
    'WIRE-OUT-2026-0205'
FROM items WHERE code = 'BOX-001'
ON CONFLICT DO NOTHING;

INSERT INTO payment_disbursements (payment_id, vendor_invoice_id, amount_applied)
SELECT
    '00000015-0000-0000-0000-000000000001',
    '00000014-0000-0000-0000-000000000001',
    ROUND(100 * standard_cost, 4)
FROM items WHERE code = 'BOX-001'
ON CONFLICT DO NOTHING;

UPDATE vendor_invoices
SET amount_paid = (
        SELECT ROUND(100 * standard_cost, 4) FROM items WHERE code = 'BOX-001'
    ),
    status = 'paid',
    updated_at = NOW()
WHERE id = '00000014-0000-0000-0000-000000000001';
