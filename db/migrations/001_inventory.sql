-- ============================================================
-- Tick Tock Inc. — Inventory Module Migration
-- 001_inventory.sql
-- ============================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- TABLES
-- ============================================================

-- Users
CREATE TABLE IF NOT EXISTS users (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        VARCHAR(100) NOT NULL,
    email       VARCHAR(150) NOT NULL UNIQUE,
    role        VARCHAR(50)  NOT NULL CHECK (role IN ('admin','warehouse','sales')),
    is_active   BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Warehouses
CREATE TABLE IF NOT EXISTS warehouses (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code        VARCHAR(20)  NOT NULL UNIQUE,
    name        VARCHAR(100) NOT NULL,
    address     TEXT,
    is_active   BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Items (product catalog)
CREATE TABLE IF NOT EXISTS items (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code            VARCHAR(30)     NOT NULL UNIQUE,
    name            VARCHAR(150)    NOT NULL,
    description     TEXT,
    unit_of_measure VARCHAR(20)     NOT NULL DEFAULT 'EA',
    cost_method     VARCHAR(10)     NOT NULL DEFAULT 'avg' CHECK (cost_method IN ('fifo','avg')),
    standard_cost   NUMERIC(14,4)   NOT NULL DEFAULT 0,
    sale_price      NUMERIC(14,4)   NOT NULL DEFAULT 0,
    reorder_point   NUMERIC(14,4)   NOT NULL DEFAULT 0,
    reorder_qty     NUMERIC(14,4)   NOT NULL DEFAULT 0,
    lead_time_days  INTEGER         NOT NULL DEFAULT 0,
    category        VARCHAR(50),
    is_active       BOOLEAN         NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- Stock Ledger — APPEND ONLY, NEVER UPDATE OR DELETE
CREATE TABLE IF NOT EXISTS stock_ledger (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    item_id          UUID            NOT NULL REFERENCES items(id),
    warehouse_id     UUID            NOT NULL REFERENCES warehouses(id),
    transaction_type VARCHAR(30)     NOT NULL,   -- opening_balance, adjustment, receipt, shipment, transfer_in, transfer_out
    reference_type   VARCHAR(30),
    reference_id     UUID,
    qty              NUMERIC(14,4)   NOT NULL,   -- positive = in, negative = out
    cost_per_unit    NUMERIC(14,4)   NOT NULL DEFAULT 0,
    total_cost       NUMERIC(18,4)   GENERATED ALWAYS AS (qty * cost_per_unit) STORED,
    notes            TEXT,
    posting_date     DATE            NOT NULL DEFAULT CURRENT_DATE,
    created_at       TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    created_by       UUID            REFERENCES users(id)
);

-- Stock Reservations
CREATE TABLE IF NOT EXISTS stock_reservations (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    item_id        UUID            NOT NULL REFERENCES items(id),
    warehouse_id   UUID            NOT NULL REFERENCES warehouses(id),
    reference_type VARCHAR(30),
    reference_id   UUID,
    qty_reserved   NUMERIC(14,4)   NOT NULL CHECK (qty_reserved > 0),
    status         VARCHAR(20)     NOT NULL DEFAULT 'active' CHECK (status IN ('active','fulfilled','cancelled')),
    created_at     TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- Stock Adjustments (header)
CREATE TABLE IF NOT EXISTS stock_adjustments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    number          VARCHAR(30)     NOT NULL UNIQUE,
    warehouse_id    UUID            NOT NULL REFERENCES warehouses(id),
    adjustment_date DATE            NOT NULL DEFAULT CURRENT_DATE,
    reason          VARCHAR(100),
    status          VARCHAR(20)     NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted','cancelled')),
    notes           TEXT,
    posted_at       TIMESTAMPTZ,
    created_by      UUID            REFERENCES users(id),
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- Stock Adjustment Lines (detail)
CREATE TABLE IF NOT EXISTS stock_adjustment_lines (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    adjustment_id   UUID            NOT NULL REFERENCES stock_adjustments(id) ON DELETE CASCADE,
    item_id         UUID            NOT NULL REFERENCES items(id),
    qty_system      NUMERIC(14,4)   NOT NULL DEFAULT 0,
    qty_actual      NUMERIC(14,4)   NOT NULL DEFAULT 0,
    qty_difference  NUMERIC(14,4)   GENERATED ALWAYS AS (qty_actual - qty_system) STORED,
    cost_per_unit   NUMERIC(14,4)   NOT NULL DEFAULT 0,
    notes           TEXT
);

-- Audit Log — APPEND ONLY
CREATE TABLE IF NOT EXISTS audit_log (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID            REFERENCES users(id),
    action      VARCHAR(50)     NOT NULL,
    table_name  VARCHAR(50)     NOT NULL,
    record_id   UUID,
    old_values  JSONB,
    new_values  JSONB,
    created_at  TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- ============================================================
-- VIEWS
-- ============================================================

-- v_stock_on_hand: current qty per item per warehouse
CREATE OR REPLACE VIEW v_stock_on_hand AS
SELECT
    sl.item_id,
    sl.warehouse_id,
    i.code      AS item_code,
    i.name      AS item_name,
    i.category,
    i.unit_of_measure,
    i.standard_cost,
    i.sale_price,
    i.reorder_point,
    i.reorder_qty,
    w.code      AS warehouse_code,
    w.name      AS warehouse_name,
    COALESCE(SUM(sl.qty), 0)                      AS qty_on_hand,
    COALESCE(SUM(sl.qty * sl.cost_per_unit), 0)   AS total_cost_value
FROM stock_ledger sl
JOIN items      i ON i.id = sl.item_id
JOIN warehouses w ON w.id = sl.warehouse_id
GROUP BY sl.item_id, sl.warehouse_id, i.code, i.name, i.category,
         i.unit_of_measure, i.standard_cost, i.sale_price,
         i.reorder_point, i.reorder_qty, w.code, w.name;

-- v_stock_availability: on_hand, committed, available
CREATE OR REPLACE VIEW v_stock_availability AS
SELECT
    soh.item_id,
    soh.warehouse_id,
    soh.item_code,
    soh.item_name,
    soh.category,
    soh.unit_of_measure,
    soh.standard_cost,
    soh.sale_price,
    soh.reorder_point,
    soh.reorder_qty,
    soh.warehouse_code,
    soh.warehouse_name,
    soh.qty_on_hand,
    soh.total_cost_value,
    COALESCE(r.qty_committed, 0)                                    AS qty_committed,
    soh.qty_on_hand - COALESCE(r.qty_committed, 0)                 AS qty_available
FROM v_stock_on_hand soh
LEFT JOIN (
    SELECT item_id, warehouse_id, SUM(qty_reserved) AS qty_committed
    FROM stock_reservations
    WHERE status = 'active'
    GROUP BY item_id, warehouse_id
) r ON r.item_id = soh.item_id AND r.warehouse_id = soh.warehouse_id;

-- v_reorder_alerts: items where available qty <= reorder_point
CREATE OR REPLACE VIEW v_reorder_alerts AS
SELECT *
FROM v_stock_availability
WHERE qty_available <= reorder_point;

-- ============================================================
-- SEED DATA
-- ============================================================

-- Users
INSERT INTO users (id, name, email, role) VALUES
    ('a0000001-0000-0000-0000-000000000001', 'Admin User',     'admin@ticktock.com',     'admin'),
    ('a0000001-0000-0000-0000-000000000002', 'Warehouse Staff','warehouse@ticktock.com', 'warehouse'),
    ('a0000001-0000-0000-0000-000000000003', 'Sales Rep',      'sales@ticktock.com',     'sales')
ON CONFLICT (email) DO NOTHING;

-- Warehouses
INSERT INTO warehouses (id, code, name, address) VALUES
    ('b0000001-0000-0000-0000-000000000001', 'MAIN',     'Main Warehouse',     '100 Tick Tock Ave, Suite 1, New York, NY 10001'),
    ('b0000001-0000-0000-0000-000000000002', 'OVERFLOW', 'Overflow Warehouse', '200 Tick Tock Ave, Suite 2, New York, NY 10002')
ON CONFLICT (code) DO NOTHING;

-- Items
INSERT INTO items (id, code, name, description, unit_of_measure, cost_method, standard_cost, sale_price, reorder_point, reorder_qty, lead_time_days, category) VALUES
    ('c0000001-0000-0000-0000-000000000001', 'WCH-001', 'Classic Silver Watch',       'Stainless steel case, leather strap, Swiss movement',       'EA', 'avg',  85.00,  149.99, 10, 25, 14, 'Watches'),
    ('c0000001-0000-0000-0000-000000000002', 'WCH-002', 'Sport Chronograph Watch',    'Water-resistant 100m, tachymeter bezel, silicone strap',    'EA', 'avg', 120.00,  219.99, 8,  20, 21, 'Watches'),
    ('c0000001-0000-0000-0000-000000000003', 'WCH-003', 'Gold Dress Watch',           '18K gold-plated case, sapphire crystal, crocodile strap',   'EA', 'fifo',210.00,  399.99, 5,  10, 30, 'Watches'),
    ('c0000001-0000-0000-0000-000000000004', 'WCH-004', 'Digital Smart Watch',        'Heart rate monitor, GPS, 7-day battery life',               'EA', 'avg',  95.00,  179.99, 12, 30, 10, 'Watches'),
    ('c0000001-0000-0000-0000-000000000005', 'STR-001', 'Leather Watch Strap 20mm',   'Genuine cowhide leather, quick-release pins, 20mm width',   'EA', 'avg',   8.50,   24.99, 50, 100,7,  'Straps'),
    ('c0000001-0000-0000-0000-000000000006', 'STR-002', 'NATO Nylon Strap 22mm',      'Military-grade nylon, stainless hardware, 22mm width',      'EA', 'avg',   4.00,   14.99, 75, 150,7,  'Straps'),
    ('c0000001-0000-0000-0000-000000000007', 'BOX-001', 'Luxury Watch Box',           'Velvet-lined wooden display box, single watch storage',     'EA', 'avg',  12.00,   34.99, 30, 60, 14, 'Packaging'),
    ('c0000001-0000-0000-0000-000000000008', 'ACC-001', 'Watch Cleaning Kit',         'Microfiber cloth, cleaning solution, polishing tool set',   'EA', 'avg',   5.50,   19.99, 40, 80, 7,  'Accessories')
ON CONFLICT (code) DO NOTHING;

-- Opening Balances in MAIN warehouse
INSERT INTO stock_ledger (item_id, warehouse_id, transaction_type, reference_type, qty, cost_per_unit, notes, posting_date, created_by) VALUES
    ('c0000001-0000-0000-0000-000000000001', 'b0000001-0000-0000-0000-000000000001', 'opening_balance', 'initial_setup', 45,   85.00,  'Opening balance - Classic Silver Watch',    '2024-01-01', 'a0000001-0000-0000-0000-000000000001'),
    ('c0000001-0000-0000-0000-000000000002', 'b0000001-0000-0000-0000-000000000001', 'opening_balance', 'initial_setup', 30,  120.00,  'Opening balance - Sport Chronograph Watch', '2024-01-01', 'a0000001-0000-0000-0000-000000000001'),
    ('c0000001-0000-0000-0000-000000000003', 'b0000001-0000-0000-0000-000000000001', 'opening_balance', 'initial_setup', 12,  210.00,  'Opening balance - Gold Dress Watch',        '2024-01-01', 'a0000001-0000-0000-0000-000000000001'),
    ('c0000001-0000-0000-0000-000000000004', 'b0000001-0000-0000-0000-000000000001', 'opening_balance', 'initial_setup', 55,   95.00,  'Opening balance - Digital Smart Watch',     '2024-01-01', 'a0000001-0000-0000-0000-000000000001'),
    ('c0000001-0000-0000-0000-000000000005', 'b0000001-0000-0000-0000-000000000001', 'opening_balance', 'initial_setup', 200,   8.50,  'Opening balance - Leather Watch Strap',     '2024-01-01', 'a0000001-0000-0000-0000-000000000001'),
    ('c0000001-0000-0000-0000-000000000006', 'b0000001-0000-0000-0000-000000000001', 'opening_balance', 'initial_setup', 8,     4.00,  'Opening balance - NATO Nylon Strap',        '2024-01-01', 'a0000001-0000-0000-0000-000000000001'),
    ('c0000001-0000-0000-0000-000000000007', 'b0000001-0000-0000-0000-000000000001', 'opening_balance', 'initial_setup', 25,   12.00,  'Opening balance - Luxury Watch Box',        '2024-01-01', 'a0000001-0000-0000-0000-000000000001'),
    ('c0000001-0000-0000-0000-000000000008', 'b0000001-0000-0000-0000-000000000001', 'opening_balance', 'initial_setup', 5,     5.50,  'Opening balance - Watch Cleaning Kit',      '2024-01-01', 'a0000001-0000-0000-0000-000000000001');

-- Sample reservations so availability view shows committed stock
INSERT INTO stock_reservations (item_id, warehouse_id, reference_type, qty_reserved, status) VALUES
    ('c0000001-0000-0000-0000-000000000001', 'b0000001-0000-0000-0000-000000000001', 'sales_order', 5,  'active'),
    ('c0000001-0000-0000-0000-000000000002', 'b0000001-0000-0000-0000-000000000001', 'sales_order', 8,  'active'),
    ('c0000001-0000-0000-0000-000000000004', 'b0000001-0000-0000-0000-000000000001', 'sales_order', 10, 'active');
