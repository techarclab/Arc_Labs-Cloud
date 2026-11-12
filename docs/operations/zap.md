# OWASP ZAP

CI job `zap`. It runs only against the **isolated production stack inside the GitHub runner** (`tests/stack/up.sh`): host names `*.arc.test`, resolved to 127.0.0.1. It never runs against `arcloud.arclabs.in`, because an active scan sends attack payloads, creates data and uses up rate limits and email quota.

1. `tests/stack/seed.ts` creates an organization admin with a channel, fields, a command type and a device, so requests reach real handlers. The token stays in a file on the runner.
2. **Passive baseline** (`zap-baseline.py`) of the console and the API: headers, cookies, information leaks.
3. **Authenticated active scan** (`zap-api-scan.py`) of every operation in the API's own OpenAPI spec, as that admin: injection, path traversal, server errors and so on. It is capped at 25 minutes.
4. `tools/zap-report.mjs` writes the summary and **fails on any High-risk alert** not listed, with a reason, in `security/zap/accepted.tsv`. Medium and lower are reported.

Reports (HTML and JSON) are in the `zap-reports` artifact.

## Evidence

| Date | Run | High | Medium | Low | Notes |
|---|---|---|---|---|---|
| 2026-11-11 | [run 43003244247](https://github.com/techarclab/Arc_Labs-Cloud/actions/runs/43003244247) | 1 (false positive, accepted for that route only) | 2 | 6 | console Content-Security-Policy and cross-origin headers; see below |

## Findings, 2026-11-11

| Risk | Alert | Where | Assessment |
|---|---|---|---|
| High | SQL Injection (40018), param `maxApiKeys`, attack `10 AND 1=1 -- ` / `10 AND 1=2 -- ` | `PATCH /api/v1/organizations/{id}/plan` | **False positive, reproduced.** Against a local API, the true, false and original payloads got byte-identical answers (`400 Validation failed (uuid is expected)`): the UUID pipe rejects ZAP's literal `id` before the handler runs. The body is zod-validated and the query parameterised, and the scanning user would be refused 403 before any SQL anyway. In a burst of 320 requests the same route answered 297 × 400, then 23 × 429 (per-route limit of 300/min): the only varying response, and what ZAP read as a boolean difference. Accepted in `accepted.tsv` for this rule on this route only |
| Medium (ZAP) → **Low** | CSP: Wildcard Directive; CSP: `style-src 'unsafe-inline'` | console | **Corrected 2026-11-12.** I first wrote that the console had no XSS protection. That was wrong: ZAP read only the HTTP header (`frame-ancestors`, `object-src`, `base-uri`), and so did I. The full policy was always delivered as a `<meta>` tag at build time (`consoleCsp()` in `apps/console/vite.config.ts`): `default-src 'self'`, scripts only from the console and Google sign-in, no inline scripts or eval. What remains is by design: `style-src 'unsafe-inline'` (user CSS in sandboxed custom boards) and `img-src`/`font-src https:` (map tiles, board images). Since PR #39 the header also carries the full policy, checked against the meta tag by `apps/console/test/csp.test.ts` and in Chromium by the stack suite |
| Low | Cross-Origin-Opener/Embedder/Resource-Policy missing | console and API | CORP added in PR #39 (`same-origin` console, `same-site` API). COOP stays `same-origin-allow-popups`, which Google sign-in's popup needs; ZAP only accepts `same-origin`. COEP is not set: it would block Google sign-in's iframe and map tiles |
| Low | Permissions-Policy not set | console `/assets/*` | Was set on pages but not on asset responses; added in PR #39 |
| Low | Server error on `POST /auth/google` | API | Expected in CI: Google sign-in is not configured there, and the API answers 503 `google_signin_unconfigured` on purpose |

No injection, path traversal, authentication bypass or information-disclosure alert was raised on the 112 API operations.
