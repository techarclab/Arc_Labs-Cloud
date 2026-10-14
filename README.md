# ARC Cloud

Multi-tenant IoT platform from ARC LABS, built to the *ARC Cloud Complete Developer Design Plan* (phases 1–7): identity and tenancy, device registry and provisioning, MQTT-over-TLS and HTTP ingestion, telemetry storage, ThingSpeak/Blynk-style channels and dashboards, rules and alerts with email and webhooks, API keys, service accounts, ARC LMS integration, device commands with acknowledgement, signed OTA firmware rollouts, quotas, retention, backups and runbooks.

```
ESP32 / Pi / gateway ──MQTT over TLS :8883──▶ EMQX ──auth + ACL hooks──▶ API :3001 (private)
          └──────────HTTPS /api/v1/update────────────────────────────────▶ API :3000
                                               │
                                               └─ shared subscription ─▶ worker ──▶ PostgreSQL / TimescaleDB
                                                  (ingestion, rules, alerts, email/webhook delivery, commands, OTA, retention)
Web console / scripts / ARC LMS ──HTTPS REST :3000──▶ API
```

| Path | What it is |
|---|---|
| `apps/api` | NestJS REST API (`/api/v1`, OpenAPI at `/api/docs`): auth, organizations, roles, channels, devices, telemetry, rules & alerts, commands, firmware/OTA, API keys, service accounts (OAuth2), webhooks, ARC LMS, quotas, platform admin. Also the EMQX auth/ACL hooks on a private port. |
| `apps/ingestion-worker` | Ingests device messages; runs rules, alert notifications (email + signed webhooks with retries), command expiry, OTA rollout tracking and data retention. `/health/*`, `/metrics`. |
| `apps/console` | Web console (React + Vite). |
| `packages/shared` | Topic convention, payload schemas, ACL rules, rule evaluation, online/offline logic. |
| `infra/` | SQL migrations, EMQX config, TLS certs, backup/restore scripts. |
| `firmware/esp32-arduino` | `arc_hardware_test` (no-sensor test, see `docs/hardware-test.md`), `arc_http` (HTTPS) and `arc_device` (MQTT/TLS), with controls, commands and OTA. |
| `tools/` | Device simulator, firmware signing, Railway deploy and diagnostics, local dev helper. |
| `tests/` | `e2e` (60+ end-to-end checks), `load`, `ui/demo-stack.ts` (seeded demo for reviewing the console). |
| `docs/` | Device protocol, OpenAPI, architecture decisions, deployment (Railway/Vercel, staging, AWS), ARC LMS, runbooks, security review. |

### Console

| Screen | What it's for |
|---|---|
| Overview | Device counts by state, alerts needing attention, messages per hour, channel shortcuts |
| Alerts | Open/acknowledged/resolved alerts; acknowledge or resolve with a note; full history and notification status |
| Channel → Dashboard, Devices, Channel settings, API keys & export | Widgets, device fleet, fields, read key and CSV |
| Channel → Rules | Threshold (“above 30 °C for 5 min”), no-data and offline rules with severity, quiet period and emails |
| Channel → Commands | Allow-list of commands (with typed settings) devices in the channel accept |
| Device page | Readings, history, details, activity, **commands** (send, track to “Done”/“Expired”), access controls |
| Integrations (admins) | API keys & service accounts (scoped, expiring), webhooks (test, delivery log), ARC LMS lab links and learner preview |
| Firmware & OTA | Signing keys, signed releases, staged rollouts (widen, pause, cancel) with per-device progress |
| Usage & limits | Plan limits, messages per day, busiest devices, data retention |
| Team, Rejected data, Audit log | People and roles, why messages were dropped, every change |
| ARC LABS → All organizations | Platform admins (`PLATFORM_ADMIN_EMAILS`): every customer organization and its plan |
| `/lab#…` | Read-only learner view opened from ARC LMS |

## Deploying

GitHub → Railway (broker, API, worker, Postgres) + Vercel (console): see **[docs/deploy/railway-vercel.md](docs/deploy/railway-vercel.md)**. AWS: `docs/aws/deployment.md`.

