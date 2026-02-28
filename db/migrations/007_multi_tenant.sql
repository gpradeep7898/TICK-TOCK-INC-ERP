-- ═══════════════════════════════════════════════════════════════════════
-- MIGRATION 007: Multi-Tenant Company Module
-- ───────────────────────────────────────────────────────────────────────
-- Strategy : Shared schema + company_id column + PostgreSQL Row Level Security
-- Isolation: Every tenant query sets set_config('app.tenant_id', uuid, true)
--            RLS policies enforce company_id = current_company_id() per row.
-- App role : erp_app (non-superuser) — required for RLS to take effect.
--            postgres superuser bypasses RLS; do NOT connect as postgres in prod.
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;

-- ───────────────────────────────────────────────────────────────────────
-- 1. COMPANIES — Tenant master record
-- ───────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS companies (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  slug              TEXT        UNIQUE NOT NULL,
  name              TEXT        NOT NULL,
  plan              TEXT        NOT NULL DEFAULT 'starter'
                                CHECK (plan IN ('starter','professional','enterprise')),
  status            TEXT        NOT NULL DEFAULT 'active'
                                CHECK (status IN ('active','suspended','cancelled','trial')),
  owner_email       TEXT        NOT NULL,
  timezone          TEXT        NOT NULL DEFAULT 'America/New_York',
  currency_code     CHAR(3)     NOT NULL DEFAULT 'USD',
  fiscal_year_start SMALLINT    NOT NULL DEFAULT 1
                                CHECK (fiscal_year_start BETWEEN 1 AND 12),
  logo_url          TEXT,
  max_users         INT         NOT NULL DEFAULT 5,
  max_warehouses    INT         NOT NULL DEFAULT 3,
  trial_ends_at     TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ───────────────────────────────────────────────────────────────────────
-- 2. COMPANY SETTINGS — Per-tenant operational configuration
-- ───────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS company_settings (
  company_id              UUID        PRIMARY KEY
                                      REFERENCES companies(id) ON DELETE CASCADE,
  costing_method          TEXT        NOT NULL DEFAULT 'weighted_avg'
                                      CHECK (costing_method IN ('weighted_avg','fifo')),
  auto_invoice            BOOLEAN     NOT NULL DEFAULT TRUE,
  auto_reserve_on_so      BOOLEAN     NOT NULL DEFAULT TRUE,
  low_stock_alert_email   TEXT,
  default_payment_terms   INT         NOT NULL DEFAULT 30,
  tax_enabled             BOOLEAN     NOT NULL DEFAULT FALSE,
  default_tax_rate        DECIMAL(6,4) NOT NULL DEFAULT 0,
  -- Document number sequences (per-tenant, no cross-tenant collisions)
  next_so_number          INT         NOT NULL DEFAULT 1000,
  next_po_number          INT         NOT NULL DEFAULT 1000,
  next_invoice_number     INT         NOT NULL DEFAULT 1000,
  next_adj_number         INT         NOT NULL DEFAULT 1,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ───────────────────────────────────────────────────────────────────────
-- 3. COMPANY USERS — User membership + role per company
--    A single user can belong to multiple companies (e.g. a consultant).
--    Their role is company-scoped, not global.
-- ───────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS company_users (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   UUID        NOT NULL REFERENCES companies(id)  ON DELETE CASCADE,
  user_id      UUID        NOT NULL REFERENCES users(id)      ON DELETE CASCADE,
  role         TEXT        NOT NULL DEFAULT 'warehouse'
                           CHECK (role IN ('admin','manager','sales','warehouse','readonly')),
  is_active    BOOLEAN     NOT NULL DEFAULT TRUE,
  invited_by   UUID        REFERENCES users(id) ON DELETE SET NULL,
  joined_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_company_users_company ON company_users(company_id);
CREATE INDEX IF NOT EXISTS idx_company_users_user    ON company_users(user_id);

-- ───────────────────────────────────────────────────────────────────────
-- 4. EXTEND USERS TABLE
-- ───────────────────────────────────────────────────────────────────────
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_platform_admin BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS last_company_id   UUID    REFERENCES companies(id) ON DELETE SET NULL;

-- ───────────────────────────────────────────────────────────────────────
-- 5. SEED DEFAULT COMPANY (Tick Tock Inc.)
--    Fixed UUID for dev/seed script compatibility.
-- ───────────────────────────────────────────────────────────────────────
INSERT INTO companies (
  id, slug, name, plan, status, owner_email,
  timezone, currency_code, fiscal_year_start, max_users, max_warehouses
) VALUES (
  '00000000-0000-0000-0000-000000000001',
  'ticktock-inc',
  'Tick Tock Inc.',
  'enterprise', 'active', 'admin@ticktock.com',
  'America/New_York', 'USD', 1, 50, 10
) ON CONFLICT (id) DO NOTHING;

INSERT INTO company_settings (company_id)
VALUES ('00000000-0000-0000-0000-000000000001')
ON CONFLICT (company_id) DO NOTHING;

-- Link all existing users to Tick Tock Inc.
INSERT INTO company_users (company_id, user_id, role)
SELECT '00000000-0000-0000-0000-000000000001', id, role
FROM   users
ON CONFLICT (company_id, user_id) DO NOTHING;

-- Set last_company_id for all existing users
UPDATE users
SET    last_company_id = '00000000-0000-0000-0000-000000000001'
WHERE  last_company_id IS NULL;

-- ───────────────────────────────────────────────────────────────────────
-- 6. ADD company_id TO ALL TENANT-SCOPED TABLES
--    Pattern: ADD nullable → backfill with default → SET NOT NULL
--    Wrapped in a DO block so we can loop dynamically.
-- ───────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  default_co UUID := '00000000-0000-0000-0000-000000000001';
  tbl        TEXT;
  tbls       TEXT[] := ARRAY[
    -- Inventory
    'items',
    'warehouses',
    'stock_ledger',
    'stock_reservations',
    'stock_adjustments',
    'stock_adjustment_lines',
    -- Parties & pricing
    'parties',
    'price_lists',
    'customer_item_price_locks',
    'price_change_log',
    -- Sales
    'sales_orders',
    'sales_order_lines',
    'shipments',
    'shipment_lines',
    'sales_invoices',
    'payments_received',
    -- Purchasing
    'purchase_orders',
    'purchase_order_lines',
    'purchase_receipts',
    'purchase_receipt_lines',
    'vendor_invoices',
    'payments_made',
    -- System
    'audit_log'
  ];
BEGIN
  FOREACH tbl IN ARRAY tbls LOOP
    -- Skip if table doesn't exist (guard for partial migrations)
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = tbl
    ) THEN
      RAISE NOTICE 'Table % does not exist — skipping', tbl;
      CONTINUE;
    END IF;

    -- Add company_id column (nullable first)
    EXECUTE format(
      'ALTER TABLE %I ADD COLUMN IF NOT EXISTS company_id UUID
       REFERENCES companies(id) ON DELETE CASCADE',
      tbl
    );

    -- Backfill all existing rows to the default company
    EXECUTE format(
      'UPDATE %I SET company_id = $1 WHERE company_id IS NULL',
      tbl
    ) USING default_co;

    -- Now enforce NOT NULL
    EXECUTE format(
      'ALTER TABLE %I ALTER COLUMN company_id SET NOT NULL',
      tbl
    );

    RAISE NOTICE 'company_id added and backfilled on %', tbl;
  END LOOP;
END $$;

-- ───────────────────────────────────────────────────────────────────────
-- 7. PERFORMANCE INDEXES on company_id
--    Composite with the most common secondary filter column.
-- ───────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_items_company              ON items(company_id);
CREATE INDEX IF NOT EXISTS idx_warehouses_company         ON warehouses(company_id);
CREATE INDEX IF NOT EXISTS idx_parties_company            ON parties(company_id);
CREATE INDEX IF NOT EXISTS idx_price_lists_company        ON price_lists(company_id);
CREATE INDEX IF NOT EXISTS idx_price_locks_company        ON customer_item_price_locks(company_id);
CREATE INDEX IF NOT EXISTS idx_price_change_log_company   ON price_change_log(company_id);

CREATE INDEX IF NOT EXISTS idx_sales_orders_company       ON sales_orders(company_id, status);
CREATE INDEX IF NOT EXISTS idx_sales_order_lines_company  ON sales_order_lines(company_id);
CREATE INDEX IF NOT EXISTS idx_shipments_company          ON shipments(company_id, status);
CREATE INDEX IF NOT EXISTS idx_sales_invoices_company     ON sales_invoices(company_id, status);
CREATE INDEX IF NOT EXISTS idx_payments_received_company  ON payments_received(company_id);

CREATE INDEX IF NOT EXISTS idx_purchase_orders_company    ON purchase_orders(company_id, status);
CREATE INDEX IF NOT EXISTS idx_po_lines_company           ON purchase_order_lines(company_id);
CREATE INDEX IF NOT EXISTS idx_receipts_company           ON purchase_receipts(company_id);
CREATE INDEX IF NOT EXISTS idx_receipt_lines_company      ON purchase_receipt_lines(company_id);
CREATE INDEX IF NOT EXISTS idx_vendor_invoices_company    ON vendor_invoices(company_id, status);
CREATE INDEX IF NOT EXISTS idx_payments_made_company      ON payments_made(company_id);

CREATE INDEX IF NOT EXISTS idx_stock_ledger_company       ON stock_ledger(company_id, posting_date DESC);
CREATE INDEX IF NOT EXISTS idx_stock_reservations_company ON stock_reservations(company_id, status);
CREATE INDEX IF NOT EXISTS idx_stock_adj_company          ON stock_adjustments(company_id, status);
CREATE INDEX IF NOT EXISTS idx_stock_adj_lines_company    ON stock_adjustment_lines(company_id);

CREATE INDEX IF NOT EXISTS idx_audit_log_company          ON audit_log(company_id, created_at DESC);

-- ───────────────────────────────────────────────────────────────────────
-- 8. APPLICATION DATABASE ROLE
--    Node.js MUST connect as erp_app (not postgres) for RLS to engage.
--    postgres is a superuser → bypasses RLS unconditionally.
-- ───────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'erp_app') THEN
    EXECUTE 'CREATE ROLE erp_app LOGIN PASSWORD ''change_in_production''';
    RAISE NOTICE 'Role erp_app created — update DATABASE_URL in .env before enabling RLS';
  END IF;
END $$;

GRANT CONNECT                         ON DATABASE ticktock  TO erp_app;
GRANT USAGE                           ON SCHEMA public      TO erp_app;
GRANT SELECT, INSERT, UPDATE, DELETE  ON ALL TABLES    IN SCHEMA public TO erp_app;
GRANT USAGE, SELECT                   ON ALL SEQUENCES IN SCHEMA public TO erp_app;
GRANT EXECUTE                         ON ALL FUNCTIONS IN SCHEMA public TO erp_app;

-- Ensure future objects also inherit these grants
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES    TO erp_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT                  ON SEQUENCES  TO erp_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE                        ON FUNCTIONS  TO erp_app;

-- ───────────────────────────────────────────────────────────────────────
-- 9. TENANT CONTEXT HELPER FUNCTION
--    Returns the UUID stored by set_config('app.tenant_id', ...) in the
--    current transaction. Returns NULL if not set (safe for superuser queries).
-- ───────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION current_company_id()
RETURNS UUID AS $$
  SELECT NULLIF(current_setting('app.tenant_id', TRUE), '')::UUID;
$$ LANGUAGE SQL STABLE SECURITY DEFINER;

-- ───────────────────────────────────────────────────────────────────────
-- 10. ROW LEVEL SECURITY
--     Enabled for erp_app role only.
--     postgres / platform migrations bypass RLS as expected.
--
--     Each table gets TWO policies:
--       tenant_isolation        — SELECT / UPDATE / DELETE filter
--       tenant_isolation_insert — INSERT check (prevents cross-tenant writes)
-- ───────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  tbl  TEXT;
  tbls TEXT[] := ARRAY[
    'items', 'warehouses', 'parties', 'price_lists',
    'customer_item_price_locks', 'price_change_log',
    'sales_orders', 'sales_order_lines', 'shipments', 'shipment_lines',
    'sales_invoices', 'payments_received',
    'purchase_orders', 'purchase_order_lines',
    'purchase_receipts', 'purchase_receipt_lines',
    'vendor_invoices', 'payments_made',
    'stock_ledger', 'stock_reservations',
    'stock_adjustments', 'stock_adjustment_lines',
    'audit_log'
  ];
BEGIN
  FOREACH tbl IN ARRAY tbls LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = tbl
    ) THEN CONTINUE; END IF;

    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);

    -- Read / Write filter
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', tbl);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
       TO erp_app
       USING (company_id = current_company_id())',
      tbl
    );

    -- Insert guard — prevents erp_app from inserting into another tenant
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_insert ON %I', tbl);
    EXECUTE format(
      'CREATE POLICY tenant_isolation_insert ON %I
       AS PERMISSIVE FOR INSERT
       TO erp_app
       WITH CHECK (company_id = current_company_id())',
      tbl
    );

    RAISE NOTICE 'RLS enabled on %', tbl;
  END LOOP;
