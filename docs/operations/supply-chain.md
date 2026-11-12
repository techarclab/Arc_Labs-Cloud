# Supply chain: dependencies, images, Dockerfiles

CI job `supply-chain` (Trivy) and job `security` (`npm audit`, secret scan). Reports go to the job summary and the `supply-chain` artifact: JSON per scan, CycloneDX SBOMs for the API and console images, and the full `npm audit`.

| Scanned | How | Gate (CI fails) |
|---|---|---|
| Application images `api` (also the worker) and `console` | `trivy image` | HIGH/CRITICAL with a fix available |
| `emqx` (our image on `emqx/emqx:5.8.9`) and the infrastructure images in `deploy/oracle/docker-compose.yml` (`postgres:16`, `caddy:2.10`) | `trivy image` | report only: upstream images are fixed by moving to a newer tag |
| npm lockfile, production **and dev** dependencies | `trivy fs --include-dev-deps`, `npm audit` | production HIGH/CRITICAL (`security` job); dev dependencies reported |
| Dockerfiles | `trivy config` | report only |

**Trivy itself:** installed as the pinned v0.76.2 binary, with its SHA-256 written in the workflow. On 2026-11-11 the hash was checked against the release's `checksums.txt`. The official `trivy-action` and `setup-trivy` actions are not used: their tags, and Trivy v0.69.4, were compromised in March 2026 ([GHSA-69fq-xp46-6x23](https://github.com/aquasecurity/trivy/security/advisories/GHSA-69fq-xp46-6x23)).

## Image results (CI, 2026-11-11, Trivy 0.76.2)

| Image | Critical | High | Medium | Low | High+ with a fix | Runs as | Gate |
|---|---|---|---|---|---|---|---|
| `api` / worker, after removing npm | 0 | 0 | 2 | 0 | 0 | `node` (uid 1000) | **pass** |
| `console`, after `nginx:1.30-alpine` + `apk upgrade` | 0 | 0 | 0 | 0 | 0 | **root** | **pass** |
| `emqx` (on `emqx/emqx:5.8.9`, Debian 13.2) | 9 | 212 | 267 | 250 | 114 | `emqx` (uid 1000) | report |
| `caddy:2.10` (**internet-facing**) | 6 | 100 | 112 | 46 | 105 | — | report |
| `postgres:16` | 2 | 147 | 174 | 144 | 28 | — | report |
| npm lockfile, all dependencies | 2 (dev: vitest/tinypool) | 0 | 7 | 0 | 2 | — | prod gate in `security` job: pass |

**How the application images got to zero:**
- **API:** the first scan had 10 HIGH, all in dependencies of the npm CLI bundled in `node:22-alpine` (pacote, sigstore, brace-expansion, ip-address, picomatch). npm, npx, yarn and corepack are now removed from the runtime stage; nothing at runtime uses them.
- **Console:** the first scan had 3 critical and 72 high, all in Alpine packages (OpenSSL, curl, expat, brotli, c-ares). After `apk upgrade`, 5 HIGH remained in the nginx package itself (1.28.3-r1). The move to the 1.30 stable image cleared those.

**Upstream images (not gated, need action):**
- **Caddy** is the only container reachable from the internet. Its listed fixable findings are in the image's Alpine 3.22.3 packages (OpenSSL `libssl3`/`libcrypto3`, curl, musl, libcap, c-ares). The log list is capped at 150 rows, so check the JSON report for findings in the Caddy binary itself. Fix: a newer `caddy:2.x` image, or the same `apk upgrade` layer as the console in a small `Dockerfile.caddy`. Re-scan either way.
- **EMQX:** the fixable findings are Debian packages (GnuTLS, OpenSSL, brotli, …) in the 5.8.9 base. A newer EMQX patch image, or an `apt-get upgrade` layer in `Dockerfile.emqx` like the console fix, would clear most of them. Check EMQX's licence terms before moving to a newer minor version.
- **Postgres:** 28 fixable. `postgres:16` is a floating tag, so the next deploy that pulls it picks up rebuilt images.

## Findings, 2026-11-11 (local runs)

### npm audit, all dependencies: 7 advisories

| Package | Severity | Production or dev | Path | Fix |
|---|---|---|---|---|
| `vitest` ≤ 4.1.10 (`tinypool` prototype pollution → code execution; `@vitest/mocker` path traversal) | **critical** ×2, moderate | dev (test runner) | direct | `vitest` 5.x: a major upgrade |
| `nodemailer` 10.1.0 (address-parser recipient injection) | moderate | **dev**: pulled by `smtp-server`, the e2e mail sink. The worker's own `nodemailer` is 10.2.1, outside the vulnerable range | `smtp-server` | `npm audit fix` |
| `js-yaml` 5.3.0 (CPU use with merge keys) | moderate | production, via `@nestjs/swagger`, which only *writes* YAML; no untrusted YAML is parsed | `@nestjs/swagger` | `npm audit fix` |

The production gate (`npm audit --omit=dev --audit-level=high`) passes. The dev-dependency criticals can't be exploited through the deployed service, because Vitest doesn't ship in the images. They do matter on developer machines and CI runners that run tests on untrusted pull requests.

### Dockerfiles (`trivy config`)

| File | Finding | Assessment |
|---|---|---|
| `Dockerfile.console` | DS-0002 (HIGH): no `USER`, so nginx's master process runs as root | **Real.** Fix: an unprivileged nginx image on port 8080, with Caddy pointing to `console:8080` |
| `Dockerfile.emqx` | DS-0002 (HIGH): no `USER` | **False positive, confirmed in CI:** the image runs as `uid=1000(emqx)`, set by the `emqx/emqx` base |

### CI configuration

- Third-party actions are pinned by tag (`actions/checkout@v4`, `actions/upload-artifact@v4`, `opentofu/setup-opentofu@v1`), not by commit SHA. The Trivy incident is exactly the attack this allows: tags were force-pushed to malicious commits. Pinning to full SHAs is a separate, small change.