## Quick start (Docker)

Requirements: Docker Desktop (or Docker Engine + Compose), OpenSSL, Node 22 (only for the simulator and tests).

```bash
bash infra/scripts/bootstrap.sh      # creates .env with random secrets + dev TLS certs
docker compose up -d --build
docker compose ps                    # wait until api, emqx and ingestion-worker are healthy
```

### Channels, fields and dashboards (ThingSpeak / Blynk style)

- A **channel** groups devices that send the same **fields** (field1…field16). Each field is either a **sensor** value devices send, or a **control** value you send to devices.
- Each channel has a **widget dashboard** with 25 widget types. Pick which device the dashboard shows at the top.
  - **Values:** value, value with trend, gauge, progress ring, tank level, thermometer, battery, bar meter, indicator light, status text, lowest/average/highest
  - **Charts:** time chart (line, area, steps or bars; up to 3 fields), histogram, scatter plot, heatmap (hour × day), data table, compare devices, map
  - **Controls:** switch, push button, slider, plus/minus, mode selector, number input, colour picker
  - **Other:** text note
- Devices send data over **MQTT** or a simple **HTTP API** (`/api/v1/update?api_key=KEY&field1=25`). Controls reach MQTT devices instantly and HTTP devices when they poll `/api/v1/controls`.
- Each channel has a **read key** for `feeds.json` / `feeds.csv`, and the console can download CSV.

ESP32 examples: `firmware/esp32-arduino/arc_device` (MQTT over TLS, receives controls) and `firmware/esp32-arduino/arc_http` (HTTP only, simplest).

### Open the web console

Go to **http://localhost:3002**, create your account, then set up your organization and first project. From there you can add devices (each gets its own password, shown once, with a ready-made `device.json` for the simulator and a `config.h` for the ESP32), watch them come online, and see live readings and charts.

| Screen | What it's for |
|---|---|
| Channel → Dashboard | Widgets for the selected device; switches and sliders send control values |
| Channel → Devices | Online / offline / not-seen-yet counts, a 30-minute heartbeat strip per device, latest readings |
| Device page | Last-hour heartbeat, reading tiles, chart (1h / 6h / 24h / 7d), details, recent activity, replace password, maintenance, suspend, revoke |
| Channel → Channel settings | Fields (number, label, firmware name, sensor/control, unit, min/max, decimals), name, description |
| Channel → API keys & export | Read key, example requests, CSV download |
| Team | Add people by email and set their role (Admin, Engineer, Viewer) |
| Rejected data | Messages that weren't saved, why, and how to fix the firmware |
| Audit log | Every change made in the organization (admins only) |

### Or use the API directly: register, create a project, provision a device

```bash
API=http://localhost:3000/api/v1

TOKEN=$(curl -s $API/auth/register -H 'content-type: application/json' \
  -d '{"email":"you@arclabs.in","displayName":"You","password":"a-long-password-123"}' | jq -r .accessToken)

ORG=$(curl -s $API/organizations -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"ARC LABS","slug":"arc-labs"}' | jq -r .id)

PROJECT=$(curl -s $API/projects -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"organizationId\":\"$ORG\",\"name\":\"Greenhouse\"}" | jq -r .id)

# The password in this response is shown ONCE. Save it.
curl -s $API/devices -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"projectId\":\"$PROJECT\",\"displayName\":\"ESP32 #1\",\"deviceType\":\"esp32\",\"expectedIntervalSeconds\":5}" \
  > device.json
```

### Send data

Simulator (no hardware):

```bash
npm install
npm run simulate -- --creds device.json --ca infra/certs/out/ca.crt --interval 5
```

Real ESP32: copy `firmware/esp32-arduino/arc_device/config.example.h` to `config.h`, fill it from `device.json`, and flash. Set `MQTT_PUBLIC_HOST` in `.env` to your computer's LAN IP and regenerate certs with `HOST_IP=<that IP> npm run certs:dev` so the ESP32 can verify the broker.

### Read it back

