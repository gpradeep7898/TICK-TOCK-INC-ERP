'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { Pool } = require('pg');

// ─────────────────────────────────────────────────────────────────────────
// Connection Pool
// ─────────────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max:                    20,
  idleTimeoutMillis:   30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err.message);
});

// ─────────────────────────────────────────────────────────────────────────
// query — Raw pool query. No tenant context.
//
// Use for:
//   • Auth operations (login, token checks)
//   • Platform-admin operations
//   • Tables without RLS: companies, company_users, state_tax_rates, users
// ─────────────────────────────────────────────────────────────────────────
const query = (text, params) => pool.query(text, params);

// ─────────────────────────────────────────────────────────────────────────
// withTenant — Execute a callback inside a transaction with tenant isolation.
//
// How it works:
//   1. Acquires a dedicated client from the pool
//   2. Begins a transaction (required for SET LOCAL / set_config local=true)
//   3. Calls set_config('app.tenant_id', tenantId, true)
//      → PostgreSQL RLS policies read this via current_company_id()
//   4. Runs your callback with the scoped client
//   5. Commits on success, rolls back on error, always releases client
//
// Usage:
//   const items = await withTenant(req.tenantId, async (client) => {
//     const { rows } = await client.query('SELECT * FROM items');
//     return rows;
//   });
//
// Multi-step atomic operation:
//   await withTenant(req.tenantId, async (client) => {
//     await client.query('INSERT INTO stock_ledger ...', [...]);
//     await client.query('UPDATE sales_orders SET status = $1 ...', [...]);
//   });
//   // Both writes committed atomically — or both rolled back on error.
//
// @param  {string}   tenantId  Company UUID from JWT
// @param  {Function} callback  async (client: PoolClient) => any
// @returns {Promise<any>}
// ─────────────────────────────────────────────────────────────────────────
async function withTenant(tenantId, callback) {
  if (!tenantId) {
    throw Object.assign(new Error('withTenant: tenantId is required'), { status: 401 });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // set_config(key, value, is_local=true) — value is local to this transaction
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);

    const result = await callback(client);

    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────
// withTenantClient — Returns a scoped client for use across multiple
// awaited calls in the same request (without wrapping in a callback).
//
// Caller is responsible for calling client.done() when finished.
// Prefer withTenant() for atomic operations — use this only when you
// need to pass the client to functions that don't accept a callback.
//
// Usage:
//   const { client, done } = await withTenantClient(req.tenantId);
//   try {
//     const { rows } = await client.query('SELECT * FROM items');
//     await done(true);  // true = commit
//     res.json(rows);
//   } catch(e) {
//     await done(false); // false = rollback
//     throw e;
//   }
// ─────────────────────────────────────────────────────────────────────────
async function withTenantClient(tenantId) {
  if (!tenantId) {
    throw Object.assign(new Error('withTenantClient: tenantId is required'), { status: 401 });
  }

  const client = await pool.connect();
  await client.query('BEGIN');
  await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);

  const done = async (commit = true) => {
    try {
      await client.query(commit ? 'COMMIT' : 'ROLLBACK');
    } finally {
      client.release();
    }
  };

  return { client, done };
}

module.exports = { pool, query, withTenant, withTenantClient };
