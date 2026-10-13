#!/usr/bin/env bash
# Proves a backup can be restored: restores it into a throwaway database and compares row counts.
#
#   bash infra/backup/verify.sh backups/arc-YYYYmmdd-HHMMSS.dump
#
# Uses Docker (a temporary postgres container) unless VERIFY_URL points at an empty scratch database.
set -euo pipefail
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/../.."
FILE="${1:?usage: verify.sh <dump-file>}"
[ -f "$FILE.counts" ] || { echo "Missing $FILE.counts (made by backup.sh)"; exit 1; }
if [ -f "$FILE.sha256" ] && [ "$(sha256sum "$FILE" | cut -d' ' -f1)" != "$(cat "$FILE.sha256")" ]; then echo "Checksum mismatch"; exit 1; fi
source "$(dirname "$0")/pg-tools.sh"
CONTAINER=""
cleanup() { [ -n "$CONTAINER" ] && docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT
if [ -n "${VERIFY_URL:-}" ]; then
  URL="$VERIFY_URL"
else
  MAJOR="${PG_MAJOR:-$(pg_restore_major "$FILE")}"
  CONTAINER="arc-verify-$$"
  echo "Starting a temporary PostgreSQL $MAJOR container…"
  docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=verify -p 127.0.0.1:55499:5432 "postgres:$MAJOR" >/dev/null
  for _ in $(seq 1 60); do docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
  sleep 2
  URL="postgresql://postgres:verify@127.0.0.1:55499/postgres"
fi
pg_tools_for "$URL"
START=$(date +%s)
run_pg pg_restore --no-owner --no-privileges --exit-on-error --dbname="$URL" < "$FILE"
run_pg psql "$URL" -Atqc "$(cat infra/backup/counts.sql)" > /tmp/arc-verify.counts
SECS=$(( $(date +%s) - START ))
if diff -q "$FILE.counts" /tmp/arc-verify.counts >/dev/null; then
  echo "VERIFIED: $FILE restores cleanly in ${SECS}s and every table's row count matches."
  echo "$(date -u +%FT%TZ) $FILE verified (${SECS}s)" >> backups/verify.log
else
  echo "FAILED: row counts differ after restore:"; diff "$FILE.counts" /tmp/arc-verify.counts || true; exit 1
fi