END $$;

-- ───────────────────────────────────────────────────────────────────────
-- 11. REBUILD VIEWS WITH company_id
--     Views use SECURITY INVOKER (default) — they inherit the caller's
--     RLS context, so tenant isolation flows through automatically.
--     We rebuild them to include company_id so callers can GROUP BY it.
-- ───────────────────────────────────────────────────────────────────────
DROP VIEW IF EXISTS v_stock_availability;
DROP VIEW IF EXISTS v_stock_on_hand;

CREATE VIEW v_stock_on_hand AS
SELECT
  sl.company_id,
  sl.item_id,
  sl.warehouse_id,
  i.code          AS item_code,
  i.name          AS item_name,
  i.category,
  i.reorder_point,
  w.code          AS warehouse_code,
  w.name          AS warehouse_name,
  SUM(sl.qty)               AS qty_on_hand,
  SUM(sl.total_cost)        AS total_cost,
  CASE
    WHEN SUM(sl.qty) <= 0              THEN 'out_of_stock'
    WHEN SUM(sl.qty) <= i.reorder_point THEN 'low_stock'
    ELSE 'in_stock'
  END AS stock_status
FROM  stock_ledger sl
JOIN  items      i ON i.id = sl.item_id
JOIN  warehouses w ON w.id = sl.warehouse_id
GROUP BY sl.company_id, sl.item_id, sl.warehouse_id,
         i.code, i.name, i.category, i.reorder_point,
         w.code, w.name;

