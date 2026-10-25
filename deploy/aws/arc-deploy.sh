#!/bin/bash
# Deploys ARC Cloud on the AWS server:   sudo arc-deploy <git-ref>      (CI runs it through SSM)
#  1. checks out <git-ref>
#  2. writes per-service env files from Secrets Manager (root-only, 0600)
#  3. builds images, starts Caddy, waits for the MQTT TLS certificate
#  4. runs database migrations as a one-off step (the API never migrates on start in production)
#  5. starts everything and waits for https://API_HOST/health/ready
set -euo pipefail

REF="${1:-main}"
APP_DIR=/opt/arc-cloud
DATA=/opt/arc-cloud-data
CONF=/etc/arc-cloud
log() { echo "[arc-deploy] $*"; }

[ "$(id -u)" -eq 0 ] || { echo "arc-deploy must run as root" >&2; exit 1; }
[[ "$REF" =~ ^[A-Za-z0-9._/-]{1,100}$ ]] || { echo "invalid git ref: $REF" >&2; exit 1; }

# shellcheck source=/dev/null
. "$CONF/config"
export AWS_REGION ACME_EMAIL API_HOST MQTT_HOST

cd "$APP_DIR"
git fetch --depth 1 origin "$REF"
git checkout --force --detach FETCH_HEAD
log "deploying $(git rev-parse --short HEAD) ($REF)"

install -m 0755 deploy/aws/arc-deploy.sh /usr/local/bin/arc-deploy
install -m 0755 deploy/aws/arc-cert-sync.sh /usr/local/bin/arc-cert-sync
install -m 0755 deploy/aws/arc-os-patch.sh /usr/local/bin/arc-os-patch
install -m 0644 deploy/aws/arc-cert-sync.service deploy/aws/arc-cert-sync.timer \
  deploy/aws/arc-os-patch.service deploy/aws/arc-os-patch.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now arc-cert-sync.timer arc-os-patch.timer

# Docker Compose v2+ builds through buildx >= 0.17; Amazon Linux's docker package does not ship it.
BUILDX_VERSION=v0.38.1
BUILDX_SHA256=3b83b3731916ba433feccaaa689fe5bcdc81c641d92c8e6c2ea865dfa141c97a
if ! docker buildx version 2>/dev/null | grep -q "$BUILDX_VERSION"; then
  log "installing docker buildx $BUILDX_VERSION"
  install -d /usr/local/lib/docker/cli-plugins
  curl -fsSL -o /usr/local/lib/docker/cli-plugins/docker-buildx.new \
    "https://github.com/docker/buildx/releases/download/$BUILDX_VERSION/buildx-$BUILDX_VERSION.linux-arm64"
  echo "$BUILDX_SHA256  /usr/local/lib/docker/cli-plugins/docker-buildx.new" | sha256sum -c -
  chmod 0755 /usr/local/lib/docker/cli-plugins/docker-buildx.new
  mv -f /usr/local/lib/docker/cli-plugins/docker-buildx.new /usr/local/lib/docker/cli-plugins/docker-buildx
fi

umask 077
python3 "$APP_DIR/deploy/aws/write-env.py"

COMPOSE=(docker compose -f "$APP_DIR/deploy/aws/docker-compose.yml")
install -d -m 0755 "$DATA/caddy"
"${COMPOSE[@]}" build --pull
"${COMPOSE[@]}" up -d caddy
/usr/local/bin/arc-cert-sync --wait 900 --no-restart

log "running database migrations"
"${COMPOSE[@]}" run --rm --no-deps api node apps/api/dist/db/migrate.js

"${COMPOSE[@]}" up -d --remove-orphans
for _ in $(seq 1 60); do
  if curl -fsS --max-time 5 "https://$API_HOST/health/ready" >/dev/null; then
    log "healthy: https://$API_HOST"
    docker image prune -f >/dev/null
    exit 0
  fi
  sleep 5
done
log "API did not become healthy; recent logs:"
"${COMPOSE[@]}" ps
"${COMPOSE[@]}" logs --tail 80 api emqx worker caddy || true
exit 1
