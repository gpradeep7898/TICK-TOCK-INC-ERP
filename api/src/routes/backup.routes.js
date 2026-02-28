'use strict';

// routes/backup.routes.js
// Database backup (pg_dump + gzip) and schedule

const { Router }    = require('express');
const { execFile }  = require('child_process');
const fs            = require('fs');
const zlib          = require('zlib');
const path          = require('path');
const { query }     = require('../db/pool');

const router     = Router();
const BACKUP_DIR = path.join(__dirname, '..', '..', '..', 'backups');

// POST /api/backup/run
router.post('/run', async (req, res) => {
    const backupType = req.body.backup_type || 'manual';
    const startedAt  = new Date();

    fs.mkdirSync(BACKUP_DIR, { recursive: true });

    const ts      = startedAt.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const sqlFile = path.join(BACKUP_DIR, `ticktock_${ts}.sql`);
    const gzFile  = sqlFile + '.gz';

    let pgArgs;
    try {
        const url = new URL(process.env.DATABASE_URL);
        pgArgs = [
            '-h', url.hostname,
            '-p', url.port || '5432',
            '-U', url.username,
            '-F', 'p',
            '-f', sqlFile,
            url.pathname.slice(1)
        ];
    } catch {
        return res.status(500).json({ error: 'Invalid DATABASE_URL' });
    }

    const { rows: [logRow] } = await query(
        `INSERT INTO backup_log (backup_type, file_path, status, started_at)
         VALUES ($1,$2,'failed',$3) RETURNING id`,
        [backupType, gzFile, startedAt]
    );

    const env = { ...process.env, PGPASSWORD: new URL(process.env.DATABASE_URL).password };

    execFile('pg_dump', pgArgs, { env }, async (err) => {
        if (err) {
            await query(
                `UPDATE backup_log SET status='failed', completed_at=NOW(), error_message=$1 WHERE id=$2`,
                [err.message, logRow.id]
            );
            return res.status(500).json({ error: err.message });
        }

        try {
            await new Promise((resolve, reject) => {
                const input  = fs.createReadStream(sqlFile);
                const output = fs.createWriteStream(gzFile);
                const gz     = zlib.createGzip();
                input.pipe(gz).pipe(output);
                output.on('finish', resolve);
                output.on('error', reject);
            });
            fs.unlinkSync(sqlFile);

            const stat        = fs.statSync(gzFile);
            const completedAt = new Date();
            await query(
                `UPDATE backup_log
                 SET status='success', completed_at=$1, file_size_bytes=$2, file_path=$3
                 WHERE id=$4`,
                [completedAt, stat.size, gzFile, logRow.id]
            );

            // Prune old backups (keep 30)
            const files = fs.readdirSync(BACKUP_DIR)
                .filter(f => f.startsWith('ticktock_') && f.endsWith('.sql.gz'))
                .map(f => path.join(BACKUP_DIR, f))
                .sort();
            while (files.length > 30) {
                try { fs.unlinkSync(files.shift()); } catch { /* ignore */ }
            }

            res.json({
                file_path:   gzFile,
                file_size:   stat.size,
                duration_ms: completedAt - startedAt,
                backup_id:   logRow.id
            });
        } catch (gzErr) {
            await query(
                `UPDATE backup_log SET status='failed', completed_at=NOW(), error_message=$1 WHERE id=$2`,
                [gzErr.message, logRow.id]
            );
            res.status(500).json({ error: gzErr.message });
        }
    });
});

// GET /api/backup/list
router.get('/list', async (_req, res) => {
    try {
        const { rows } = await query(
            `SELECT * FROM backup_log ORDER BY started_at DESC LIMIT 50`
        );
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/backup/schedule
router.post('/schedule', async (req, res) => {
    const { cron_expression = '0 2 * * *' } = req.body;
    const configPath = path.join(__dirname, '..', '..', 'backup-schedule.json');
    try {
        fs.writeFileSync(configPath, JSON.stringify({ cron_expression, updated_at: new Date() }, null, 2));
        res.json({ message: 'Schedule saved', cron_expression, config_file: configPath });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
