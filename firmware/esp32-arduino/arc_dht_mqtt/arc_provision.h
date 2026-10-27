// Per-device settings kept in NVS (non-volatile storage), provisioned once over USB serial.
//
// Why: config.h is compiled into the firmware image, and one image serves every device of a type and is
// hosted publicly for OTA. Wi-Fi and device credentials therefore must not be in the image. NVS survives
// OTA updates and normal USB uploads (it is erased only by "Erase All Flash Before Sketch Upload" or
// FACTORY-RESET).
//
// Serial commands (115200 baud, Serial Monitor line ending "New Line"):
//   PROVISION {"deviceId":"…","devicePassword":"…","topicBase":"arc/v1/<org>/<project>/<device>",
//              "wifiSsid":"…","wifiPassword":"…","intervalSeconds":15}
//       Any subset of keys updates only those settings. The console's "ESP32 over USB" tab prints the line.
//       Saves, then reboots.
//   STATUS          what is stored (secrets are never printed)
//   FACTORY-RESET   erases every stored setting, then reboots
#pragma once
#include <Preferences.h>
#include <ArduinoJson.h>

struct ArcSettings {
  String wifiSsid, wifiPassword, deviceId, devicePassword, topicBase;
  uint32_t intervalS = 0;
  bool complete() const { return wifiSsid.length() && deviceId.length() && devicePassword.length() && topicBase.length(); }
};

static ArcSettings arcCfg;
static const char *ARC_NVS_NS = "arc";

inline void arcLoadSettings(uint32_t defaultIntervalS) {
  Preferences p;
  p.begin(ARC_NVS_NS, true);
  arcCfg.wifiSsid = p.getString("wifi_ssid", "");
  arcCfg.wifiPassword = p.getString("wifi_pass", "");
  arcCfg.deviceId = p.getString("dev_id", "");
  arcCfg.devicePassword = p.getString("dev_pass", "");
  arcCfg.topicBase = p.getString("topic_base", "");
  arcCfg.intervalS = p.getUInt("interval_s", defaultIntervalS);
  p.end();
}

inline bool arcIsUuid(const char *s) {
  if (strlen(s) != 36) return false;
  for (int i = 0; i < 36; i++) {
    bool dash = (i == 8 || i == 13 || i == 18 || i == 23);
    if (dash ? s[i] != '-' : !isxdigit((unsigned char)s[i])) return false;
  }
  return true;
}

// Validates and stores a PROVISION payload. Returns "" on success, or what is wrong.
inline String arcApplyProvision(const char *json) {
  JsonDocument doc;
  if (deserializeJson(doc, json)) return "not valid JSON";
  ArcSettings next = arcCfg;
  if (doc["wifiSsid"].is<const char *>()) next.wifiSsid = (const char *)doc["wifiSsid"];
  if (doc["wifiPassword"].is<const char *>()) next.wifiPassword = (const char *)doc["wifiPassword"];
  if (doc["deviceId"].is<const char *>()) next.deviceId = (const char *)doc["deviceId"];
  if (doc["devicePassword"].is<const char *>()) next.devicePassword = (const char *)doc["devicePassword"];
  if (doc["topicBase"].is<const char *>()) next.topicBase = (const char *)doc["topicBase"];
  if (doc["intervalSeconds"].is<uint32_t>()) next.intervalS = doc["intervalSeconds"].as<uint32_t>();

  if (next.wifiSsid.length() == 0 || next.wifiSsid.length() > 32) return "wifiSsid must be 1-32 characters";
  if (next.wifiPassword.length() > 63) return "wifiPassword must be at most 63 characters";
  if (!arcIsUuid(next.deviceId.c_str())) return "deviceId must be the device UUID from ARC Cloud";
  if (next.devicePassword.length() == 0 || next.devicePassword.length() > 128) return "devicePassword missing";
  if (!next.topicBase.startsWith("arc/v1/") || !next.topicBase.endsWith("/" + next.deviceId)) return "topicBase must be arc/v1/<org>/<project>/<deviceId>";
  if (next.intervalS < 5 || next.intervalS > 86400) return "intervalSeconds must be 5-86400";

  Preferences p;
  if (!p.begin(ARC_NVS_NS, false)) return "could not open NVS";
  p.putString("wifi_ssid", next.wifiSsid);
  p.putString("wifi_pass", next.wifiPassword);
  p.putString("dev_id", next.deviceId);
  p.putString("dev_pass", next.devicePassword);
  p.putString("topic_base", next.topicBase);
  p.putUInt("interval_s", next.intervalS);
  p.end();
  arcCfg = next;
  return "";
}

inline void arcPrintStatus() {
  Serial.printf("firmware %s (%s)\n", FIRMWARE_VERSION, DEVICE_TYPE);
  Serial.printf("wifi     %s\n", arcCfg.wifiSsid.length() ? arcCfg.wifiSsid.c_str() : "(not set)");
  Serial.printf("device   %s\n", arcCfg.deviceId.length() ? arcCfg.deviceId.c_str() : "(not set)");
  Serial.printf("password %s\n", arcCfg.devicePassword.length() ? "(set)" : "(not set)");
  Serial.printf("topics   %s/…\n", arcCfg.topicBase.length() ? arcCfg.topicBase.c_str() : "(not set)");
  Serial.printf("interval %lu s\n", (unsigned long)arcCfg.intervalS);
}

inline void arcPrintProvisionHelp() {
  Serial.println("This device is not provisioned. In ARC Cloud: Devices -> Add device (or Replace password) ->");
  Serial.println("tab \"ESP32 over USB\" -> copy the PROVISION line, put in your Wi-Fi, paste it here and press Enter.");
  Serial.println("(Serial Monitor: 115200 baud, line ending \"New Line\".)");
}

// Reads serial input without blocking. Call it often (also while waiting for Wi-Fi or MQTT).
inline void arcPollSerial() {
  static char line[1024];
  static size_t len = 0;
  static bool overflow = false;
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\r' || c == '\n') {
      if (len == 0 && !overflow) continue;
      line[len] = 0;
      if (overflow) {
        Serial.println("input too long; ignored");
      } else if (strncmp(line, "PROVISION ", 10) == 0) {
        String err = arcApplyProvision(line + 10);
        if (err.length()) {
          Serial.printf("PROVISION rejected: %s (nothing was changed)\n", err.c_str());
        } else {
          Serial.println("PROVISION saved. Rebooting...");
          Serial.flush();
          delay(300);
          ESP.restart();
        }
      } else if (strcmp(line, "STATUS") == 0) {
        arcPrintStatus();
      } else if (strcmp(line, "FACTORY-RESET") == 0) {
        Preferences p;
        p.begin(ARC_NVS_NS, false);
        p.clear();
        p.end();
        Serial.println("All settings erased. Rebooting...");
        Serial.flush();
        delay(300);
        ESP.restart();
      } else {
        Serial.println("commands: PROVISION {json} | STATUS | FACTORY-RESET");
      }
      len = 0;
      overflow = false;
    } else if (len < sizeof(line) - 1) {
      line[len++] = c;
    } else {
      overflow = true;
    }
  }
}
