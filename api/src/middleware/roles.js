'use strict';

// middleware/roles.js
// Platform-level role guards (independent of tenant/company roles).
// These operate on req.user, set by requireAuth.
//
// For company-scoped role checks use the tenant middleware:
//   requireRole('admin') from middleware/tenant.js

/**
 * Gate to users whose global `role` field matches one of the supplied values.
 * Note: this is the platform-level role stored in `users.role` (e.g. 'admin', 'manager').
 * For tenant-scoped company roles use requireRole from tenant.js.
 */
function requireUserRole(...roles) {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({ success: false, error: 'Authentication required' });
        }
        if (!roles.includes(req.user.role)) {
            return res.status(403).json({
                success: false,
                error: `Access denied. Required role: ${roles.join(' or ')}.`,
            });
        }
        next();
    };
}

/**
 * Gate to platform administrators only (users.is_platform_admin = true).
 */
function requirePlatformAdmin(req, res, next) {
    if (!req.user) {
        return res.status(401).json({ success: false, error: 'Authentication required' });
    }
    if (!req.user.isPlatformAdmin) {
        return res.status(403).json({ success: false, error: 'Platform admin access required.' });
    }
    next();
}

module.exports = { requireUserRole, requirePlatformAdmin };
