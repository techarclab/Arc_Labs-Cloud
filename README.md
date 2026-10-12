# ARC Cloud

Multi-tenant IoT platform from ARC LABS. This repository is the **V1 MVP backbone** from the developer design plan (phases 1–2): identity and tenancy, device registry and provisioning, MQTT-over-TLS ingestion, telemetry storage, device state, and audit, with a telemetry-only (no downlink) security model.

```
ESP32 / Pi / gateway ──MQTT over TLS :8883──▶ EMQX ──auth + ACL hooks──▶ API :3001 (private)
                                               │
                                               └─ shared subscription ─▶ ingestion-worker ──▶ PostgreSQL / TimescaleDB
Web console / scripts ──HTTPS REST :3000──▶ API ─────────────────────────────────────────────┘
```

| Path | What it is |
|---|---|
| `apps/api` | NestJS REST API (`/api/v1`): auth, organizations, members/RBAC, projects, metric definitions, devices, credentials, telemetry and state queries, audit. Also serves the EMQX auth/ACL hooks on a separate private port. |
| `apps/console` | Web console (React + Vite), served by nginx on port 3002 in Docker. `npm run dev -w @arc/console` for live reload. |
| `apps/ingestion-worker` | Subscribes to device topics, validates payloads, dedupes by `messageId`, persists telemetry, tracks last-seen and connect/disconnect, records rejections. Exposes `/health/*` and `/metrics`. |
| `packages/shared` | Topic convention, payload schemas, ACL rules and online/offline logic shared by every service. |
| `infra/` | SQL migrations, EMQX config, dev TLS certs, bootstrap script. |
| `firmware/esp32-arduino` | ESP32 example that connects over TLS and publishes telemetry. |
| `tools/device-simulator` | Pretend device for testing without hardware. |
| `tests/e2e` | 27 end-to-end checks (auth, ACL, ingestion, dedupe, tenant isolation, rotation, revocation). |
| `docs/` | Device protocol, architecture decisions, AWS deployment path. |

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

All routes are under `/api/v1` and need `Authorization: Bearer <token>` except register/login. Roles per organization: `org_admin` > `engineer` > `viewer`. Resources outside your organizations return **404**, not 403.

| Area | Endpoints |
|---|---|
| Auth | `POST auth/register`, `POST auth/login`, `GET auth/me` |
| Organizations | `POST/GET organizations`, `GET/PATCH organizations/:id`, `GET/POST organizations/:id/members`, `PATCH/DELETE organizations/:id/members/:userId`, `GET organizations/:id/audit-logs`, `GET organizations/:id/rejected-messages` |
| Projects | `POST projects`, `GET projects?organizationId=`, `GET/PATCH projects/:id`, `GET/PUT projects/:id/metric-definitions` |
| Devices | `POST devices`, `GET devices?projectId=&connectivity=&lifecycle=&tag=&search=`, `GET/PATCH devices/:id`, `POST devices/:id/rotate-credentials`, `POST devices/:id/revoke`, `POST devices/:id/lifecycle` |
| Data | `GET devices/:id/state`, `GET devices/:id/telemetry/latest`, `GET devices/:id/telemetry?metric=a,b&from=&to=&bucket=1m\|5m\|15m\|1h\|6h\|1d&agg=avg\|min\|max\|sum\|count\|last`, `GET devices/:id/events` |
| Health | `GET /health/live`, `GET /health/ready` |

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
- Device identity comes from the authenticated connection (`clientId = username = device UUID`). The ACL lets a device publish only to its own `telemetry`/`state` topics and never subscribe. The worker re-checks topic vs. device as defence in depth.
- Broker hooks run on a separate port with a shared token; keep port 3001 off the public network.
- Revoking or rotating takes effect on the next connect; the EMQX authorization cache (30 s) bounds how long an already-connected revoked device can keep publishing. Kick the client from EMQX for immediate effect (automating this is a planned follow-up).
- Change `ALLOW_SIGNUP=false` once accounts exist. Review Indian DPDP Act obligations before production data.

## What's next (from the plan)

Phase 3 console (Next.js), phase 4 rules/alerts, phase 5 webhooks/API keys/ARC LMS integration, phase 6 hardening and AWS. See `docs/aws/deployment.md` and `docs/architecture/decisions.md`.
