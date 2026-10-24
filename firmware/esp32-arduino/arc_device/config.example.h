// Copy to config.h and fill in. Never commit config.h (it holds this device's secret).
#pragma once

#define WIFI_SSID      "your-wifi"
#define WIFI_PASSWORD  "your-wifi-password"

// From the POST /api/v1/devices response → credentials
#define MQTT_HOST        "mqtt.example.com"   // local dev: your computer's LAN IP (must be in the dev cert SAN)
#define MQTT_PORT        8883
#define DEVICE_ID        "00000000-0000-0000-0000-000000000000"
#define DEVICE_PASSWORD  "paste-the-one-time-password"
#define TOPIC_TELEMETRY  "arc/v1/<orgId>/<projectId>/<deviceId>/telemetry"
#define TOPIC_STATE      "arc/v1/<orgId>/<projectId>/<deviceId>/state"
#define TOPIC_COMMANDS   "arc/v1/<orgId>/<projectId>/<deviceId>/cmd"
#define TOPIC_ACK        "arc/v1/<orgId>/<projectId>/<deviceId>/cmd-ack"

#define DEVICE_TYPE      "esp32"   // must equal the device type registered in ARC Cloud (OTA releases target it)
#define FIRMWARE_VERSION "1.0.0"   // MAJOR.MINOR.PATCH; bump it for every release (devices refuse downgrades)
#define PUBLISH_INTERVAL_MS 10000  // keep in line with the device's expectedIntervalSeconds

// Which CA verifies the broker's TLS certificate.
//  - Production (AWS NLB with an ACM certificate, or any Let's Encrypt / Google-issued cert): ARC_PUBLIC_ROOTS
//  - Local Docker: paste infra/certs/out/ca.crt into DEV_CA_CERT below and use DEV_CA_CERT
#define BROKER_CA ARC_PUBLIC_ROOTS
static const char DEV_CA_CERT[] = R"PEM(
-----BEGIN CERTIFICATE-----
...paste infra/certs/out/ca.crt here for local Docker...
-----END CERTIFICATE-----
)PEM";

// OTA signing PUBLIC key (ECDSA P-256). Generate it with:  node tools/firmware-sign.mjs keygen
// then print this block with:                             node tools/firmware-sign.mjs header firmware-signing-public.pem
// Until it is set, the device refuses every OTA update (fails closed).
static const char OTA_PUBLIC_KEY_PEM[] = R"PEM(
-----BEGIN PUBLIC KEY-----
...paste firmware-signing-public.pem here...
-----END PUBLIC KEY-----
)PEM";
