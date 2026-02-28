-- ============================================================
-- Tick Tock Inc. — Customer & Vendor Master Enhancements
-- 008_customers_vendors.sql
-- ============================================================
-- Adds structured contact / address fields to the parties table
-- so both the customer and vendor UIs have first-class fields.
-- Existing JSONB billing_address / shipping_address are kept for
-- backward compatibility; new flat columns are the preferred path.
-- ============================================================

-- ── New columns on parties ────────────────────────────────────────────────────

ALTER TABLE parties
    ADD COLUMN IF NOT EXISTS contact_name       VARCHAR(100),
    ADD COLUMN IF NOT EXISTS city               VARCHAR(100),
    ADD COLUMN IF NOT EXISTS state_province     VARCHAR(100),
    ADD COLUMN IF NOT EXISTS postal_code        VARCHAR(20),
    ADD COLUMN IF NOT EXISTS country            VARCHAR(100) DEFAULT 'US',
    ADD COLUMN IF NOT EXISTS payment_terms_label VARCHAR(20)  DEFAULT 'NET30'
                                 CHECK (payment_terms_label IN
                                        ('NET15','NET30','NET45','NET60','NET90','COD','PREPAID','DUE_ON_RECEIPT')),
    ADD COLUMN IF NOT EXISTS lead_time_days     INTEGER      NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS website            VARCHAR(255),
    ADD COLUMN IF NOT EXISTS fax                VARCHAR(30);

-- ── Back-fill payment_terms_label from existing integer days ─────────────────
UPDATE parties SET payment_terms_label =
    CASE
        WHEN payment_terms_days <= 0  THEN 'COD'
        WHEN payment_terms_days = 15  THEN 'NET15'
        WHEN payment_terms_days = 30  THEN 'NET30'
        WHEN payment_terms_days = 45  THEN 'NET45'
        WHEN payment_terms_days = 60  THEN 'NET60'
        WHEN payment_terms_days >= 90 THEN 'NET90'
        ELSE 'NET30'
    END
WHERE payment_terms_label IS NULL OR payment_terms_label = 'NET30';

-- ── Indexes for common look-ups ───────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_parties_type         ON parties (type);
CREATE INDEX IF NOT EXISTS idx_parties_contact_name ON parties (contact_name);
CREATE INDEX IF NOT EXISTS idx_parties_country      ON parties (country);
