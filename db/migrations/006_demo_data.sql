-- ============================================================
-- Tick Tock Inc. — Demo Data Migration
-- 006_demo_data.sql
-- Realistic watch/accessory SKUs + warehouse stock + adjustments
-- ============================================================

-- ── Warehouses ────────────────────────────────────────────────
INSERT INTO warehouses (code, name, address, is_active) VALUES
  ('WH-MAIN',   'Main Distribution Center', '1420 Commerce Blvd, Nashville, TN 37203', true),
  ('WH-EAST',   'East Coast Fulfillment',   '800 Harbor Way, Newark, NJ 07102',         true),
  ('WH-WEST',   'West Coast Hub',           '3300 Gateway Ave, Los Angeles, CA 90058',  true)
ON CONFLICT (code) DO NOTHING;

-- ── Items ─────────────────────────────────────────────────────
INSERT INTO items (code, name, description, unit_of_measure, cost_method, standard_cost, sale_price, reorder_point, reorder_qty, lead_time_days, category, upc_code, is_active) VALUES
  ('MOV-NH35',  'Seiko NH35 Movement',            'Automatic 24-jewel movement, date',                     'EA', 'avg', 18.50,  34.99,  50, 100, 14, 'Movements',       '085740123401', true),
  ('MOV-ETA28', 'ETA 2824-2 Swiss Movement',      'Swiss Made automatic, 25 jewels, date',                 'EA', 'avg', 95.00, 179.99,  20,  40, 21, 'Movements',       '405690012345', true),
  ('MOV-MYO8',  'Miyota 8215 Movement',           'Reliable auto movement, 21 jewels',                     'EA', 'avg', 12.00,  22.99,  80, 150, 10, 'Movements',       '085740998801', true),
  ('STR-NATO20','NATO Strap 20mm Black',           'Military-style nylon strap, stainless hardware',        'EA', 'avg',  2.80,   7.99, 200, 500,  7, 'Straps & Bands',  NULL,           true),
  ('STR-NATO22','NATO Strap 22mm Olive',           'Military-style nylon strap, olive green',               'EA', 'avg',  2.80,   7.99, 200, 500,  7, 'Straps & Bands',  NULL,           true),
  ('STR-RUBB20','Rubber Strap 20mm Black',         'FKM rubber, quick-release, black',                      'EA', 'avg',  4.50,  11.99, 150, 300,  7, 'Straps & Bands',  NULL,           true),
  ('STR-LTHR20','Leather Strap 20mm Brown',        'Genuine calfskin, padded, deployment buckle',           'EA', 'avg',  7.20,  18.99,  80, 150, 10, 'Straps & Bands',  NULL,           true),
  ('STR-LTHR22','Leather Strap 22mm Tan',          'Genuine leather tan, stitched border',                  'EA', 'avg',  7.20,  18.99,  60, 120, 10, 'Straps & Bands',  NULL,           true),
  ('CASE-SS40', 'Watch Case 40mm Stainless',       '316L stainless, 200m WR, flat caseback',                'EA', 'avg', 28.00,  59.99,  30,  60, 21, 'Cases',           NULL,           true),
  ('CASE-SS42', 'Watch Case 42mm Stainless',       '316L stainless, 300m WR, exhibition back',              'EA', 'avg', 32.00,  69.99,  25,  50, 21, 'Cases',           NULL,           true),
  ('DIAL-BLK',  'Sunburst Black Dial 38mm',        'Sunburst brushed black, applied indexes',                'EA', 'avg',  6.50,  14.99,  60, 120, 14, 'Dials',           NULL,           true),
  ('DIAL-BLU',  'Sunburst Blue Dial 38mm',         'Deep blue gradient, luminous hands',                    'EA', 'avg',  6.50,  14.99,  60, 120, 14, 'Dials',           NULL,           true),
  ('DIAL-WHT',  'Cream White Dial 36mm',           'Vintage cream, Arabic numerals, lume',                  'EA', 'avg',  5.80,  12.99,  40,  80, 14, 'Dials',           NULL,           true),
  ('CRST-SAPH', 'Sapphire Crystal 30mm Flat',      'Anti-reflective coated sapphire',                       'EA', 'avg',  8.50,  18.99, 100, 200, 14, 'Crystals',        NULL,           true),
  ('CRST-MINE', 'Mineral Crystal 28mm Domed',      'Hardened mineral glass, domed',                         'EA', 'avg',  3.20,   6.99, 100, 200, 10, 'Crystals',        NULL,           true),
  ('CLSP-3FOLD','3-Fold Deployant Clasp 20mm',     'Solid stainless, butterfly, brushed finish',            'EA', 'avg',  5.50,  12.99, 100, 200,  7, 'Clasps',          NULL,           true),
  ('CLSP-TANG', 'Tang Buckle 18mm Stainless',      'Polished stainless pin buckle',                         'EA', 'avg',  1.80,   4.99, 150, 300,  7, 'Clasps',          NULL,           true),
  ('BOX-SINGLE','Watch Box Single Slot',            'Matte black leatherette, glass lid, pillow insert',     'EA', 'avg',  3.50,   8.99, 100, 200, 10, 'Packaging',       NULL,           true),
  ('BOX-DOUBLE','Watch Box Double Slot',            'Matte black leatherette, glass lid, 2 pillows',         'EA', 'avg',  5.50,  12.99,  60, 120, 10, 'Packaging',       NULL,           true),
  ('TOOL-CSHK', 'Crystal Lift Press Tool',         'Adjustable press for crystal setting, 6 dies',          'EA', 'avg', 14.00,  32.99,  10,  20, 14, 'Tools',           NULL,           true),
  ('TOOL-PINR', 'Spring Bar Tool',                 'Dual-ended, fine tip + fork, stainless',                'EA', 'avg',  2.50,   5.99,  50, 100,  7, 'Tools',           NULL,           true),
  ('TOOL-CASBK','Case Back Opener Set',            'Friction + notch type, 6-piece set',                    'EA', 'avg',  9.00,  21.99,  20,  40, 14, 'Tools',           NULL,           true),
  ('BRSL-OYSTR','Oyster-Style Bracelet 20mm SS',   '316L stainless, folded end links, microdive',           'EA', 'avg', 22.00,  49.99,  40,  80, 21, 'Bracelets',       NULL,           true),
  ('BRSL-JUBIL','Jubilee Bracelet 20mm SS',         '316L stainless, 5-link, center polish',                 'EA', 'avg', 25.00,  54.99,  30,  60, 21, 'Bracelets',       NULL,           true),
  ('LUB-MOEBG', 'Moebius 9501 Grease 1g',          'Watch movement lubricant, gear train',                  'EA', 'avg', 18.00,  35.99,  20,  40, 21, 'Supplies',        NULL,           true)
