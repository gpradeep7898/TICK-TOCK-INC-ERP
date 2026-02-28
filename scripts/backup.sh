#!/usr/bin/env bash
# scripts/backup.sh — pg_dump backup for Tick Tock Inc. ERP
#
# Usage (local):
#   ./scripts/backup.sh
#   DATABASE_URL=postgresql://... ./scripts/backup.sh
#   ./scripts/backup.sh postgresql://... /path/to/backups
#
# Usage (Docker):
#   docker compose -f docker/docker-compose.yml exec postgres \
#       pg_dump -U postgres ticktock | gzip > backups/ticktock_$(date +%Y%m%d_%H%M%S).sql.gz
#
# Creates:  backups/ticktock_YYYYMMDD_HHMMSS.sql.gz
# Retains:  30 most recent backups (older ones are removed)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

DB_URL="${1:-${DATABASE_URL:-}}"
BACKUP_DIR="${2:-${BACKUP_DIR:-$PROJECT_ROOT/backups}}"

if [[ -z "$DB_URL" ]]; then
    echo "Error: DATABASE_URL is not set." >&2
    echo "  Usage: DATABASE_URL=postgresql://... $0" >&2
    exit 1
fi

mkdir -p "$BACKUP_DIR"

TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
FILE="$BACKUP_DIR/ticktock_${TIMESTAMP}.sql.gz"

echo "Creating backup…"
echo "  Source : $DB_URL"
echo "  Output : $FILE"

pg_dump "$DB_URL" | gzip > "$FILE"

SIZE="$(du -sh "$FILE" | cut -f1)"
echo "  Done   : $SIZE"

# ── Rotation: keep 30 most recent ────────────────────────────────────────────
KEEP=30
mapfile -t old_files < <(ls -1t "$BACKUP_DIR"/ticktock_*.sql.gz 2>/dev/null | tail -n +$((KEEP + 1)))
if [[ ${#old_files[@]} -gt 0 ]]; then
    rm -f "${old_files[@]}"
    echo "  Rotated: removed ${#old_files[@]} old backup(s) (keeping $KEEP)"
fi

echo "Backup complete: $FILE"
