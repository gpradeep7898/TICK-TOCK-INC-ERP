'use strict';

// companies.service.js
//
// Business logic layer for multi-tenant company management.
// Enforces all ERP rules: role guards, slug uniqueness, last-admin protection.

const repo = require('./companies.repository');

// ─────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────

function err(msg, status = 400) {
  return Object.assign(new Error(msg), { status });
}

function toSlug(name) {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const VALID_ROLES = ['admin', 'manager', 'sales', 'warehouse', 'readonly'];

// ─────────────────────────────────────────────────────────────────────────
// COMPANY OPERATIONS
// ─────────────────────────────────────────────────────────────────────────

async function getCompany(id) {
  const company = await repo.findById(id);
  if (!company) throw err('Company not found', 404);
  return company;
}

async function listCompanies({ limit = 50, offset = 0 } = {}) {
  return repo.findAll({ limit: Math.min(+limit, 200), offset: +offset });
}

async function createCompany(data, createdByUserId) {
  if (!data.name?.trim())        throw err('Company name is required');
  if (!data.owner_email?.trim()) throw err('Owner email is required');

  const slug = data.slug ? toSlug(data.slug) : toSlug(data.name);
  if (!slug)                     throw err('Could not generate a valid slug from company name');

  const existing = await repo.findBySlug(slug);
  if (existing) throw err(`Company slug "${slug}" is already taken`, 409);

  const company = await repo.create({
    slug,
    name:            data.name.trim(),
    plan:            data.plan || 'starter',
    ownerEmail:      data.owner_email.trim().toLowerCase(),
    timezone:        data.timezone        || 'America/New_York',
    currencyCode:    data.currency_code   || 'USD',
    fiscalYearStart: data.fiscal_year_start || 1,
    maxUsers:        data.max_users       || 5,
    maxWarehouses:   data.max_warehouses  || 3,
    trialEndsAt:     data.trial_ends_at   || null,
  });

  // Auto-enroll the creator as company admin
  if (createdByUserId) {
    await repo.addMember({
      companyId: company.id,
      userId:    createdByUserId,
      role:      'admin',
      invitedBy: null,
    });
  }

  return company;
}

async function updateCompany(companyId, data, requestingRole) {
  if (requestingRole !== 'admin') {
    throw err('Only company admins can update company details', 403);
  }

  // Slug change: re-validate uniqueness
  if (data.slug) {
    data.slug = toSlug(data.slug);
    const conflict = await repo.findBySlug(data.slug);
    if (conflict && conflict.id !== companyId) {
      throw err(`Slug "${data.slug}" is already taken by another company`, 409);
    }
  }

  const updated = await repo.update(companyId, data);
  if (!updated) throw err('Company not found', 404);
  return updated;
}

async function updateSettings(companyId, data, requestingRole) {
  if (requestingRole !== 'admin') {
    throw err('Only company admins can update operational settings', 403);
  }

  // Validate costing_method if provided
  if (data.costing_method && !['weighted_avg', 'fifo'].includes(data.costing_method)) {
    throw err('costing_method must be weighted_avg or fifo');
  }

  const updated = await repo.updateSettings(companyId, data);
  if (!updated) throw err('Company settings not found', 404);
  return updated;
}

// ─────────────────────────────────────────────────────────────────────────
// MEMBER MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────

async function getMembers(companyId) {
  return repo.getMembers(companyId);
}

async function addMember({ companyId, userId, role, invitedBy, requestingRole }) {
  if (!['admin', 'manager'].includes(requestingRole)) {
    throw err('Only admins or managers can add members', 403);
  }

  if (role && !VALID_ROLES.includes(role)) {
    throw err(`Invalid role. Valid roles: ${VALID_ROLES.join(', ')}`);
  }

  // Managers cannot add other admins
  if (requestingRole === 'manager' && role === 'admin') {
    throw err('Managers cannot assign the admin role', 403);
  }

  if (!userId) throw err('user_id is required');

  return repo.addMember({ companyId, userId, role: role || 'warehouse', invitedBy });
}

async function updateMemberRole(companyId, targetUserId, newRole, requestingUserId, requestingRole) {
  if (requestingRole !== 'admin') {
    throw err('Only admins can change member roles', 403);
  }

  if (!VALID_ROLES.includes(newRole)) {
    throw err(`Invalid role. Valid roles: ${VALID_ROLES.join(', ')}`);
  }

  // Last-admin protection: prevent removing the only admin
  if (targetUserId === requestingUserId && newRole !== 'admin') {
    const members  = await repo.getMembers(companyId);
    const admins   = members.filter(m => m.role === 'admin' && m.is_active);
    if (admins.length <= 1) {
      throw err('Cannot demote the last admin. Assign another admin first.', 409);
    }
  }

  const updated = await repo.updateMemberRole(companyId, targetUserId, newRole);
  if (!updated) throw err('Member not found', 404);
  return updated;
}

async function removeMember(companyId, targetUserId, requestingUserId, requestingRole) {
  if (requestingRole !== 'admin') {
    throw err('Only admins can remove members', 403);
  }

  if (targetUserId === requestingUserId) {
    throw err('You cannot remove yourself. Transfer admin rights first.', 409);
  }

  // Last-admin protection
  const membership = await repo.getMembership(companyId, targetUserId);
  if (membership?.role === 'admin') {
    const members = await repo.getMembers(companyId);
    const admins  = members.filter(m => m.role === 'admin' && m.is_active);
    if (admins.length <= 1) {
      throw err('Cannot remove the last admin from a company', 409);
    }
  }

  const updated = await repo.deactivateMember(companyId, targetUserId);
  if (!updated) throw err('Member not found', 404);
  return updated;
}

async function getUserCompanies(userId) {
  return repo.getUserCompanies(userId);
}

module.exports = {
  getCompany,
  listCompanies,
  createCompany,
  updateCompany,
  updateSettings,
  getMembers,
  addMember,
  updateMemberRole,
  removeMember,
  getUserCompanies,
};
