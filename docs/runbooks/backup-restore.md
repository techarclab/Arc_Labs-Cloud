# Backups and restore

Targets for V1: **RPO 24 hours** (at most one day of data lost) and **RTO 1 hour** (service restored within an hour).

## Automatic backups (Railway)
Railway → Postgres → *Backups*: enable scheduled backups (daily; keep 7+). Restore from that screen in an emergency.

## Your own backups (portable, verified)
Get the database's public address: Railway → Postgres → Variables → `DATABASE_PUBLIC_URL`. Then in Git Bash:

```bash
cd /c/arc-cloud
bash infra/backup/backup.sh "postgresql://…DATABASE_PUBLIC_URL…"
bash infra/backup/verify.sh backups/arc-YYYYmmdd-HHMMSS.dump
```

- `backup.sh` writes `backups/arc-<time>.dump` plus a checksum and the row counts of every important table. It uses your local `pg_dump` if it's new enough, otherwise Docker (`postgres:<server version>`).
- `verify.sh` restores the dump into a **throwaway** database (a temporary Docker container) and checks every row count matches. A backup you haven't verified doesn't count.
- Keep copies off your laptop (e.g. a private cloud drive). `backups/` is git-ignored: never commit it.

Do this weekly, and before every risky change (migration, big import).

## Restore (disaster recovery)
1. Railway → `api` and `worker` → Settings → *Remove/stop* the active deployment (so nothing writes during the restore).
2. `bash infra/backup/restore.sh backups/arc-<time>.dump "postgresql://…DATABASE_PUBLIC_URL…"` and type `RESTORE`. It replaces the ARC Cloud tables and checks the row counts.
3. Redeploy `api` (it runs any newer migrations), then `worker`.
4. Check `/health/ready`, sign in, open a device: readings up to the backup time are there.
5. Tell users the gap: data between the backup and the incident is lost (devices don't resend old data).

## Tested
`infra/backup/verify.sh` runs in CI on every push (`.github/workflows/ci.yml`): a database filled by the end-to-end tests is backed up and restored, and the counts must match. Log of manual verifications: `backups/verify.log`.
