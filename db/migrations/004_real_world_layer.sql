-- ============================================================
-- Tick Tock Inc. — Module 4: Real-World Layer
-- 004_real_world_layer.sql
-- ============================================================

-- ── Extend items ──────────────────────────────────────────────────────────────
ALTER TABLE items ADD COLUMN IF NOT EXISTS upc_code          VARCHAR(20)  UNIQUE;
ALTER TABLE items ADD COLUMN IF NOT EXISTS weight_lb         DECIMAL(8,2);
ALTER TABLE items ADD COLUMN IF NOT EXISTS country_of_origin VARCHAR(100);

-- ── Extend parties (customers) ────────────────────────────────────────────────
ALTER TABLE parties ADD COLUMN IF NOT EXISTS tax_exempt             BOOLEAN      NOT NULL DEFAULT false;
ALTER TABLE parties ADD COLUMN IF NOT EXISTS tax_exempt_certificate VARCHAR(100);
ALTER TABLE parties ADD COLUMN IF NOT EXISTS tax_exempt_expiry      DATE;
ALTER TABLE parties ADD COLUMN IF NOT EXISTS state_code             CHAR(2);
ALTER TABLE parties ADD COLUMN IF NOT EXISTS vip_tier               VARCHAR(20)  NOT NULL DEFAULT 'standard'
    CHECK (vip_tier IN ('standard','silver','gold','platinum'));

-- ── Extend customer_price_lists (VIP lock) ────────────────────────────────────
ALTER TABLE customer_price_lists ADD COLUMN IF NOT EXISTS is_locked    BOOLEAN      NOT NULL DEFAULT false;
ALTER TABLE customer_price_lists ADD COLUMN IF NOT EXISTS locked_price  DECIMAL(12,4);
ALTER TABLE customer_price_lists ADD COLUMN IF NOT EXISTS locked_at     TIMESTAMPTZ;
ALTER TABLE customer_price_lists ADD COLUMN IF NOT EXISTS locked_by     UUID         REFERENCES users(id);
ALTER TABLE customer_price_lists ADD COLUMN IF NOT EXISTS lock_reason   TEXT;

-- customer_price_lists needs item_id for per-item locking
-- We need a separate table for item-level locks since customer_price_lists is keyed by price_list
-- Create a dedicated VIP price lock table
CREATE TABLE IF NOT EXISTS customer_item_price_locks (
    id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id     UUID         NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
    item_id         UUID         NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    locked_price    DECIMAL(12,4) NOT NULL,
    lock_reason     TEXT,
    locked_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    locked_by       UUID         REFERENCES users(id),
    is_active       BOOLEAN      NOT NULL DEFAULT true,
    UNIQUE (customer_id, item_id)
);

