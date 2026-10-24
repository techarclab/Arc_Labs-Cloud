#!/bin/sh
# Starts EMQX with ARC Cloud's config.
#   INTERNAL_HOOK_TOKEN  (required) shared secret for the API's /internal/mqtt hooks
#   API_HOOKS_URL        API hook base URL (default http://api:3001; on Railway http://api.railway.internal:3001)
#   MQTT_TLS_CA_B64, MQTT_TLS_CERT_B64, MQTT_TLS_KEY_B64
#                        base64 PEMs for the device TLS listener. When not set, certificates mounted at
#                        /opt/emqx/etc/certs/arc are used (docker-compose mounts infra/certs/out there).
#   ARC_EMQX_API_KEY, ARC_EMQX_API_SECRET
#                        optional: management API key the ARC API uses to disconnect revoked devices at once
#                        (DELETE /api/v5/clients/{id}). Loaded through EMQX's api_key.bootstrap_file. Letters,
#                        digits, '-' and '_' only. To rotate, change BOTH the key name and the secret: EMQX keeps
#                        keys it already imported in its data volume.
#                        NOT named EMQX_*: EMQX reads every EMQX_<PATH> environment variable as a config
#                        override, so EMQX_API_KEY=arc-api would mean `api_key = "arc-api"` and EMQX would refuse
#                        to start. The old names are still accepted here and removed before EMQX starts.
set -eu

: "${INTERNAL_HOOK_TOKEN:?INTERNAL_HOOK_TOKEN must be set}"
API_HOOKS_URL="${API_HOOKS_URL:-http://api:3001}"
CERTS=/opt/emqx/etc/certs/arc

if [ -n "${MQTT_TLS_CERT_B64:-}" ] && [ -n "${MQTT_TLS_KEY_B64:-}" ]; then
  mkdir -p "$CERTS"
  echo "$MQTT_TLS_CERT_B64" | base64 -d > "$CERTS/server.crt"
  echo "$MQTT_TLS_KEY_B64" | base64 -d > "$CERTS/server.key"
  echo "${MQTT_TLS_CA_B64:-$MQTT_TLS_CERT_B64}" | base64 -d > "$CERTS/ca.crt"
  chmod 600 "$CERTS/server.key"
  echo "[arc] TLS certificates loaded from environment"
fi

if [ ! -f "$CERTS/server.crt" ]; then
  echo "[arc] ERROR: no TLS certificate. Set MQTT_TLS_*_B64 (see docs/deploy/railway-vercel.md) or mount infra/certs/out." >&2
  exit 1
fi

sed -e "s|__INTERNAL_HOOK_TOKEN__|${INTERNAL_HOOK_TOKEN}|g" -e "s|__API_HOOKS_URL__|${API_HOOKS_URL}|g" \
  /arc/base.hocon.tpl > /opt/emqx/etc/base.hocon
echo "[arc] broker hooks -> ${API_HOOKS_URL}"

API_KEY="${ARC_EMQX_API_KEY:-${EMQX_API_KEY:-}}"
API_SECRET="${ARC_EMQX_API_SECRET:-${EMQX_API_SECRET:-}}"
unset EMQX_API_KEY EMQX_API_SECRET ARC_EMQX_API_KEY ARC_EMQX_API_SECRET
if [ -n "$API_KEY" ] && [ -n "$API_SECRET" ]; then
  case "${API_KEY}${API_SECRET}" in
    *[!A-Za-z0-9_-]*) echo "[arc] ERROR: ARC_EMQX_API_KEY/ARC_EMQX_API_SECRET may only contain letters, digits, '-' and '_'" >&2; exit 1 ;;
  esac
  if [ "${#API_SECRET}" -lt 32 ]; then echo "[arc] ERROR: ARC_EMQX_API_SECRET must be at least 32 characters" >&2; exit 1; fi
  (
    umask 077
    printf '%s:%s:administrator\n' "$API_KEY" "$API_SECRET" > /opt/emqx/etc/arc-api-keys
  )
  printf '\napi_key.bootstrap_file = "/opt/emqx/etc/arc-api-keys"\n' >> /opt/emqx/etc/base.hocon
  echo "[arc] management API key '${API_KEY}' provisioned (keep port 18083 on the private network)"
fi
unset API_SECRET

exec /usr/bin/docker-entrypoint.sh /opt/emqx/bin/emqx foreground
