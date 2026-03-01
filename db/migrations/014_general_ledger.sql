-- ============================================================
-- Tick Tock Inc. — General Ledger
-- 014_general_ledger.sql
-- ============================================================

-- ── Chart of Accounts ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gl_accounts (
    id             UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    account_number VARCHAR(10)   NOT NULL UNIQUE,
    name           VARCHAR(100)  NOT NULL,
    type           VARCHAR(15)   NOT NULL
                       CHECK (type IN ('asset','liability','equity','revenue','expense','cogs')),
    sub_type       VARCHAR(30),              -- e.g. 'current_asset', 'fixed_asset', 'current_liability'
    parent_id      UUID          REFERENCES gl_accounts(id),
    normal_balance VARCHAR(6)    NOT NULL DEFAULT 'debit'
                       CHECK (normal_balance IN ('debit','credit')),
    is_active      BOOLEAN       NOT NULL DEFAULT true,
    description    TEXT,
    created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gl_accounts_type   ON gl_accounts (type);
CREATE INDEX IF NOT EXISTS idx_gl_accounts_parent ON gl_accounts (parent_id);

-- ── Seed: Standard Chart of Accounts ─────────────────────────────────────────
INSERT INTO gl_accounts (account_number, name, type, sub_type, normal_balance, description) VALUES
  -- ── Assets (1000–1999)
  ('1000', 'Current Assets',           'asset', 'current_asset',   'debit',  'Header'),
  ('1010', 'Cash — Checking',          'asset', 'current_asset',   'debit',  'Primary operating checking account'),
  ('1020', 'Cash — Savings',           'asset', 'current_asset',   'debit',  'Business savings account'),
  ('1100', 'Accounts Receivable',      'asset', 'current_asset',   'debit',  'Amounts owed by customers'),
  ('1150', 'Allowance for Bad Debt',   'asset', 'current_asset',   'credit', 'Contra-AR — estimated uncollectibles'),
  ('1200', 'Inventory',                'asset', 'current_asset',   'debit',  'Finished goods — watches & accessories'),
  ('1250', 'Prepaid Expenses',         'asset', 'current_asset',   'debit',  'Prepaid insurance, rent, etc.'),
  ('1300', 'Other Current Assets',     'asset', 'current_asset',   'debit',  'Miscellaneous current assets'),
  ('1500', 'Fixed Assets',             'asset', 'fixed_asset',     'debit',  'Header'),
  ('1510', 'Equipment',                'asset', 'fixed_asset',     'debit',  'Warehouse & office equipment'),
  ('1520', 'Accumulated Depreciation', 'asset', 'fixed_asset',     'credit', 'Contra-asset — accumulated depreciation'),
  ('1600', 'Other Assets',             'asset', 'other_asset',     'debit',  'Deposits, intangibles'),

  -- ── Liabilities (2000–2999)
  ('2000', 'Current Liabilities',      'liability', 'current_liability', 'credit', 'Header'),
  ('2010', 'Accounts Payable',         'liability', 'current_liability', 'credit', 'Amounts owed to vendors'),
  ('2100', 'Accrued Liabilities',      'liability', 'current_liability', 'credit', 'Accrued salaries, expenses'),
  ('2200', 'Sales Tax Payable',        'liability', 'current_liability', 'credit', 'Sales tax collected, awaiting remittance'),
  ('2300', 'Customer Deposits',        'liability', 'current_liability', 'credit', 'Pre-payments from customers'),
  ('2400', 'Short-Term Loans',         'liability', 'current_liability', 'credit', 'Lines of credit & short-term debt'),
  ('2500', 'Long-Term Liabilities',    'liability', 'long_term_liability','credit','Header'),
  ('2510', 'Long-Term Debt',           'liability', 'long_term_liability','credit','Term loans & bonds payable'),

  -- ── Equity (3000–3999)
  ('3000', 'Equity',                   'equity', NULL, 'credit', 'Header'),
  ('3010', 'Common Stock',             'equity', NULL, 'credit', 'Paid-in capital'),
  ('3020', 'Retained Earnings',        'equity', NULL, 'credit', 'Accumulated earnings not distributed'),
  ('3030', 'Owner Draws',              'equity', NULL, 'debit',  'Distributions to owners'),

  -- ── Revenue (4000–4999)
  ('4000', 'Revenue',                  'revenue', NULL, 'credit', 'Header'),
  ('4010', 'Sales — Watches',          'revenue', NULL, 'credit', 'Revenue from watch sales'),
  ('4020', 'Sales — Accessories',      'revenue', NULL, 'credit', 'Revenue from accessory sales'),
  ('4030', 'Freight Income',           'revenue', NULL, 'credit', 'Shipping & handling billed to customers'),
  ('4900', 'Other Income',             'revenue', NULL, 'credit', 'Miscellaneous income'),

  -- ── Cost of Goods Sold (5000–5999)
  ('5000', 'Cost of Goods Sold',       'cogs', NULL, 'debit', 'Header'),
  ('5010', 'COGS — Watches',           'cogs', NULL, 'debit', 'Cost of watches sold'),
  ('5020', 'COGS — Accessories',       'cogs', NULL, 'debit', 'Cost of accessories sold'),
  ('5030', 'Freight & Duty',           'cogs', NULL, 'debit', 'Inbound freight & import duties'),
  ('5100', 'Inventory Adjustments',    'cogs', NULL, 'debit', 'Write-offs, shrinkage, adjustments'),

  -- ── Operating Expenses (6000–6999)
  ('6000', 'Operating Expenses',       'expense', NULL, 'debit', 'Header'),
  ('6010', 'Salaries & Wages',         'expense', NULL, 'debit', 'Employee compensation'),
  ('6020', 'Payroll Taxes',            'expense', NULL, 'debit', 'Employer payroll tax contributions'),
  ('6030', 'Rent & Occupancy',         'expense', NULL, 'debit', 'Warehouse & office rent'),
  ('6040', 'Utilities',                'expense', NULL, 'debit', 'Electric, water, internet'),
  ('6050', 'Insurance',                'expense', NULL, 'debit', 'Business & product liability insurance'),
  ('6060', 'Depreciation Expense',     'expense', NULL, 'debit', 'Depreciation on fixed assets'),
  ('6070', 'Marketing & Advertising',  'expense', NULL, 'debit', 'Advertising, trade shows'),
  ('6080', 'Travel & Entertainment',   'expense', NULL, 'debit', 'Business travel & meals'),
  ('6090', 'Professional Services',    'expense', NULL, 'debit', 'Legal, accounting, consulting'),
  ('6100', 'Office Supplies',          'expense', NULL, 'debit', 'Stationery, postage, supplies'),
  ('6110', 'Software & Subscriptions', 'expense', NULL, 'debit', 'SaaS tools, licenses'),
  ('6120', 'Bank & Merchant Fees',     'expense', NULL, 'debit', 'Credit card processing, bank charges'),
  ('6900', 'Other Expenses',           'expense', NULL, 'debit', 'Miscellaneous operating expenses')
ON CONFLICT (account_number) DO NOTHING;

-- ── Journal Entries ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS journal_entries (
    id          UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    number      VARCHAR(20)   NOT NULL UNIQUE,
    entry_date  DATE          NOT NULL DEFAULT CURRENT_DATE,
    description TEXT          NOT NULL,
    status      VARCHAR(10)   NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','posted','void')),
    reference   VARCHAR(100),            -- optional external ref (invoice #, SO #, etc.)
    created_by  UUID          REFERENCES users(id),
    posted_by   UUID          REFERENCES users(id),
    posted_at   TIMESTAMPTZ,
    created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- ── Journal Entry Lines ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS journal_entry_lines (
    id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    journal_entry_id UUID          NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
    line_number      INTEGER       NOT NULL,
    account_id       UUID          NOT NULL REFERENCES gl_accounts(id),
    description      TEXT,
    debit            NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
    credit           NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
    UNIQUE (journal_entry_id, line_number),
    CHECK (debit > 0 OR credit > 0),        -- at least one must be non-zero
    CHECK (NOT (debit > 0 AND credit > 0))  -- can't be both debit and credit
);

CREATE INDEX IF NOT EXISTS idx_je_status   ON journal_entries (status);
CREATE INDEX IF NOT EXISTS idx_je_date     ON journal_entries (entry_date);
CREATE INDEX IF NOT EXISTS idx_jel_entry   ON journal_entry_lines (journal_entry_id);
CREATE INDEX IF NOT EXISTS idx_jel_account ON journal_entry_lines (account_id);

CREATE TRIGGER trg_je_updated_at
    BEFORE UPDATE ON journal_entries
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Opening Balance Journal Entry (optional demo) ─────────────────────────────
-- Seed a sample opening balance entry so reports show data immediately
DO $$
DECLARE
    v_je_id UUID;
    v_cash  UUID;
    v_inv   UUID;
    v_ar    UUID;
    v_ap    UUID;
    v_eq    UUID;
    v_re    UUID;
BEGIN
    -- Only insert if no entries exist
    IF (SELECT COUNT(*) FROM journal_entries) = 0 THEN
        SELECT id INTO v_cash FROM gl_accounts WHERE account_number = '1010';
        SELECT id INTO v_inv  FROM gl_accounts WHERE account_number = '1200';
        SELECT id INTO v_ar   FROM gl_accounts WHERE account_number = '1100';
        SELECT id INTO v_ap   FROM gl_accounts WHERE account_number = '2010';
        SELECT id INTO v_eq   FROM gl_accounts WHERE account_number = '3010';
        SELECT id INTO v_re   FROM gl_accounts WHERE account_number = '3020';

        INSERT INTO journal_entries (number, entry_date, description, status, posted_at, reference)
        VALUES ('JE-00001', CURRENT_DATE - INTERVAL '90 days',
                'Opening balance entry', 'posted', NOW(), 'OPENING')
        RETURNING id INTO v_je_id;

        INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit) VALUES
            (v_je_id, 1, v_cash, 'Opening cash balance',       125000.00, 0),
            (v_je_id, 2, v_inv,  'Opening inventory',          340000.00, 0),
            (v_je_id, 3, v_ar,   'Opening AR balance',          48000.00, 0),
            (v_je_id, 4, v_ap,   'Opening AP balance',                 0, 62000.00),
            (v_je_id, 5, v_eq,   'Paid-in capital',                    0, 300000.00),
            (v_je_id, 6, v_re,   'Retained earnings',                  0, 151000.00);
    END IF;
END $$;
