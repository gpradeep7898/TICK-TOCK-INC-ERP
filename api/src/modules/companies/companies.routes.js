'use strict';

// companies.routes.js
//
// Route map for /api/companies/*
//
// Middleware layers (applied in order):
//   requireAuth         — verify JWT, attach req.user
//   tenantMiddleware    — verify company membership, attach req.tenantId / req.companyRole
//   requireRole(...)    — gate to specific roles
//   requirePlatformAdmin — gate to platform-level admins
//
// NOTE: requireAuth is applied globally in server.js for all /api/* routes.
//       We only apply tenantMiddleware / requireRole per-route here.

const { Router } = require('express');
const ctrl = require('./companies.controller');
const { tenantMiddleware, requireRole, requirePlatformAdmin } = require('../../middleware/tenant');

const router = Router();

// ─────────────────────────────────────────────────────────────────────────
// Platform-admin routes — no tenant context, but must be platform admin
// ─────────────────────────────────────────────────────────────────────────

// List all companies across the platform
router.get('/', requirePlatformAdmin, ctrl.listCompanies);

// Create a new tenant company
router.post('/', requirePlatformAdmin, ctrl.createCompany);

// Get any company by ID (platform admin view)
router.get('/:id([0-9a-f-]{36})', requirePlatformAdmin, ctrl.getCompanyById);

// ─────────────────────────────────────────────────────────────────────────
// User-scoped — no tenant context needed, just valid JWT
// ─────────────────────────────────────────────────────────────────────────

// All companies the current user belongs to (used for company-switcher UI)
router.get('/mine', ctrl.getUserCompanies);

// ─────────────────────────────────────────────────────────────────────────
// Tenant-scoped — require active membership in the company from JWT
// ─────────────────────────────────────────────────────────────────────────

// Current company profile
router.get('/me',          tenantMiddleware, ctrl.getCurrentCompany);

// Update company name, plan, timezone, etc. — admin only
router.put('/me',          tenantMiddleware, requireRole('admin'), ctrl.updateCurrentCompany);

// Update operational settings (costing method, invoice auto, tax, etc.) — admin only
router.put('/me/settings', tenantMiddleware, requireRole('admin'), ctrl.updateSettings);

// User management within this company
router.get   ('/me/users',                 tenantMiddleware,                              ctrl.getMembers);
router.post  ('/me/users',                 tenantMiddleware, requireRole('admin','manager'), ctrl.addMember);
router.put   ('/me/users/:userId/role',    tenantMiddleware, requireRole('admin'),           ctrl.updateMemberRole);
router.delete('/me/users/:userId',         tenantMiddleware, requireRole('admin'),           ctrl.removeMember);

module.exports = router;
