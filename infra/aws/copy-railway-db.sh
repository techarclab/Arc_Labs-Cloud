#!/bin/sh
# Runs inside an isolated one-off ECS task. The task role can read only its temporary S3 dump;
# the ECS execution role injects AWS_DATABASE_URL from Secrets Manager.
set -eu

apk add --no-cache aws-cli >/dev/null
aws s3 cp "s3://$BACKUP_BUCKET/railway.dump" /tmp/railway.dump --only-show-errors
test -s /tmp/railway.dump
pg_restore --list /tmp/railway.dump >/dev/null

mkdir -p /tmp/certs
wget -q -O /tmp/certs/rds-global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
test -s /tmp/certs/rds-global-bundle.pem
DST=$(printf %s "$AWS_DATABASE_URL" | sed 's#sslrootcert=[^&]*#sslrootcert=/tmp/certs/rds-global-bundle.pem#')
ADMIN=$(printf %s "$DST" | sed 's#/arc_cloud?#/postgres?#')

echo "== Replacing the AWS database with the supplied Railway dump"
psql "$ADMIN" -v ON_ERROR_STOP=1 -q \
  -c 'DROP DATABASE IF EXISTS arc_cloud WITH (FORCE)' \
  -c 'CREATE DATABASE arc_cloud'
pg_restore --no-owner --no-privileges --file=/tmp/restore.sql /tmp/railway.dump
# PostgreSQL 18 dumps include a setting unknown to the stack's PostgreSQL 16 RDS target.
sed -i '/^SET transaction_timeout = /d' /tmp/restore.sql
psql "$DST" -v ON_ERROR_STOP=1 --file=/tmp/restore.sql

echo "== Rows restored to AWS"
Q="SELECT 'users', count(*) FROM users UNION ALL SELECT 'organizations', count(*) FROM organizations
   UNION ALL SELECT 'channels', count(*) FROM projects UNION ALL SELECT 'devices', count(*) FROM devices
   UNION ALL SELECT 'readings', count(*) FROM telemetry_measurements UNION ALL SELECT 'alerts', count(*) FROM alerts"
psql "$DST" -XtA -F' ' -v ON_ERROR_STOP=1 -c "$Q"
echo IMPORT-OK
