# Authorization matrix, 2026-11-11T09:47:18.988Z

112 operations in the generated OpenAPI spec × 6 callers: 529 pass, 2 fail, 63 known defect, 0 inconclusive.

Every operation has a policy entry.


## Failures

| Operation | Caller | Expected | Got | Why |
|---|---|---|---|---|
| `DELETE /api/v1/rules/{id}` | viewer | deny | 204  | NOT REFUSED |
| `DELETE /api/v1/rules/{id}` | engineer | allow | 404 not_found | allowed caller refused or failed |

## Known defects (current behaviour expected until fixed)

- **DEF-001** (63 cells): Platform admins get org_admin rights in EVERY organization and bypass row-level security (AccessService.roleIn, TenantScopeInterceptor); the console says they have "no access to their data"

## Grid

✓ as intended · ✗ wrong · ! known defect · ? inconclusive · · not called (public route, or destructive/session-ending probe run once as the least-privileged allowed caller)

| Operation | Needs | anon | outsider | viewer | engineer | admin | platform |
|---|---|---|---|---|---|---|---|
| `GET /` | public | ✓ 200 | · | · | · | · | · |
| `GET /health/live` | public | ✓ 200 | · | · | · | · | · |
| `GET /health/ready` | public | ✓ 200 | · | · | · | · | · |
| `GET /health/deep` | public | ✓ 503 | · | · | · | · | · |
| `POST /api/v1/auth/register` | public | ✓ 400 | · | · | · | · | · |
| `POST /api/v1/auth/login` | public | ✓ 400 | · | · | · | · | · |
| `GET /api/v1/auth/google/config` | public | ✓ 200 | · | · | · | · | · |
| `POST /api/v1/auth/google` | public | ✓ 503 | · | · | · | · | · |
| `GET /api/v1/auth/me` | user | ✓ 401 | ✓ 200 | ✓ 200 | ✓ 200 | ✓ 200 | ✓ 200 |
| `PATCH /api/v1/auth/me` | user | ✓ 401 | ✓ 200 | ✓ 200 | ✓ 200 | ✓ 200 | ✓ 200 |
| `POST /api/v1/auth/accept-terms` | user | ✓ 401 | ✓ 409 | ✓ 409 | ✓ 409 | ✓ 409 | ✓ 409 |
| `POST /api/v1/auth/verify-email` | public | ✓ 400 | · | · | · | · | · |
| `POST /api/v1/auth/resend-verification` | user | ✓ 401 | ✓ 200 | ✓ 200 | ✓ 200 | ✓ 200 | ✓ 429 |
| `POST /api/v1/auth/complete-profile` | user | ✓ 401 | ✓ 409 | ✓ 409 | ✓ 409 | ✓ 409 | ✓ 409 |
| `POST /api/v1/auth/redeem-invite` | user | ✓ 401 | ✓ 403 | ✓ 403 | ✓ 403 | ✓ 403 | ✓ 403 |
| `POST /api/v1/auth/forgot-password` | public | ✓ 400 | · | · | · | · | · |
| `POST /api/v1/auth/reset-password` | public | ✓ 400 | · | · | · | · | · |
| `POST /api/v1/auth/change-password` | user | ✓ 401 | ✓ 403 | ✓ 403 | ✓ 403 | ✓ 403 | ✓ 429 |
| `POST /api/v1/auth/sign-out-everywhere` | user | ✓ 401 | · | · | · | · | · |
| `GET /api/v1/organizations` | user | ✓ 401 | ✓ 200 | ✓ 200 | ✓ 200 | ✓ 200 | ✓ 200 |
| `POST /api/v1/organizations` | user | ✓ 401 | ✓ 403 | ✓ 201 | ✓ 201 | ✓ 403 | ✓ 201 |
| `GET /api/v1/organizations/{id}` | viewer | ✓ 401 | ✓ 404 | ✓ 200 | ✓ 200 | ✓ 200 | ! 200 |
| `PATCH /api/v1/organizations/{id}` | org_admin | ✓ 401 | ✓ 404 | ✓ 403 | ✓ 403 | ✓ 200 | ! 200 |
| `GET /api/v1/organizations/{id}/members` | viewer | ✓ 401 | ✓ 404 | ✓ 200 | ✓ 200 | ✓ 200 | ! 200 |
| `POST /api/v1/organizations/{id}/members` | org_admin | ✓ 401 | ✓ 404 | ✓ 403 | ✓ 403 | ✓ 201 | ! 201 |
| `PATCH /api/v1/organizations/{id}/members/{userId}` | org_admin | ✓ 401 | ✓ 404 | ✓ 403 | ✓ 403 | ✓ 200 | ! 200 |
| `DELETE /api/v1/organizations/{id}/members/{userId}` | org_admin | ✓ 401 | ✓ 404 | ✓ 403 | ✓ 403 | ✓ 204 | · |
| `GET /api/v1/organizations/{id}/audit-logs` | org_admin | ✓ 401 | ✓ 404 | ✓ 403 | ✓ 403 | ✓ 200 | ! 200 |
| `GET /api/v1/organizations/{id}/rejected-messages` | engineer | ✓ 401 | ✓ 404 | ✓ 403 | ✓ 200 | ✓ 200 | ! 200 |
| `GET /api/v1/organizations/{id}/overview` | viewer | ✓ 401 | ✓ 404 | ✓ 200 | ✓ 200 | ✓ 200 | ! 200 |
| `GET /api/v1/organizations/{id}/usage` | viewer | ✓ 401 | ✓ 404 | ✓ 200 | ✓ 200 | ✓ 200 | ! 200 |
| `PATCH /api/v1/organizations/{id}/settings` | org_admin | ✓ 401 | ✓ 404 | ✓ 403 | ✓ 403 | ✓ 200 | ! 200 |
| `PATCH /api/v1/organizations/{id}/plan` | platform | ✓ 401 | ✓ 403 | ✓ 403 | ✓ 403 | ✓ 403 | ✓ 200 |
| `GET /api/v1/platform/invites` | platform | ✓ 401 | ✓ 403 | ✓ 403 | ✓ 403 | ✓ 403 | ✓ 200 |
| `POST /api/v1/platform/invites` | platform | ✓ 401 | ✓ 403 | ✓ 403 | ✓ 403 | ✓ 403 | ✓ 201 |
| `POST /api/v1/platform/invites/{id}/revoke` | platform | ✓ 401 | ✓ 403 | ✓ 403 | ✓ 403 | ✓ 403 | ✓ 200 |
| `GET /api/v1/platform/organizations` | platform | ✓ 401 | ✓ 403 | ✓ 403 | ✓ 403 | ✓ 403 | ✓ 200 |
| `GET /api/v1/projects` | viewer | ✓ 401 | ✓ 404 | ✓ 200 | ✓ 200 | ✓ 200 | ! 200 |
| `POST /api/v1/projects` | org_admin | ✓ 401 | ✓ 404 | ✓ 403 | ✓ 403 | ✓ 201 | ! 201 |
| `GET /api/v1/projects/{id}` | viewer | ✓ 401 | ✓ 404 | ✓ 200 | ✓ 200 | ✓ 200 | ! 200 |
| `PATCH /api/v1/projects/{id}` | engineer | ✓ 401 | ✓ 404 | ✓ 403 | ✓ 200 | ✓ 200 | ! 200 |
| `DELETE /api/v1/projects/{id}` | org_admin | ✓ 401 | ✓ 404 | ✓ 403 | ✓ 403 | ✓ 200 | · |
| `GET /api/v1/projects/{id}/fields` | viewer | ✓ 401 | ✓ 404 | ✓ 200 | ✓ 200 | ✓ 200 | ! 200 |
| `PUT /api/v1/projects/{id}/fields` | engineer | ✓ 401 | ✓ 404 | ✓ 403 | ✓ 200 | ✓ 200 | ! 200 |
| `GET /api/v1/projects/{id}/metric-definitions` | viewer | ✓ 401 | ✓ 404 | ✓ 200 | ✓ 200 | ✓ 200 | ! 200 |
| `PUT /api/v1/projects/{id}/metric-definitions` | engineer | ✓ 401 | ✓ 404 | ✓ 403 | ✓ 200 | ✓ 200 | ! 200 |
| `POST /api/v1/projects/{id}/read-key` | org_admin | ✓ 401 | ✓ 404 | ✓ 403 | ✓ 403 | ✓ 200 | ! 200 |
| `GET /api/v1/projects/{id}/dashboard` | viewer | ✓ 401 | ✓ 404 | ✓ 200 | ✓ 200 | ✓ 200 | ! 200 |
| `PUT /api/v1/projects/{id}/dashboard` | engineer | ✓ 401 | ✓ 404 | ✓ 403 | ✓ 200 | ✓ 200 | ! 200 |
| `GET /api/v1/devices` | viewer | ✓ 401 | ✓ 404 | ✓ 200 | ✓ 200 | ✓ 200 | ! 200 |
| `POST /api/v1/devices` | engineer | ✓ 401 | ✓ 404 | ✓ 403 | ✓ 201 | ✓ 201 | ! 201 |
| `GET /api/v1/devices/{id}` | viewer | ✓ 401 | ✓ 404 | ✓ 200 | ✓ 200 | ✓ 200 | ! 200 |
| `PATCH /api/v1/devices/{id}` | engineer | ✓ 401 | ✓ 404 | ✓ 403 | ✓ 200 | ✓ 200 | ! 200 |
| `POST /api/v1/devices/{id}/rotate-credentials` | engineer | ✓ 401 | ✓ 404 | ✓ 403 | ✓ 200 | ✓ 200 | ! 200 |
| `POST /api/v1/devices/{id}/revoke` | org_admin | ✓ 401 | ✓ 404 | ✓ 403 | ✓ 403 | ✓ 200 | · |
| `POST /api/v1/devices/{id}/lifecycle` | engineer | ✓ 401 | ✓ 404 | ✓ 403 | ✓ 200 | · | · |
| `GET /api/v1/devices/{id}/state` | viewer | ✓ 401 | ✓ 404 | ✓ 200 | ✓ 200 | ✓ 200 | ! 200 |
| `GET /api/v1/devices/{id}/telemetry/latest` | viewer | ✓ 401 | ✓ 404 | ✓ 200 | ✓ 200 | ✓ 200 | ! 200 |
| `GET /api/v1/devices/{id}/telemetry` | viewer | ✓ 401 | ✓ 404 | ✓ 200 | ✓ 200 | ✓ 200 | ! 200 |
| `GET /api/v1/devices/{id}/controls` | viewer | ✓ 401 | ✓ 404 | ✓ 200 | ✓ 200 | ✓ 200 | ! 200 |
| `POST /api/v1/devices/{id}/controls` | engineer | ✓ 401 | ✓ 404 | ✓ 403 | ✓ 200 | ✓ 200 | ! 200 |
| `GET /api/v1/devices/{id}/events` | viewer | ✓ 401 | ✓ 404 | ✓ 200 | ✓ 200 | ✓ 200 | ! 200 |
| `GET /api/v1/commands/next` | device | ✓ 401 | ✓ 401 | ✓ 401 | ✓ 401 | ✓ 401 | ✓ 401 |
| `POST /api/v1/commands/{commandId}/ack` | device | ✓ 401 | ✓ 401 | ✓ 401 | ✓ 401 | ✓ 401 | ✓ 401 |
| `GET /api/v1/update` | device | ✓ 401 | ✓ 401 | ✓ 401 | ✓ 401 | ✓ 401 | ✓ 401 |
| `POST /api/v1/update` | device | ✓ 401 | ✓ 401 | ✓ 401 | ✓ 401 | ✓ 401 | ✓ 401 |
| `PUT /api/v1/update` | device | ✓ 404 | ✓ 404 | ✓ 404 | ✓ 404 | ✓ 404 | ✓ 404 |
| `PATCH /api/v1/update` | device | ✓ 404 | ✓ 404 | ✓ 404 | ✓ 404 | ✓ 404 | ✓ 404 |
| `DELETE /api/v1/update` | device | ✓ 404 | ✓ 404 | ✓ 404 | ✓ 404 | ✓ 404 | ✓ 404 |
| `GET /api/v1/controls` | device | ✓ 401 | ✓ 401 | ✓ 401 | ✓ 401 | ✓ 401 | ✓ 401 |
| `GET /api/v1/channels/{id}/feeds.json` | viewer | ✓ 401 | ✓ 404 | ✓ 200 | ✓ 200 | ✓ 200 | ✓ 404 |
| `GET /api/v1/channels/{id}/feeds.csv` | viewer | ✓ 401 | ✓ 404 | ✓ 200 | ✓ 200 | ✓ 200 | ✓ 404 |
| `GET /api/v1/projects/{id}/command-types` | viewer | ✓ 401 | ✓ 404 | ✓ 200 | ✓ 200 | ✓ 200 | ! 200 |
| `PUT /api/v1/projects/{id}/command-types/{name}` | org_admin | ✓ 401 | ✓ 404 | ✓ 403 | ✓ 403 | ✓ 200 | ! 200 |
| `DELETE /api/v1/projects/{id}/command-types/{name}` | org_admin | ✓ 401 | ✓ 404 | ✓ 403 | ✓ 403 | ✓ 204 | · |
| `GET /api/v1/devices/{id}/commands` | viewer | ✓ 401 | ✓ 404 | ✓ 200 | ✓ 200 | ✓ 200 | ! 200 |
| `POST /api/v1/devices/{id}/commands` | engineer | ✓ 401 | ✓ 404 | ✓ 403 | ✓ 201 | ✓ 201 | ! 201 |
| `GET /api/v1/commands/{commandId}` | viewer | ✓ 401 | ✓ 404 | ✓ 200 | ✓ 200 | ✓ 200 | ! 200 |
| `POST /api/v1/commands/{commandId}/retry` | engineer | ✓ 401 | ✓ 404 | ✓ 403 | ✓ 200 | ✓ 200 | ! 200 |
| `GET /api/v1/rules` | viewer | ✓ 401 | ✓ 404 | ✓ 200 | ✓ 200 | ✓ 200 | ! 200 |
| `POST /api/v1/rules` | engineer | ✓ 401 | ✓ 404 | ✓ 403 | ✓ 201 | ✓ 201 | ! 201 |
| `GET /api/v1/rules/{id}` | viewer | ✓ 401 | ✓ 404 | ✓ 200 | ✓ 200 | ✓ 200 | ! 200 |
| `PATCH /api/v1/rules/{id}` | engineer | ✓ 401 | ✓ 404 | ✓ 403 | ✓ 200 | ✓ 200 | ! 200 |
| `DELETE /api/v1/rules/{id}` | engineer | ✓ 401 | ✓ 404 | ✗ 204 | ✗ 404 | · | · |
| `GET /api/v1/alerts` | viewer | ✓ 401 | ✓ 404 | ✓ 200 | ✓ 200 | ✓ 200 | ! 200 |
| `GET /api/v1/alerts/{id}` | viewer | ✓ 401 | ✓ 404 | ✓ 200 | ✓ 200 | ✓ 200 | ! 200 |
| `POST /api/v1/alerts/{id}/acknowledge` | engineer | ✓ 401 | ✓ 404 | ✓ 403 | ✓ 200 | ✓ 409 | ! 409 |
| `POST /api/v1/alerts/{id}/resolve` | engineer | ✓ 401 | ✓ 404 | ✓ 403 | ✓ 200 | · | · |
| `GET /api/v1/api-keys` | org_admin | ✓ 401 | ✓ 404 | ✓ 403 | ✓ 403 | ✓ 200 | ! 200 |
| `POST /api/v1/api-keys` | org_admin | ✓ 401 | ✓ 404 | ✓ 403 | ✓ 403 | ✓ 201 | ! 201 |
| `DELETE /api/v1/api-keys/{id}` | org_admin | ✓ 401 | ✓ 404 | ✓ 403 | ✓ 403 | ✓ 204 | · |
| `POST /api/v1/oauth/token` | public | ✓ 400 | · | · | · | · | · |
| `GET /api/v1/webhooks` | org_admin | ✓ 401 | ✓ 404 | ✓ 403 | ✓ 403 | ✓ 200 | ! 200 |
| `POST /api/v1/webhooks` | org_admin | ✓ 401 | ✓ 404 | ✓ 403 | ✓ 403 | ✓ 201 | ! 201 |
| `PATCH /api/v1/webhooks/{id}` | org_admin | ✓ 401 | ✓ 404 | ✓ 403 | ✓ 403 | ✓ 200 | ! 200 |
| `DELETE /api/v1/webhooks/{id}` | org_admin | ✓ 401 | ✓ 404 | ✓ 403 | ✓ 403 | ✓ 204 | · |
| `POST /api/v1/webhooks/{id}/test` | org_admin | ✓ 401 | ✓ 404 | ✓ 403 | ✓ 403 | ✓ 202 | ! 202 |
| `GET /api/v1/webhooks/{id}/deliveries` | org_admin | ✓ 401 | ✓ 404 | ✓ 403 | ✓ 403 | ✓ 200 | ! 200 |
| `GET /api/v1/lms/links` | org_admin | ✓ 401 | ✓ 404 | ✓ 403 | ✓ 403 | ✓ 200 | ! 200 |
| `POST /api/v1/lms/links` | org_admin | ✓ 401 | ✓ 404 | ✓ 403 | ✓ 403 | ✓ 201 | ! 201 |
| `DELETE /api/v1/lms/links/{id}` | org_admin | ✓ 401 | ✓ 404 | ✓ 403 | ✓ 403 | ✓ 204 | · |
| `POST /api/v1/lms/links/{id}/learner-tokens` | org_admin | ✓ 401 | ✓ 404 | ✓ 403 | ✓ 403 | ✓ 201 | ! 201 |
| `GET /api/v1/firmware/signing-keys` | viewer | ✓ 401 | ✓ 404 | ✓ 200 | ✓ 200 | ✓ 200 | ! 200 |
| `POST /api/v1/firmware/signing-keys` | org_admin | ✓ 401 | ✓ 404 | ✓ 403 | ✓ 403 | ✓ 201 | ! 201 |
| `DELETE /api/v1/firmware/signing-keys/{id}` | org_admin | ✓ 401 | ✓ 404 | ✓ 403 | ✓ 403 | ✓ 204 | · |
| `GET /api/v1/firmware/releases` | viewer | ✓ 401 | ✓ 404 | ✓ 200 | ✓ 200 | ✓ 200 | ! 200 |
| `POST /api/v1/firmware/releases` | org_admin | ✓ 401 | ✓ 404 | ✓ 403 | ✓ 403 | ✓ 201 | ! 201 |
| `POST /api/v1/firmware/releases/{id}/withdraw` | org_admin | ✓ 401 | ✓ 404 | ✓ 403 | ✓ 403 | ✓ 200 | · |
| `GET /api/v1/firmware/rollouts` | viewer | ✓ 401 | ✓ 404 | ✓ 200 | ✓ 200 | ✓ 200 | ! 200 |
| `POST /api/v1/firmware/rollouts` | org_admin | ✓ 401 | ✓ 404 | ✓ 403 | ✓ 403 | ✓ 201 | ! 201 |
| `GET /api/v1/firmware/rollouts/{id}` | viewer | ✓ 401 | ✓ 404 | ✓ 200 | ✓ 200 | ✓ 200 | ! 200 |
| `PATCH /api/v1/firmware/rollouts/{id}` | org_admin | ✓ 401 | ✓ 404 | ✓ 403 | ✓ 403 | ✓ 200 | ! 200 |
