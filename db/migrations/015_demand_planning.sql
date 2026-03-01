-- ============================================================
-- Tick Tock Inc. — Demand Planning
-- 015_demand_planning.sql
-- ============================================================

-- ── Sales Velocity View ───────────────────────────────────────────────────────
-- Computes 30/60/90-day rolling daily sell-through per item (all warehouses combined)
CREATE OR REPLACE VIEW v_sales_velocity AS
WITH sold AS (
    SELECT
        item_id,
        ABS(SUM(CASE WHEN posting_date >= CURRENT_DATE - 30 THEN qty ELSE 0 END)) AS sold_30d,
        ABS(SUM(CASE WHEN posting_date >= CURRENT_DATE - 60 THEN qty ELSE 0 END)) AS sold_60d,
        ABS(SUM(CASE WHEN posting_date >= CURRENT_DATE - 90 THEN qty ELSE 0 END)) AS sold_90d
    FROM   stock_ledger
    WHERE  transaction_type = 'shipment' AND qty < 0
    GROUP  BY item_id
),
stock AS (
    SELECT item_id, SUM(qty_available) AS total_available
    FROM   v_stock_availability
    GROUP  BY item_id
),
lead AS (
    -- best lead time from most recent PO vendor per item
    SELECT DISTINCT ON (pol.item_id)
        pol.item_id,
        po.vendor_id,
        p.name  AS vendor_name,
        COALESCE(p.lead_time_days, 14) AS lead_time_days
    FROM   purchase_order_lines pol
    JOIN   purchase_orders po ON po.id = pol.purchase_order_id
    JOIN   parties p ON p.id = po.vendor_id
    ORDER  BY pol.item_id, po.created_at DESC
)
SELECT
    i.id            AS item_id,
    i.code,
    i.name          AS item_name,
    i.unit_of_measure,
    i.reorder_point,
    i.reorder_qty,
    i.standard_cost,
    COALESCE(st.total_available, 0)           AS qty_available,
    COALESCE(sold.sold_30d, 0)                AS sold_30d,
    COALESCE(sold.sold_60d, 0)                AS sold_60d,
    COALESCE(sold.sold_90d, 0)                AS sold_90d,
    ROUND(COALESCE(sold.sold_30d, 0) / 30.0, 4) AS velocity_30d,
    ROUND(COALESCE(sold.sold_60d, 0) / 60.0, 4) AS velocity_60d,
    ROUND(COALESCE(sold.sold_90d, 0) / 90.0, 4) AS velocity_90d,
    CASE
        WHEN COALESCE(sold.sold_30d, 0) > 0
        THEN ROUND(COALESCE(st.total_available, 0) / (sold.sold_30d / 30.0), 1)
        ELSE NULL
    END AS days_of_stock,
    lead.vendor_id,
    lead.vendor_name,
    COALESCE(lead.lead_time_days, 14) AS lead_time_days,
    CASE
        WHEN COALESCE(st.total_available, 0) <= 0
             THEN 'critical'
        WHEN COALESCE(sold.sold_30d, 0) > 0
             AND COALESCE(st.total_available, 0) / (sold.sold_30d / 30.0) < COALESCE(lead.lead_time_days, 14)
             THEN 'critical'
        WHEN COALESCE(st.total_available, 0) < i.reorder_point
             THEN 'high'
        WHEN COALESCE(st.total_available, 0) < COALESCE(i.reorder_qty, i.reorder_point * 2)
             THEN 'normal'
        ELSE 'ok'
    END AS urgency
FROM   items i
LEFT JOIN sold  ON sold.item_id  = i.id
LEFT JOIN stock st ON st.item_id = i.id
LEFT JOIN lead  ON lead.item_id  = i.id
WHERE  i.is_active = true;

-- ── Replenishment Suggestions ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS replenishment_suggestions (
    id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    item_id          UUID          NOT NULL REFERENCES items(id),
    vendor_id        UUID          REFERENCES parties(id),
    suggested_qty    NUMERIC(14,4) NOT NULL,
    urgency          VARCHAR(10)   NOT NULL CHECK (urgency IN ('critical','high','normal')),
    days_of_stock    NUMERIC(10,2),
    daily_velocity   NUMERIC(14,6),
    unit_cost        NUMERIC(14,4),
    estimated_value  NUMERIC(14,2),
    status           VARCHAR(10)   NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','approved','converted','dismissed')),
    po_id            UUID          REFERENCES purchase_orders(id),
    notes            TEXT,
    computed_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_repl_item    ON replenishment_suggestions (item_id);
CREATE INDEX IF NOT EXISTS idx_repl_status  ON replenishment_suggestions (status);
CREATE INDEX IF NOT EXISTS idx_repl_urgency ON replenishment_suggestions (urgency);
