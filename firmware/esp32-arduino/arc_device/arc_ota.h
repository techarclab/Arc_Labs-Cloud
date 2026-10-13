// ARC Cloud OTA for ESP32: download the image over HTTPS, check size + SHA-256 from the
// (server-verified, signed) manifest, and only then switch the boot partition.
#pragma once
#include <HTTPClient.h>
#include <Update.h>
#include <WiFiClientSecure.h>
#include "mbedtls/sha256.h"

// Returns "" on success (caller acks ok and restarts), otherwise the reason (caller acks error).
inline String arcOtaInstall(const char *url, const char *expectedSha256, size_t expectedSize) {
  WiFiClientSecure tls;
  tls.setInsecure();  // integrity comes from the SHA-256 below; set a CA here to also authenticate the host
  HTTPClient http;
  http.setTimeout(15000);
  if (!http.begin(tls, url)) return "cannot open url";
  int code = http.GET();
  if (code != 200) { http.end(); return String("download HTTP ") + code; }
  int len = http.getSize();
  if (len > 0 && (size_t)len != expectedSize) { http.end(); return "size mismatch"; }
  if (!Update.begin(expectedSize)) { http.end(); return "not enough space for the update"; }

  mbedtls_sha256_context sha;
  mbedtls_sha256_init(&sha);
  mbedtls_sha256_starts(&sha, 0);
  WiFiClient *stream = http.getStreamPtr();
  uint8_t buf[1024];
  size_t total = 0;
  unsigned long lastData = millis();
  while (total < expectedSize && millis() - lastData < 20000) {
    size_t avail = stream->available();
    if (!avail) { delay(5); continue; }
    int n = stream->readBytes(buf, min(avail, sizeof buf));
    if (n <= 0) continue;
    lastData = millis();
    mbedtls_sha256_update(&sha, buf, n);
    if (Update.write(buf, n) != (size_t)n) { Update.abort(); http.end(); return "flash write failed"; }
    total += n;
  }
  http.end();
  uint8_t digest[32];
  mbedtls_sha256_finish(&sha, digest);
  mbedtls_sha256_free(&sha);
  if (total != expectedSize) { Update.abort(); return "download incomplete"; }
  char hex[65];
  for (int i = 0; i < 32; i++) sprintf(hex + i * 2, "%02x", digest[i]);
  if (strcasecmp(hex, expectedSha256) != 0) { Update.abort(); return "SHA-256 mismatch: image rejected"; }
  if (!Update.end(true)) return String("update failed: ") + Update.errorString();
  return "";
}
