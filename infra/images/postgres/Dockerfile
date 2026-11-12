# PostgreSQL for the Oracle VM: the official 16 image plus Debian's security updates (Trivy, 2026-11-11: 28 fixable
# HIGH/CRITICAL in system libraries). Same major version and data format; built, not pulled, so every deploy
# (`compose build --pull`) refreshes it.
FROM postgres:16
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get -y upgrade \
 && rm -rf /var/lib/apt/lists/*
