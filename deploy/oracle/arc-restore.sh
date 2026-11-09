#!/bin/bash
# Replaces the arc_cloud database with a pg_dump (custom format):   sudo arc-restore <file.dump>
# Use it for a backup from /opt/arc-cloud-data/backups, or for a dump of the AWS pilot's RDS database
# (same role and database names; see docs/deploy/oracle-free.md, "Move your data from AWS").
# Stops api/worker/emqx, recreates the database, restores, checks it, applies newer migrations, starts again.
set -euo pipefail

FILE="${1:-}"
[ -n "$FILE" ] && [ -s "$FILE" ] || { echo "usage: arc-restore <file.dump> [--yes]" >&2; exit 2; }
read -r -a PG <<< "${ARC_PG_EXEC:-docker exec -i -u postgres arc-cloud-postgres-1}"
COMPOSE=(docker compose -f /opt/arc-cloud/deploy/oracle/docker-compose.yml)
NO_COMPOSE="${ARC_RESTORE_NO_COMPOSE:-}"   # tests only
log() { echo "[arc-restore] $*"; }

"${PG[@]}" pg_restore --list < "$FILE" > /dev/null || { log "$FILE is not a pg_dump custom-format file"; exit 1; }
if [ "${2:-}" != "--yes" ]; then
  read -r -p "This REPLACES all ARC Cloud data with $FILE. Type RESTORE to continue: " answer
  [ "$answer" = RESTORE ] || { log "cancelled"; exit 1; }
fi

[ -n "$NO_COMPOSE" ] || "${COMPOSE[@]}" stop api worker emqx

"${PG[@]}" psql -v ON_ERROR_STOP=1 --dbname postgres -q <<'SQL'
SET client_min_messages = warning;
DO $$ BEGIN
  PERFORM pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'arc_cloud' AND pid <> pg_backend_pid();
END $$;
DROP DATABASE IF EXISTS arc_cloud;
CREATE DATABASE arc_cloud OWNER arc_admin;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'arc_tenant') THEN
    CREATE ROLE arc_tenant NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;
  END IF;
END $$;
GRANT arc_tenant TO arc_admin;
SQL

# --no-owner --role=arc_admin: everything ends up owned by arc_admin, whatever owned it in the source (RDS:
# arc_admin as well). Grants to arc_tenant are kept. Statements that only make sense on RDS (rds_* roles) fail
# harmlessly, so errors are reported, and the result is judged by the checks below instead.
set +e
"${PG[@]}" pg_restore --no-owner --role=arc_admin --dbname arc_cloud < "$FILE" 2> /tmp/arc-restore.err
rc=$?
set -e
if [ "$rc" -ne 0 ]; then
  log "pg_restore reported $(grep -c 'error:' /tmp/arc-restore.err || true) error(s) (often harmless RDS-only grants):"
  grep 'error:' /tmp/arc-restore.err | head -10 || true
fi

check() { "${PG[@]}" psql --dbname arc_cloud -tA -c "$1"; }
migrations="$(check 'SELECT count(*) FROM schema_migrations' 2>/dev/null || echo 0)"
policies="$(check "SELECT count(*) FROM pg_policies WHERE schemaname = 'public'" 2>/dev/null || echo 0)"
users="$(check 'SELECT count(*) FROM users' 2>/dev/null || echo '?')"
log "restored: $migrations migrations, $policies row-level security policies, $users users"
[ "$migrations" -gt 0 ] && [ "$policies" -gt 0 ] || { log "restore looks incomplete; services left stopped. See /tmp/arc-restore.err"; exit 1; }

if [ -z "$NO_COMPOSE" ]; then
  "${COMPOSE[@]}" run --rm --no-deps api node apps/api/dist/db/migrate.js   # apply migrations newer than the dump
  "${COMPOSE[@]}" up -d
  api_host="$(sed -n 's/^API_HOST=//p' /etc/arc-cloud/config 2>/dev/null)"
  log "services started; check https://${api_host:-<API_HOST>}/health/deep in a minute"
fi
