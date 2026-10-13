# Database exhaustion (disk, connections, slow queries)

**You notice:** API returns 503 on `/health/ready`; logs show `too many clients`, `could not extend file`, or queries > seconds.

**Disk full**
1. Railway → Postgres → Metrics → Disk. Telemetry is the biggest table.
2. Lower retention for the biggest organizations: *Usage & plan* → Data retention (or `PATCH /api/v1/organizations/{id}/settings {"retentionDays": 30}`). The worker's retention job deletes old data in one-day slices every 6 hours.
3. Grow the volume (Railway → Postgres → Settings → Volume).

**Connections**
- Each `api` and `worker` instance uses up to 10 connections (+1 for alert notifications). Replicas × 11 must stay below Postgres `max_connections` (Railway default 100). Reduce replicas or add PgBouncer (Railway template) in front.

**Slow queries**
- Check for missing indexes after manual schema changes: migrations in `infra/db/migrations` create the indexes used by the API.
- Run `ANALYZE;` after bulk restores.

**Confirm:** `/health/ready` is OK; worker logs no DB errors; dashboards load in < 1 s.
