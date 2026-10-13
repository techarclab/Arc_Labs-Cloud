# Deploying ARC Cloud: GitHub → Railway (backend) + Vercel (console)

```
ESP32 ──MQTT/TLS──▶ Railway "emqx" (TCP proxy, e.g. xxxx.proxy.rlwy.net:12345)
ESP32 ──HTTPS─────▶ Railway "api"  (https://api-xxxx.up.railway.app/api/v1/update)
Browser ──HTTPS───▶ Vercel console (https://arc-cloud.vercel.app) ──▶ Railway "api"
                    Railway private network: api ⇄ emqx ⇄ worker ⇄ Postgres
```

Vercel only hosts the web console. The broker, API, ingestion worker and database run on Railway,
because they need long-running processes and an open TCP port for MQTT.

Expect about 30–45 minutes the first time. Do the steps in order.

---

## 1. Push the code to GitHub

1. On github.com, click **New repository**. Name it `arc-cloud`, choose **Private**, and **don't** add a README, .gitignore or licence.
2. In Git Bash:

```bash
cd /c/arc-cloud
git init -b main
git add .
git commit -m "ARC Cloud"
git remote add origin https://github.com/YOUR-USERNAME/arc-cloud.git
git push -u origin main
```

Git opens a browser window to sign in to GitHub the first time.

Check before pushing: `git status` must **not** list `.env`, `device*.json` or anything in `infra/certs/out/`. They're in `.gitignore` because they contain secrets.

---

## 2. Railway: backend

Sign in at railway.com with GitHub. The Hobby plan is enough to start.

### 2.1 Project, database and secrets

1. **New Project → Deploy from GitHub repo →** pick `arc-cloud`. Railway creates a service from the repo. Open it, go to **Settings**, and rename it to **`api`**. The name matters, because the other services find it as `api.railway.internal`.
2. In the project, **Create → Database → PostgreSQL**. Keep the name `Postgres`.
3. **Project Settings → Shared Variables**. Add three secrets. Make each one with `openssl rand -hex 32` in Git Bash:

```
JWT_SECRET=<random>
INTERNAL_HOOK_TOKEN=<random>
MQTT_SERVICE_PASSWORD=<random>
```

### 2.2 `api` service

**Variables → Raw Editor**, paste:

```
DATABASE_URL=${{Postgres.DATABASE_URL}}
RUN_MIGRATIONS=true
PORT=3000
JWT_SECRET=${{shared.JWT_SECRET}}
INTERNAL_HOOK_TOKEN=${{shared.INTERNAL_HOOK_TOKEN}}
MQTT_SERVICE_PASSWORD=${{shared.MQTT_SERVICE_PASSWORD}}
MQTT_URL=mqtt://emqx.railway.internal:1883
MQTT_PUBLIC_HOST=${{emqx.RAILWAY_TCP_PROXY_DOMAIN}}
MQTT_PUBLIC_PORT=${{emqx.RAILWAY_TCP_PROXY_PORT}}
HTTP_PUBLIC_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}
CORS_ORIGINS=https://CHANGE-ME.vercel.app
ALLOW_SIGNUP=true
```

**Settings:**
- **Networking → Generate Domain**, port **3000**. Note the URL, for example `https://arc-cloud-api.up.railway.app`.
- **Deploy → Healthcheck Path:** `/health/ready`

The API creates the database tables itself on first start.

### 2.3 `emqx` service (MQTT broker)

1. **Create → GitHub Repo →** `arc-cloud` again. Rename the new service to **`emqx`**.
2. **Variables → Raw Editor:**

```
RAILWAY_DOCKERFILE_PATH=Dockerfile.emqx
INTERNAL_HOOK_TOKEN=${{shared.INTERNAL_HOOK_TOKEN}}
API_HOOKS_URL=http://api.railway.internal:3001
EMQX_DASHBOARD__DEFAULT_PASSWORD=<another random value>
```

3. **Settings → Networking → TCP Proxy**, port **8883**. Railway shows an address like `xxxx.proxy.rlwy.net:12345`. Write down the domain and the port.
4. Make the broker's TLS certificate for that domain. In Git Bash on your laptop:

```bash
cd /c/arc-cloud
bash infra/scripts/railway-cert-vars.sh xxxx.proxy.rlwy.net
```

   Paste the three printed lines (`MQTT_TLS_CA_B64=…`, `MQTT_TLS_CERT_B64=…`, `MQTT_TLS_KEY_B64=…`) into the `emqx` service's **Variables → Raw Editor**, then **Deploy**.

   The first `emqx` deploy fails with "no TLS certificate" until these are set. That's expected.

