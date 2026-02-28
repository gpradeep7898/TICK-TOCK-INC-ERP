'use strict';

// companies.repository.js
//
// All DB operations for companies, company_settings, and company_users.
// These tables are NOT covered by RLS (they ARE the tenancy control layer),
// so we use the raw pool query() — no withTenant() needed here.

const { query, pool } = require('../../db/pool');

// ─────────────────────────────────────────────────────────────────────────
// COMPANY QUERIES
// ─────────────────────────────────────────────────────────────────────────

async function findById(id) {
  const { rows } = await query(
    `SELECT
       c.*,
       cs.costing_method,
       cs.auto_invoice,
       cs.auto_reserve_on_so,
       cs.low_stock_alert_email,
       cs.default_payment_terms,
       cs.tax_enabled,
       cs.default_tax_rate,
       cs.next_so_number,
       cs.next_po_number,
       cs.next_invoice_number,
       cs.next_adj_number
     FROM  companies       c
     LEFT JOIN company_settings cs ON cs.company_id = c.id
     WHERE c.id = $1`,
    [id]
  );
  return rows[0] || null;
}

async function findBySlug(slug) {
  const { rows } = await query(
    `SELECT * FROM companies WHERE slug = $1`,
    [slug]
  );
  return rows[0] || null;
}

async function findAll({ limit = 50, offset = 0 } = {}) {
  const { rows } = await query(
    `SELECT
       c.id, c.slug, c.name, c.plan, c.status,
       c.owner_email, c.timezone, c.currency_code,
       c.max_users, c.max_warehouses, c.trial_ends_at, c.created_at,
       COUNT(cu.user_id) FILTER (WHERE cu.is_active = TRUE)::INT AS active_user_count
     FROM  companies c
     LEFT JOIN company_users cu ON cu.company_id = c.id
     GROUP BY c.id
     ORDER BY c.created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return rows;
}

async function create({ slug, name, plan, ownerEmail, timezone, currencyCode, fiscalYearStart, maxUsers, maxWarehouses, trialEndsAt }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: [company] } = await client.query(
      `INSERT INTO companies
         (slug, name, plan, status, owner_email, timezone,
          currency_code, fiscal_year_start, max_users, max_warehouses, trial_ends_at)
       VALUES ($1,$2,$3,'active',$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [slug, name, plan, ownerEmail, timezone, currencyCode,
       fiscalYearStart, maxUsers, maxWarehouses, trialEndsAt || null]
    );

    // Create default settings row
    await client.query(
      `INSERT INTO company_settings (company_id) VALUES ($1)`,
      [company.id]
    );

    await client.query('COMMIT');
    return company;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function update(id, fields) {
  const ALLOWED = [
    'name', 'plan', 'status', 'owner_email', 'timezone',
    'currency_code', 'fiscal_year_start', 'logo_url',
    'max_users', 'max_warehouses', 'trial_ends_at',
  ];
  const sets = [];
  const vals = [];
  let   i    = 1;

  for (const [k, v] of Object.entries(fields)) {
    if (ALLOWED.includes(k)) {
      sets.push(`${k} = $${i++}`);
      vals.push(v);
    }
  }
  if (!sets.length) return null;

  vals.push(id);
  const { rows } = await query(
    `UPDATE companies
     SET    ${sets.join(', ')}, updated_at = NOW()
     WHERE  id = $${i}
     RETURNING *`,
    vals
  );
  return rows[0] || null;
}

async function updateSettings(companyId, fields) {
  const ALLOWED = [
    'costing_method', 'auto_invoice', 'auto_reserve_on_so',
    'low_stock_alert_email', 'default_payment_terms',
    'tax_enabled', 'default_tax_rate',
  ];
  const sets = [];
  const vals = [];
  let   i    = 1;

  for (const [k, v] of Object.entries(fields)) {
    if (ALLOWED.includes(k)) {
      sets.push(`${k} = $${i++}`);
      vals.push(v);
    }
  }
  if (!sets.length) return null;

  vals.push(companyId);
  const { rows } = await query(
    `UPDATE company_settings
     SET    ${sets.join(', ')}, updated_at = NOW()
     WHERE  company_id = $${i}
     RETURNING *`,
    vals
  );
  return rows[0] || null;
}

// ─────────────────────────────────────────────────────────────────────────
// DOCUMENT NUMBER SEQUENCES
// Each company has independent incrementing counters stored in company_settings.
// Uses SELECT ... FOR UPDATE to prevent race conditions under concurrent requests.
// ─────────────────────────────────────────────────────────────────────────
async function nextDocNumber(client, companyId, type) {
  // type: 'so' | 'po' | 'invoice' | 'adj'
  const col = `next_${type}_number`;
  const { rows } = await client.query(
    `UPDATE company_settings
     SET    ${col} = ${col} + 1
     WHERE  company_id = $1
     RETURNING ${col} - 1 AS current_num`,
    [companyId]
  );
  if (!rows[0]) throw new Error(`Company settings not found for ${companyId}`);
  return rows[0].current_num;
}

// ─────────────────────────────────────────────────────────────────────────
// COMPANY USER (MEMBERSHIP) QUERIES
// ─────────────────────────────────────────────────────────────────────────

async function getMembers(companyId) {
  const { rows } = await query(
    `SELECT
       cu.id, cu.user_id, cu.role, cu.is_active, cu.joined_at,
       u.name, u.email,
       u.is_active AS user_is_active
     FROM  company_users cu
     JOIN  users u ON u.id = cu.user_id
     WHERE cu.company_id = $1
     ORDER BY cu.joined_at ASC`,
    [companyId]
  );
  return rows;
}

async function getMembership(companyId, userId) {
  const { rows } = await query(
    `SELECT * FROM company_users
     WHERE  company_id = $1 AND user_id = $2`,
    [companyId, userId]
  );
  return rows[0] || null;
}

async function addMember({ companyId, userId, role, invitedBy }) {
  const { rows } = await query(
    `INSERT INTO company_users (company_id, user_id, role, invited_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (company_id, user_id)
       DO UPDATE SET role = EXCLUDED.role, is_active = TRUE, joined_at = NOW()
     RETURNING *`,
    [companyId, userId, role || 'warehouse', invitedBy || null]
  );
  return rows[0];
}

async function updateMemberRole(companyId, userId, role) {
  const { rows } = await query(
    `UPDATE company_users
     SET    role = $1
     WHERE  company_id = $2 AND user_id = $3
     RETURNING *`,
    [role, companyId, userId]
  );
  return rows[0] || null;
}

async function deactivateMember(companyId, userId) {
  const { rows } = await query(
    `UPDATE company_users
     SET    is_active = FALSE
     WHERE  company_id = $1 AND user_id = $2
     RETURNING *`,
    [companyId, userId]
  );
  return rows[0] || null;
}

async function getUserCompanies(userId) {
  const { rows } = await query(
    `SELECT
       c.id, c.slug, c.name, c.plan, c.status,
       c.logo_url, c.currency_code, c.timezone,
       cu.role, cu.is_active, cu.joined_at
     FROM  company_users cu
     JOIN  companies c ON c.id = cu.company_id
     WHERE cu.user_id   = $1
       AND cu.is_active = TRUE
       AND c.status     = 'active'
     ORDER BY cu.joined_at ASC`,
    [userId]
  );
  return rows;
}

module.exports = {
  findById,
  findBySlug,
  findAll,
  create,
  update,
  updateSettings,
  nextDocNumber,
  getMembers,
  getMembership,
  addMember,
  updateMemberRole,
  deactivateMember,
  getUserCompanies,
};
