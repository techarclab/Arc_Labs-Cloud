#!/bin/bash
# Deploys ARC Cloud on the Oracle VM:   sudo arc-deploy [git-ref]      (default: main)
#  1. checks out <git-ref> in /opt/arc-cloud
#  2. writes env files and database password files (secrets generated once, kept in /etc/arc-cloud/secrets.env)
#  3. builds images, starts PostgreSQL, Caddy and the console, waits for the MQTT TLS certificate
#  4. runs database migrations as a one-off step (the API never migrates on start in production)
#  5. starts everything and waits for https://API_HOST/health/deep (database + broker connection)
set -euo pipefail

REF="${1:-main}"
APP_DIR=/opt/arc-cloud
DATA=/opt/arc-cloud-data
CONF=/etc/arc-cloud
log() { echo "[arc-deploy] $*"; }

[ "$(id -u)" -eq 0 ] || { echo "arc-deploy must run as root (sudo arc-deploy)" >&2; exit 1; }
[[ "$REF" =~ ^[A-Za-z0-9._/-]{1,100}$ ]] || { echo "invalid git ref: $REF" >&2; exit 1; }

# shellcheck source=/dev/null
. "$CONF/config"
export ACME_EMAIL API_HOST MQTT_HOST CONSOLE_HOST

cd "$APP_DIR"
git fetch --depth 1 origin "$REF"
git checkout --force --detach FETCH_HEAD

# The running copy of this script may be older than the one just checked out: hand over to the new one first.
if [ -z "${ARC_DEPLOY_REEXEC:-}" ] && ! cmp -s deploy/oracle/arc-deploy.sh /usr/local/bin/arc-deploy; then
  install -m 0755 deploy/oracle/arc-deploy.sh /usr/local/bin/arc-deploy
  log "arc-deploy updated; restarting with the new version"
  ARC_DEPLOY_REEXEC=1 exec /usr/local/bin/arc-deploy "$REF"
fi
log "deploying $(git rev-parse --short HEAD) ($REF)"

install -m 0755 deploy/aws/arc-cert-sync.sh /usr/local/bin/arc-cert-sync   # shared with the AWS pilot
install -m 0755 deploy/oracle/arc-backup.sh /usr/local/bin/arc-backup
install -m 0755 deploy/oracle/arc-restore.sh /usr/local/bin/arc-restore
install -m 0644 deploy/aws/arc-cert-sync.service deploy/aws/arc-cert-sync.timer \
  deploy/oracle/arc-backup.service deploy/oracle/arc-backup.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now arc-cert-sync.timer arc-backup.timer

umask 077
python3 "$APP_DIR/deploy/oracle/write-env.py"
install -d -m 0755 "$DATA/caddy"
install -d -m 0755 "$DATA/firmware"
install -d -m 0700 "$DATA/backups"
install -d -m 0700 -o 999 -g 999 "$DATA/postgres"

COMPOSE=(docker compose -f "$APP_DIR/deploy/oracle/docker-compose.yml")
"${COMPOSE[@]}" build --pull
"${COMPOSE[@]}" up -d postgres caddy console

for _ in $(seq 1 60); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' arc-cloud-postgres-1 2>/dev/null)" = healthy ] && break
  sleep 2
done
[ "$(docker inspect -f '{{.State.Health.Status}}' arc-cloud-postgres-1 2>/dev/null)" = healthy ] \
  || { log "PostgreSQL did not become healthy"; "${COMPOSE[@]}" logs --tail 60 postgres; exit 1; }

/usr/local/bin/arc-cert-sync --wait 900 --no-restart

log "running database migrations"
"${COMPOSE[@]}" run --rm --no-deps api node apps/api/dist/db/migrate.js

"${COMPOSE[@]}" up -d --remove-orphans
for _ in $(seq 1 60); do
  # Healthy = a fresh database login works AND the API's MQTT publisher reached the broker.
  if curl -fsS --max-time 5 "https://$API_HOST/health/deep" 2>/dev/null | grep -q '"status":"ok"' \
     && curl -fsS --max-time 5 -o /dev/null "https://$CONSOLE_HOST/"; then
    log "healthy: https://$CONSOLE_HOST (console) and https://$API_HOST (API, database, broker)"
    docker image prune -f >/dev/null
    exit 0
  fi
  sleep 5
done
log "not healthy: $(curl -sS --max-time 5 "https://$API_HOST/health/deep" 2>&1 || true)"
"${COMPOSE[@]}" ps
"${COMPOSE[@]}" logs --tail 80 api emqx worker caddy postgres || true
exit 1