```bash
DEVICE=$(jq -r .device.id device.json)
curl -s "$API/devices/$DEVICE/state"            -H "authorization: Bearer $TOKEN" | jq
curl -s "$API/devices/$DEVICE/telemetry/latest" -H "authorization: Bearer $TOKEN" | jq
curl -s "$API/devices/$DEVICE/telemetry?metric=temperatureC,humidityPct&bucket=1m&agg=avg" -H "authorization: Bearer $TOKEN" | jq
curl -s "$API/organizations/$ORG/rejected-messages" -H "authorization: Bearer $TOKEN" | jq   # why a message was dropped
```

Worker metrics: `curl localhost:9100/metrics`. EMQX dashboard: http://127.0.0.1:18083 (default `admin` / `public`, change it on first login).

## API summary

Full interactive reference: **`/api/docs`** on the API (machine-readable: `/api/openapi.json`, also committed as `docs/api/openapi.json`). All routes are under `/api/v1` and need `Authorization: Bearer <token>` (a user token, an API key `arc_sk_…`, or a service-account token from `POST /api/v1/oauth/token`), except register/login and the device HTTP API. Roles per organization: `org_admin` > `engineer` > `viewer`. Resources outside your organizations return **404**, not 403. Requests are rate-limited, and plan quotas return `403 quota_exceeded`.

| Area | Endpoints |
|---|---|
| Auth | `auth/register`, `auth/login`, `auth/me`, `oauth/token` (client credentials) |
| Organizations | `organizations`, members, `audit-logs`, `rejected-messages`, `overview`, `usage`, `settings` (retention), `plan` (platform admins), `platform/organizations` |
| Channels | `projects`, `fields`, `dashboard`, `read-key`, `command-types` |
| Devices & data | `devices`, credentials, lifecycle, `state`, `telemetry`, `events`, `controls`, `commands`, `channels/:id/feeds.json\|csv` |
| Device HTTP | `update?api_key=…&field1=…`, `controls`, next command + acknowledgement |
| Rules & alerts | `rules`, `alerts`, `alerts/:id/acknowledge`, `alerts/:id/resolve` |
| Integrations | `api-keys`, `webhooks` (+ `test`, `deliveries`), `lms/links` (+ `learner-tokens`) |
| Firmware | `firmware/signing-keys`, `firmware/releases`, `firmware/rollouts` |
| Health | `/health/live`, `/health/ready`; worker `/metrics` |

## Development without Docker

```bash
npm install
npm run build
npm test                                                   # unit tests
DATABASE_URL=postgres://user:pass@localhost:5432/empty_db npm run test:e2e   # full data path, uses an in-process test broker
```

`npm run dev:api` / `npm run dev:worker` run with reload; set the variables from `.env.example` in your shell.

## Security notes

- Each device has its own credential, stored as an scrypt hash; the plaintext is returned once at provisioning or rotation.
- Device identity comes from the authenticated connection (`clientId = username = device UUID`). The ACL lets a device publish only to its own `telemetry`, `state` and `cmd-ack` topics and subscribe only to its own `cmd` topic. The worker re-checks topic vs. device as defence in depth.
- Broker hooks run on a separate port with a shared token; keep port 3001 off the public network.
- Revoking or rotating takes effect on the next connect; the EMQX authorization cache (30 s) bounds how long an already-connected revoked device can keep publishing. Kick the client from EMQX for immediate effect (automating this is a planned follow-up).
- Change `ALLOW_SIGNUP=false` once accounts exist. Review Indian DPDP Act obligations before production data.

## Plan coverage

All roadmap phases in the design plan are implemented: 1 Foundation, 2 Ingestion, 3 Console, 4 Rules & alerts, 5 Integrations (REST/OpenAPI, webhooks, API keys, service accounts, ARC LMS), 6 Hardening (rate limits, quotas, retention, backup + verified restore in `infra/backup`, monitoring, load test, CI, staging, runbooks, security review), 7 Advanced (commands with acknowledgement, signed OTA with staged rollouts, usage analytics, plans). Still open, by design: billing/payments and a native mobile app (the console works on phones), and the kickoff decisions in `docs/architecture/kickoff-decisions.md` (scale, budget, uptime targets) that only ARC LABS can make.
