# PostgreSQL for the Oracle VM: the official 16 image plus Debian's security updates, running as `postgres` (uid 999)
# from the start instead of root. Same major version and data format; built, not pulled, so every deploy
# (`compose build --pull`) refreshes it.
#
# Non-root: the official entrypoint only uses gosu to drop from root to postgres; started as postgres it never calls
# it, so gosu is deleted. It was also the image's only Go binary, and carried 26 fixable HIGH/CRITICAL in its Go 1.24
# standard library (Trivy, 2026-11-12). Works because the data directory and the secret files are owned by 999
# (arc-deploy.sh, write-env.py), and /var/run/postgresql is writable by postgres in the official image.
FROM postgres:16
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get -y upgrade \
 && rm -rf /var/lib/apt/lists/* \
 && rm -f /usr/local/bin/gosu
USER postgres
