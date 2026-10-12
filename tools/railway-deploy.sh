#!/usr/bin/env bash
# One-command Railway setup for ARC Cloud (API + MQTT broker + ingestion worker).
#
#   cd /c/arc-cloud
#   bash tools/railway-deploy.sh
#
# It signs you in to Railway (browser), links the project, removes the services Railway
# auto-created from the monorepo, then creates "api", "emqx" and "worker" with all their
# settings. Safe to run again: existing services are updated, not duplicated.
set -uo pipefail
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/.."

PROJECT_ID="${RAILWAY_PROJECT_ID:-41619fd2-2193-4924-8628-0ea60750a7d7}"
ENVIRONMENT="${RAILWAY_ENVIRONMENT:-production}"
REPO="${GITHUB_REPO:-techarclab/Arc_Labs-Cloud}"
CONSOLE_URL="${CONSOLE_URL:-https://arc-labs-cloud.vercel.app}"
CLI_VERSION="5.64.2"

say()  { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
ok()   { printf '   \033[32mOK\033[0m %s\n' "$*"; }
warn() { printf '   \033[33m!!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31mStopped: %s\033[0m\n' "$*"; exit 1; }

command -v node >/dev/null || die "Node.js is not installed."
CLI_DIR="$HOME/.arc-railway-cli"
if [ ! -x "$CLI_DIR/node_modules/.bin/railway" ]; then
  echo "Installing the Railway command-line tool (one time)..."
  npm install --prefix "$CLI_DIR" "@railway/cli@$CLI_VERSION" --no-audit --no-fund >/dev/null 2>&1 \
    || die "couldn't install @railway/cli (check your internet connection)"
fi
R() { "$CLI_DIR/node_modules/.bin/railway" "$@"; }

cat <<INFO
This sets up ARC Cloud's backend in your Railway project:
  - deletes the 4 broken services Railway auto-created (@arc/console, @arc/api,
    @arc/ingestion-worker, @arc/device-simulator)
  - creates "api", "emqx" and "worker" from GitHub repo $REPO, with their variables
  - gives the API a public web address and the broker a public MQTT address
Postgres and its data are not touched.
INFO
read -r -p "Continue? [y/N] " ans; [[ "$ans" =~ ^[Yy] ]] || die "nothing changed."

say "1/7  Railway sign-in"
if R whoami >/dev/null 2>&1; then ok "already signed in as $(R whoami 2>/dev/null | tail -1)"
else
  echo "   A browser window opens. Approve the sign-in there, then come back here."
  R login || die "Railway sign-in didn't finish. Run the script again."
fi

say "2/7  Linking project $PROJECT_ID ($ENVIRONMENT)"
R link -p "$PROJECT_ID" -e "$ENVIRONMENT" >/dev/null || die "Couldn't link the project. Is it the right Railway account?"
ok "linked"

services_json() { R service list --json 2>/dev/null || echo '[]'; }
has_service() { services_json | grep -qF "\"$1\""; }

say "3/7  Removing the services Railway auto-created from the monorepo"
for s in "@arc/console" "@arc/device-simulator" "@arc/api" "@arc/ingestion-worker"; do
  if has_service "$s"; then
    R service delete --service "$s" --yes >/dev/null 2>&1 && ok "deleted $s" || {
      warn "couldn't delete $s automatically (2-factor?). Delete it in the dashboard: card -> Settings -> Delete service."
    }
  fi
done

say "4/7  Secrets"
VARS_FILE=railway-variables.txt
get_secret() { [ -f "$VARS_FILE" ] && grep -m1 "^$1=" "$VARS_FILE" | cut -d= -f2-; }
rnd() { node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))'; }
JWT_SECRET="$(get_secret JWT_SECRET)";                 JWT_SECRET="${JWT_SECRET:-$(rnd)}"
INTERNAL_HOOK_TOKEN="$(get_secret INTERNAL_HOOK_TOKEN)"; INTERNAL_HOOK_TOKEN="${INTERNAL_HOOK_TOKEN:-$(rnd)}"
MQTT_SERVICE_PASSWORD="$(get_secret MQTT_SERVICE_PASSWORD)"; MQTT_SERVICE_PASSWORD="${MQTT_SERVICE_PASSWORD:-$(rnd)}"
EMQX_DASH="$(get_secret EMQX_DASHBOARD__DEFAULT_PASSWORD)"; EMQX_DASH="${EMQX_DASH:-$(rnd | cut -c1-24)}"
ok "ready (kept in $VARS_FILE, which git ignores)"

# create_or_update <service> KEY=VALUE...
create_or_update() {
  local svc="$1"; shift
  if has_service "$svc"; then
    R variable set --service "$svc" --skip-deploys "$@" >/dev/null || die "couldn't set variables on $svc"
    ok "$svc exists: variables updated"
  else
    local args=(); for kv in "$@"; do args+=(--variables "$kv"); done
    R add --service "$svc" --repo "$REPO" --branch main "${args[@]}" >/dev/null \
      || die "couldn't create $svc. Check Railway has access to the GitHub repo $REPO."
    ok "$svc created from $REPO"
  fi
}

