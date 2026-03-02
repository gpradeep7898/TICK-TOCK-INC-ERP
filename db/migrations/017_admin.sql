-- ============================================================
-- Tick Tock Inc. — Admin & Settings
-- 017_admin.sql
-- ============================================================

-- ── Audit Log (table pre-exists from 007_multi_tenant.sql) ───────────────────
-- Add extra columns needed for admin UI
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS entity_label VARCHAR(200);
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS ip_address   VARCHAR(45);

CREATE INDEX IF NOT EXISTS idx_audit_action  ON audit_log (action);
CREATE INDEX IF NOT EXISTS idx_audit_entity  ON audit_log (table_name, record_id);
CREATE INDEX IF NOT EXISTS idx_audit_user    ON audit_log (user_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log (created_at DESC);

-- ── Company Settings ──────────────────────────────────────────────────────────
-- Simple key-value store for UI-editable company configuration
CREATE TABLE IF NOT EXISTS company_settings (
    key         VARCHAR(60)  PRIMARY KEY,
    value       TEXT,
    description VARCHAR(200),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_by  UUID         REFERENCES users(id)
);

INSERT INTO company_settings (key, value, description) VALUES
  ('company_name',    'Tick Tock Inc.',                    'Company display name'),
  ('company_address', '123 Watch Way, New York, NY 10001', 'Mailing address'),
  ('company_phone',   '+1 (212) 555-0100',                 'Main phone'),
  ('company_email',   'info@ticktockinc.com',              'Contact email'),
  ('company_website', 'www.ticktockinc.com',               'Website URL'),
  ('tax_id',          '12-3456789',                        'Federal Tax ID / EIN'),
  ('currency',        'USD',                               'Default currency'),
  ('fiscal_year_end', '12-31',                             'Fiscal year end (MM-DD)'),
  ('invoice_terms',   'Net 30',                            'Default invoice payment terms'),
  ('low_stock_days',  '14',                                'Reorder alert threshold (days of stock)')
ON CONFLICT (key) DO NOTHING;
