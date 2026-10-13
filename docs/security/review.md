# Security review (design plan §17)

Status of each control in this codebase. ✅ in place · 🟡 partly / depends on hosting · ⬜ owner action.

| Control | Status | How |
|---|---|---|
| TLS for web, API, MQTT | ✅ | Vercel + Railway HTTPS; EMQX TLS 1.2/1.3 on 8883; plain MQTT 1883 only on the private network. Internal links (api⇄emqx⇄worker) use Railway's private network. |
| Unique per-device credentials; rotation; revocation | ✅ | 256-bit random password per device, scrypt-hashed; rotate/revoke take effect on next auth (≤30 s ACL cache). |
| No anonymous MQTT; topic ACLs per device | ✅ | Every client authenticated by the API hook; device may publish only its own `telemetry`/`state`/`cmd-ack` and subscribe only its own `cmd`. |
| Backend RBAC and tenant checks on every read/write | ✅ | `AccessService` resolves ownership from the DB; non-members get 404. API keys, service accounts and LMS learners carry an org/channel/device scope enforced in the same place. Tested end-to-end. |
| Rate limits and payload limits | ✅ | 300 req/min per client, 10/min on login, 30/min on OAuth; per-device MQTT 5 msg/s (burst 20) and HTTP 1/s; JSON body 256 KB; MQTT packet 16 KB. |
| Input/schema validation | ✅ | zod on every API input (also generates the OpenAPI docs); telemetry schema + per-field min/max; command parameters validated against an allow-list. |
| Dependency scanning | ✅ | CI runs `npm audit --omit=dev --audit-level=high` on every push. Known: 2 moderate advisories in `js-yaml` via `@nestjs/swagger` (only parses the platform's own spec, never user input). |
| Secrets management; none in source or frontend | ✅ | Railway variables; CI fails if `.env`, device files, `railway-variables.txt`, private keys or certs are committed. The console bundle only contains the public API URL. |
| Audit: provisioning, credentials, rules, commands, exports | ✅ | `audit_logs` records device create/rotate/revoke/lifecycle, rules, alert ack/resolve, API keys, webhooks, LMS tokens, commands, firmware, settings/plan changes, read-key rotation. |
| Commands safety | ✅ | Allow-listed per channel, parameter validation, role check (engineer or admin-only types), expiry, status only "acknowledged" after the device confirms. |
| OTA authenticity/integrity | ✅ | Releases must carry an Ed25519 signature over the manifest from a registered key (server verifies); manifest includes SHA-256 and size; devices verify the SHA-256 before installing; staged rollout with pause/withdraw. |
| Webhook safety | ✅ | HTTPS only, private/loopback addresses refused (checked at creation and at each send), HMAC-SHA256 signature with timestamp, 10 s timeout, no redirects, bounded retries. |
| Backups and tested restore | ✅ | `infra/backup/*` with checksum + row-count verification; verified in CI. Enable Railway scheduled backups too (⬜ owner). |
| Incident response, data export/deletion | 🟡 | Runbooks in `docs/runbooks`. Data export: channel CSV/JSON feeds and the API. Deleting an organization's data on request is a manual SQL step today (document requests in the audit log). |
| Indian privacy/legal review (DPDP Act 2023) | ⬜ | Owner action before storing personal data: privacy notice, consent where needed, data-processing agreements with Railway/Vercel, breach-notification procedure. Not legal advice. |
| Penetration test | ⬜ | Recommended before the first paying customer. |
