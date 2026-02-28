'use strict';

// routes/migration.routes.js
// CSV / Excel data import for items, customers, vendors

const { Router } = require('express');
const XLSX       = require('xlsx');
const { query }  = require('../db/pool');

const router = Router();

// Column mappings for each importable table
const COLUMN_MAPS = {
    items: {
        'code': 'code', 'sku': 'code', 'item code': 'code', 'item_code': 'code',
        'name': 'name', 'description': 'description', 'uom': 'unit_of_measure',
        'unit_of_measure': 'unit_of_measure', 'cost': 'standard_cost', 'standard_cost': 'standard_cost',
        'price': 'sale_price', 'sale_price': 'sale_price', 'reorder_point': 'reorder_point',
        'reorder point': 'reorder_point', 'reorder_qty': 'reorder_qty', 'category': 'category',
        'upc': 'upc_code', 'upc_code': 'upc_code', 'weight': 'weight_lb', 'weight_lb': 'weight_lb',
        'country': 'country_of_origin', 'country_of_origin': 'country_of_origin'
    },
    customers: {
        'code': 'code', 'customer code': 'code', 'customer_code': 'code',
        'name': 'name', 'company': 'name', 'email': 'email', 'phone': 'phone',
        'terms': 'payment_terms_days', 'payment terms': 'payment_terms_days', 'payment_terms_days': 'payment_terms_days',
        'credit limit': 'credit_limit', 'credit_limit': 'credit_limit',
        'state': 'state_code', 'state_code': 'state_code',
        'vip': 'vip_tier', 'vip_tier': 'vip_tier',
        'tax exempt': 'tax_exempt', 'tax_exempt': 'tax_exempt',
        'tax cert': 'tax_exempt_certificate', 'tax_exempt_certificate': 'tax_exempt_certificate'
    },
    vendors: {
        'code': 'code', 'vendor code': 'code', 'vendor_code': 'code',
        'name': 'name', 'company': 'name', 'email': 'email', 'phone': 'phone',
        'terms': 'payment_terms_days', 'payment_terms_days': 'payment_terms_days',
        'address': 'billing_address_line1', 'city': 'billing_address_city',
        'state': 'billing_address_state', 'zip': 'billing_address_zip'
    }
};

function parseFileContent(fileContent, fileName) {
    const buf = Buffer.from(fileContent, 'base64');
    if (fileName && (fileName.endsWith('.xlsx') || fileName.endsWith('.xls'))) {
        const wb = XLSX.read(buf, { type: 'buffer' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        return XLSX.utils.sheet_to_json(ws, { defval: '' });
    }
    const text    = buf.toString('utf8');
    const lines   = text.split(/\r?\n/).filter(l => l.trim());
    if (!lines.length) return [];
    const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g,''));
    return lines.slice(1).map(line => {
        const vals = line.match(/(".*?"|[^,]+|(?<=,)(?=,))/g) || line.split(',');
        const row  = {};
        headers.forEach((h, i) => {
            row[h] = (vals[i] || '').trim().replace(/^"|"$/g,'');
        });
        return row;
    });
}

function mapColumns(rows, table) {
    const map = COLUMN_MAPS[table] || {};
    return rows.map(row => {
        const out = {};
        for (const [k, v] of Object.entries(row)) {
            const mapped = map[k.toLowerCase().trim()];
            if (mapped) out[mapped] = v;
        }
        return out;
    });
}

