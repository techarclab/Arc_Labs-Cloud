#!/usr/bin/env bash
# One-time local setup: random secrets in .env + dev TLS certificates.
set -euo pipefail
cd "$(dirname "$0")/../.."

rand() { openssl rand -base64 48 | tr -d '/+=\n' | cut -c1-"$1"; }

if [ -f .env ]; then
  echo ".env already exists — leaving it unchanged"
else
  sed -e "s|__JWT_SECRET__|$(rand 48)|" \
      -e "s|__INTERNAL_HOOK_TOKEN__|$(rand 40)|" \
      -e "s|__MQTT_SERVICE_PASSWORD__|$(rand 32)|" \
      -e "s|__POSTGRES_PASSWORD__|$(rand 24)|" \
      -e "s|__EMQX_API_SECRET__|$(rand 40)|" \
      .env.example > .env
  echo "created .env with random secrets"
fi

bash infra/certs/gen-dev-certs.sh
echo
echo "Next: docker compose up -d --build"
