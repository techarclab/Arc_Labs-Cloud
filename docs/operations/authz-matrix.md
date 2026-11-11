# Authorization matrix

`tests/authz/run.ts` calls **every operation in the API's OpenAPI spec as every kind of caller** and checks the answer against `tests/authz/policy.ts`. It runs in CI on every push (job `test`, step *Authorization matrix*). Results are in the job summary and the `authz-matrix` artifact.

| Caller | Who |
|---|---|
| anon | no token |
| outsider | admin of another organization (tenant isolation) |
| viewer / engineer / admin | members of the target organization with that role |
| platform | ARC LABS platform admin, not a member of the target organization |

## Rules

- **Denied callers** must get 401, 403 or 404 (anonymous: 401). They are sent real resource ids and realistic request bodies, so a missing check would actually perform the action and show up as a failure.
- **Allowed callers** must not be refused: GETs must answer 2xx, and writes must not be refused for permissions.
- **Destructive routes** (delete, revoke, withdraw, resolve) run once at the end, as the least-privileged allowed caller, on resources created for them.
- **New routes:** every operation in the spec must have an entry in `policy.ts`, and every entry must still exist. A new route fails CI until someone decides who may call it.
- **Known defects:** `KNOWN_DEFECTS` lists cells where today's code differs from the intended policy. Those cells must keep today's behaviour, are reported, and fail once the code is fixed, so the entry gets removed.
- `docs/api/openapi.json` must equal the spec generated from the code (CI step *OpenAPI spec in docs/ is current*).

## Evidence

| Date | Where | Result | File |
|---|---|---|---|
| 2026-11-11 | local, PostgreSQL 16 | 112 operations: 531 pass, 0 fail, 63 known (DEF-001), 0 inconclusive | [evidence/2026-11-11-authz-matrix-local.md](evidence/2026-11-11-authz-matrix-local.md) |
| 2026-11-11 | local, **planted bug** | `DELETE /rules/{id}` downgraded to viewer in the built API: the matrix failed (`viewer → 204, NOT REFUSED`). Build restored afterwards | — |

## Findings from the first run

- **DEF-001 (high):** platform admins hold org_admin rights in every organization.
  - `AccessService.roleIn` returns `org_admin`, and `TenantScopeInterceptor` runs their requests without row-level security.
  - The Account page tells them "no access to their data", and the reference documentation says the same.
  - 63 cells: read telemetry, rotate and revoke devices, delete channels, manage keys and webhooks of any customer.
  - The channel feeds endpoint behaves differently: it checks only the database flag `users.is_platform_admin`, so admins listed in `PLATFORM_ADMIN_EMAILS` are refused there.
  - Decision needed: remove the bypass (platform routes only), or keep it, document it honestly in the privacy notice and audit every use.
- **Spec drift (fixed here):** `docs/api/openapi.json` was missing 14 operations added since PR #24 (sign-up, password reset, invites). It is regenerated, and CI now fails when it goes stale.
- **Spec noise (low):** `@All('update')` documents PUT, PATCH and DELETE `/api/v1/update`, which answer 404. Only GET and POST are real.
- **Role decisions written down by the matrix (match the code; confirm they are intended):**
  - Engineers may put a device into maintenance, suspend or resume it; only admins retire or revoke.
  - *Rejected data* needs engineer, but the console sidebar shows that page to viewers too, who then get a 403.
  - ARC LMS links are admin-only for people. Scoped service accounts can list them with viewer.
