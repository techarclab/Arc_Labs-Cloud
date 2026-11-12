# Week A report: testing foundation and security (2026-11-11)

Scope as approved:
1. Real EMQX 5.8 in CI with the production configuration, plus restart and mass-reconnect tests.
2. A route × role authorization matrix generated from OpenAPI.
3. Trivy on every image, plus dependency auditing that includes dev dependencies.
4. OWASP ZAP against the isolated CI environment only.
5. Coverage reporting and unit tests for the pure business logic.
6. The firmware library field-name fix, done with TDD.

**Constraints:**
- Nothing is merged, deployed or changed on the production VM. Work is on feature branches with draft PRs; you approved the pushes.
- This workspace cannot pull Docker Hub images or download GitHub artifacts. Container-based tests ran in GitHub Actions; logs were read through the API.

## Changes (draft PRs, all open)

| PR | Branch | What |
|---|---|---|
| [#28](https://github.com/techarclab/Arc_Labs-Cloud/pull/28) | `test/real-emqx-stack` | Production stack in CI (arm64, real EMQX 5.8.9) + 25-check suite, 200 simulated devices |
| [#29](https://github.com/techarclab/Arc_Labs-Cloud/pull/29) | `test/authz-matrix` | Authorization matrix from the OpenAPI spec; regenerated stale `openapi.json` + drift check |
| [#30](https://github.com/techarclab/Arc_Labs-Cloud/pull/30) | `fix/library-field-names` | ArcCloud library 1.0.1: field names follow the server rule (TDD) |
| [#31](https://github.com/techarclab/Arc_Labs-Cloud/pull/31) | `test/unit-coverage` | Coverage reports with floors; 41 unit tests |
| [#32](https://github.com/techarclab/Arc_Labs-Cloud/pull/32) | `ci/supply-chain-scans` | Trivy scans and gate; npm removed from the API image; console on nginx 1.30 + Alpine updates |
| [#33](https://github.com/techarclab/Arc_Labs-Cloud/pull/33) | `ci/zap-scan` (stacked on #28) | OWASP ZAP baseline + authenticated active scan of the CI stack |
| [#34](https://github.com/techarclab/Arc_Labs-Cloud/pull/34) | `docs/week-b-environment` | Week B environment plan: cost, cap, isolation, teardown (nothing provisioned) |

## Tests added

| Suite | Size | Runs in |
|---|---|---|
| Production-stack suite (`tests/stack`) | 25 checks: exposure, TLS, auth/authz hooks, protocol limits, controls/commands, rotation/revocation, restarts with 200 devices | CI `stack` (arm64) |
| Authorization matrix (`tests/authz`) | 112 operations × 6 callers (594 cells) + 2 retire checks; fails on any route without a policy | CI `test` |
| Unit tests | +41 (37 → 78): protocol boundaries 29, sketch generator 9, plan limits 3 | CI `test` |
| Library field names (`tests/firmware/field-names.mjs`) | 212 names compared with the server rule | CI `firmware-crypto` |
| Coverage | unit floors on pure logic; end-to-end backend floors 90/75/88 | CI `test` |
| Trivy | 3 application images, 2 infrastructure images, full lockfile, Dockerfiles; SBOMs | CI `supply-chain` |
| ZAP | console + API baseline, authenticated active scan of every API operation | CI `zap` |
| OpenAPI drift | committed spec must equal the generated one | CI `test` |

## Results

| Suite | Result (CI) |
|---|---|
| Production stack, real EMQX 5.8.9, arm64 | **25/25 pass** (1 known defect, DEF-003), run 43003163463 |
| Authorization matrix | **531 pass, 0 fail, 0 inconclusive**, 63 known-defect cells (DEF-001). A planted bug was caught |
| End-to-end (existing, 90 checks) | 90/90 |
| Unit tests | 78/78 |
| Backend coverage from end-to-end | **92.29% lines, 78.16% branches, 90.98% functions** |
| Pure-logic coverage | shared protocol files 100% lines; sketch generator 100% lines / 83.7% branches |
| Library field names | red before the fix (21 wrong names accepted), green after (212/212) |
| Trivy gate (application images) | **pass**: API 0 critical / 0 high; console 0 at every severity |
| ZAP | **gate pass** (run 43004092377): 0 unaccepted High; 1 High reproduced as a false positive and accepted for that route only; 2 Medium (console CSP); Low: cross-origin and Permissions-Policy headers, plus the expected 503 from unconfigured Google sign-in |

## Defect register

| ID | Severity | Status | Finding | Proposed fix |
|---|---|---|---|---|
| DEF-001 | **High** | open: **your decision** | Platform admins get org_admin in every organization and bypass row-level security (`AccessService.roleIn`, `TenantScopeInterceptor`). The console tells them "no access to their data" | Remove the bypass (platform routes only), or keep it with disclosure in the privacy notice and audit of every use |
| DEF-006 | **High** | open | `caddy:2.10`, the only HTTPS entry point: 6 critical / 100 high, 105 fixable, in its Alpine 3.22.3 packages (OpenSSL, curl, musl, libcap) | Newer Caddy image, or an `apk upgrade` layer; gate it |
| DEF-007 | **High** | open | EMQX image (`emqx/emqx:5.8.9`, Debian 13.2), internet-facing on 8883: 9 critical / 212 high, 114 fixable (GnuTLS, OpenSSL, …) | `apt-get upgrade` layer in `Dockerfile.emqx`, or a newer 5.8 patch image (check licence terms for newer minors) |
| DEF-004 | Medium | open | Console CSP has no `default-src`/`script-src`, so no XSS protection (ZAP 10055) | Explicit CSP including Google sign-in; browser-test before deploy |
| DEF-005 | Medium | open | Console nginx master runs as root (Trivy DS-0002, confirmed `uid=0` in CI) | Unprivileged nginx on 8080; Caddy → `console:8080` |
| DEF-012 | Medium | open | CI actions pinned by tag, not commit SHA: the exact weakness used in the March 2026 Trivy compromise | Pin every action to a full SHA |
| DEF-009 | Medium (dev only) | open | `vitest` ≤ 4.1.10: 2 critical (tinypool prototype pollution → code execution; mocker path traversal) | Upgrade to Vitest 5 (major) |
| DEF-002 | Low / open question | not reproduced | Readings sent after an EMQX restart but before the worker re-subscribes could be dropped. Measured 200/200 stored in both restart scenarios | Keep measuring; per-device first-reading check |
| DEF-003 | Low | open | EMQX enforces 65,536 connections; `base.hocon` says 100,000 | Raise the container's open-file limit or document 65,536 (to confirm the cause) |
| DEF-008 | Low | open | `postgres:16`: 2 critical / 147 high, 28 fixable; not reachable from outside the Docker network | Pull the rebuilt image on the next deploy |
| DEF-010 | Low | open | *Rejected data* is shown to viewers, but the API requires engineer, so viewers get a 403 | Hide it for viewers, or allow viewers read access |
| DEF-011 | Low | open | OpenAPI documents PUT/PATCH/DELETE `/api/v1/update` (they answer 404) | Restrict `@All('update')` to GET/POST |
| DEF-013 | Low | open | Missing Cross-Origin-Opener/Resource-Policy and Permissions-Policy headers (ZAP) | Add in nginx / Caddy |
| — | — | **fixed in PR** | `docs/api/openapi.json` missing 14 operations | #29 |
| — | — | **fixed in PR** | Library accepted names the server rejects | #30 |
| — | — | **fixed in PR** | API image: 10 HIGH in the bundled npm CLI; console image: 3 critical / 72+5 high | #32 |

## Production impact

- **Today: none.** Nothing merged or deployed. The Oracle VM, its configuration, DNS, Brevo and the database were not touched. The only external actions were GitHub branches, draft PRs and CI runs on GitHub's runners. The CI stack uses `*.arc.test` names and synthetic data.
- **When merged and deployed** (`sudo arc-deploy`), these change what runs:
  - **#32:** the API/worker image no longer contains npm (nothing in production uses it), and the console runs nginx 1.30 with current Alpine packages. Smoke-test the console and API after the deploy.
  - **#30:** the console serves `ArcCloud-1.0.1.zip`. Boards already flashed are unaffected.
  - **#28, #29, #31, #33, #34:** tests, CI and docs only.

## Notes on method

- Several first CI runs failed because of bugs in the new test harness. Examples: the credentials' topic key, the CA trust for Node, restart detection, a ZAP launch option. Each was fixed and re-run; none was a product defect, and the PR commits say so.
- Findings were verified before being reported. The ZAP High was reproduced locally and accepted only for its route. The Trivy findings were traced to package paths (npm CLI, Alpine, nginx). The EMQX non-root user was confirmed with `id` in CI.
- Two statements in the reference documentation were wrong and have been corrected: platform admins "never see data" (see DEF-001), and the rate limit is per IP **and per route**.

## Week B

Blocked until off-VM backups and external uptime monitoring are working, as agreed. The plan and cost are in #34. Worst case is USD 12.24 for 7 days; the proposed cap is USD 25. The upgrade to Pay As You Go needs your decision.
