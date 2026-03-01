'use strict';

// routes/crm.routes.js
// Module 9 — CRM Light: interactions, opportunities, customer health

const { Router } = require('express');
const { query, pool } = require('../db/pool');
const { z } = require('zod');
const { validate } = require('../middleware/validate');
const { parsePage, paginate } = require('../lib/pagination');

const router = Router();

const UUID = z.string().uuid();

// ── Schemas ───────────────────────────────────────────────────────────────────
const CreateInteractionSchema = z.object({
    customer_id:      UUID,
    type:             z.enum(['call','email','meeting','note','demo','follow_up']),
    direction:        z.enum(['inbound','outbound','internal']).default('outbound'),
    subject:          z.string().trim().min(1).max(200),
    body:             z.string().trim().optional(),
    outcome:          z.string().trim().max(200).optional(),
    follow_up_date:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    agent_id:         UUID.optional(),
    interaction_date: z.string().optional(),
});

const CreateOpportunitySchema = z.object({
    customer_id:         UUID,
    title:               z.string().trim().min(1).max(200),
    description:         z.string().trim().optional(),
    stage:               z.enum(['lead','qualified','proposal','negotiation','won','lost']).default('lead'),
    estimated_value:     z.coerce.number().nonnegative().default(0),
    probability:         z.coerce.number().int().min(0).max(100).default(10),
    expected_close_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    assigned_to:         UUID.optional(),
    notes:               z.string().trim().optional(),
});

const UpdateOpportunitySchema = z.object({
    title:               z.string().trim().min(1).max(200).optional(),
    stage:               z.enum(['lead','qualified','proposal','negotiation','won','lost']).optional(),
    estimated_value:     z.coerce.number().nonnegative().optional(),
    probability:         z.coerce.number().int().min(0).max(100).optional(),
    expected_close_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    assigned_to:         UUID.optional(),
    notes:               z.string().trim().optional(),
    lost_reason:         z.string().trim().max(200).optional(),
});

// ── OPP number generator ──────────────────────────────────────────────────────
async function nextOppNumber(client) {
    const year = new Date().getFullYear();
    const pfx  = `OPP-${year}-`;
    const { rows } = await client.query(
        `SELECT number FROM opportunities WHERE number LIKE $1 ORDER BY number DESC LIMIT 1`,
        [`${pfx}%`]
    );
    const seq = rows.length ? parseInt(rows[0].number.split('-').pop(), 10) + 1 : 1;
    return `${pfx}${String(seq).padStart(4, '0')}`;
}

// Stage → default probability
const STAGE_PROB = { lead: 10, qualified: 25, proposal: 50, negotiation: 75, won: 100, lost: 0 };

