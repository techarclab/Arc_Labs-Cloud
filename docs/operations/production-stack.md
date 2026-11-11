# Production-stack tests (real EMQX 5.8)

CI job `stack`, on an **arm64** runner like the Oracle VM.
- `tests/stack/up.sh` starts `deploy/oracle/docker-compose.yml` the way `arc-deploy` does: `write-env.py`, `arc-cert-sync`, migrations as a one-off step, then a wait on `/health/deep`.
- `tests/stack/run.ts` tests it through HTTPS (Caddy) and MQTT over TLS (port 8883) only.
- **The only difference from production** is that Caddy uses its internal CA instead of Let's Encrypt (no public DNS in CI). The diff is saved with every run (`Caddyfile.diff`).

Before this job, every MQTT test ran against Aedes, an in-process stand-in. The EMQX configuration (listener, hooks, limits, `deny_action`, client events, management API) was never tested.

## What it checks

| Area | Checks |
|---|---|
| Exposure | only 80/443/8883 published; 1883, 18083, 5432, 3000, 3001 unreachable from outside |
| TLS listener | TLS 1.3 default, 1.2 accepted, certificate SAN, plain MQTT refused |
| Authentication hook | valid credentials over MQTT 3.1.1 and 5; wrong, unknown or empty password refused; client ID ≠ username refused; session takeover |
| Authorization hook | own telemetry stored and device online through EMQX's own client events; own `cmd` subscription granted; other device's topic, publishing on `cmd`, and wildcards refused with disconnect |
| Limits | 16 KB packets, 64-character client IDs, retain disabled, listener connection limit, 1 GB memory cap |
| Data path | dashboard switch delivered and re-sent after reconnect; command re-delivered on connect and acknowledged; rotation and revocation cut live sessions through the EMQX management API |
| Restarts, 200 devices | simultaneous connect; worker restart (persistent session); API restart; EMQX restart with jittered reconnects, and with all devices reconnecting every second; a device that never returns goes offline within interval × 3 + 30 s |

## Defects found by this suite

| ID | Severity | Finding |
|---|---|---|
| DEF-002 | see results | Readings a device sends right after an EMQX restart, before the worker has re-subscribed, are acknowledged by EMQX and dropped (QoS 1 to a topic with no subscriber). The suite measures it on every run |
| DEF-003 | low | `base.hocon` sets `max_connections = 100000` but EMQX enforces 65,536, most likely the container's open-file limit (to confirm). The config overstates capacity |

## Runs

| Date | Run | Result | Notes |
|---|---|---|---|
| — | first full run pending | | |
