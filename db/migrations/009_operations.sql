-- ============================================================
-- Tick Tock Inc. — Operational Enhancements
-- 009_operations.sql
-- Tasks: Receiving Discrepancy (3), Negative Stock Prevention (4),
--        Partial Shipment / Backorders (5)
-- ============================================================

-- ── Task 3: Receiving Discrepancy Handling ────────────────────────────────────
-- Add discrepancy fields to purchase receipt lines
ALTER TABLE purchase_receipt_lines
    ADD COLUMN IF NOT EXISTS qty_ordered_at_time  NUMERIC(14,4),
    ADD COLUMN IF NOT EXISTS over_receipt_flag    BOOLEAN        NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS discrepancy_reason   TEXT,
    ADD COLUMN IF NOT EXISTS discrepancy_pct      NUMERIC(7,4);   -- (qty_received - qty_ordered) / qty_ordered * 100

-- ── Task 4: Negative Stock Prevention ────────────────────────────────────────
-- Function returns available qty; negative means insufficient
-- Usage: SELECT check_stock_availability(item_id, warehouse_id, qty_needed)
-- Returns: available qty (negative = short)
CREATE OR REPLACE FUNCTION check_stock_availability(
    p_item_id     UUID,
    p_warehouse_id UUID,
    p_qty_needed  NUMERIC
) RETURNS NUMERIC
LANGUAGE sql STABLE AS $$
    SELECT COALESCE(
        (SELECT qty_available FROM v_stock_availability
         WHERE item_id = p_item_id AND warehouse_id = p_warehouse_id),
        0
    ) - p_qty_needed;
$$;

-- ── Task 5: Backorders ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS backorders (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sales_order_id      UUID          NOT NULL REFERENCES sales_orders(id),
    sales_order_line_id UUID          NOT NULL REFERENCES sales_order_lines(id),
    item_id             UUID          NOT NULL REFERENCES items(id),
    warehouse_id        UUID          NOT NULL REFERENCES warehouses(id),
    qty_backordered     NUMERIC(14,4) NOT NULL CHECK (qty_backordered > 0),
    qty_fulfilled       NUMERIC(14,4) NOT NULL DEFAULT 0,
    qty_remaining       NUMERIC(14,4) GENERATED ALWAYS AS
                            (GREATEST(qty_backordered - qty_fulfilled, 0)) STORED,
    status              VARCHAR(15)   NOT NULL DEFAULT 'open'
                            CHECK (status IN ('open','partial','fulfilled','cancelled')),
    notes               TEXT,
    created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uix_backorders_sol ON backorders (sales_order_line_id);

CREATE INDEX IF NOT EXISTS idx_backorders_so       ON backorders (sales_order_id);
CREATE INDEX IF NOT EXISTS idx_backorders_item     ON backorders (item_id);
CREATE INDEX IF NOT EXISTS idx_backorders_status   ON backorders (status) WHERE status = 'open';

-- Trigger to update updated_at
CREATE TRIGGER trg_backorders_updated_at
    BEFORE UPDATE ON backorders
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
