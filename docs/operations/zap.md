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
| — | first CI run pending | | | | |
