-- ============================================================
-- Tick Tock Inc. — Invoice Payment Tracking
-- 010_invoice_payments.sql
-- Adds denormalized payment tracking columns to sales_invoices
-- for fast dashboard queries without additional joins.
-- ============================================================

ALTER TABLE sales_invoices
    ADD COLUMN IF NOT EXISTS last_payment_date      DATE,
    ADD COLUMN IF NOT EXISTS last_payment_method    VARCHAR(15),
    ADD COLUMN IF NOT EXISTS last_payment_reference VARCHAR(100),
    ADD COLUMN IF NOT EXISTS tax_rate               NUMERIC(7,6) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS state_code             VARCHAR(2),
    ADD COLUMN IF NOT EXISTS tax_exempt             BOOLEAN      NOT NULL DEFAULT false;

-- Back-fill from existing payment_applications if any
UPDATE sales_invoices si
SET last_payment_date      = latest.payment_date,
    last_payment_method    = latest.method,
    last_payment_reference = latest.reference_number
FROM (
    SELECT DISTINCT ON (pa.invoice_id)
           pa.invoice_id,
           pr.payment_date,
           pr.method,
           pr.reference_number
    FROM payment_applications pa
    JOIN payments_received pr ON pr.id = pa.payment_id
    ORDER BY pa.invoice_id, pr.payment_date DESC
) latest
WHERE si.id = latest.invoice_id
  AND si.last_payment_date IS NULL;

CREATE INDEX IF NOT EXISTS idx_inv_due_date  ON sales_invoices (due_date);
CREATE INDEX IF NOT EXISTS idx_inv_last_pay  ON sales_invoices (last_payment_date) WHERE last_payment_date IS NOT NULL;