// ─────────────────────────────────────────────────────────────────────────────
// Interactions
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/crm/interactions
router.get('/interactions', async (req, res) => {
    const { customer_id, type, from_date, to_date } = req.query;
    try {
        const { page, limit, offset } = parsePage(req.query);
        const conds = []; const params = [];
        if (customer_id) { params.push(customer_id); conds.push(`ci.customer_id = $${params.length}`); }
        if (type)        { params.push(type);        conds.push(`ci.type = $${params.length}`); }
        if (from_date)   { params.push(from_date);   conds.push(`ci.interaction_date >= $${params.length}`); }
        if (to_date)     { params.push(to_date);     conds.push(`ci.interaction_date <= $${params.length}::timestamptz + interval '1 day'`); }
        const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

        const { rows: [{ count }] } = await query(
            `SELECT COUNT(*) FROM customer_interactions ci ${where}`, params
        );
        const { rows } = await query(
            `SELECT ci.*, p.name AS customer_name, p.code AS customer_code,
                    u.name AS agent_name
             FROM   customer_interactions ci
             JOIN   parties p ON p.id = ci.customer_id
             LEFT JOIN users u ON u.id = ci.agent_id
             ${where}
             ORDER  BY ci.interaction_date DESC
             LIMIT $${params.length+1} OFFSET $${params.length+2}`,
            [...params, limit, offset]
        );
        res.json(paginate(rows, parseInt(count, 10), page, limit));
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// POST /api/crm/interactions
router.post('/interactions', validate(CreateInteractionSchema), async (req, res) => {
    const { customer_id, type, direction, subject, body, outcome,
            follow_up_date, agent_id, interaction_date } = req.body;
    try {
        const { rows: [row] } = await query(
            `INSERT INTO customer_interactions
                (customer_id, type, direction, subject, body, outcome,
                 follow_up_date, agent_id, interaction_date)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
            [customer_id, type, direction, subject, body || null, outcome || null,
             follow_up_date || null, agent_id || null,
             interaction_date ? new Date(interaction_date) : new Date()]
        );
        res.status(201).json({ success: true, data: row });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// GET /api/crm/interactions/followups — upcoming follow-up tasks
router.get('/interactions/followups', async (_req, res) => {
    try {
        const { rows } = await query(
            `SELECT ci.*, p.name AS customer_name, p.code AS customer_code
             FROM   customer_interactions ci
             JOIN   parties p ON p.id = ci.customer_id
             WHERE  ci.follow_up_date IS NOT NULL
               AND  ci.follow_up_date >= CURRENT_DATE
               AND  ci.follow_up_date <= CURRENT_DATE + 14
             ORDER  BY ci.follow_up_date ASC
             LIMIT 50`
        );
        res.json({ success: true, data: rows });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Opportunities
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/crm/opportunities
router.get('/opportunities', async (req, res) => {
    const { stage, customer_id, assigned_to } = req.query;
    try {
        const { page, limit, offset } = parsePage(req.query);
        const conds = []; const params = [];
        if (stage)       { params.push(stage);       conds.push(`o.stage = $${params.length}`); }
        if (customer_id) { params.push(customer_id); conds.push(`o.customer_id = $${params.length}`); }
        if (assigned_to) { params.push(assigned_to); conds.push(`o.assigned_to = $${params.length}`); }
        const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

        const { rows: [{ count }] } = await query(
            `SELECT COUNT(*) FROM opportunities o ${where}`, params
        );
        const { rows } = await query(
            `SELECT o.*, p.name AS customer_name, p.code AS customer_code,
                    u.name AS assigned_to_name
             FROM   opportunities o
             JOIN   parties p ON p.id = o.customer_id
             LEFT JOIN users u ON u.id = o.assigned_to
             ${where}
             ORDER  BY
                CASE o.stage WHEN 'negotiation' THEN 1 WHEN 'proposal' THEN 2
                             WHEN 'qualified' THEN 3 WHEN 'lead' THEN 4
                             WHEN 'won' THEN 5 ELSE 6 END,
                o.estimated_value DESC
             LIMIT $${params.length+1} OFFSET $${params.length+2}`,
            [...params, limit, offset]
        );

        // Pipeline summary
        const { rows: summary } = await query(
            `SELECT stage,
                    COUNT(*) AS count,
                    COALESCE(SUM(estimated_value), 0) AS total_value,
                    COALESCE(SUM(estimated_value * probability / 100.0), 0) AS weighted_value
             FROM opportunities WHERE stage NOT IN ('won','lost')
             GROUP BY stage`
        );

        res.json({ ...paginate(rows, parseInt(count, 10), page, limit), pipeline_summary: summary });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// GET /api/crm/opportunities/:id
router.get('/opportunities/:id', async (req, res) => {
    try {
        const { rows: [opp] } = await query(
            `SELECT o.*, p.name AS customer_name, p.code AS customer_code,
                    u.name AS assigned_to_name
             FROM   opportunities o
             JOIN   parties p ON p.id = o.customer_id
             LEFT JOIN users u ON u.id = o.assigned_to
             WHERE  o.id = $1`, [req.params.id]
        );
        if (!opp) return res.status(404).json({ success: false, error: 'Opportunity not found' });

        const { rows: activities } = await query(
            `SELECT oa.*, u.name AS performed_by_name
             FROM opportunity_activities oa
             LEFT JOIN users u ON u.id = oa.performed_by
             WHERE oa.opportunity_id = $1
             ORDER BY oa.performed_at DESC`, [req.params.id]
        );

        const { rows: interactions } = await query(
            `SELECT ci.*, u.name AS agent_name
             FROM customer_interactions ci
             LEFT JOIN users u ON u.id = ci.agent_id
             WHERE ci.customer_id = $1
             ORDER BY ci.interaction_date DESC LIMIT 20`,
            [opp.customer_id]
        );

        res.json({ success: true, data: { ...opp, activities, interactions } });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// POST /api/crm/opportunities
router.post('/opportunities', validate(CreateOpportunitySchema), async (req, res) => {
    const { customer_id, title, description, stage, estimated_value,
            probability, expected_close_date, assigned_to, notes } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const number = await nextOppNumber(client);
        const prob   = probability ?? STAGE_PROB[stage] ?? 10;

        const { rows: [opp] } = await client.query(
            `INSERT INTO opportunities
                (number, customer_id, title, description, stage, estimated_value,
                 probability, expected_close_date, assigned_to, notes)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
            [number, customer_id, title, description || null, stage,
             estimated_value, prob, expected_close_date || null,
             assigned_to || null, notes || null]
        );

        await client.query(
            `INSERT INTO opportunity_activities (opportunity_id, type, notes, to_stage)
             VALUES ($1,'stage_change',$2,$3)`,
            [opp.id, `Opportunity created — stage: ${stage}`, stage]
        );

        await client.query('COMMIT');
        res.status(201).json({ success: true, data: opp });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(400).json({ success: false, error: err.message });
    } finally { client.release(); }
});

// PATCH /api/crm/opportunities/:id
router.patch('/opportunities/:id', validate(UpdateOpportunitySchema), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows: [current] } = await client.query(
            `SELECT * FROM opportunities WHERE id = $1 FOR UPDATE`, [req.params.id]
        );
        if (!current) throw Object.assign(new Error('Opportunity not found'), { status: 404 });

        const { stage, title, estimated_value, probability, expected_close_date,
                assigned_to, notes, lost_reason } = req.body;

        const sets = ['updated_at = NOW()']; const params = [req.params.id];
        if (title               !== undefined) { params.push(title);               sets.push(`title = $${params.length}`); }
        if (estimated_value     !== undefined) { params.push(estimated_value);     sets.push(`estimated_value = $${params.length}`); }
        if (expected_close_date !== undefined) { params.push(expected_close_date); sets.push(`expected_close_date = $${params.length}`); }
        if (assigned_to         !== undefined) { params.push(assigned_to);         sets.push(`assigned_to = $${params.length}`); }
        if (notes               !== undefined) { params.push(notes);               sets.push(`notes = $${params.length}`); }
        if (lost_reason         !== undefined) { params.push(lost_reason);         sets.push(`lost_reason = $${params.length}`); }

        const stageChanged = stage && stage !== current.stage;
        if (stageChanged) {
            params.push(stage);
            sets.push(`stage = $${params.length}`);
            const newProb = probability ?? STAGE_PROB[stage];
            if (newProb !== undefined) { params.push(newProb); sets.push(`probability = $${params.length}`); }
        } else if (probability !== undefined) {
            params.push(probability); sets.push(`probability = $${params.length}`);
        }

        const { rows: [updated] } = await client.query(
            `UPDATE opportunities SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params
        );

        if (stageChanged) {
            await client.query(
                `INSERT INTO opportunity_activities
                    (opportunity_id, type, notes, from_stage, to_stage)
                 VALUES ($1,'stage_change',$2,$3,$4)`,
                [req.params.id,
                 `Stage changed: ${current.stage} → ${stage}`,
                 current.stage, stage]
            );
        }

        await client.query('COMMIT');
        res.json({ success: true, data: updated });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(err.status || 500).json({ success: false, error: err.message });
    } finally { client.release(); }
});

// POST /api/crm/opportunities/:id/activities
router.post('/opportunities/:id/activities', async (req, res) => {
    const { type = 'note', notes, performed_by } = req.body;
    if (!notes) return res.status(400).json({ success: false, error: 'notes is required' });
    try {
        const { rows: [act] } = await query(
            `INSERT INTO opportunity_activities (opportunity_id, type, notes, performed_by)
             VALUES ($1,$2,$3,$4) RETURNING *`,
            [req.params.id, type, notes, performed_by || null]
        );
        res.status(201).json({ success: true, data: act });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// POST /api/crm/opportunities/:id/convert — won → create Sales Order
router.post('/opportunities/:id/convert', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows: [opp] } = await client.query(
            `SELECT o.*, p.id AS party_id FROM opportunities o
             JOIN parties p ON p.id = o.customer_id
             WHERE o.id = $1 FOR UPDATE`, [req.params.id]
        );
        if (!opp) throw Object.assign(new Error('Opportunity not found'), { status: 404 });
        if (opp.stage !== 'won')
            throw Object.assign(new Error('Only won opportunities can be converted to Sales Orders'), { status: 400 });
        if (opp.sales_order_id)
            throw Object.assign(new Error('Opportunity already converted'), { status: 409 });

        // Generate SO number
        const year = new Date().getFullYear();
        const pfx  = `SO-${year}-`;
        const { rows: last } = await client.query(
            `SELECT number FROM sales_orders WHERE number LIKE $1 ORDER BY number DESC LIMIT 1`,
            [`${pfx}%`]
        );
        const seq   = last.length ? parseInt(last[0].number.split('-').pop(), 10) + 1 : 1;
        const soNum = `${pfx}${String(seq).padStart(5, '0')}`;

        const { rows: [wh] } = await client.query(
            `SELECT id FROM warehouses ORDER BY created_at LIMIT 1`
        );

        const { rows: [so] } = await client.query(
            `INSERT INTO sales_orders
                (number, customer_id, warehouse_id, status, subtotal, notes)
             VALUES ($1,$2,$3,'draft',0,$4) RETURNING *`,
            [soNum, opp.customer_id, wh.id,
             `Converted from opportunity ${opp.number}: ${opp.title}`]
        );

        await client.query(
            `UPDATE opportunities SET sales_order_id = $2, updated_at = NOW() WHERE id = $1`,
            [opp.id, so.id]
        );
        await client.query(
            `INSERT INTO opportunity_activities (opportunity_id, type, notes)
             VALUES ($1,'note',$2)`,
            [opp.id, `Converted to Sales Order ${soNum}`]
        );

        await client.query('COMMIT');
        res.json({ success: true, data: { opportunity_id: opp.id, sales_order_id: so.id, so_number: soNum } });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(err.status || 500).json({ success: false, error: err.message });
    } finally { client.release(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Customer Health
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/crm/health
router.get('/health', async (req, res) => {
    const { label, sort = 'health_score', order = 'desc' } = req.query;
    try {
        const { page, limit, offset } = parsePage(req.query);
        const cond   = label ? `WHERE health_label = $1` : '';
        const params = label ? [label] : [];
        const allowed = ['health_score','revenue_12m','order_count_90d','overdue_balance','avg_days_to_pay'];
        const sortCol = allowed.includes(sort) ? sort : 'health_score';
        const sortDir = order === 'asc' ? 'ASC' : 'DESC';

        const { rows: [{ count }] } = await query(
            `SELECT COUNT(*) FROM v_customer_health ${cond}`, params
        );
        const { rows } = await query(
            `SELECT * FROM v_customer_health ${cond}
             ORDER BY ${sortCol} ${sortDir} NULLS LAST
             LIMIT $${params.length+1} OFFSET $${params.length+2}`,
            [...params, limit, offset]
        );
        res.json(paginate(rows, parseInt(count, 10), page, limit));
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// GET /api/crm/health/:customerId
router.get('/health/:customerId', async (req, res) => {
    try {
        const { rows: [health] } = await query(
            `SELECT * FROM v_customer_health WHERE customer_id = $1`, [req.params.customerId]
        );
        if (!health) return res.status(404).json({ success: false, error: 'Customer not found' });

        const { rows: recentOrders } = await query(
            `SELECT number, order_date, status, subtotal
             FROM sales_orders WHERE customer_id = $1
             ORDER BY order_date DESC LIMIT 10`, [req.params.customerId]
        );
        const { rows: recentInteractions } = await query(
            `SELECT type, subject, interaction_date, outcome
             FROM customer_interactions WHERE customer_id = $1
             ORDER BY interaction_date DESC LIMIT 10`, [req.params.customerId]
        );

        res.json({ success: true, data: { ...health, recent_orders: recentOrders, recent_interactions: recentInteractions } });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// GET /api/crm/pipeline-summary
router.get('/pipeline-summary', async (_req, res) => {
    try {
        const { rows } = await query(
            `SELECT stage, COUNT(*) AS count,
                    COALESCE(SUM(estimated_value), 0) AS total_value,
                    COALESCE(SUM(estimated_value * probability / 100.0), 0) AS weighted_value
             FROM opportunities
             GROUP BY stage
             ORDER BY CASE stage
                WHEN 'lead' THEN 1 WHEN 'qualified' THEN 2 WHEN 'proposal' THEN 3
                WHEN 'negotiation' THEN 4 WHEN 'won' THEN 5 ELSE 6 END`
        );
        res.json({ success: true, data: rows });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

module.exports = router;
