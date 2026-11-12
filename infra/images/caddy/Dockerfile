# Caddy for the Oracle VM: the 2.11 release line plus Alpine's security updates. Trivy (2026-11-12) found the 2.10
# image's Caddy binary built with Go 1.24/1.25 and old golang.org/x modules (68 fixable HIGH/CRITICAL, fixed in Caddy
# 2.11.x), and its Alpine packages behind (OpenSSL, curl, musl, libcap, c-ares). Built, not pulled, so arc-deploy's
# `compose build --pull` refreshes it on every deploy; CI's Trivy gate fails if a fixable HIGH remains.
FROM caddy:2.11
RUN apk upgrade --no-cache
