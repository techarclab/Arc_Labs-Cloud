# Releases and rollback

**Normal release:** push to `main`. CI runs build, unit + end-to-end tests, backup/restore check and the dependency scan. Railway rebuilds `api`, `emqx`, `worker`; Vercel rebuilds the console. The API applies new database migrations on start.

**Staged:** test in the `staging` environment first (see `docs/deploy/staging.md`), then merge to `main`.

**Before a release with a migration:** take and verify a backup (`backup-restore.md`). Migrations only add tables/columns; they are not reversed automatically.

**Roll back the code:** Railway → service → Deployments → pick the previous good deployment → *Redeploy*. Vercel → Deployments → previous → *Promote to Production*. Or `git revert` the bad commit and push.

**Roll back data** (rare; only if a migration damaged data): restore the pre-release backup (`backup-restore.md`).

**Firmware (OTA):** pause the rollout (*Firmware → rollout → Pause*), or withdraw the release (cancels active rollouts). Devices already updated keep the new version; publish a fixed version (higher number) and roll that out.
