-- ============================================================
-- Tick Tock Inc. — Pick List Workflow
-- 012_pick_lists.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS pick_lists (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    number          VARCHAR(30)   NOT NULL UNIQUE,
    sales_order_id  UUID          NOT NULL REFERENCES sales_orders(id),
    warehouse_id    UUID          NOT NULL REFERENCES warehouses(id),
    status          VARCHAR(15)   NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open','in_progress','completed','cancelled')),
    assigned_to     UUID          REFERENCES users(id),
    created_by      UUID          REFERENCES users(id),
    notes           TEXT,
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pick_list_lines (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pick_list_id        UUID          NOT NULL REFERENCES pick_lists(id) ON DELETE CASCADE,
    sales_order_line_id UUID          NOT NULL REFERENCES sales_order_lines(id),
    item_id             UUID          NOT NULL REFERENCES items(id),
    line_number         INTEGER       NOT NULL,
    qty_to_pick         NUMERIC(14,4) NOT NULL CHECK (qty_to_pick > 0),
    qty_picked          NUMERIC(14,4) NOT NULL DEFAULT 0,
    status              VARCHAR(15)   NOT NULL DEFAULT 'open'
                            CHECK (status IN ('open','picked','short','skipped')),
    bin_location        VARCHAR(50),
    notes               TEXT,
    UNIQUE (pick_list_id, line_number)
);

CREATE INDEX IF NOT EXISTS idx_pl_so       ON pick_lists (sales_order_id);
CREATE INDEX IF NOT EXISTS idx_pl_status   ON pick_lists (status);
CREATE INDEX IF NOT EXISTS idx_pll_list    ON pick_list_lines (pick_list_id);
CREATE INDEX IF NOT EXISTS idx_pll_item    ON pick_list_lines (item_id);

CREATE TRIGGER trg_pick_lists_updated_at
    BEFORE UPDATE ON pick_lists
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
