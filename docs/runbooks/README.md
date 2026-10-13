# Runbooks

What to do when something goes wrong in production (Railway: `api`, `emqx`, `worker`, `Postgres`).
Each runbook lists how you notice, what to check, how to fix, and how to confirm.

| Situation | Runbook |
|---|---|
| Devices can't connect / broker down | [broker-outage.md](broker-outage.md) |
| Data arriving late, queue growing | [ingestion-backlog.md](ingestion-backlog.md) |
| Database full, slow or out of connections | [database-exhaustion.md](database-exhaustion.md) |
| A device password, API key or server secret leaked | [credential-compromise.md](credential-compromise.md) |
| Restore data from a backup | [backup-restore.md](backup-restore.md) |
| Releasing a new version / rolling back | [release-rollback.md](release-rollback.md) |

Quick health checks:

- API: `https://<api-domain>/health/ready` → `{"status":"ok"}`
- Worker: Railway → worker → Logs shows `connected to broker`, `subscribed`, `background jobs started`
- Broker: Railway → emqx → Logs shows `TLS certificates loaded` and no repeating `nxdomain`/`authn` errors
- Diagnostics bundle from your laptop: `bash tools/railway-doctor.sh` → `railway-doctor.txt`
