// Copy to config.h. Fleet-wide settings ONLY: the same config.h builds the one image every device of this
// type runs, and that image is hosted publicly for OTA. Never put Wi-Fi or device credentials here:
// each device gets those once over USB (serial), stored in its NVS. See arc_dht_mqtt.ino.
#pragma once

#define MQTT_HOST        "mqtt.arcloud.arclabs.in"
#define MQTT_PORT        8883

#define DEVICE_TYPE      "esp32"   // must equal the device type registered in ARC Cloud (OTA releases target it)
#define FIRMWARE_VERSION "1.1.0"   // MAJOR.MINOR.PATCH; bump it for every release (devices refuse downgrades)
#define PUBLISH_INTERVAL_S 15      // default; a device's provisioning line can override it (intervalSeconds)

// Which CA verifies the broker's TLS certificate: ARC_PUBLIC_ROOTS for hosted ARC Cloud.
#define BROKER_CA ARC_PUBLIC_ROOTS

// OTA signing PUBLIC key (ECDSA P-256):  node tools/firmware-sign.mjs header firmware-signing-public.pem
// Until it is set, the device refuses every OTA update (fails closed).
static const char OTA_PUBLIC_KEY_PEM[] = R"PEM(
-----BEGIN PUBLIC KEY-----
...paste firmware-signing-public.pem here...
-----END PUBLIC KEY-----
)PEM";
