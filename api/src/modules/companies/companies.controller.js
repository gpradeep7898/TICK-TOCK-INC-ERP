'use strict';

// companies.controller.js
//
// HTTP layer only — validates inputs, calls service, formats responses.
// No business logic or DB access here.

const svc = require('./companies.service');

// ─────────────────────────────────────────────────────────────────────────
// PLATFORM-ADMIN ROUTES  (no tenant context required)
// ─────────────────────────────────────────────────────────────────────────

// GET /api/companies
async function listCompanies(req, res, next) {
  try {
    const { limit = 50, offset = 0 } = req.query;
    const companies = await svc.listCompanies({ limit, offset });
    res.json({ data: companies, count: companies.length });
  } catch (err) { next(err); }
}

// GET /api/companies/:id
async function getCompanyById(req, res, next) {
  try {
    const company = await svc.getCompany(req.params.id);
    res.json({ data: company });
  } catch (err) { next(err); }
}

// POST /api/companies
async function createCompany(req, res, next) {
  try {
    const company = await svc.createCompany(req.body, req.user.userId);
    res.status(201).json({ data: company });
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────────────────────────────────
// CURRENT-USER ROUTES  (require JWT — no specific tenant needed)
// ─────────────────────────────────────────────────────────────────────────

// GET /api/companies/mine  — all companies this user belongs to
async function getUserCompanies(req, res, next) {
  try {
    const companies = await svc.getUserCompanies(req.user.userId);
    res.json({ data: companies });
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────────────────────────────────
// COMPANY-SCOPED ROUTES  (require tenantMiddleware → req.tenantId)
// ─────────────────────────────────────────────────────────────────────────

// GET /api/companies/me
async function getCurrentCompany(req, res, next) {
  try {
    const company = await svc.getCompany(req.tenantId);
    res.json({ data: company });
  } catch (err) { next(err); }
}

// PUT /api/companies/me
async function updateCurrentCompany(req, res, next) {
  try {
    const updated = await svc.updateCompany(req.tenantId, req.body, req.companyRole);
    res.json({ data: updated });
  } catch (err) { next(err); }
}

// PUT /api/companies/me/settings
async function updateSettings(req, res, next) {
  try {
    const updated = await svc.updateSettings(req.tenantId, req.body, req.companyRole);
    res.json({ data: updated });
  } catch (err) { next(err); }
}

// GET /api/companies/me/users
async function getMembers(req, res, next) {
  try {
    const members = await svc.getMembers(req.tenantId);
    res.json({ data: members, count: members.length });
  } catch (err) { next(err); }
}

// POST /api/companies/me/users
async function addMember(req, res, next) {
  try {
    const { user_id, role } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id is required' });

    const member = await svc.addMember({
      companyId:      req.tenantId,
      userId:         user_id,
      role,
      invitedBy:      req.user.userId,
      requestingRole: req.companyRole,
    });
    res.status(201).json({ data: member });
  } catch (err) { next(err); }
}

// PUT /api/companies/me/users/:userId/role
async function updateMemberRole(req, res, next) {
  try {
    const { role } = req.body;
    if (!role) return res.status(400).json({ error: 'role is required' });

    const updated = await svc.updateMemberRole(
      req.tenantId,
      req.params.userId,
      role,
      req.user.userId,
      req.companyRole
    );
    res.json({ data: updated });
  } catch (err) { next(err); }
}

// DELETE /api/companies/me/users/:userId
async function removeMember(req, res, next) {
  try {
    await svc.removeMember(
      req.tenantId,
      req.params.userId,
      req.user.userId,
      req.companyRole
    );
    res.json({ success: true, message: 'Member deactivated.' });
  } catch (err) { next(err); }
}

module.exports = {
  // Platform-admin
  listCompanies,
  getCompanyById,
  createCompany,
  // Current-user
  getUserCompanies,
  // Company-scoped
  getCurrentCompany,
  updateCurrentCompany,
  updateSettings,
  getMembers,
  addMember,
  updateMemberRole,
  removeMember,
};
