#!/usr/bin/env bash
# Makes a TLS certificate for the broker's public Railway address and prints the three
# variables to paste into the Railway "emqx" service (Variables -> Raw Editor).
#
#   bash infra/scripts/railway-cert-vars.sh xxxx.proxy.rlwy.net
#
# Devices verify the broker with infra/certs/out/ca.crt (paste it into the ESP32 config.h).
set -euo pipefail
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/../.."
DOMAIN="${1:?usage: railway-cert-vars.sh <tcp-proxy-domain, e.g. xxxx.proxy.rlwy.net>}"
HOST_DNS="$DOMAIN" bash infra/certs/gen-dev-certs.sh >/dev/null
b64() { base64 < "$1" | tr -d '\n'; }
echo
echo "# Paste these into Railway -> emqx -> Variables -> Raw Editor:"
echo "MQTT_TLS_CA_B64=$(b64 infra/certs/out/ca.crt)"
echo "MQTT_TLS_CERT_B64=$(b64 infra/certs/out/server.crt)"
echo "MQTT_TLS_KEY_B64=$(b64 infra/certs/out/server.key)"
echo
echo "# Certificate is valid for: $DOMAIN (and localhost)"