-- ── State Tax Rates ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS state_tax_rates (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    state_code  CHAR(2)     NOT NULL UNIQUE,
    state_name  VARCHAR(100) NOT NULL,
    tax_rate    DECIMAL(6,4) NOT NULL,
    is_active   BOOLEAN      NOT NULL DEFAULT true,
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Seed all 50 states + DC
INSERT INTO state_tax_rates (state_code, state_name, tax_rate) VALUES
('AL','Alabama',           0.0400),
('AK','Alaska',            0.0000),
('AZ','Arizona',           0.0560),
('AR','Arkansas',          0.0650),
('CA','California',        0.0725),
('CO','Colorado',          0.0290),
('CT','Connecticut',       0.0635),
('DE','Delaware',          0.0000),
('DC','District of Columbia', 0.0600),
('FL','Florida',           0.0600),
('GA','Georgia',           0.0400),
('HI','Hawaii',            0.0400),
('ID','Idaho',             0.0600),
('IL','Illinois',          0.0625),
('IN','Indiana',           0.0700),
('IA','Iowa',              0.0600),
('KS','Kansas',            0.0650),
('KY','Kentucky',          0.0600),
('LA','Louisiana',         0.0445),
('ME','Maine',             0.0550),
('MD','Maryland',          0.0600),
('MA','Massachusetts',     0.0625),
('MI','Michigan',          0.0600),
('MN','Minnesota',         0.0688),
('MS','Mississippi',       0.0700),
('MO','Missouri',          0.0423),
('MT','Montana',           0.0000),
('NE','Nebraska',          0.0550),
('NV','Nevada',            0.0685),
('NH','New Hampshire',     0.0000),
('NJ','New Jersey',        0.0663),
('NM','New Mexico',        0.0513),
('NY','New York',          0.0800),
('NC','North Carolina',    0.0475),
('ND','North Dakota',      0.0500),
('OH','Ohio',              0.0575),
('OK','Oklahoma',          0.0450),
('OR','Oregon',            0.0000),
('PA','Pennsylvania',      0.0600),
('RI','Rhode Island',      0.0700),
('SC','South Carolina',    0.0600),
('SD','South Dakota',      0.0450),
('TN','Tennessee',         0.0700),
('TX','Texas',             0.0625),
('UT','Utah',              0.0485),
('VT','Vermont',           0.0600),
('VA','Virginia',          0.0530),
('WA','Washington',        0.0650),
('WV','West Virginia',     0.0600),
('WI','Wisconsin',         0.0500),
('WY','Wyoming',           0.0400)
ON CONFLICT (state_code) DO NOTHING;

-- ── Price Change Log ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS price_change_log (
    id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    item_id             UUID         NOT NULL REFERENCES items(id),
    old_cost            DECIMAL(12,4),
    new_cost            DECIMAL(12,4),
    old_sale_price      DECIMAL(12,4),
    new_sale_price      DECIMAL(12,4),
    customers_updated   INTEGER      NOT NULL DEFAULT 0,
    customers_locked    INTEGER      NOT NULL DEFAULT 0,
    changed_by          UUID         REFERENCES users(id),
    changed_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    notes               TEXT
);

-- ── Backup Log ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS backup_log (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    backup_type     VARCHAR(50) NOT NULL DEFAULT 'manual',
    file_path       TEXT,
    file_size_bytes BIGINT,
    status          VARCHAR(10) NOT NULL DEFAULT 'success'
                        CHECK (status IN ('success','failed')),
    started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at    TIMESTAMPTZ,
    error_message   TEXT
);

-- ── Extend sales_invoices with tax audit fields ────────────────────────────────
ALTER TABLE sales_invoices ADD COLUMN IF NOT EXISTS tax_rate      DECIMAL(6,4);
ALTER TABLE sales_invoices ADD COLUMN IF NOT EXISTS state_code    CHAR(2);
ALTER TABLE sales_invoices ADD COLUMN IF NOT EXISTS tax_exempt    BOOLEAN NOT NULL DEFAULT false;

-- ── Indexes ───────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_items_upc        ON items(upc_code) WHERE upc_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_price_lock_cust  ON customer_item_price_locks(customer_id);
CREATE INDEX IF NOT EXISTS idx_price_lock_item  ON customer_item_price_locks(item_id);
CREATE INDEX IF NOT EXISTS idx_pcl_item         ON price_change_log(item_id);
CREATE INDEX IF NOT EXISTS idx_pcl_date         ON price_change_log(changed_at);

-- ── Seed: update existing customers with state_code from their shipping address ─
UPDATE parties SET state_code = 'NY' WHERE code = 'CUST-001';
UPDATE parties SET state_code = 'FL' WHERE code = 'CUST-002';
UPDATE parties SET state_code = 'CA' WHERE code = 'CUST-003';
UPDATE parties SET state_code = 'CA' WHERE code = 'CUST-004';
UPDATE parties SET state_code = 'NJ' WHERE code = 'CUST-005';

-- Mark CUST-003 (Pacific Rim) as platinum VIP for demo purposes
UPDATE parties SET vip_tier = 'platinum' WHERE code = 'CUST-003';
