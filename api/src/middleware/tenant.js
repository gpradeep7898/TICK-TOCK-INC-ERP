'use strict';

const { query, withTenant } = require('../db/pool');

// ─────────────────────────────────────────────────────────────────────────
// tenantMiddleware
//
// Must run AFTER requireAuth (which sets req.user from JWT).
//
// What it does:
//   1. Reads company_id from req.user.companyId (set during login)
//   2. Verifies the user is an active member of that company in DB
//      (guards against JWT replay after membership revocation)
//   3. Attaches to the request:
//        req.tenantId    — company UUID for use in routes
//        req.companyRole — role within this company (admin/manager/etc.)
//        req.withTenant  — pre-bound withTenant(fn) shorthand
//
// Usage in routes:
//   router.get('/items', requireAuth, tenantMiddleware, async (req, res) => {
//     const items = await req.withTenant(async (client) => {
//       const { rows } = await client.query('SELECT * FROM items');
//       return rows;
//     });
//     res.json({ data: items });
//   });
// ─────────────────────────────────────────────────────────────────────────
async function tenantMiddleware(req, res, next) {
  try {
    const companyId = req.user?.companyId;

    if (!companyId) {
      return res.status(401).json({
        error: 'No company context in token. Please log in again.',
      });
    }

    // Verify active membership — catches revoked users or switched companies
    const { rows } = await query(
      `SELECT cu.role
       FROM   company_users cu
       JOIN   companies     c ON c.id = cu.company_id
       WHERE  cu.company_id = $1
         AND  cu.user_id    = $2
         AND  cu.is_active  = TRUE
         AND  c.status      = 'active'`,
      [companyId, req.user.userId]
    );

    if (!rows.length) {
      return res.status(403).json({
        error: 'Access denied: your membership in this company is inactive or the company is suspended.',
      });
    }

    req.tenantId    = companyId;
    req.companyRole = rows[0].role;
    req.withTenant  = (fn) => withTenant(companyId, fn);

    next();
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// requireRole — Gate a route to specific company roles.
//
// Must run AFTER tenantMiddleware.
//
// Usage:
//   router.delete('/items/:id',
//     requireAuth, tenantMiddleware, requireRole('admin','manager'),
//     ctrl.deleteItem
//   );
// ─────────────────────────────────────────────────────────────────────────
function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.companyRole)) {
      return res.status(403).json({
        error: `This action requires one of the following roles: ${roles.join(', ')}. Your role: ${req.companyRole}.`,
      });
    }
    next();
  };
}

// ─────────────────────────────────────────────────────────────────────────
// requirePlatformAdmin — Gate a route to platform-level admins only.
//   (users with is_platform_admin = true in the users table)
//
// Must run AFTER requireAuth.
// ─────────────────────────────────────────────────────────────────────────
function requirePlatformAdmin(req, res, next) {
  if (!req.user?.isPlatformAdmin) {
    return res.status(403).json({ error: 'Platform admin access required.' });
  }
  next();
}

module.exports = { tenantMiddleware, requireRole, requirePlatformAdmin };
