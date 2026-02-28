#!/usr/bin/env bash
# scripts/restore.sh — Restore a Tick Tock Inc. ERP backup
#
# Usage:
#   ./scripts/restore.sh backups/ticktock_20260228_120000.sql.gz
#   DATABASE_URL=postgresql://... ./scripts/restore.sh <backup_file>
#   ./scripts/restore.sh <backup_file> postgresql://user:pass@host:5432/ticktock
#
# The backup file must be a gzip-compressed SQL file produced by backup.sh.
# WARNING: This OVERWRITES the target database.

set -euo pipefail

BACKUP_FILE="${1:-}"
DB_URL="${2:-${DATABASE_URL:-}}"

# ── Validate arguments ────────────────────────────────────────────────────────
if [[ -z "$BACKUP_FILE" ]]; then
    echo "Error: backup file argument is required." >&2
    echo "  Usage: $0 <backup_file.sql.gz> [database_url]" >&2
    exit 1
fi

if [[ ! -f "$BACKUP_FILE" ]]; then
    echo "Error: file not found: $BACKUP_FILE" >&2
    exit 1
fi

if [[ -z "$DB_URL" ]]; then
    echo "Error: DATABASE_URL is not set." >&2
    echo "  Export it or pass as second argument: $0 <file> <database_url>" >&2
    exit 1
fi

FILE_SIZE="$(du -sh "$BACKUP_FILE" | cut -f1)"

echo ""
echo "══════════════════════════════════════════"
echo "  Tick Tock Inc. ERP — Database Restore"
echo "══════════════════════════════════════════"
echo "  File : $BACKUP_FILE ($FILE_SIZE)"
echo "  DB   : $DB_URL"
echo ""
echo "  !! This will OVERWRITE all data in the target database. !!"
echo ""
read -rp "  Type YES to continue: " confirm

if [[ "$confirm" != "YES" ]]; then
    echo "Aborted."
    exit 0
fi

echo ""
echo "Restoring…"
gunzip -c "$BACKUP_FILE" | psql "$DB_URL" -v ON_ERROR_STOP=1 -q

echo ""
echo "══════════════════════════════════════════"
echo "  Restore complete."
echo "  Restored from: $BACKUP_FILE"
echo "══════════════════════════════════════════"
echo ""
