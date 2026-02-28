-- ============================================================
-- Tick Tock Inc. — Stock Transfers Between Warehouses
-- 011_transfers.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS stock_transfers (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    number          VARCHAR(30)   NOT NULL UNIQUE,
    from_warehouse_id UUID        NOT NULL REFERENCES warehouses(id),
    to_warehouse_id   UUID        NOT NULL REFERENCES warehouses(id),
    status          VARCHAR(15)   NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','posted','cancelled')),
    transfer_date   DATE          NOT NULL DEFAULT CURRENT_DATE,
    notes           TEXT,
    created_by      UUID          REFERENCES users(id),
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_transfer_warehouses CHECK (from_warehouse_id <> to_warehouse_id)
);

CREATE TABLE IF NOT EXISTS stock_transfer_lines (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transfer_id     UUID          NOT NULL REFERENCES stock_transfers(id) ON DELETE CASCADE,
    line_number     INTEGER       NOT NULL,
    item_id         UUID          NOT NULL REFERENCES items(id),
    qty             NUMERIC(14,4) NOT NULL CHECK (qty > 0),
    cost_per_unit   NUMERIC(14,4) NOT NULL DEFAULT 0,
    notes           TEXT,
    UNIQUE (transfer_id, line_number)
);

CREATE INDEX IF NOT EXISTS idx_transfers_from  ON stock_transfers (from_warehouse_id);
CREATE INDEX IF NOT EXISTS idx_transfers_to    ON stock_transfers (to_warehouse_id);
CREATE INDEX IF NOT EXISTS idx_transfers_status ON stock_transfers (status);
CREATE INDEX IF NOT EXISTS idx_tl_transfer     ON stock_transfer_lines (transfer_id);
CREATE INDEX IF NOT EXISTS idx_tl_item         ON stock_transfer_lines (item_id);

CREATE TRIGGER trg_transfers_updated_at
    BEFORE UPDATE ON stock_transfers
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
