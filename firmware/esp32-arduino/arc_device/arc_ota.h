// ARC Cloud OTA for ESP32 (Arduino core 2.x and 3.x).
//
// Trust model: the device trusts ONLY the OTA signing public key compiled into it (OTA_PUBLIC_KEY_PEM).
// The cloud, broker and network are not trusted for firmware integrity. Before anything is written to flash:
//   1. the ECDSA P-256 signature is verified over the exact manifest bytes the cloud sends (`manifest`);
//   2. url, sha256, size and version are taken from that signed manifest only (never the loose fields);
//   3. the manifest's deviceType must equal DEVICE_TYPE, and its version must be NEWER than FIRMWARE_VERSION
//      (a replayed old, signed release cannot downgrade the device);
//   4. the image is downloaded over certificate-verified HTTPS and its size + SHA-256 must match.
// After the new image boots, call arcOtaConfirmBoot() once the device has reached the cloud. If it never does
// (crash loop, bad Wi-Fi code), arcOtaRollbackWatchdog() rolls back to the previous image. Rollback needs the
// bootloader option CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE (on in the Arduino-ESP32 3.x prebuilt bootloader,
// checked on 3.3.12); without it these two calls do nothing.
//
// Required before #include "arc_ota.h":  FIRMWARE_VERSION, DEVICE_TYPE, OTA_PUBLIC_KEY_PEM, and a CA bundle
// passed to arcOtaInstall() for the firmware host (see arc_roots.h).
#pragma once
#include <Arduino.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <Update.h>
#include <WiFiClientSecure.h>
#include "esp_ota_ops.h"
#include "arc_ota_verify.h"

#if !defined(FIRMWARE_VERSION) || !defined(DEVICE_TYPE)
#error "Define FIRMWARE_VERSION and DEVICE_TYPE (the device type registered in ARC Cloud) before including arc_ota.h"
#endif

#ifndef ARC_OTA_CONFIRM_TIMEOUT_MS
#define ARC_OTA_CONFIRM_TIMEOUT_MS (5UL * 60UL * 1000UL)  // new image must reach the cloud within 5 minutes
#endif

// Keep the Arduino core from marking a freshly-updated image valid at boot: we confirm it only after the
// device has proven it can reach the cloud (arcOtaConfirmBoot). Overrides the core's weak default.
extern "C" bool verifyRollbackLater() { return true; }

// Returns "" when the device should flash and restart, "up-to-date" when there is nothing to do (ack ok),
// otherwise the reason the update was refused or failed (ack error with it).
inline String arcOtaInstall(JsonObject payload, const char *caBundle) {
  const char *manifestStr = payload["manifest"] | "";
  const char *signature = payload["signature"] | "";
  if (!*manifestStr || !*signature) return "unsigned manifest: update ARC Cloud";

  const char *sigErr = arcVerifySignatureWithKey(manifestStr, signature, OTA_PUBLIC_KEY_PEM);
  if (sigErr) return sigErr;

  // From here on, every value comes from the signed bytes.
  JsonDocument m;
  if (deserializeJson(m, manifestStr)) return "manifest is not valid JSON";
  const char *deviceType = m["deviceType"] | "";
  const char *version = m["version"] | "";
  const char *url = m["url"] | "";
  const char *expectedSha256 = m["sha256"] | "";
  size_t expectedSize = m["sizeBytes"] | 0;

  if (strcmp(deviceType, DEVICE_TYPE) != 0) return String("release is for device type ") + deviceType;
  int cmp = arcCompareVersions(version, FIRMWARE_VERSION);
  if (cmp == -2) return "version must be MAJOR.MINOR.PATCH";
  if (cmp == 0) return "up-to-date";
  if (cmp < 0) return String("downgrade to ") + version + " refused";
  if (strncmp(url, "https://", 8) != 0) return "firmware url must be https://";
  if (strlen(expectedSha256) != 64 || expectedSize == 0) return "manifest is missing sha256/sizeBytes";

  WiFiClientSecure tls;
  tls.setCACert(caBundle);  // authenticates the firmware host; integrity is already pinned by the signature
  HTTPClient http;
  http.setTimeout(15000);
  if (!http.begin(tls, url)) return "cannot open url";
  int code = http.GET();
  if (code != 200) { http.end(); return String("download HTTP ") + code; }
  int len = http.getSize();
  if (len > 0 && (size_t)len != expectedSize) { http.end(); return "size mismatch"; }
  if (!Update.begin(expectedSize)) { http.end(); return "not enough space for the update"; }

  mbedtls_md_context_t sha;
  mbedtls_md_init(&sha);
  if (mbedtls_md_setup(&sha, mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), 0) != 0 || mbedtls_md_starts(&sha) != 0) {
    mbedtls_md_free(&sha); Update.abort(); http.end(); return "SHA-256 unavailable";
  }
  WiFiClient *stream = http.getStreamPtr();
  uint8_t buf[1024];
  size_t total = 0;
  unsigned long lastData = millis();
  while (total < expectedSize && millis() - lastData < 20000) {
    size_t avail = stream->available();
    if (!avail) { delay(5); continue; }
    size_t want = avail < sizeof buf ? avail : sizeof buf;
    if (want > expectedSize - total) want = expectedSize - total;
    int n = stream->readBytes(buf, want);
    if (n <= 0) continue;
    lastData = millis();
    mbedtls_md_update(&sha, buf, n);
    if (Update.write(buf, n) != (size_t)n) { mbedtls_md_free(&sha); Update.abort(); http.end(); return "flash write failed"; }
    total += n;
  }
  http.end();
  uint8_t digest[32];
  mbedtls_md_finish(&sha, digest);
  mbedtls_md_free(&sha);
  if (total != expectedSize) { Update.abort(); return "download incomplete"; }
  char hex[65];
  for (int i = 0; i < 32; i++) snprintf(hex + i * 2, 3, "%02x", digest[i]);
  if (strcasecmp(hex, expectedSha256) != 0) { Update.abort(); return "SHA-256 mismatch: image rejected"; }
  if (!Update.end(true)) return String("update failed: ") + Update.errorString();
  return "";
}

static int8_t arcOtaPending = -1;  // -1 unknown, 0 no, 1 waiting for confirmation (read from flash once)

static bool arcOtaPendingVerify() {
  if (arcOtaPending < 0) {
    esp_ota_img_states_t state;
    const esp_partition_t *running = esp_ota_get_running_partition();
    arcOtaPending = (running && esp_ota_get_state_partition(running, &state) == ESP_OK && state == ESP_OTA_IMG_PENDING_VERIFY) ? 1 : 0;
  }
  return arcOtaPending == 1;
}

// Call once the new image has connected to the cloud. Safe to call on every connect.
inline void arcOtaConfirmBoot() {
  if (arcOtaPendingVerify()) {
    esp_ota_mark_app_valid_cancel_rollback();
    arcOtaPending = 0;
    Serial.println("OTA: new firmware confirmed");
  }
}

// Call from loop(). Rolls back if a freshly-updated image has not confirmed itself in time.
inline void arcOtaRollbackWatchdog() {
  if (millis() > ARC_OTA_CONFIRM_TIMEOUT_MS && arcOtaPendingVerify()) {
    Serial.println("OTA: new firmware never reached the cloud, rolling back");
    esp_ota_mark_app_invalid_rollback_and_reboot();
  }
}