ON CONFLICT (code) DO NOTHING;

-- ── Stock Ledger — Opening Balances for WH-MAIN ──────────────
DO $$
DECLARE
  wh_main UUID;
  wh_east UUID;
  wh_west UUID;
  item     RECORD;
BEGIN
  SELECT id INTO wh_main FROM warehouses WHERE code = 'WH-MAIN';
  SELECT id INTO wh_east FROM warehouses WHERE code = 'WH-EAST';
  SELECT id INTO wh_west FROM warehouses WHERE code = 'WH-WEST';

  -- Opening balances — Main warehouse (healthy stock)
  FOR item IN SELECT id, code, standard_cost, reorder_point FROM items LOOP
    -- Main: generous stock
    INSERT INTO stock_ledger (item_id, warehouse_id, transaction_type, qty, cost_per_unit, posting_date, notes)
    VALUES (item.id, wh_main, 'opening_balance',
      CASE
        WHEN item.code IN ('MOV-NH35','STR-NATO20','STR-NATO22','STR-RUBB20') THEN 250
        WHEN item.code IN ('MOV-MYO8','BOX-SINGLE','BOX-DOUBLE','CRST-SAPH','CRST-MINE') THEN 180
        WHEN item.code IN ('CLSP-3FOLD','CLSP-TANG','TOOL-PINR') THEN 120
        WHEN item.code IN ('MOV-ETA28','CASE-SS40','CASE-SS42') THEN 45
        WHEN item.code IN ('DIAL-BLK','DIAL-BLU','DIAL-WHT') THEN 90
        WHEN item.code IN ('BRSL-OYSTR','BRSL-JUBIL','STR-LTHR20','STR-LTHR22') THEN 65
        ELSE 30
      END,
      item.standard_cost, CURRENT_DATE - 90, 'Opening balance — system migration');

    -- East coast: moderate stock
    INSERT INTO stock_ledger (item_id, warehouse_id, transaction_type, qty, cost_per_unit, posting_date, notes)
    VALUES (item.id, wh_east, 'opening_balance',
      CASE
        WHEN item.code IN ('STR-NATO20','STR-NATO22','BOX-SINGLE') THEN 120
        WHEN item.code IN ('MOV-NH35','MOV-MYO8','CRST-SAPH') THEN 60
        WHEN item.code IN ('DIAL-BLK','DIAL-BLU','CLSP-TANG') THEN 40
        ELSE 15
      END,
      item.standard_cost, CURRENT_DATE - 90, 'Opening balance — East hub');

    -- West coast: intentionally low/out on some items (to show alerts)
    IF item.code IN ('MOV-ETA28','CASE-SS40','CASE-SS42','BRSL-OYSTR','BRSL-JUBIL','LUB-MOEBG') THEN
      INSERT INTO stock_ledger (item_id, warehouse_id, transaction_type, qty, cost_per_unit, posting_date, notes)
      VALUES (item.id, wh_west, 'opening_balance',
        CASE item.code
          WHEN 'MOV-ETA28'  THEN 3   -- below reorder_point=20 → alert
          WHEN 'CASE-SS40'  THEN 5   -- below 30 → alert
          WHEN 'CASE-SS42'  THEN 0   -- out of stock
          WHEN 'BRSL-OYSTR' THEN 8   -- below 40 → alert
          WHEN 'BRSL-JUBIL' THEN 0   -- out of stock
          WHEN 'LUB-MOEBG'  THEN 4   -- below 20 → alert
        END,
        item.standard_cost, CURRENT_DATE - 90, 'Opening balance — West hub');
    END IF;
  END LOOP;

  -- ── Posted Adjustments (historical) ──────────────────────────
  DECLARE
    adj1 UUID; adj2 UUID; adj3 UUID;
  BEGIN
    -- Adj 1: Cycle count — Main
    INSERT INTO stock_adjustments (number, warehouse_id, adjustment_date, reason, status, notes, posted_at)
    VALUES ('ADJ-20241001-001', wh_main, CURRENT_DATE-60, 'Cycle Count', 'posted', 'Q3 cycle count — straps aisle', NOW()-INTERVAL '60 days')
    RETURNING id INTO adj1;
    INSERT INTO stock_adjustment_lines (adjustment_id, item_id, qty_system, qty_actual, cost_per_unit)
    SELECT adj1, i.id, 250, 247, i.standard_cost FROM items i WHERE i.code = 'STR-NATO20';
    INSERT INTO stock_adjustment_lines (adjustment_id, item_id, qty_system, qty_actual, cost_per_unit)
    SELECT adj1, i.id, 250, 248, i.standard_cost FROM items i WHERE i.code = 'STR-NATO22';
    -- Stock adjustments (net difference)
    INSERT INTO stock_ledger (item_id, warehouse_id, transaction_type, reference_type, reference_id, qty, cost_per_unit, posting_date)
    SELECT i.id, wh_main, 'adjustment', 'stock_adjustment', adj1, -3, i.standard_cost, CURRENT_DATE-60 FROM items i WHERE i.code IN ('STR-NATO20','STR-NATO22');

    -- Adj 2: Damaged Goods — East
    INSERT INTO stock_adjustments (number, warehouse_id, adjustment_date, reason, status, notes, posted_at)
    VALUES ('ADJ-20241115-001', wh_east, CURRENT_DATE-30, 'Damaged Goods', 'posted', 'Water damage — boxes near loading dock', NOW()-INTERVAL '30 days')
    RETURNING id INTO adj2;
    INSERT INTO stock_adjustment_lines (adjustment_id, item_id, qty_system, qty_actual, cost_per_unit)
    SELECT adj2, i.id, 120, 112, i.standard_cost FROM items i WHERE i.code = 'BOX-SINGLE';
    INSERT INTO stock_ledger (item_id, warehouse_id, transaction_type, reference_type, reference_id, qty, cost_per_unit, posting_date)
    SELECT i.id, wh_east, 'adjustment', 'stock_adjustment', adj2, -8, i.standard_cost, CURRENT_DATE-30 FROM items i WHERE i.code = 'BOX-SINGLE';

    -- Adj 3: Receiving Variance — Main
    INSERT INTO stock_adjustments (number, warehouse_id, adjustment_date, reason, status, notes, posted_at)
    VALUES ('ADJ-20241201-001', wh_main, CURRENT_DATE-10, 'Receiving Variance', 'posted', 'Shipment 4821 — count variance on movements', NOW()-INTERVAL '10 days')
    RETURNING id INTO adj3;
    INSERT INTO stock_adjustment_lines (adjustment_id, item_id, qty_system, qty_actual, cost_per_unit)
    SELECT adj3, i.id, 250, 255, i.standard_cost FROM items i WHERE i.code = 'MOV-NH35';
    INSERT INTO stock_ledger (item_id, warehouse_id, transaction_type, reference_type, reference_id, qty, cost_per_unit, posting_date)
    SELECT i.id, wh_main, 'adjustment', 'stock_adjustment', adj3, 5, i.standard_cost, CURRENT_DATE-10 FROM items i WHERE i.code = 'MOV-NH35';
  END;

END $$;
