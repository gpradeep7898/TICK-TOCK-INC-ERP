#!/usr/bin/env node
'use strict';

/**
 * Tick Tock Inc. — Database Backup Script
 * Usage: node scripts/backup.js [backup_type]
 * backup_type: 'daily' | 'manual' | 'pre_migration' (default: 'manual')
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { execFile } = require('child_process');
const fs   = require('fs');
const zlib = require('zlib');
const path = require('path');
const { Pool } = require('pg');

const BACKUP_DIR = path.join(__dirname, '..', '..', 'backups');
const KEEP_COUNT = 30;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
    const backupType = process.argv[2] || 'manual';
    const startedAt  = new Date();

    console.log(`\n  Tick Tock Inc. — Database Backup`);
    console.log(`  ──────────────────────────────────`);
    console.log(`  Type:    ${backupType}`);
    console.log(`  Started: ${startedAt.toISOString()}`);
    console.log(`  DB:      ${process.env.DATABASE_URL}`);
    console.log();

    // Ensure backup directory exists
    fs.mkdirSync(BACKUP_DIR, { recursive: true });

    // Build filename: ticktock_YYYY-MM-DD_HH-MM.sql.gz
    const ts      = startedAt.toISOString().replace(/[:.]/g, '-').slice(0, 16);
    const sqlFile = path.join(BACKUP_DIR, `ticktock_${ts}.sql`);
    const gzFile  = sqlFile + '.gz';

    // Parse DATABASE_URL
    let url;
    try {
        url = new URL(process.env.DATABASE_URL);
    } catch {
        console.error('  ERROR: Invalid DATABASE_URL in .env');
        process.exit(1);
    }

    const pgArgs = [
        '-h', url.hostname,
        '-p', url.port || '5432',
        '-U', url.username,
        '-F', 'p',      // plain SQL format
        '-f', sqlFile,
        url.pathname.slice(1)   // database name (strip leading /)
    ];

    // Log to backup_log as started (status will be updated after)
    let logId;
    try {
        const { rows } = await pool.query(
            `INSERT INTO backup_log (backup_type, file_path, status, started_at)
             VALUES ($1, $2, 'failed', $3) RETURNING id`,
            [backupType, gzFile, startedAt]
        );
        logId = rows[0].id;
    } catch (dbErr) {
        console.warn(`  WARN: Could not write to backup_log: ${dbErr.message}`);
    }

    // Run pg_dump
    console.log('  Running pg_dump…');
    await new Promise((resolve, reject) => {
        const env = { ...process.env, PGPASSWORD: url.password || '' };
        execFile('pg_dump', pgArgs, { env }, (err, stdout, stderr) => {
            if (err) reject(new Error(stderr || err.message));
            else resolve();
        });
    }).catch(async (err) => {
        console.error(`  ERROR: pg_dump failed: ${err.message}`);
        if (logId) {
            await pool.query(
                `UPDATE backup_log SET status='failed', completed_at=NOW(), error_message=$1 WHERE id=$2`,
                [err.message, logId]
            ).catch(() => {});
        }
        await pool.end();
        process.exit(1);
    });

    console.log('  Compressing…');

    // Gzip compress
    await new Promise((resolve, reject) => {
        const input  = fs.createReadStream(sqlFile);
        const output = fs.createWriteStream(gzFile);
        const gz     = zlib.createGzip({ level: 9 });
        input.pipe(gz).pipe(output);
        output.on('finish', resolve);
        output.on('error', reject);
    });

    // Remove uncompressed file
    fs.unlinkSync(sqlFile);

    const completedAt = new Date();
    const stat        = fs.statSync(gzFile);
    const durationMs  = completedAt - startedAt;
    const sizeMB      = (stat.size / 1024 / 1024).toFixed(2);

    console.log(`  Done!`);
    console.log(`  File:     ${gzFile}`);
    console.log(`  Size:     ${sizeMB} MB (${stat.size.toLocaleString()} bytes)`);
    console.log(`  Duration: ${durationMs}ms`);

    // Update backup_log
    if (logId) {
        await pool.query(
            `UPDATE backup_log
             SET status='success', completed_at=$1, file_size_bytes=$2, file_path=$3
             WHERE id=$4`,
            [completedAt, stat.size, gzFile, logId]
        ).catch((err) => console.warn(`  WARN: Could not update backup_log: ${err.message}`));
    }

    // Prune old backups (keep last KEEP_COUNT)
    const allFiles = fs.readdirSync(BACKUP_DIR)
        .filter(f => f.startsWith('ticktock_') && f.endsWith('.sql.gz'))
        .map(f => path.join(BACKUP_DIR, f))
        .sort();  // oldest first (lexicographic = chronological for our naming)

    if (allFiles.length > KEEP_COUNT) {
        const toDelete = allFiles.slice(0, allFiles.length - KEEP_COUNT);
        for (const f of toDelete) {
            try {
                fs.unlinkSync(f);
                console.log(`  Pruned old backup: ${path.basename(f)}`);
            } catch { /* ignore */ }
        }
    }

    console.log(`\n  Backup complete. ${allFiles.length} file(s) retained.\n`);
    await pool.end();
}

run().catch(async (err) => {
    console.error(`\n  FATAL: ${err.message}\n`);
    await pool.end().catch(() => {});
    process.exit(1);
});
