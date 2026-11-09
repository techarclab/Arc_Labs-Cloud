#!/bin/bash
# Daily database backup (arc-backup.timer):   sudo arc-backup
# pg_dump of arc_cloud (custom format) into /opt/arc-cloud-data/backups, checked with pg_restore --list,
# newest ARC_BACKUP_KEEP (default 7) kept. These copies live on the same VM: they protect against mistakes,
# not against losing the VM. For that, if /etc/arc-cloud/backup-upload is executable it is called with the
# file path (e.g. copy to OCI Object Storage), and the boot volume should have an Oracle backup policy
# (docs/deploy/oracle-free.md, "Backups").
set -euo pipefail

DIR="${ARC_BACKUP_DIR:-/opt/arc-cloud-data/backups}"
KEEP="${ARC_BACKUP_KEEP:-7}"
# How to run PostgreSQL client tools as the postgres superuser (override only for tests).
read -r -a PG <<< "${ARC_PG_EXEC:-docker exec -i -u postgres arc-cloud-postgres-1}"

umask 077
install -d -m 0700 "$DIR"
f="$DIR/arc_cloud-$(date -u +%Y%m%dT%H%M%SZ).dump"
"${PG[@]}" pg_dump --dbname arc_cloud --format custom > "$f.tmp"
"${PG[@]}" pg_restore --list < "$f.tmp" > /dev/null   # refuse to keep a truncated or corrupt dump
mv "$f.tmp" "$f"
echo "[arc-backup] $(basename "$f") $(du -h "$f" | cut -f1)"

mapfile -t old < <(ls -1t "$DIR"/arc_cloud-*.dump 2>/dev/null | tail -n +"$((KEEP + 1))")
if [ "${#old[@]}" -gt 0 ]; then rm -f -- "${old[@]}"; echo "[arc-backup] removed ${#old[@]} old backup(s)"; fi

if [ -x /etc/arc-cloud/backup-upload ]; then
  /etc/arc-cloud/backup-upload "$f" && echo "[arc-backup] uploaded off-site"
fi
