# Staging environment

Keep **local** (Docker on your laptop), **staging** and **production** separate, each with its own database and secrets.

## Create staging on Railway (once)

```bash
cd /c/arc-cloud
.railway-cli/node_modules/.bin/railway link -p <project-id>
.railway-cli/node_modules/.bin/railway environment new staging --duplicate production
```

Then in Railway, switch the environment selector (top bar) to **staging** and:

1. **Project Settings → Shared Variables (staging):** give staging its **own** `JWT_SECRET`, `INTERNAL_HOOK_TOKEN` and `MQTT_SERVICE_PASSWORD` (`openssl rand -hex 32` each). Never share secrets between environments.
2. **Postgres (staging)** is a separate database; it starts empty.
3. **api → Networking:** generate a domain; set `CORS_ORIGINS` to the staging console address.
4. **emqx → Networking → TCP Proxy 8883:** staging gets its own proxy address; run `bash infra/scripts/railway-cert-vars.sh <staging-proxy-domain>` and paste the three variables into staging `emqx`.
5. **Source:** api/emqx/worker → Settings → Source → Branch: `staging`. Production stays on `main`.

## Console for staging
Vercel creates a *Preview* deployment for every branch. In Vercel → Settings → Environment Variables, give `VITE_API_URL` a **Preview** value pointing at the staging API.

## Flow
1. Work on a branch → push → CI runs.
2. Merge into `staging` → Railway staging + Vercel preview update → test with a test device.
3. Merge `staging` into `main` → production.
