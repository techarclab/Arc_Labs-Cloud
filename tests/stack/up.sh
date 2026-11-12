#!/bin/bash
# Boots the PRODUCTION stack on a throwaway machine (GitHub Actions runner), following deploy/oracle/arc-deploy.sh
# step by step: the same compose file, Dockerfiles, EMQX config (infra/emqx/base.hocon.tpl), env writer
# (deploy/oracle/write-env.py) and certificate hand-over (deploy/aws/arc-cert-sync.sh).
#
#   bash tests/stack/up.sh        (needs root or sudo, Docker, ports 80/443/8883 free)
#   bash tests/stack/down.sh      (removes everything it created)
#
# The ONLY differences from the Oracle VM, all because a CI runner has no public DNS name:
#   - Caddy issues certificates from its own CA (`local_certs`) instead of Let's Encrypt. The MQTT listener still
#     gets its certificate from Caddy through arc-cert-sync, exactly as in production.
#   - Host names *.arc.test point to 127.0.0.1 in /etc/hosts.
#   - No git checkout, systemd timers or backups (they are not part of the request path).
# NEVER run this on the production server: it writes /etc/arc-cloud and /opt/arc-cloud-data.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || exec sudo -E bash "$0" "$@"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/tests/stack/out"
DATA=/opt/arc-cloud-data
CONF=/etc/arc-cloud
log() { echo "[stack-up] $*"; }

if [ -f "$CONF/config" ] && ! grep -q '\.arc\.test$' "$CONF/config"; then
  echo "[stack-up] $CONF/config exists and is not a test config: refusing to run on what looks like a real server" >&2
  exit 1
fi

export ACME_EMAIL=ci@example.invalid API_HOST=api.arc.test MQTT_HOST=mqtt.arc.test CONSOLE_HOST=console.arc.test
grep -q ' api\.arc\.test' /etc/hosts || echo "127.0.0.1 $API_HOST $MQTT_HOST $CONSOLE_HOST" >> /etc/hosts

install -d -m 0700 "$CONF"
printf 'ACME_EMAIL=%s\nAPI_HOST=%s\nMQTT_HOST=%s\nCONSOLE_HOST=%s\n' "$ACME_EMAIL" "$API_HOST" "$MQTT_HOST" "$CONSOLE_HOST" > "$CONF/config"
# Operator settings as on the VM (extra.env), minus email: the worker has no SMTP here, tests confirm accounts in SQL.
printf 'ALLOW_SIGNUP=true\nPLATFORM_ADMIN_EMAILS=platform-admin@arc.test\nORGS_PER_USER=1\n' > "$CONF/extra.env"

# --- arc-deploy, step 2 onwards -------------------------------------------------------------------------------
install -m 0755 "$ROOT/deploy/aws/arc-cert-sync.sh" /usr/local/bin/arc-cert-sync
(umask 077; python3 "$ROOT/deploy/oracle/write-env.py")
install -d -m 0755 "$DATA/caddy" "$DATA/firmware"
install -d -m 0700 "$DATA/backups"
install -d -m 0700 -o 999 -g 999 "$DATA/postgres"

# The production Caddyfile with Let's Encrypt swapped for Caddy's internal CA. Everything else (sites, routes,
# headers, key type) is byte-for-byte the production file.
mkdir -p "$OUT"
sed -E 's#^([[:space:]]*)acme_ca .*#\1local_certs#' "$ROOT/deploy/oracle/Caddyfile" > "$OUT/Caddyfile"
grep -q 'local_certs' "$OUT/Caddyfile" || { echo "[stack-up] could not switch the Caddyfile to local_certs" >&2; exit 1; }
diff "$ROOT/deploy/oracle/Caddyfile" "$OUT/Caddyfile" > "$OUT/Caddyfile.diff" || true
export ARC_CI_CADDYFILE="$OUT/Caddyfile"

COMPOSE=(docker compose -f "$ROOT/deploy/oracle/docker-compose.yml" -f "$ROOT/tests/stack/compose.ci.yml")
log "building images"
"${COMPOSE[@]}" build
"${COMPOSE[@]}" up -d postgres caddy console
for _ in $(seq 1 60); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' arc-cloud-postgres-1 2>/dev/null)" = healthy ] && break
  sleep 2
done
[ "$(docker inspect -f '{{.State.Health.Status}}' arc-cloud-postgres-1 2>/dev/null)" = healthy ] \
  || { log "PostgreSQL did not become healthy"; "${COMPOSE[@]}" logs --tail 60 postgres; exit 1; }
/usr/local/bin/arc-cert-sync --wait 180 --no-restart
log "running database migrations"
"${COMPOSE[@]}" run --rm --no-deps api node apps/api/dist/db/migrate.js
"${COMPOSE[@]}" up -d --remove-orphans

# Caddy's root certificate: the tests trust it the way devices trust ISRG Root X1 in production.
cp "$DATA/caddy/caddy/pki/authorities/local/root.crt" "$OUT/ca.crt"
chmod 0644 "$OUT/ca.crt"
[ -n "${SUDO_USER:-}" ] && chown -R "$SUDO_USER" "$OUT"   # the test runner (not root) writes its results here

for _ in $(seq 1 60); do
  if curl -fsS --max-time 5 --cacert "$OUT/ca.crt" "https://$API_HOST/health/deep" 2>/dev/null | grep -q '"status":"ok"' \
     && curl -fsS --max-time 5 --cacert "$OUT/ca.crt" -o /dev/null "https://$CONSOLE_HOST/"; then
    log "healthy: https://$CONSOLE_HOST, https://$API_HOST (database + broker), mqtts://$MQTT_HOST:8883"
    "${COMPOSE[@]}" ps
    exit 0
  fi
  sleep 5
done
log "not healthy: $(curl -sS --max-time 5 --cacert "$OUT/ca.crt" "https://$API_HOST/health/deep" 2>&1 || true)"
"${COMPOSE[@]}" ps
"${COMPOSE[@]}" logs --tail 80 api emqx worker caddy postgres || true
exit 1
