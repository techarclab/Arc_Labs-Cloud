# Test coverage

Two measurements, both in CI (job `test`). Results go to the job summary and the `coverage` artifact (HTML reports).

| What | Command | Measures | Floors (CI fails below) |
|---|---|---|---|
| Unit tests (Vitest) | `npm run test:coverage` | `packages/shared`, API and worker sources, the console's sketch generator | pure logic only: `shared/src/{acl,connectivity,rules,telemetry,topics}.ts` 90% lines / 75% branches / 95% functions; `arduinoSketch.ts` 95 / 80 / 95 (`vitest.config.ts`) |
| End-to-end suite (90 checks, real API + worker + PostgreSQL) | `npm run test:e2e:coverage` | the same backend code, through real HTTP and MQTT | 90% lines, 75% branches, 88% functions (`coverage:e2e` in `package.json`) |

The end-to-end coverage comes from Node's built-in V8 coverage (`NODE_V8_COVERAGE`), collected from the API and worker processes the suite starts and mapped back to TypeScript with `c8`. Most API and worker code is exercised that way, which is why the unit-test total for the whole backend is low.

## Tests added (2026-11-11)

- **`packages/shared/test/boundaries.test.ts`** (29 tests): exact boundaries of the device protocol.
  - 64 metrics, 16 KB payloads, timestamps at +5 min and −7 days, the online threshold at 75 s.
  - Metric-name rule, open-ended field bounds, state payloads, control message shape, ACL for unknown actions.
- **`apps/console/test/arduinoSketch.test.ts`** (9 tests): the generated sketch.
  - Quick start vs no-secrets mode: no token or device ID leaks in the latter.
  - Field order, `rssi`, controls, interval floor, host arguments.
  - User-supplied names can't break out of C comments or strings.
- **`apps/api/test/plans.test.ts`** (3 tests): plan limits equal the documented values, never decrease from free to enterprise, and fit the plan endpoint's limits.

**Mutation check:** removing the `*/` escaping in the sketch generator made 2 tests fail. The source was restored.

## Evidence

| Date | Where | Unit tests | Unit, pure-logic files | End-to-end backend coverage |
|---|---|---|---|---|
| 2026-11-11 | local (Node 22, PostgreSQL 16) | 78 passed (was 37) | shared protocol files 100% lines; `arduinoSketch.ts` 100% lines / 83.7% branches | 90/90 checks; **92.29% lines, 78.16% branches, 90.98% functions** |

### Least-covered backend files (end-to-end, lines)

| File | Lines |
|---|---|
| `apps/api/src/openapi.ts` | 60% |
| `apps/api/src/common/broker-admin.service.ts` | 71.11% |
| `apps/api/src/db/migrate.ts` | 79.68% |
| `packages/shared/src/rules.ts` | 80.24% |
| `apps/api/src/auth/auth.controller.ts` | 83.69% |
| `apps/api/src/organizations/organizations.controller.ts` | 85.27% |
| `apps/api/src/commands/commands.controller.ts` | 85.49% |
| `apps/api/src/firmware/firmware.controller.ts` | 87% |
| `apps/api/src/alerts/alerts.controller.ts` | 87.94% |
| `apps/api/src/app.module.ts` | 89.36% |

Notes on the low ones:
- `openapi.ts` only runs when the spec is generated.
- `migrate.ts` has error paths for failed migrations.
- `broker-admin.service.ts`: the EMQX management-API error paths, now exercised against real EMQX by the production-stack tests (PR #28).
- `auth.controller.ts`: the Google sign-in branches. They need a Google token and are not covered automatically.
