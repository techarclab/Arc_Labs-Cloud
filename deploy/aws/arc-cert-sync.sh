#!/bin/bash
# Hands Caddy's Let's Encrypt certificate for MQTT_HOST to EMQX (port 8883) and restarts EMQX when it changes.
# Caddy renews ~30 days before expiry; the daily timer picks the new file up (devices reconnect once per renewal).
#   arc-cert-sync [--wait SECONDS] [--no-restart]
set -euo pipefail
# shellcheck source=/dev/null
. /etc/arc-cloud/config

WAIT=0
RESTART=1
while [ $# -gt 0 ]; do
  case "$1" in
    --wait) WAIT="$2"; shift 2 ;;
    --no-restart) RESTART=0; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done

STORE=/opt/arc-cloud-data/caddy/caddy/certificates
DST=/opt/arc-cloud-data/mqtt-tls
deadline=$((SECONDS + WAIT))
# Caddy creates $STORE only after its first certificate. Under `set -o pipefail` a failing find (missing
# directory) would abort the script silently inside the command substitution, so treat it as "not yet".
find_cert() {
  [ -d "$STORE" ] || return 0
  find "$STORE" -path "*/$MQTT_HOST/$MQTT_HOST.crt" 2>/dev/null | head -n1 || true
}

CRT="$(find_cert)"
until [ -n "$CRT" ] && [ -s "$CRT" ] && [ -s "${CRT%.crt}.key" ]; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "[arc-cert-sync] no certificate for $MQTT_HOST yet. Check that $MQTT_HOST resolves to this server and port 80 is open; see: docker logs arc-cloud-caddy-1" >&2
    exit 1
  fi
  sleep 5
  CRT="$(find_cert)"
done
KEY="${CRT%.crt}.key"

if [ -f "$DST/server.crt" ] && cmp -s "$CRT" "$DST/server.crt"; then
  exit 0
fi

# EMQX runs as an unprivileged user inside its image: give that uid read access to the key, nobody else.
EMQX_UID="$(docker run --rm --entrypoint id arc-cloud-emqx -u 2>/dev/null || echo 1000)"
EMQX_GID="$(docker run --rm --entrypoint id arc-cloud-emqx -g 2>/dev/null || echo 1000)"
install -d -m 0750 -o "$EMQX_UID" -g "$EMQX_GID" "$DST"
install -m 0644 -o "$EMQX_UID" -g "$EMQX_GID" "$CRT" "$DST/server.crt.new"
install -m 0644 -o "$EMQX_UID" -g "$EMQX_GID" "$CRT" "$DST/ca.crt.new"
install -m 0600 -o "$EMQX_UID" -g "$EMQX_GID" "$KEY" "$DST/server.key.new"
mv -f "$DST/server.key.new" "$DST/server.key"
mv -f "$DST/server.crt.new" "$DST/server.crt"
mv -f "$DST/ca.crt.new" "$DST/ca.crt"
echo "[arc-cert-sync] installed new certificate for $MQTT_HOST: $(openssl x509 -in "$DST/server.crt" -noout -enddate 2>/dev/null || true)"

if [ "$RESTART" -eq 1 ] && [ -n "$(docker ps -q --filter 'name=^arc-cloud-emqx-1$')" ]; then
  docker restart arc-cloud-emqx-1 >/dev/null
  echo "[arc-cert-sync] restarted EMQX"
fi
