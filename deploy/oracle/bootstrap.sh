#!/bin/bash
# One-time setup of a fresh Oracle Cloud Ubuntu 24.04 (aarch64, Ampere A1) VM for ARC Cloud.
#   curl -fsSL https://raw.githubusercontent.com/techarclab/Arc_Labs-Cloud/main/deploy/oracle/bootstrap.sh -o bootstrap.sh
#   sudo bash bootstrap.sh --console-host arcloud.example.com --api-host api.arcloud.example.com \
#        --mqtt-host mqtt.arcloud.example.com --email ops@example.com
# Then: DNS records + Oracle security list (docs/deploy/oracle-free.md), and  sudo arc-deploy
# Safe to run again: it skips what is already done and never overwrites /etc/arc-cloud/config without --force.
set -euo pipefail

REPO="${ARC_REPO:-https://github.com/techarclab/Arc_Labs-Cloud.git}"
CONSOLE_HOST="" API_HOST="" MQTT_HOST="" EMAIL="" FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --console-host) CONSOLE_HOST="$2"; shift 2 ;;
    --api-host) API_HOST="$2"; shift 2 ;;
    --mqtt-host) MQTT_HOST="$2"; shift 2 ;;
    --email) EMAIL="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
log() { echo "[bootstrap] $*"; }
[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }
. /etc/os-release
[ "$ID" = ubuntu ] || { echo "expects Ubuntu (found $ID)" >&2; exit 1; }
[ "$(uname -m)" = aarch64 ] || log "warning: $(uname -m), not aarch64 (Always Free Ampere A1). Continuing."
host_re='^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$'
for h in "$CONSOLE_HOST" "$API_HOST" "$MQTT_HOST"; do
  [[ "$h" =~ $host_re ]] || { echo "pass --console-host, --api-host and --mqtt-host (lower-case host names)" >&2; exit 2; }
done
[[ "$EMAIL" == *@*.* ]] || { echo "pass --email (Let's Encrypt account contact)" >&2; exit 2; }

log "1/6 system packages and security updates"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get upgrade -yq
apt-get install -yq ca-certificates curl git python3 openssl unattended-upgrades iptables-persistent netfilter-persistent

log "2/6 Docker Engine + Compose (Docker's official apt repository)"
if ! command -v docker > /dev/null || ! docker compose version > /dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -yq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker

log "3/6 host firewall: allow 80, 443, 8883 (Oracle's Ubuntu image rejects everything but SSH)"
# Oracle images ship iptables rules ending in a REJECT; insert the ACCEPTs before it and persist them.
for port in 80 443 8883; do
  if ! iptables -C INPUT -p tcp -m state --state NEW --dport "$port" -j ACCEPT 2> /dev/null; then
    pos="$(iptables -L INPUT --line-numbers -n | awk '$2 == "REJECT" { print $1; exit }')"
    if [ -n "$pos" ]; then
      iptables -I INPUT "$pos" -p tcp -m state --state NEW --dport "$port" -j ACCEPT
    else
      iptables -A INPUT -p tcp -m state --state NEW --dport "$port" -j ACCEPT
    fi
  fi
done
netfilter-persistent save > /dev/null

log "4/6 automatic security updates, reboot if needed at 03:30 IST"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
cat > /etc/apt/apt.conf.d/52arc-cloud-reboot <<'EOF'
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "22:00";
EOF

log "5/6 code in /opt/arc-cloud"
if [ ! -d /opt/arc-cloud/.git ]; then
  git clone --depth 1 "$REPO" /opt/arc-cloud
fi
install -m 0755 /opt/arc-cloud/deploy/oracle/arc-deploy.sh /usr/local/bin/arc-deploy

log "6/6 settings in /etc/arc-cloud/config"
install -d -m 0700 /etc/arc-cloud
if [ -f /etc/arc-cloud/config ] && [ "$FORCE" -ne 1 ]; then
  log "/etc/arc-cloud/config exists; left unchanged (use --force to replace)"
else
  umask 077
  cat > /etc/arc-cloud/config <<EOF
CONSOLE_HOST=$CONSOLE_HOST
API_HOST=$API_HOST
MQTT_HOST=$MQTT_HOST
ACME_EMAIL=$EMAIL
EOF
fi
[ -f /etc/arc-cloud/extra.env ] || printf 'ALLOW_SIGNUP=false\n' > /etc/arc-cloud/extra.env

ip="$(curl -fsS --max-time 5 https://checkip.amazonaws.com 2> /dev/null || echo '<this VM public IP>')"
cat <<EOF

[bootstrap] done. Next (docs/deploy/oracle-free.md):
  1. Oracle console -> the VM's subnet -> Security List: allow TCP 80, 443, 8883 from 0.0.0.0/0.
  2. DNS (Wix): A records  ${CONSOLE_HOST}, ${API_HOST}, ${MQTT_HOST}  ->  ${ip}
  3. Once they resolve to ${ip}:   sudo arc-deploy
EOF
