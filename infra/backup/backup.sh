#!/usr/bin/env bash
# Backs up the ARC Cloud database to backups/arc-<timestamp>.dump (+ row counts for verification).
#
#   bash infra/backup/backup.sh "postgresql://user:pass@host:port/db"
#
# On Railway use the Postgres service's DATABASE_PUBLIC_URL (Postgres → Variables).
# Uses local pg_dump when it matches the server's major version, otherwise Docker (postgres:<version>).
set -euo pipefail
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/../.."
URL="${1:-${DATABASE_URL:-}}"
[ -n "$URL" ] || { echo "usage: backup.sh <postgres-url>"; exit 1; }
mkdir -p backups
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT="backups/arc-$STAMP.dump"
source "$(dirname "$0")/pg-tools.sh"
pg_tools_for "$URL"

echo "Backing up (server PostgreSQL $SERVER_MAJOR) → $OUT"
run_pg pg_dump --format=custom --no-owner --no-privileges --dbname="$URL" > "$OUT"
run_pg psql "$URL" -Atqc "$(cat infra/backup/counts.sql)" > "$OUT.counts"
SIZE=$(wc -c < "$OUT")
[ "$SIZE" -gt 1000 ] || { echo "Backup looks empty ($SIZE bytes)"; exit 1; }
sha256sum "$OUT" | cut -d' ' -f1 > "$OUT.sha256"
echo "Done: $OUT ($SIZE bytes). Verify it with:  bash infra/backup/verify.sh $OUT"
