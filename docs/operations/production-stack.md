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
| DEF-002 | open question, low | Suspected: a reading a device sends after an EMQX restart but before the ingest worker has re-subscribed is acknowledged by EMQX and dropped (MQTT drops QoS 1 messages that match no subscription). **Not reproduced on 2026-11-11:** readings sent the moment all 200 devices were back were all stored, in both restart scenarios. A device that reconnects earlier than the worker can still hit the window, and the suite does not yet measure each device's first reading. The suite re-checks this on every run and records it as a known defect if readings go missing |
| DEF-003 | low | `base.hocon` sets `max_connections = 100000` but EMQX enforces 65,536, most likely the container's open-file limit (to confirm). The config overstates capacity |

## Runs

| Date | Run | Result | Notes |
|---|---|---|---|
| 2026-11-11 | [run 43003163463](https://github.com/techarclab/Arc_Labs-Cloud/actions/runs/43003163463), EMQX 5.8.9, arm64, 200 devices | **25/25 pass** (1 known defect: DEF-003) | see measurements below |

### Measurements, 2026-11-11

| Measurement | Value |
|---|---|
| 200 devices connecting at once | all connected in 2.6 s, 0 refused; EMQX memory 245 MiB of 1 GiB |
| Rotation → live session cut | 245 ms (through the EMQX management API) |
| EMQX restart, devices with jittered back-off | all 200 back after 12.6 s; 371 connection attempts refused while EMQX started; 200/200 readings stored |
| EMQX restart, all devices retrying every second | all 200 back after 11.1 s; 400 refused attempts; 200/200 readings stored |
| Device that never returns after an EMQX restart | shown offline after 51 s (limit 60 s for a 10 s interval) |
| Worker restart | readings sent while it was down: all stored once it was back (persistent session) |
| API restart | no device dropped; readings stored during the restart |
| Listener limit | 65,536 enforced (config: 100,000), see DEF-003 |

Earlier runs on the same day failed because of test-harness bugs, all fixed in this PR: `credentials.topics.commands` misnamed, a CA certificate not trusted by Node, restart detection, and worker-subscription detection. They were not product defects.
