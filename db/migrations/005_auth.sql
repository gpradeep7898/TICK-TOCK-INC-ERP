-- ============================================================
-- Tick Tock Inc. — Auth Migration
-- 005_auth.sql
-- Adds password_hash to users, seeds demo users
-- ============================================================

-- Add password_hash column to users if not exists
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);

-- Delete old demo users if any (idempotent)
DELETE FROM users WHERE email IN (
    'admin@ticktock.com',
    'warehouse@ticktock.com',
    'sales@ticktock.com'
);

-- Seed demo users (passwords are hashed via bcrypt, cost 10)
-- admin123, wh123, sales123
INSERT INTO users (name, email, role, password_hash, is_active) VALUES
(
    'Admin User',
    'admin@ticktock.com',
    'admin',
    '$2b$10$YourHashHere_REPLACE_WITH_REAL_HASH',
    true
),
(
    'Warehouse Staff',
    'warehouse@ticktock.com',
    'warehouse',
    '$2b$10$YourHashHere_REPLACE_WITH_REAL_HASH_2',
    true
),
(
    'Sales Rep',
    'sales@ticktock.com',
    'sales',
    '$2b$10$YourHashHere_REPLACE_WITH_REAL_HASH_3',
    true
);
-- NOTE: Run the seed script instead: node api/src/seed-users.js
