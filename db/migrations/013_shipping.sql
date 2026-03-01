-- ============================================================
-- Tick Tock Inc. — Fulfillment & Shipping
-- 013_shipping.sql
-- ============================================================

-- ── Shipping carrier reference ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shipping_carriers (
    id                    UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    code                  VARCHAR(10)   NOT NULL UNIQUE,
    name                  VARCHAR(100)  NOT NULL,
    tracking_url_template VARCHAR(255),
    is_active             BOOLEAN       NOT NULL DEFAULT true,
    created_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

INSERT INTO shipping_carriers (code, name, tracking_url_template) VALUES
    ('UPS',    'United Parcel Service',
     'https://www.ups.com/track?tracknum={tracking_number}'),
    ('FEDEX',  'FedEx',
     'https://www.fedex.com/fedextrack/?tracknumbers={tracking_number}'),
    ('USPS',   'United States Postal Service',
     'https://tools.usps.com/go/TrackConfirmAction?tLabels={tracking_number}'),
    ('DHL',    'DHL Express',
     'https://www.dhl.com/us-en/home/tracking.html?tracking-id={tracking_number}'),
    ('CUSTOM', 'Custom / Local Carrier', NULL)
ON CONFLICT (code) DO NOTHING;

-- ── Add shipping fields to shipments ─────────────────────────────────────────
ALTER TABLE shipments
    ADD COLUMN IF NOT EXISTS carrier          VARCHAR(10)   REFERENCES shipping_carriers(code),
    ADD COLUMN IF NOT EXISTS service_level    VARCHAR(50),
    ADD COLUMN IF NOT EXISTS tracking_number  VARCHAR(100),
    ADD COLUMN IF NOT EXISTS freight_cost     NUMERIC(10,2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS weight_lb        NUMERIC(10,3),
    ADD COLUMN IF NOT EXISTS shipped_by       UUID          REFERENCES users(id);

-- ── Rate quote log ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shipping_rate_quotes (
    id             UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    shipment_id    UUID          REFERENCES shipments(id),
    carrier        VARCHAR(10)   NOT NULL REFERENCES shipping_carriers(code),
    service_level  VARCHAR(50)   NOT NULL,
    estimated_days INTEGER,
    rate           NUMERIC(10,2) NOT NULL,
    weight_lb      NUMERIC(10,3),
    from_zip       VARCHAR(10),
    to_zip         VARCHAR(10),
    quoted_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rate_quotes_shipment ON shipping_rate_quotes (shipment_id);
CREATE INDEX IF NOT EXISTS idx_shipments_carrier    ON shipments (carrier);
CREATE INDEX IF NOT EXISTS idx_shipments_tracking   ON shipments (tracking_number);
