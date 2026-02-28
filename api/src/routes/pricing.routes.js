'use strict';

// routes/pricing.routes.js
// VIP pricing resolution, price locks, cost updates, change log

const { Router } = require('express');
const { query, pool } = require('../db/pool');

const router = Router();

// ── Internal helpers ──────────────────────────────────────────────────────────

async function resolvePriceForCustomer(customerId, itemId, qty, date) {
    const checkDate = date || new Date().toISOString().slice(0, 10);

    if (customerId) {
        const { rows: locked } = await query(
            `SELECT locked_price, lock_reason FROM customer_item_price_locks
             WHERE customer_id = $1 AND item_id = $2 AND is_active = true`,
            [customerId, itemId]
        );
        if (locked.length) {
            return { price: locked[0].locked_price, source: 'locked',
                     is_locked: true, lock_reason: locked[0].lock_reason };
        }

        const { rows } = await query(
            `SELECT pli.price
             FROM   customer_price_lists cpl
             JOIN   price_list_items pli ON pli.price_list_id = cpl.price_list_id
             JOIN   price_lists pl       ON pl.id = cpl.price_list_id
             WHERE  cpl.customer_id = $1
               AND  pli.item_id = $2
               AND  pli.min_qty <= $3
               AND  (pli.valid_from IS NULL OR pli.valid_from <= $4)
               AND  (pli.valid_to   IS NULL OR pli.valid_to   >= $4)
               AND  (pl.valid_from  IS NULL OR pl.valid_from  <= $4)
               AND  (pl.valid_to    IS NULL OR pl.valid_to    >= $4)
             ORDER  BY cpl.priority ASC, pli.min_qty DESC
             LIMIT  1`,
            [customerId, itemId, qty, checkDate]
        );
        if (rows.length) {
            return { price: rows[0].price, source: 'price_list', is_locked: false };
        }
    }

    const { rows: [item] } = await query(
        `SELECT sale_price AS price FROM items WHERE id = $1`, [itemId]
    );
    return { price: item ? item.price : 0, source: 'default', is_locked: false };
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /api/pricing/resolve?customerId=X&itemId=Y&qty=Z&date=D
router.get('/resolve', async (req, res) => {
    const { customerId, itemId, qty = 1, date } = req.query;
    if (!itemId) return res.status(400).json({ error: 'itemId required' });
    try {
        const result = await resolvePriceForCustomer(customerId, itemId, qty, date);
        res.json(result);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/pricing/customer/:customerId
router.get('/customer/:customerId', async (req, res) => {
    try {
        const { rows: items } = await query(
            `SELECT i.id, i.code, i.name, i.sale_price, i.standard_cost, i.category
             FROM items i WHERE i.is_active = true ORDER BY i.category, i.code`
        );
        const { rows: locks } = await query(
            `SELECT item_id, locked_price, lock_reason, locked_at
             FROM customer_item_price_locks
             WHERE customer_id = $1 AND is_active = true`,
            [req.params.customerId]
        );
        const lockMap = {};
        for (const l of locks) lockMap[l.item_id] = l;

        const { rows: priceLists } = await query(
            `SELECT pli.item_id, pli.price
             FROM customer_price_lists cpl
             JOIN price_list_items pli ON pli.price_list_id = cpl.price_list_id
             JOIN price_lists pl ON pl.id = cpl.price_list_id
             WHERE cpl.customer_id = $1
               AND (pl.valid_to IS NULL OR pl.valid_to >= CURRENT_DATE)
             ORDER BY cpl.priority ASC, pli.min_qty ASC`,
            [req.params.customerId]
        );
        const listMap = {};
        for (const p of priceLists) {
            if (!listMap[p.item_id]) listMap[p.item_id] = p.price;
        }

        const result = items.map(item => {
            if (lockMap[item.id]) {
                return { ...item, price: lockMap[item.id].locked_price,
                         source: 'locked', is_locked: true,
                         lock_reason: lockMap[item.id].lock_reason,
                         locked_at: lockMap[item.id].locked_at };
            }
            if (listMap[item.id]) {
                return { ...item, price: listMap[item.id], source: 'price_list', is_locked: false };
            }
            return { ...item, price: item.sale_price, source: 'default', is_locked: false };
        });
        res.json(result);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/pricing/lock
router.post('/lock', async (req, res) => {
    const { customerId, itemId, lockedPrice, reason, lockedBy } = req.body;
    if (!customerId || !itemId || lockedPrice == null)
        return res.status(400).json({ error: 'customerId, itemId, and lockedPrice required' });
    try {
        const { rows } = await query(
            `INSERT INTO customer_item_price_locks
                (customer_id, item_id, locked_price, lock_reason, locked_by, is_active)
             VALUES ($1,$2,$3,$4,$5,true)
             ON CONFLICT (customer_id, item_id)
             DO UPDATE SET locked_price=$3, lock_reason=$4, locked_by=$5,
                           locked_at=NOW(), is_active=true
             RETURNING *`,
            [customerId, itemId, lockedPrice, reason || null, lockedBy || null]
        );
        res.status(201).json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/pricing/unlock
router.post('/unlock', async (req, res) => {
    const { customerId, itemId } = req.body;
    if (!customerId || !itemId) return res.status(400).json({ error: 'customerId and itemId required' });
    try {
        const { rows } = await query(
            `UPDATE customer_item_price_locks SET is_active = false
             WHERE customer_id = $1 AND item_id = $2 RETURNING *`,
            [customerId, itemId]
        );
        if (!rows.length) return res.status(404).json({ error: 'No active lock found' });
        res.json({ message: 'Lock removed', ...rows[0] });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/pricing/update-cost  (preview — does NOT apply)
router.post('/update-cost', async (req, res) => {
    const { itemId, newCost, notes } = req.body;
    if (!itemId || newCost == null) return res.status(400).json({ error: 'itemId and newCost required' });
    try {
        const { rows: [item] } = await query(
            `SELECT id, code, name, standard_cost, sale_price FROM items WHERE id = $1`, [itemId]
        );
        if (!item) return res.status(404).json({ error: 'Item not found' });

        const oldCost      = parseFloat(item.standard_cost);
        const oldSalePrice = parseFloat(item.sale_price);
        const newCostF     = parseFloat(newCost);

        const suggested_sale_price = oldCost > 0
            ? parseFloat((newCostF * (oldSalePrice / oldCost)).toFixed(4))
            : oldSalePrice;
        const old_margin_pct = oldCost > 0 ? ((oldSalePrice - oldCost) / oldCost * 100).toFixed(2) : null;

        const { rows: [counts] } = await query(
            `SELECT
                COUNT(*) FILTER (WHERE cipl.is_active = true) AS locked_count,
                COUNT(DISTINCT pli.id) FILTER (WHERE cipl.id IS NULL OR cipl.is_active = false) AS list_count
             FROM price_list_items pli
             LEFT JOIN customer_price_lists cpl ON cpl.price_list_id = pli.price_list_id
             LEFT JOIN customer_item_price_locks cipl
                    ON cipl.customer_id = cpl.customer_id AND cipl.item_id = pli.item_id AND cipl.is_active = true
             WHERE pli.item_id = $1`, [itemId]
        );

        res.json({
            item_id:             item.id,
            item_code:           item.code,
            item_name:           item.name,
            old_cost:            oldCost,
            new_cost:            newCostF,
            old_sale_price:      oldSalePrice,
            suggested_sale_price,
            old_margin_pct,
            customers_affected:  parseInt(counts.list_count || 0),
            customers_locked:    parseInt(counts.locked_count || 0),
            notes
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/pricing/update-cost/:itemId/confirm
router.post('/update-cost/:itemId/confirm', async (req, res) => {
    const { newCost, newSalePrice, notes, changedBy } = req.body;
    if (newCost == null) return res.status(400).json({ error: 'newCost required' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const { rows: [item] } = await client.query(
            `SELECT id, standard_cost, sale_price FROM items WHERE id = $1 FOR UPDATE`,
            [req.params.itemId]
        );
        if (!item) throw Object.assign(new Error('Item not found'), { status: 404 });

        const oldCost      = parseFloat(item.standard_cost);
        const oldSalePrice = parseFloat(item.sale_price);
        const newCostF     = parseFloat(newCost);
        const newSaleF     = newSalePrice != null
            ? parseFloat(newSalePrice)
            : (oldCost > 0 ? parseFloat((newCostF * (oldSalePrice / oldCost)).toFixed(4)) : oldSalePrice);

        await client.query(
            `UPDATE items SET standard_cost=$1, sale_price=$2, updated_at=NOW() WHERE id=$3`,
            [newCostF, newSaleF, req.params.itemId]
        );

        const { rows: listItems } = await client.query(
            `SELECT pli.id AS pli_id, cpl.customer_id
             FROM price_list_items pli
             JOIN customer_price_lists cpl ON cpl.price_list_id = pli.price_list_id
             LEFT JOIN customer_item_price_locks cipl
                    ON cipl.customer_id = cpl.customer_id AND cipl.item_id = pli.item_id AND cipl.is_active = true
             WHERE pli.item_id = $1 AND cipl.id IS NULL`, [req.params.itemId]
        );

        let customersUpdated = 0;
        const seenPli = new Set();
        for (const row of listItems) {
            if (seenPli.has(row.pli_id)) continue;
            seenPli.add(row.pli_id);
            await client.query(
                `UPDATE price_list_items SET price=$1 WHERE id=$2`, [newSaleF, row.pli_id]
            );
            customersUpdated++;
        }

        const { rows: [lockCount] } = await client.query(
            `SELECT COUNT(*) AS cnt FROM customer_item_price_locks
             WHERE item_id = $1 AND is_active = true`, [req.params.itemId]
        );

        await client.query(
            `INSERT INTO price_change_log
                (item_id, old_cost, new_cost, old_sale_price, new_sale_price,
                 customers_updated, customers_locked, changed_by, notes)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [req.params.itemId, oldCost, newCostF, oldSalePrice, newSaleF,
             customersUpdated, parseInt(lockCount.cnt), changedBy || null, notes || null]
        );

        await client.query('COMMIT');
        res.json({ old_cost: oldCost, new_cost: newCostF,
                   old_sale_price: oldSalePrice, new_sale_price: newSaleF,
                   customers_updated: customersUpdated,
                   customers_locked: parseInt(lockCount.cnt) });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(err.status || 500).json({ error: err.message });
    } finally { client.release(); }
});

// GET /api/pricing/change-log
router.get('/change-log', async (_req, res) => {
    try {
        const { rows } = await query(
            `SELECT pcl.*, i.code AS item_code, i.name AS item_name, u.name AS changed_by_name
             FROM price_change_log pcl
             JOIN items i ON i.id = pcl.item_id
             LEFT JOIN users u ON u.id = pcl.changed_by
             ORDER BY pcl.changed_at DESC LIMIT 100`
        );
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
