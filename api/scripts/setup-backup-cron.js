#!/usr/bin/env node
'use strict';

/**
 * Tick Tock Inc. — Backup Cron Setup
 * Sets up a daily cron job at 2am to run backup.js
 * Usage: node scripts/setup-backup-cron.js
 */

const { execSync, execFileSync } = require('child_process');
const path = require('path');
const os   = require('os');

const BACKUP_SCRIPT = path.resolve(__dirname, 'backup.js');
const LOG_FILE      = path.resolve(__dirname, '..', '..', 'backups', 'backup-cron.log');
const CRON_JOB      = `0 2 * * * node ${BACKUP_SCRIPT} daily >> ${LOG_FILE} 2>&1`;
const CRON_MARKER   = '# ticktock-backup-cron';

const platform = os.platform();

if (platform === 'win32') {
    console.log('\n  Windows Task Scheduler Instructions:');
    console.log('  ─────────────────────────────────────────────────────────');
    console.log('  Run these PowerShell commands as Administrator:\n');
    console.log(`  $action = New-ScheduledTaskAction -Execute "node" -Argument "${BACKUP_SCRIPT} daily"`);
    console.log(`  $trigger = New-ScheduledTaskTrigger -Daily -At "02:00"`);
    console.log(`  Register-ScheduledTask -Action $action -Trigger $trigger -TaskName "TickTockBackup" -Description "Daily DB backup for Tick Tock ERP"`);
    console.log('\n  To remove it later:');
    console.log('  Unregister-ScheduledTask -TaskName "TickTockBackup" -Confirm:$false\n');
    process.exit(0);
}

// macOS or Linux — use crontab
console.log('\n  Tick Tock Inc. — Backup Cron Setup');
console.log('  ────────────────────────────────────');
console.log(`  Platform: ${platform}`);
console.log(`  Script:   ${BACKUP_SCRIPT}`);
console.log(`  Schedule: Daily at 2:00 AM`);
console.log(`  Log:      ${LOG_FILE}`);
console.log();

try {
    // Read current crontab (may fail with exit code 1 if empty — that's ok)
    let current = '';
    try {
        current = execSync('crontab -l', { encoding: 'utf8' });
    } catch {
        current = ''; // no crontab yet
    }

    // Check if already installed
    if (current.includes(CRON_MARKER)) {
        console.log('  Already installed! Current cron job:');
        const line = current.split('\n').find(l => l.includes('ticktock'));
        console.log(`  ${line}\n`);
        process.exit(0);
    }

    // Append new job
    const newCrontab = current.trimEnd()
        + `\n${CRON_MARKER}\n${CRON_JOB}\n`;

    // Write via stdin
    const child = require('child_process').spawnSync(
        'crontab', ['-'],
        { input: newCrontab, encoding: 'utf8' }
    );

    if (child.status !== 0) {
        throw new Error(child.stderr || 'crontab write failed');
    }

    console.log('  ✓ Cron job installed successfully!');
    console.log(`  Schedule: ${CRON_JOB}`);
    console.log('\n  To verify: run  crontab -l');
    console.log('  To remove: run  crontab -e  and delete the ticktock lines\n');

} catch (err) {
    console.error(`  ERROR: ${err.message}`);
    console.log('\n  Manual installation — add this line to your crontab (run: crontab -e):');
    console.log(`\n  ${CRON_MARKER}\n  ${CRON_JOB}\n`);
    process.exit(1);
}
