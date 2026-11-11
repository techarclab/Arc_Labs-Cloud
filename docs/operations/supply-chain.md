# Supply chain: dependencies, images, Dockerfiles

CI job `supply-chain` (Trivy) and job `security` (`npm audit`, secret scan). Reports go to the job summary and the `supply-chain` artifact: JSON per scan, CycloneDX SBOMs for the API and console images, and the full `npm audit`.

| Scanned | How | Gate (CI fails) |
|---|---|---|
| Application images `api` (also the worker) and `console` | `trivy image` | HIGH/CRITICAL with a fix available |
| `emqx` (our image on `emqx/emqx:5.8.9`) and the infrastructure images in `deploy/oracle/docker-compose.yml` (`postgres:16`, `caddy:2.10`) | `trivy image` | report only: upstream images are fixed by moving to a newer tag |
| npm lockfile, production **and dev** dependencies | `trivy fs --include-dev-deps`, `npm audit` | production HIGH/CRITICAL (`security` job); dev dependencies reported |
| Dockerfiles | `trivy config` | report only |

**Trivy itself:** installed as the pinned v0.76.2 binary, with its SHA-256 written in the workflow. On 2026-11-11 the hash was checked against the release's `checksums.txt`. The official `trivy-action` and `setup-trivy` actions are not used: their tags, and Trivy v0.69.4, were compromised in March 2026 ([GHSA-69fq-xp46-6x23](https://github.com/aquasecurity/trivy/security/advisories/GHSA-69fq-xp46-6x23)).

## Findings, 2026-11-11 (local runs; image scans need CI)

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
| `Dockerfile.emqx` | DS-0002 (HIGH): no `USER` | Probably a false positive: `emqx/emqx` already sets a non-root user. The CI job prints `id` for each image to confirm |

### CI configuration

- Third-party actions are pinned by tag (`actions/checkout@v4`, `actions/upload-artifact@v4`, `opentofu/setup-opentofu@v1`), not by commit SHA. The Trivy incident is exactly the attack this allows: tags were force-pushed to malicious commits. Pinning to full SHAs is a separate, small change.

Image results get added here from the first CI run.
