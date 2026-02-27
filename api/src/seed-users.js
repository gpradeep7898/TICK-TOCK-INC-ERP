'use strict';
// Run: node api/src/seed-users.js
// Seeds demo users with proper bcrypt hashes

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function seed() {
    const client = await pool.connect();
    try {
        // Add password_hash column if missing
        await client.query(`
            ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255)
        `);

        const users = [
            { name: 'Admin User',      email: 'admin@ticktock.com',     role: 'admin',     pass: 'admin123' },
            { name: 'Warehouse Staff', email: 'warehouse@ticktock.com', role: 'warehouse', pass: 'wh123'    },
            { name: 'Sales Rep',       email: 'sales@ticktock.com',     role: 'sales',     pass: 'sales123' },
        ];

        for (const u of users) {
            const hash = await bcrypt.hash(u.pass, 10);
            await client.query(`
                INSERT INTO users (name, email, role, password_hash, is_active)
                VALUES ($1, $2, $3, $4, true)
                ON CONFLICT (email) DO UPDATE SET
                    name = EXCLUDED.name,
                    role = EXCLUDED.role,
                    password_hash = EXCLUDED.password_hash,
                    is_active = true
            `, [u.name, u.email, u.role, hash]);
            console.log(`  ✓  ${u.email}  (${u.role})`);
        }

        console.log('\n  Demo users seeded successfully.\n');
    } finally {
        client.release();
        await pool.end();
    }
}

seed().catch(err => { console.error(err); process.exit(1); });
