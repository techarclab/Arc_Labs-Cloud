# Phase 0: kickoff decisions (design plan §25)

The plan asks for these decisions before development. ARC Cloud was built with the defaults below; each is a setting or a small change if your answer differs. **Owner: confirm or correct each line.**

| Question | Default used | Where to change it |
|---|---|---|
| Devices at launch / 12 months / 3 years | ~50 / 1,000 / 10,000+ | Plans & quotas (`organizations.max_devices`); scale workers/DB per `docs/runbooks/ingestion-backlog.md`. Load test: one worker ≈ 200 msg/s. |
| Publish interval, payload size, bursts | 5–60 s per device; ≤ 16 KB per message; burst 20 | Device "sends data every"; `DEVICE_RATE_PER_SEC`, `DEVICE_BURST`; EMQX `max_packet_size`. |
| Offline buffering on devices | Not required in V1 (devices send live data) | Firmware can send `timestamp` with buffered readings; the platform accepts past timestamps (up to 7 days). |
| Raw telemetry retention; aggregates | 90 days raw (Free), 365 (Pro), 1,825 (Enterprise); aggregates computed on read | *Usage & plan* → retention; TimescaleDB continuous aggregates on AWS (docs/aws). |
| Cloud provider / region / budget | Railway (US East) + Vercel now; AWS Mumbai later | `docs/deploy/railway-vercel.md`, `docs/aws/deployment.md`. |
| Commands / OTA in V1? | Yes, gated: allow-listed commands with acknowledgement; signed OTA with staged rollout | Disable by not defining command types / signing keys. |
| Mandatory alert channels | In-app + email (+ webhooks); SMS/WhatsApp later via a webhook to an approved provider | Set `SMTP_URL` on `worker`. |
| Initial customer | ARC LABS internal + colleges, multi-tenant from day one | Plans (`free`, `pro`, `enterprise`). |
| What ARC LMS may access | Read-only telemetry/state of devices linked to a course/lab, via short-lived learner tokens | *Integrations → ARC LMS*; `docs/integrations/arc-lms.md`. |
| Uptime, recovery objectives, support owner | 99.5% target; RPO 24 h, RTO 1 h; owner: ARC LABS engineering | `docs/runbooks/backup-restore.md`. |
