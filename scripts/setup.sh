#!/usr/bin/env bash
# scripts/setup.sh — First-run database initialisation for Tick Tock Inc. ERP
#
# Usage (local):
#   ./scripts/setup.sh
#   DATABASE_URL=postgresql://... ./scripts/setup.sh
#
# Usage (Docker — after `docker compose up -d postgres`):
#   docker compose -f docker/docker-compose.yml exec postgres \
#       psql -U postgres -d ticktock -c '\conninfo'   # verify DB is up
#   docker compose -f docker/docker-compose.yml run --rm api \
#       node src/seed-users.js                         # seed demo users
#
# What this script does:
#   1. Waits for PostgreSQL to accept connections
#   2. Applies all migrations (001–007) in order
#   3. Runs seed-users.js to create demo auth users
#
# Prerequisites (local): psql, node

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MIGRATIONS_DIR="$PROJECT_ROOT/db/migrations"
API_DIR="$PROJECT_ROOT/api"

DB_URL="${DATABASE_URL:-}"
if [[ -z "$DB_URL" ]]; then
    echo "Error: DATABASE_URL is not set." >&2
    echo "  Export it or prefix the command:" >&2
    echo "  DATABASE_URL=postgresql://user:pass@host:5432/ticktock ./scripts/setup.sh" >&2
    exit 1
fi

echo ""
echo "══════════════════════════════════════════"
echo "  Tick Tock Inc. ERP — Database Setup"
echo "══════════════════════════════════════════"
echo "  DB: $DB_URL"
echo ""

# ── 1. Wait for PostgreSQL ────────────────────────────────────────────────────
echo "Waiting for PostgreSQL..."
for i in $(seq 1 30); do
    if psql "$DB_URL" -c '\q' >/dev/null 2>&1; then
        echo "  PostgreSQL ready."
        break
    fi
    if [[ $i -eq 30 ]]; then
        echo "  Timed out waiting for PostgreSQL after 60 s." >&2
        exit 1
    fi
    printf "  Attempt %d/30…\r" "$i"
    sleep 2
done

# ── 2. Apply migrations ───────────────────────────────────────────────────────
echo ""
echo "Applying migrations:"
for sql_file in "$MIGRATIONS_DIR"/0*.sql; do
    name="$(basename "$sql_file")"
    printf "  %-40s" "$name"
    psql "$DB_URL" -f "$sql_file" -v ON_ERROR_STOP=1 -q
    echo "✓"
done

# ── 3. Seed demo users ────────────────────────────────────────────────────────
echo ""
echo "Seeding demo users:"
export DATABASE_URL="$DB_URL"
node "$API_DIR/src/seed-users.js"

echo ""
echo "══════════════════════════════════════════"
echo "  Setup complete!"
echo ""
echo "  Start the API:  cd api && npm start"
echo "  Demo logins:    admin@ticktock.com / admin123"
echo "                  manager@ticktock.com / manager123"
echo "                  viewer@ticktock.com / viewer123"
echo "══════════════════════════════════════════"
echo ""
