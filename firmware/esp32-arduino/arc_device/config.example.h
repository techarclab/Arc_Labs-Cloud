// Copy to config.h and fill in. Never commit config.h (it holds this device's secret).
#pragma once

#define WIFI_SSID      "your-wifi"
#define WIFI_PASSWORD  "your-wifi-password"

// From the POST /api/v1/devices response → credentials
#define MQTT_HOST        "192.168.1.20"   // your computer's LAN IP for local dev (must be in the cert SAN)
#define MQTT_PORT        8883
#define DEVICE_ID        "00000000-0000-0000-0000-000000000000"
#define DEVICE_PASSWORD  "paste-the-one-time-password"
#define TOPIC_TELEMETRY  "arc/v1/<orgId>/<projectId>/<deviceId>/telemetry"
#define TOPIC_STATE      "arc/v1/<orgId>/<projectId>/<deviceId>/state"
#define TOPIC_COMMANDS   "arc/v1/<orgId>/<projectId>/<deviceId>/cmd"
#define TOPIC_ACK        "arc/v1/<orgId>/<projectId>/<deviceId>/cmd-ack"

#define FIRMWARE_VERSION "1.0.0"
#define PUBLISH_INTERVAL_MS 10000   // keep in line with the device's expectedIntervalSeconds

// Contents of infra/certs/out/ca.crt (dev) or your production CA.
static const char CA_CERT[] = R"PEM(
-----BEGIN CERTIFICATE-----
...paste ca.crt here...
-----END CERTIFICATE-----
)PEM";
