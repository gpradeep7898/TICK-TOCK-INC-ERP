-- ============================================================
-- Tick Tock Inc. — CRM Light
-- 016_crm.sql
-- ============================================================

-- ── Customer Interactions ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS customer_interactions (
    id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id      UUID          NOT NULL REFERENCES parties(id),
    type             VARCHAR(15)   NOT NULL
                         CHECK (type IN ('call','email','meeting','note','demo','follow_up')),
    direction        VARCHAR(10)   NOT NULL DEFAULT 'outbound'
                         CHECK (direction IN ('inbound','outbound','internal')),
    subject          VARCHAR(200)  NOT NULL,
    body             TEXT,
    outcome          VARCHAR(200),
    follow_up_date   DATE,
    agent_id         UUID          REFERENCES users(id),
    interaction_date TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ci_customer ON customer_interactions (customer_id);
CREATE INDEX IF NOT EXISTS idx_ci_date     ON customer_interactions (interaction_date DESC);
CREATE INDEX IF NOT EXISTS idx_ci_type     ON customer_interactions (type);
CREATE INDEX IF NOT EXISTS idx_ci_followup ON customer_interactions (follow_up_date)
    WHERE follow_up_date IS NOT NULL;

-- ── Opportunities ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS opportunities (
    id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    number              VARCHAR(20)   NOT NULL UNIQUE,
    customer_id         UUID          NOT NULL REFERENCES parties(id),
    title               VARCHAR(200)  NOT NULL,
    description         TEXT,
    stage               VARCHAR(15)   NOT NULL DEFAULT 'lead'
                            CHECK (stage IN ('lead','qualified','proposal','negotiation','won','lost')),
    estimated_value     NUMERIC(14,2) NOT NULL DEFAULT 0,
    probability         INTEGER       NOT NULL DEFAULT 10
                            CHECK (probability BETWEEN 0 AND 100),
    expected_close_date DATE,
    assigned_to         UUID          REFERENCES users(id),
    notes               TEXT,
    lost_reason         VARCHAR(200),
    sales_order_id      UUID          REFERENCES sales_orders(id),
    created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_opp_customer ON opportunities (customer_id);
CREATE INDEX IF NOT EXISTS idx_opp_stage    ON opportunities (stage);
CREATE INDEX IF NOT EXISTS idx_opp_assigned ON opportunities (assigned_to);

CREATE TRIGGER trg_opportunities_updated_at
    BEFORE UPDATE ON opportunities
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Opportunity Activities ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS opportunity_activities (
    id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    opportunity_id  UUID          NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
    type            VARCHAR(20)   NOT NULL
                        CHECK (type IN ('note','stage_change','call','email','meeting','task')),
    notes           TEXT          NOT NULL,
    from_stage      VARCHAR(15),
    to_stage        VARCHAR(15),
    performed_by    UUID          REFERENCES users(id),
    performed_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_oa_opportunity ON opportunity_activities (opportunity_id);

-- ── Customer Health View ──────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_customer_health AS
WITH orders_90d AS (
    SELECT customer_id, COUNT(*) AS order_count_90d,
           COALESCE(SUM(total_amount), 0) AS revenue_90d
    FROM   sales_orders
    WHERE  status NOT IN ('cancelled','draft')
      AND  order_date >= CURRENT_DATE - 90
    GROUP  BY customer_id
),
orders_12m AS (
    SELECT customer_id, COALESCE(SUM(total_amount), 0) AS revenue_12m
    FROM   sales_orders
    WHERE  status NOT IN ('cancelled','draft')
      AND  order_date >= CURRENT_DATE - 365
    GROUP  BY customer_id
),
payment_speed AS (
    -- Average days from invoice date to payment date
    SELECT si.customer_id,
           ROUND(AVG(
               EXTRACT(EPOCH FROM (pa.payment_date - si.invoice_date)) / 86400
           ), 1) AS avg_days_to_pay,
           COUNT(DISTINCT si.id) AS invoices_paid
    FROM   sales_invoices si
    JOIN   payment_applications papp ON papp.invoice_id = si.id
    JOIN   payments_received pa ON pa.id = papp.payment_id
    GROUP  BY si.customer_id
),
ar_overdue AS (
    SELECT si.customer_id,
           COALESCE(SUM(si.amount_due - si.amount_paid), 0) AS overdue_balance
    FROM   sales_invoices si
    WHERE  si.status IN ('sent','partial')
      AND  si.due_date < CURRENT_DATE
    GROUP  BY si.customer_id
),
last_order AS (
    SELECT customer_id, MAX(order_date) AS last_order_date
    FROM   sales_orders WHERE status NOT IN ('cancelled','draft')
    GROUP  BY customer_id
),
interactions_30d AS (
    SELECT customer_id, COUNT(*) AS interaction_count
    FROM   customer_interactions
    WHERE  interaction_date >= CURRENT_DATE - 30
    GROUP  BY customer_id
)
-- Pre-aggregate raw data then score in outer query to avoid repeating expressions
raw AS (
    SELECT
        p.id   AS customer_id,
        p.code AS customer_code,
        p.name AS customer_name,
        p.vip_tier,
        COALESCE(o90.order_count_90d, 0)   AS order_count_90d,
        COALESCE(o90.revenue_90d, 0)       AS revenue_90d,
        COALESCE(o12.revenue_12m, 0)       AS revenue_12m,
        ps.avg_days_to_pay,
        COALESCE(ps.invoices_paid, 0)      AS invoices_paid,
        COALESCE(ar.overdue_balance, 0)    AS overdue_balance,
        lo.last_order_date,
        COALESCE(i30.interaction_count, 0) AS interactions_30d,
        EXTRACT(DAYS FROM (CURRENT_DATE - lo.last_order_date))::INT AS days_since_last_order
    FROM   parties p
    LEFT JOIN orders_90d    o90 ON o90.customer_id = p.id
    LEFT JOIN orders_12m    o12 ON o12.customer_id = p.id
    LEFT JOIN payment_speed ps  ON ps.customer_id  = p.id
    LEFT JOIN ar_overdue    ar  ON ar.customer_id  = p.id
    LEFT JOIN last_order    lo  ON lo.customer_id  = p.id
    LEFT JOIN interactions_30d i30 ON i30.customer_id = p.id
    WHERE  p.type IN ('customer','both') AND p.is_active = true
),
scored AS (
    SELECT *,
        LEAST(100, GREATEST(0,
            CASE WHEN avg_days_to_pay IS NULL THEN 15
                 WHEN avg_days_to_pay <= 15   THEN 30
                 WHEN avg_days_to_pay <= 30   THEN 22
                 WHEN avg_days_to_pay <= 45   THEN 14
                 WHEN avg_days_to_pay <= 60   THEN 6
                 ELSE 0 END
            + CASE WHEN order_count_90d >= 10 THEN 30
                   WHEN order_count_90d >= 5  THEN 22
                   WHEN order_count_90d >= 2  THEN 14
                   WHEN order_count_90d >= 1  THEN 8
                   ELSE 0 END
            + CASE WHEN revenue_12m >= 100000 THEN 25
                   WHEN revenue_12m >= 50000  THEN 20
                   WHEN revenue_12m >= 20000  THEN 14
                   WHEN revenue_12m >= 5000   THEN 8
                   ELSE 0 END
            + CASE WHEN overdue_balance > 10000 THEN -20
                   WHEN overdue_balance > 5000  THEN -12
                   WHEN overdue_balance > 1000  THEN -6
                   ELSE 0 END
            + CASE WHEN last_order_date >= CURRENT_DATE - 30  THEN 15
                   WHEN last_order_date >= CURRENT_DATE - 90  THEN 10
                   WHEN last_order_date >= CURRENT_DATE - 180 THEN 5
                   ELSE 0 END
        )) AS health_score
    FROM raw
)
SELECT *,
    CASE
        WHEN overdue_balance > 10000 THEN 'At Risk'
        WHEN health_score >= 65      THEN 'Excellent'
        WHEN health_score >= 45      THEN 'Good'
        WHEN health_score >= 25      THEN 'Fair'
        ELSE 'Poor'
    END AS health_label
FROM scored;
