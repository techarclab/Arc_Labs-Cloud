#!/bin/bash
# Removes what tests/stack/up.sh created (containers, volumes, images' data, /etc/arc-cloud, /opt/arc-cloud-data).
set -euo pipefail
[ "$(id -u)" -eq 0 ] || exec sudo -E bash "$0" "$@"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
if [ -f /etc/arc-cloud/config ] && ! grep -q '\.arc\.test$' /etc/arc-cloud/config; then
  echo "[stack-down] /etc/arc-cloud/config is not a test config: refusing to delete anything" >&2
  exit 1
fi
export ACME_EMAIL=x API_HOST=x MQTT_HOST=x CONSOLE_HOST=x ARC_CI_CADDYFILE=/dev/null
docker compose -f "$ROOT/deploy/oracle/docker-compose.yml" -f "$ROOT/tests/stack/compose.ci.yml" down -v --remove-orphans || true
rm -rf /etc/arc-cloud /opt/arc-cloud-data /usr/local/bin/arc-cert-sync
sed -i '/ api\.arc\.test /d' /etc/hosts
echo "[stack-down] removed"