say "5/7  API service"
create_or_update api \
  'DATABASE_URL=${{Postgres.DATABASE_URL}}' \
  RUN_MIGRATIONS=true PORT=3000 \
  "JWT_SECRET=$JWT_SECRET" \
  "INTERNAL_HOOK_TOKEN=$INTERNAL_HOOK_TOKEN" \
  "MQTT_SERVICE_PASSWORD=$MQTT_SERVICE_PASSWORD" \
  MQTT_URL=mqtt://emqx.railway.internal:1883 \
  'HTTP_PUBLIC_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}' \
  "CORS_ORIGINS=$CONSOLE_URL" \
  ALLOW_SIGNUP=true
R environment edit --service-config api deploy.healthcheckPath /health/ready >/dev/null 2>&1 \
  && ok "health check: /health/ready" || warn "set Healthcheck Path /health/ready in api -> Settings -> Deploy"
API_DOMAIN="$(R domain list --service api 2>/dev/null | grep -oE '[a-z0-9.-]+\.up\.railway\.app' | head -1)"
if [ -z "$API_DOMAIN" ]; then
  API_DOMAIN="$(R domain --service api --port 3000 2>&1 | grep -oE '[a-z0-9.-]+\.up\.railway\.app' | head -1)"
fi
[ -n "$API_DOMAIN" ] && ok "public address: https://$API_DOMAIN" || warn "add a domain in api -> Settings -> Networking -> Generate Domain (port 3000)"

say "6/7  MQTT broker (emqx)"
create_or_update emqx \
  RAILWAY_DOCKERFILE_PATH=Dockerfile.emqx \
  "INTERNAL_HOOK_TOKEN=$INTERNAL_HOOK_TOKEN" \
  API_HOOKS_URL=http://api.railway.internal:3001 \
  "EMQX_DASHBOARD__DEFAULT_PASSWORD=$EMQX_DASH"
PROXY="$(R tcp-proxy list --service emqx --json 2>/dev/null)"
if ! grep -q 'proxy.rlwy.net' <<<"$PROXY"; then
  R tcp-proxy create --port 8883 --service emqx --json >/dev/null 2>&1 || true
  sleep 3; PROXY="$(R tcp-proxy list --service emqx --json 2>/dev/null)"
fi
MQTT_HOST="$(grep -oE '[a-z0-9.-]+\.proxy\.rlwy\.net' <<<"$PROXY" | head -1)"
MQTT_PORT="$(node -e 'let s=process.argv[1];let m=s.match(/"(?:proxyPort|port)"\s*:\s*(\d{4,5})/g)||[];const p=m.map(x=>+x.match(/(\d+)$/)[1]).find(n=>n!==8883);console.log(p||"")' "$PROXY")"
if [ -n "$MQTT_HOST" ]; then
  ok "devices connect to $MQTT_HOST:${MQTT_PORT:-?}"
  CERTS="$(bash infra/scripts/railway-cert-vars.sh "$MQTT_HOST" | grep '^MQTT_TLS_')"
  # shellcheck disable=SC2046
  R variable set --service emqx --skip-deploys $(echo "$CERTS") >/dev/null && ok "TLS certificate for $MQTT_HOST installed" \
    || warn "couldn't set the certificate; run: bash infra/scripts/railway-cert-vars.sh $MQTT_HOST"
  R variable set --service api --skip-deploys \
    'MQTT_PUBLIC_HOST=${{emqx.RAILWAY_TCP_PROXY_DOMAIN}}' 'MQTT_PUBLIC_PORT=${{emqx.RAILWAY_TCP_PROXY_PORT}}' >/dev/null \
    && ok "API tells devices to use the broker's public address"
else
  warn "no TCP proxy yet: emqx -> Settings -> Networking -> TCP Proxy, port 8883; then run this script again"
fi

say "7/7  Ingestion worker"
create_or_update worker \
  ARC_ROLE=worker \
  'DATABASE_URL=${{Postgres.DATABASE_URL}}' \
  MQTT_URL=mqtt://emqx.railway.internal:1883 \
  "MQTT_SERVICE_PASSWORD=$MQTT_SERVICE_PASSWORD" \
  WORKER_ID=ingest-1

say "Deploying"
for s in api emqx worker; do
  R redeploy --service "$s" --from-source --yes >/dev/null 2>&1 && ok "$s deploying" || ok "$s will deploy from its latest commit"
done

cat <<EOF

=====================================================================
 Done. Builds take 3-6 minutes. Watch them at:
   https://railway.com/project/$PROJECT_ID

 When "api" is green, open:
   https://${API_DOMAIN:-<api-domain>}/health/ready      -> {"status":"ok"}

 Last step, in Vercel (Settings -> Environment Variables):
   VITE_API_URL = https://${API_DOMAIN:-<api-domain>}
 then Deployments -> Redeploy. Sign-up on $CONSOLE_URL will then work.
=====================================================================
EOF