// POST /api/migration/preview-csv
router.post('/preview-csv', async (req, res) => {
    const { table, fileContent, fileName } = req.body;
    if (!table || !fileContent) return res.status(400).json({ error: 'table and fileContent required' });
    if (!['items','customers','vendors'].includes(table))
        return res.status(400).json({ error: 'table must be items, customers, or vendors' });
    try {
        const raw    = parseFileContent(fileContent, fileName);
        const mapped = mapColumns(raw, table);
        const requiredFields = { items: ['code','name'], customers: ['code','name'], vendors: ['code','name'] };
        const required = requiredFields[table];
        let valid = 0;
        const errors = [];
        for (let i = 0; i < mapped.length; i++) {
            const missing = required.filter(f => !mapped[i][f]);
            if (missing.length) errors.push({ row: i + 2, missing, data: mapped[i] });
            else valid++;
        }
        res.json({
            rows_found:       raw.length,
            rows_valid:       valid,
            rows_with_errors: errors.length,
            sample_data:      mapped.slice(0, 10),
            column_mapping:   COLUMN_MAPS[table],
            errors:           errors.slice(0, 20)
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/migration/import-csv
router.post('/import-csv', async (req, res) => {
    const { table, fileContent, fileName, skipErrors = true } = req.body;
    if (!table || !fileContent) return res.status(400).json({ error: 'table and fileContent required' });
    if (!['items','customers','vendors'].includes(table))
        return res.status(400).json({ error: 'table must be items, customers, or vendors' });

    const raw    = parseFileContent(fileContent, fileName);
    const mapped = mapColumns(raw, table);

    let imported = 0, skipped = 0;
    const errors = [];

    for (let i = 0; i < mapped.length; i++) {
        const row = mapped[i];
        try {
            if (table === 'items') {
                if (!row.code || !row.name) throw new Error('code and name required');
                await query(
                    `INSERT INTO items (code, name, description, unit_of_measure, standard_cost,
                                        sale_price, reorder_point, reorder_qty, category,
                                        upc_code, weight_lb, country_of_origin)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
                     ON CONFLICT (code) DO UPDATE
                       SET name=EXCLUDED.name, description=EXCLUDED.description,
                           standard_cost=EXCLUDED.standard_cost, sale_price=EXCLUDED.sale_price,
                           upc_code=COALESCE(EXCLUDED.upc_code,items.upc_code),
                           updated_at=NOW()`,
                    [row.code, row.name, row.description || null,
                     row.unit_of_measure || 'EA', parseFloat(row.standard_cost) || 0,
                     parseFloat(row.sale_price) || 0, parseInt(row.reorder_point) || 0,
                     parseInt(row.reorder_qty) || 0, row.category || null,
                     row.upc_code || null, row.weight_lb ? parseFloat(row.weight_lb) : null,
                     row.country_of_origin || null]
                );
            } else if (table === 'customers') {
                if (!row.code || !row.name) throw new Error('code and name required');
                await query(
                    `INSERT INTO parties (type, code, name, email, phone,
                                          payment_terms_days, credit_limit, state_code, vip_tier)
                     VALUES ('customer',$1,$2,$3,$4,$5,$6,$7,$8)
                     ON CONFLICT (code) DO UPDATE
                       SET name=EXCLUDED.name, email=EXCLUDED.email,
                           state_code=COALESCE(EXCLUDED.state_code,parties.state_code),
                           updated_at=NOW()`,
                    [row.code, row.name, row.email || null, row.phone || null,
                     parseInt(row.payment_terms_days) || 30,
                     parseFloat(row.credit_limit) || 0,
                     row.state_code || null, row.vip_tier || 'standard']
                );
            } else if (table === 'vendors') {
                if (!row.code || !row.name) throw new Error('code and name required');
                const addr = (row.billing_address_line1 || row.billing_address_city)
                    ? JSON.stringify({ line1: row.billing_address_line1 || '',
                                       city:  row.billing_address_city || '',
                                       state: row.billing_address_state || '',
                                       zip:   row.billing_address_zip || '' })
                    : null;
                await query(
                    `INSERT INTO parties (type, code, name, email, phone,
                                          payment_terms_days, billing_address)
                     VALUES ('vendor',$1,$2,$3,$4,$5,$6)
                     ON CONFLICT (code) DO UPDATE
                       SET name=EXCLUDED.name, email=EXCLUDED.email, updated_at=NOW()`,
                    [row.code, row.name, row.email || null, row.phone || null,
                     parseInt(row.payment_terms_days) || 30, addr]
                );
            }
            imported++;
        } catch (err) {
            skipped++;
            errors.push({ row: i + 2, error: err.message, data: row });
            if (!skipErrors) break;
        }
    }
    res.json({ imported, skipped, errors: errors.slice(0, 50) });
});

// GET /api/migration/status
router.get('/status', async (_req, res) => {
    try {
        const [items, customers, vendors] = await Promise.all([
            query(`SELECT COUNT(*) AS cnt FROM items WHERE is_active = true`),
            query(`SELECT COUNT(*) AS cnt FROM parties WHERE type IN ('customer','both')`),
            query(`SELECT COUNT(*) AS cnt FROM parties WHERE type IN ('vendor','both')`)
        ]);
        res.json({
            items:     parseInt(items.rows[0].cnt),
            customers: parseInt(customers.rows[0].cnt),
            vendors:   parseInt(vendors.rows[0].cnt)
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
