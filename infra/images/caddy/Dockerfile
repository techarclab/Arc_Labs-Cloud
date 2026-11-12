# Caddy for the Oracle VM: the official image plus Alpine's security updates. The upstream image lags behind them
# (Trivy, 2026-11-11: 6 critical / 100 high fixable, in OpenSSL, curl, musl, libcap, c-ares). Built, not pulled, so
# arc-deploy's `compose build --pull` refreshes it on every deploy; CI's Trivy gate fails if a fixable HIGH remains.
FROM caddy:2.10
RUN apk upgrade --no-cache