CREATE VIEW v_stock_availability AS
SELECT
  soh.company_id,
  soh.item_id,
  soh.warehouse_id,
  soh.item_code,
  soh.item_name,
  soh.category,
  soh.reorder_point,
  soh.warehouse_code,
  soh.warehouse_name,
  soh.qty_on_hand,
  COALESCE(res.qty_reserved, 0)                                     AS qty_committed,
  GREATEST(soh.qty_on_hand - COALESCE(res.qty_reserved, 0), 0)      AS qty_available,
  soh.total_cost,
  soh.stock_status
FROM v_stock_on_hand soh
LEFT JOIN (
  SELECT company_id, item_id, warehouse_id, SUM(qty_reserved) AS qty_reserved
  FROM   stock_reservations
  WHERE  status = 'active'
  GROUP  BY company_id, item_id, warehouse_id
) res USING (company_id, item_id, warehouse_id);

-- ───────────────────────────────────────────────────────────────────────
-- 12. UPDATED_AT TRIGGERS for new tables
-- ───────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_companies_updated_at        ON companies;
CREATE TRIGGER trg_companies_updated_at
  BEFORE UPDATE ON companies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_company_settings_updated_at ON company_settings;
CREATE TRIGGER trg_company_settings_updated_at
  BEFORE UPDATE ON company_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════
-- POST-MIGRATION CHECKLIST
-- ═══════════════════════════════════════════════════════════════════════
-- 1. Update .env:
--      DATABASE_URL=postgresql://erp_app:change_in_production@127.0.0.1:5432/ticktock
-- 2. Restart API server (npm start)
-- 3. Run: npm run seed   (re-links users to company_users table)
-- 4. Verify RLS: connect as erp_app and run SELECT current_company_id();
--    Should return NULL until a transaction sets app.tenant_id.
-- ═══════════════════════════════════════════════════════════════════════