Don't add a public HTTP domain to `emqx`. Its dashboard should stay private.

### 2.4 `worker` service (ingestion)

1. **Create → GitHub Repo →** `arc-cloud` again. Rename it to **`worker`**.
2. **Variables → Raw Editor:**

```
ARC_ROLE=worker
DATABASE_URL=${{Postgres.DATABASE_URL}}
MQTT_URL=mqtt://emqx.railway.internal:1883
MQTT_SERVICE_PASSWORD=${{shared.MQTT_SERVICE_PASSWORD}}
WORKER_ID=ingest-1
```

No domain is needed.

### 2.5 Check

- `https://<api-domain>/health/ready` returns `{"status":"ok"}`.
- `worker` logs show `connected to broker` and `subscribed`.
- `emqx` logs show `TLS certificates loaded from environment` and `broker hooks -> http://api.railway.internal:3001`.

---

## 3. Vercel: web console

1. On vercel.com: **Add New → Project →** import `arc-cloud` from GitHub.
2. **Root Directory:** leave it as the repository root. The `vercel.json` at the top of the repo builds only the console (`apps/console`) and serves it. (Setting Root Directory to `apps/console` also works.)
3. **Environment Variables:** `VITE_API_URL` = your Railway API URL from step 2.2, for example `https://arc-cloud-api.up.railway.app`, with no trailing slash.
4. **Deploy.** Note the site URL, for example `https://arc-cloud.vercel.app`.
5. Back in Railway, set the `api` variable `CORS_ORIGINS` to that exact URL and redeploy `api`. To allow more than one address (such as a custom domain), separate them with commas.

---

### If the Vercel build fails with `tsc: command not found` in `apps/api`

Vercel built an old commit, or ran an install that skipped dev tools. Check:
- **Deployments:** the failing deployment's commit must be the newest one on GitHub. "Redeploy" on an old deployment rebuilds that old commit, so push a new commit instead.
- **Settings → Build and Deployment:** turn off the Build, Install and Output overrides, and set **Root Directory** to the repository root (empty).
- **Settings → Environment Variables:** delete `NODE_ENV` if it's there.

### Alert emails (optional)

Alerts always appear in the console and go to your webhooks. To also send emails, give the `worker` an SMTP server:

```
SMTP_URL=smtps://USER:APP_PASSWORD@smtp.gmail.com:465
MAIL_FROM=ARC Cloud <you@gmail.com>
```

With Gmail, turn on 2-step verification and create an **App password** (Google Account → Security → App passwords); use that, not your normal password. Any provider works (Brevo, SendGrid, Zoho, Amazon SES) using its SMTP address. Set it in Railway → `worker` → Variables, or run `SMTP_URL='smtps://…' bash tools/railway-deploy.sh`.

### ARC LABS admin

People whose emails are in `PLATFORM_ADMIN_EMAILS` on the `api` service (comma-separated; the deploy script sets `techarclab@gmail.com`) see **ARC LABS → All organizations** in the console: every customer organization, its usage, and its plan and limits. They can't see other organizations' devices or data.

## 4. Use it

1. Open the Vercel URL, create your account, then your organization and channel.
2. Once your team has accounts, set `ALLOW_SIGNUP=false` on the Railway `api` service.
3. Devices:
   - **HTTP (simplest):** the device's "HTTP API" tab shows the `https://…/api/v1/update?api_key=…` URL. In `firmware/esp32-arduino/arc_http`, set `SERVER` to `https://<api-domain>` and use `WiFiClientSecure` (or `setInsecure()` just for testing).
   - **MQTT:** the device file now points at the Railway TCP proxy. Test from your laptop with
     `npm run simulate -- --creds <file>.json --ca infra/certs/out/ca.crt`
     For an ESP32, paste `infra/certs/out/ca.crt` into `config.h`.

## Updating

Push to `main`. Railway and Vercel both redeploy automatically. Database changes in `infra/db/migrations` run when `api` starts.

## Notes

- **Costs and plans:** Railway charges for usage on top of its plan. Vercel's free Hobby plan is for personal, non-commercial projects, so a commercial ARC LABS product needs Vercel Pro. Check both pricing pages for current terms.
- **Database:** Railway's PostgreSQL doesn't include TimescaleDB. ARC Cloud works without it and uses a plain table, which is fine for early volumes. See `docs/aws/deployment.md` when you outgrow it.
- **Backups:** turn on Railway's Postgres backups before storing customer data.
- **Certificate:** valid for about 2 years. To change the broker address, re-run `railway-cert-vars.sh`. The CA stays the same, so devices keep working.
