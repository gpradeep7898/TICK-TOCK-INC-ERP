'use strict';

// routes/auth.routes.js
// POST /api/auth/login
// GET  /api/auth/me
// POST /api/auth/switch-company

const { Router } = require('express');
const jwt        = require('jsonwebtoken');
const bcrypt     = require('bcryptjs');
const { query }  = require('../db/pool');
const { requireAuth }              = require('../middleware/auth');
const { loginLimiter }             = require('../middleware/rateLimiter');
const { validate }                 = require('../middleware/validate');
const { LoginSchema, SwitchCompanySchema } = require('../lib/schemas');
const { JWT_SECRET, JWT_EXPIRES_IN } = require('../config/env');

const router = Router();

// POST /api/auth/login
router.post('/login', loginLimiter, validate(LoginSchema), async (req, res) => {
    const { email, password } = req.body;   // email is already lowercased/trimmed by schema
    try {
        const { rows } = await query(
            `SELECT id, name, email, role, password_hash, is_active FROM users WHERE email = $1`,
            [email]
        );
        if (!rows.length) {
            return res.status(401).json({ success: false, error: 'Invalid email or password' });
        }
        const user = rows[0];
        if (!user.is_active) {
            return res.status(403).json({ success: false, error: 'Account is disabled' });
        }
        const match = await bcrypt.compare(password, user.password_hash || '');
        if (!match) {
            return res.status(401).json({ success: false, error: 'Invalid email or password' });
        }

        // Resolve active company — priority: last_company_id → first active membership
        const { rows: memberships } = await query(
            `SELECT cu.company_id, cu.role, c.name AS company_name, c.slug
             FROM   company_users cu
             JOIN   companies     c ON c.id = cu.company_id
             WHERE  cu.user_id   = $1
               AND  cu.is_active = TRUE
               AND  c.status     = 'active'
             ORDER BY (cu.company_id = $2) DESC, cu.joined_at ASC
             LIMIT 20`,
            [user.id, user.last_company_id || '00000000-0000-0000-0000-000000000000']
        );

        const activeMembership = memberships[0] || null;
        const companyId        = activeMembership?.company_id || null;

        if (companyId && companyId !== user.last_company_id) {
            await query(
                `UPDATE users SET last_company_id = $1 WHERE id = $2`,
                [companyId, user.id]
            );
        }

        const payload = {
            userId:          user.id,
            email:           user.email,
            role:            user.role,
            name:            user.name,
            companyId,
            isPlatformAdmin: user.is_platform_admin || false,
        };
        const token = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

        res.json({
            success: true,
            data: {
                token,
                user:      payload,
                companies: memberships.map(m => ({
                    id:   m.company_id,
                    name: m.company_name,
                    slug: m.slug,
                    role: m.role,
                })),
            },
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET /api/auth/me
router.get('/me', requireAuth, (req, res) => {
    res.json({ success: true, data: req.user });
});

// POST /api/auth/switch-company
router.post('/switch-company', requireAuth, validate(SwitchCompanySchema), async (req, res) => {
    const { company_id } = req.body;
    try {
        const { rows } = await query(
            `SELECT cu.role, c.name AS company_name, c.slug, c.status
             FROM   company_users cu
             JOIN   companies     c ON c.id = cu.company_id
             WHERE  cu.user_id   = $1
               AND  cu.company_id = $2
               AND  cu.is_active = TRUE`,
            [req.user.userId, company_id]
        );
        if (!rows.length) {
            return res.status(403).json({ error: 'You are not an active member of this company.' });
        }
        if (rows[0].status !== 'active') {
            return res.status(403).json({ error: 'This company account is not active.' });
        }

        await query(
            `UPDATE users SET last_company_id = $1 WHERE id = $2`,
            [company_id, req.user.userId]
        );

        const payload = {
            userId:          req.user.userId,
            email:           req.user.email,
            role:            req.user.role,
            name:            req.user.name,
            companyId:       company_id,
            isPlatformAdmin: req.user.isPlatformAdmin,
        };
        const token = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
        res.json({ success: true, data: { token, company: rows[0] } });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
