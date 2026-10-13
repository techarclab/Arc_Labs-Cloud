#!/usr/bin/env bash
# Restores a backup INTO an existing database, replacing its ARC Cloud tables.
#
#   bash infra/backup/restore.sh backups/arc-YYYYmmdd-HHMMSS.dump "postgresql://…/target_db"
#
# Stop the api and worker services first (Railway: Settings → scale to 0, or remove the deployment),
# restore, then start them again. See docs/runbooks/backup-restore.md.
set -euo pipefail
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/../.."
FILE="${1:?usage: restore.sh <dump-file> <target-url>}"
URL="${2:?usage: restore.sh <dump-file> <target-url>}"
[ -f "$FILE" ] || { echo "No such file: $FILE"; exit 1; }
if [ -f "$FILE.sha256" ] && [ "$(sha256sum "$FILE" | cut -d' ' -f1)" != "$(cat "$FILE.sha256")" ]; then
  echo "Checksum mismatch: $FILE is damaged."; exit 1
fi
source "$(dirname "$0")/pg-tools.sh"
pg_tools_for "$URL"
HOST=$(printf '%s' "$URL" | sed -E 's#^[a-z]+://([^@]*@)?([^/:?]+).*#\2#')
if [ "${ARC_RESTORE_YES:-}" != "yes" ]; then
  read -r -p "This REPLACES all ARC Cloud data in the database on $HOST. Type RESTORE to continue: " ok
  [ "$ok" = "RESTORE" ] || { echo "Cancelled."; exit 1; }
fi
run_pg pg_restore --clean --if-exists --no-owner --no-privileges --exit-on-error --dbname="$URL" < "$FILE"
if [ -f "$FILE.counts" ]; then
  run_pg psql "$URL" -Atqc "$(cat infra/backup/counts.sql)" > /tmp/arc-restore.counts
  if diff -q "$FILE.counts" /tmp/arc-restore.counts >/dev/null; then echo "Restored; row counts match the backup."; else echo "Restored, but row counts differ:"; diff "$FILE.counts" /tmp/arc-restore.counts || true; exit 1; fi
fi
