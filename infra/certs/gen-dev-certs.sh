#!/usr/bin/env bash
# Generates a local development CA and an MQTT server certificate for EMQX.
# Output: infra/certs/out/{ca.crt,ca.key,server.crt,server.key}
# Production: use certificates from a real CA (e.g. ACM Private CA or Let's Encrypt on your broker domain).
set -euo pipefail
# Git Bash (MSYS) rewrites "/O=..." arguments into Windows paths; turn that off.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL="*"

cd "$(dirname "$0")"
OUT=out
mkdir -p "$OUT"

HOST_IP="${HOST_IP:-}"
HOST_DNS="${HOST_DNS:-}"   # e.g. the Railway TCP proxy domain: xxxx.proxy.rlwy.net
SAN="DNS:localhost,DNS:emqx,DNS:mqtt.local,IP:127.0.0.1"
[ -n "$HOST_IP" ] && SAN="$SAN,IP:$HOST_IP"
[ -n "$HOST_DNS" ] && SAN="$SAN,DNS:$HOST_DNS"

if [ ! -f "$OUT/ca.key" ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 1825 \
    -keyout "$OUT/ca.key" -out "$OUT/ca.crt" -subj "/O=ARC LABS Dev/CN=ARC Cloud Dev CA" >/dev/null 2>&1
  echo "created dev CA: $OUT/ca.crt"
fi

openssl req -newkey rsa:2048 -nodes -keyout "$OUT/server.key" -out "$OUT/server.csr" \
  -subj "/O=ARC LABS Dev/CN=localhost" >/dev/null 2>&1
printf "subjectAltName=%s\nextendedKeyUsage=serverAuth\n" "$SAN" > "$OUT/server.ext"
openssl x509 -req -in "$OUT/server.csr" -CA "$OUT/ca.crt" -CAkey "$OUT/ca.key" -CAcreateserial \
  -out "$OUT/server.crt" -days 825 -sha256 -extfile "$OUT/server.ext" >/dev/null 2>&1
rm -f "$OUT/server.csr" "$OUT/server.ext"
chmod 644 "$OUT"/*.crt "$OUT/server.key"

echo "server cert SAN: $SAN"
echo "Devices on your LAN (e.g. an ESP32) need your machine's IP in the SAN:"
echo "  HOST_IP=192.168.1.20 npm run certs:dev"
