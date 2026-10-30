#!/bin/bash
# Publishes what the outside-in Route 53 checks cannot see, as CloudWatch metrics in namespace ARC/Cloud
# (alarms: infra/terraform/pilot/uptime.tf). Run every 5 minutes by arc-monitor.timer; manual: sudo arc-monitor
#
#   CertDaysLeft{Host=api.…}   days until the certificate served on :443 expires
#   CertDaysLeft{Host=mqtt.…}  days until the certificate EMQX serves on :8883 expires (catches a failed arc-cert-sync)
#   WorkerReady                1 when the ingestion worker reports database + broker OK, else 0
#
# Why: Let's Encrypt stopped sending expiry emails in June 2025, and Caddy renewing its own certificate says
# nothing about the copy EMQX serves. The worker has no public endpoint, so only the server can ask it.
# WorkerReady is sent on every run, so its alarm (missing data = alarm) also fires if this monitor stops.
set -uo pipefail
# shellcheck source=/dev/null
. /etc/arc-cloud/config

NS="ARC/Cloud"
WORKER_HEALTH_PORT="${WORKER_HEALTH_PORT:-9100}"
log() { echo "[arc-monitor] $*"; }

# Days until the certificate served at host:port expires (via the public name, as devices see it); -1 if none.
cert_days() {
  local host="$1" port="$2" end epoch
  end="$(echo | timeout 10 openssl s_client -connect "$host:$port" -servername "$host" 2>/dev/null |
    openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)"
  [ -n "$end" ] || { echo -1; return; }
  epoch="$(date -d "$end" +%s 2>/dev/null)" || { echo -1; return; }
  echo $(((epoch - $(date +%s)) / 86400))
}

api_days="$(cert_days "$API_HOST" 443)"
mqtt_days="$(cert_days "$MQTT_HOST" 8883)"

worker=0
if docker exec arc-cloud-worker-1 wget -qO- -T 5 "http://127.0.0.1:$WORKER_HEALTH_PORT/health/ready" >/dev/null 2>&1; then
  worker=1
fi

log "cert days: $API_HOST=$api_days $MQTT_HOST=$mqtt_days; worker ready=$worker"

aws cloudwatch put-metric-data --region "$AWS_REGION" --namespace "$NS" --metric-data \
  "MetricName=CertDaysLeft,Dimensions=[{Name=Host,Value=$API_HOST}],Value=$api_days,Unit=Count" \
  "MetricName=CertDaysLeft,Dimensions=[{Name=Host,Value=$MQTT_HOST}],Value=$mqtt_days,Unit=Count" \
  "MetricName=WorkerReady,Value=$worker,Unit=Count"
