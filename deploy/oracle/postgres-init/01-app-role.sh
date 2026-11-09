#!/bin/bash
# Runs once, when the postgres container initialises an empty data directory.
# Creates the application role and database. The app never uses the `postgres` superuser:
#   arc_admin  LOGIN, CREATEROLE (migration 004 creates the arc_tenant role), owner of arc_cloud, NOT superuser,
#              so PostgreSQL row-level security and normal permission checks apply to it, as on RDS.
# Same role and database names as the AWS pilot, so a dump from RDS restores here unchanged (arc-restore).
set -euo pipefail
pw="$(cat /run/arc-db/password)"
[ -n "$pw" ] || { echo "empty /run/arc-db/password" >&2; exit 1; }
psql -v ON_ERROR_STOP=1 --username postgres --dbname postgres --set=pw="$pw" <<'SQL'
CREATE ROLE arc_admin LOGIN CREATEROLE NOSUPERUSER NOBYPASSRLS PASSWORD :'pw';
CREATE DATABASE arc_cloud OWNER arc_admin;
SQL
echo "[postgres-init] created role arc_admin and database arc_cloud"
