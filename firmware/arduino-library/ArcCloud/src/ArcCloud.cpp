#include "ArcCloud.h"
#include "ArcCloudFieldName.h"

#include <HTTPClient.h>
#include <Preferences.h>
#include <esp_heap_caps.h>
#include <esp_random.h>
#include <time.h>

#define ARC_LOG(...)                     \
  do {                                   \
    if (verbose_) Serial.printf(__VA_ARGS__); \
  } while (0)

// Same NVS namespace and keys as firmware/esp32-arduino/arc_dht_mqtt, so a board provisioned for one works with the other.
static const char *ARC_NVS = "arc";

static bool isUuid(const char *s) {
  if (strlen(s) != 36) return false;
  for (int i = 0; i < 36; i++) {
    bool dash = (i == 8 || i == 13 || i == 18 || i == 23);
    if (dash ? s[i] != '-' : !isxdigit((unsigned char)s[i])) return false;
  }
  return true;
}

static bool validField(const char *f) { return arcValidFieldName(f); }

// Settings fetched with a device key, kept apart from PROVISION settings ("arc").
static const char *ARC_CFG_NVS = "arc_cfg";

// arc_dk_<32 hex digits>_<secret>  ->  device ID with dashes, and the secret. False when it is not a device key.
static bool splitDeviceKey(const String &raw, String &id, String &secret) {
  String key = raw;
  key.trim();
  if (!key.startsWith("arc_dk_") || key.length() < 7 + 32 + 1 + 16 || key.length() > 140 || key[39] != '_') return false;
  String hex = key.substring(7, 39);
  for (size_t i = 0; i < hex.length(); i++) {
    char c = hex[i];
    if (!isxdigit((unsigned char)c) || (c >= 'A' && c <= 'F')) return false;
  }
  secret = key.substring(40);
  for (size_t i = 0; i < secret.length(); i++) {
    char c = secret[i];
    if (!isalnum((unsigned char)c) && c != '_' && c != '-') return false;
  }
  id = hex.substring(0, 8) + "-" + hex.substring(8, 12) + "-" + hex.substring(12, 16) + "-" + hex.substring(16, 20) + "-" + hex.substring(20);
  return true;
}

// ---------------------------------------------------------------- setup

void ArcCloud::begin(const char *wifiSsid, const char *wifiPassword, const char *deviceId, const char *deviceToken, const char *topic,
                     const char *host, uint16_t port) {
  wifiSsid_ = wifiSsid;
  wifiPassword_ = wifiPassword;
  deviceId_ = deviceId;
  token_ = deviceToken;
  topicBase_ = topic;
  host_ = host;
  port_ = port;
  provisionedMode_ = false;
  start();
}

void ArcCloud::begin(const char *wifiSsid, const char *wifiPassword, const char *deviceKey, const char *apiHost) {
  wifiSsid_ = wifiSsid;
  wifiPassword_ = wifiPassword;
  deviceKey_ = deviceKey;
  deviceKey_.trim();
  apiHost_ = apiHost;
  host_ = ARC_HOST;
  port_ = ARC_PORT;
  provisionedMode_ = false;
  if (splitDeviceKey(deviceKey_, deviceId_, token_)) {
    configFetched_ = false;  // asked from ARC Cloud once Wi-Fi is up
    loadCachedConfig();      // until then (or if that fails): what this board was told last time
  }
  start();
}

void ArcCloud::loadCachedConfig() {
  Preferences p;
  if (!p.begin(ARC_CFG_NVS, true)) return;
  if (p.getString("dev_id", "") == deviceId_) {
    topicBase_ = p.getString("topic_base", "");
    host_ = p.getString("mqtt_host", host_);
    port_ = (uint16_t)p.getUInt("mqtt_port", port_);
    intervalS_ = p.getUInt("interval_s", intervalS_);
  }
  p.end();
}

// GET https://<apiHost>/api/v1/device/config with the device key: topic, broker and interval. The certificate is checked
// against the same pinned roots as the broker's.
bool ArcCloud::fetchConfig() {
  ARC_LOG("[arc] settings from %s... ", apiHost_.c_str());
  HTTPClient http;
  http.setTimeout(10000);
  if (!http.begin(net_, apiHost_.c_str(), 443, "/api/v1/device/config", true)) {
    ARC_LOG("failed to start\n");
    return false;
  }
  http.addHeader("Authorization", "Bearer " + deviceKey_);
  int code = http.GET();
  if (code != 200) {
    if (code == 401) Serial.println("refused: this device key is not valid (replaced, or mistyped). Copy it again from ARC Cloud.");
    else if (code == 403) Serial.println("refused: the device is suspended or revoked in ARC Cloud.");
    else Serial.printf("failed (%d)\n", code);
    http.end();
    if (code < 0) diagnose();
    return false;
  }
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, http.getStream());
  http.end();
  net_.stop();
  const char *base = doc["topicBase"] | "";
  if (err || strcmp(doc["deviceId"] | "", deviceId_.c_str()) != 0 || strncmp(base, "arc/v1/", 7) != 0) {
    ARC_LOG("unexpected answer\n");
    return false;
  }
  topicBase_ = base;
  if (doc["mqttHost"].is<const char *>()) host_ = (const char *)doc["mqttHost"];
  if (doc["mqttPort"].is<uint16_t>()) port_ = doc["mqttPort"].as<uint16_t>();
  if (doc["intervalSeconds"].is<uint32_t>()) intervalS_ = doc["intervalSeconds"].as<uint32_t>();
  mqtt_.setServer(host_.c_str(), port_);
  ARC_LOG("ok (\"%s\")\n", doc["name"] | "");
  Preferences p;
  if (p.begin(ARC_CFG_NVS, false)) {
    // Written only when something changed: flash wears out.
    if (p.getString("dev_id", "") != deviceId_ || p.getString("topic_base", "") != topicBase_ || p.getString("mqtt_host", "") != host_ ||
        p.getUInt("mqtt_port", 0) != port_ || p.getUInt("interval_s", 0) != intervalS_) {
      p.putString("dev_id", deviceId_);
      p.putString("topic_base", topicBase_);
      p.putString("mqtt_host", host_);
      p.putUInt("mqtt_port", port_);
      p.putUInt("interval_s", intervalS_);
    }
    p.end();
  }
  return true;
}

void ArcCloud::beginProvisioned(const char *host, uint16_t port) {
  host_ = host;
  port_ = port;
  provisionedMode_ = true;
  loadSettings();
  start();
}

void ArcCloud::start() {
  bootId_ = esp_random();
  ARC_LOG("\n[arc] ArcCloud %s, firmware %s\n", ARC_CLOUD_LIBRARY_VERSION, firmwareVersion_);
  ready_ = validate();
  if (!ready_) return;
  ARC_LOG("[arc] device %s\n", deviceId_.c_str());
  net_.setCACert(caCert_);  // the server certificate is always checked; there is no insecure fallback
  mqtt_.setServer(host_.c_str(), port_);
  mqtt_.setBufferSize(2048);  // room for commands and signed OTA manifests
  mqtt_.setKeepAlive(30);
  mqtt_.setSocketTimeout(10);
  mqtt_.setCallback([this](char *t, byte *p, unsigned int n) { handleMessage(t, p, n); });
  WiFi.mode(WIFI_STA);
  WiFi.begin(wifiSsid_.c_str(), wifiPassword_.c_str());
  wifiStartedAt_ = millis();
  ARC_LOG("[arc] Wi-Fi \"%s\" connecting\n", wifiSsid_.c_str());
}

bool ArcCloud::validate() {
  const char *problem = nullptr;
  if (wifiSsid_.length() == 0 || wifiSsid_.length() > 32) problem = "Wi-Fi name (SSID) missing";
  else if (deviceKey_.length() && deviceId_.length() == 0) problem = "the device key must be the arc_dk_... key from ARC Cloud, copied whole";
  else if (!isUuid(deviceId_.c_str())) problem = "device ID must be the device's ID from ARC Cloud (36 characters)";
  else if (token_.length() == 0) problem = "device token missing";
  else if (configFetched_ && (!topicBase_.startsWith("arc/v1/") || !topicBase_.endsWith("/" + deviceId_))) problem = "topic must be arc/v1/<org>/<channel>/<device id>";
  if (!problem) return true;
  if (provisionedMode_ && deviceId_.length() == 0) {
    Serial.println("[arc] Not provisioned yet. In ARC Cloud: Devices -> your device -> New device key (or Add device) ->");
    Serial.println("[arc] tab \"ESP32 over USB\" -> copy the PROVISION line, put in your Wi-Fi, paste it here and press Enter.");
    Serial.println("[arc] (Serial Monitor: 115200 baud, line ending \"New Line\".)");
  } else {
    Serial.printf("[arc] SETTINGS ERROR: %s. Copy the values again from ARC Cloud.\n", problem);
  }
  return false;
}

void ArcCloud::loadSettings() {
  Preferences p;
  p.begin(ARC_NVS, true);
  wifiSsid_ = p.getString("wifi_ssid", "");
  wifiPassword_ = p.getString("wifi_pass", "");
  deviceId_ = p.getString("dev_id", "");
  token_ = p.getString("dev_pass", "");
  topicBase_ = p.getString("topic_base", "");
  intervalS_ = p.getUInt("interval_s", 15);
  p.end();
}

// ---------------------------------------------------------------- serial commands

String ArcCloud::applyProvision(const char *json) {
  JsonDocument doc;
  if (deserializeJson(doc, json)) return "not valid JSON";
  String ssid = wifiSsid_, pass = wifiPassword_, id = deviceId_, tok = token_, base = topicBase_;
  uint32_t interval = intervalS_;
  if (doc["wifiSsid"].is<const char *>()) ssid = (const char *)doc["wifiSsid"];
  if (doc["wifiPassword"].is<const char *>()) pass = (const char *)doc["wifiPassword"];
  if (doc["deviceId"].is<const char *>()) id = (const char *)doc["deviceId"];
  if (doc["devicePassword"].is<const char *>()) tok = (const char *)doc["devicePassword"];
  if (doc["deviceKey"].is<const char *>() && !splitDeviceKey(String((const char *)doc["deviceKey"]), id, tok)) return "deviceKey must be the arc_dk_... key from ARC Cloud";
  if (doc["topicBase"].is<const char *>()) base = (const char *)doc["topicBase"];
  if (doc["intervalSeconds"].is<uint32_t>()) interval = doc["intervalSeconds"].as<uint32_t>();
  if (ssid.length() == 0 || ssid.length() > 32) return "wifiSsid must be 1-32 characters";
  if (pass.length() > 63) return "wifiPassword must be at most 63 characters";
  if (!isUuid(id.c_str())) return "deviceId must be the device ID from ARC Cloud";
  if (tok.length() == 0 || tok.length() > 128) return "devicePassword missing";
  if (!base.startsWith("arc/v1/") || !base.endsWith("/" + id)) return "topicBase must be arc/v1/<org>/<channel>/<deviceId>";
  if (interval < 5 || interval > 86400) return "intervalSeconds must be 5-86400";
  Preferences p;
  if (!p.begin(ARC_NVS, false)) return "could not open flash storage (NVS)";
  p.putString("wifi_ssid", ssid);
  p.putString("wifi_pass", pass);
  p.putString("dev_id", id);
  p.putString("dev_pass", tok);
  p.putString("topic_base", base);
  p.putUInt("interval_s", interval);
  p.end();
  return "";
}

void ArcCloud::printStatus() {
  Serial.printf("library  ArcCloud %s, firmware %s\n", ARC_CLOUD_LIBRARY_VERSION, firmwareVersion_);
  Serial.printf("mode     %s\n", provisionedMode_ ? "provisioned (settings in flash)" : "quick start (settings in the sketch)");
  Serial.printf("wifi     %s (%s)\n", wifiSsid_.length() ? wifiSsid_.c_str() : "(not set)", WiFi.status() == WL_CONNECTED ? "connected" : "not connected");
  Serial.printf("device   %s\n", deviceId_.length() ? deviceId_.c_str() : "(not set)");
  Serial.printf("token    %s\n", token_.length() ? "(set)" : "(not set)");  // never printed
  Serial.printf("cloud    %s:%u %s\n", host_.c_str(), port_, mqtt_.connected() ? "connected" : "not connected");
}

// Reads Serial without blocking. Provisioned mode: PROVISION {json} | STATUS | FACTORY-RESET. Quick start: STATUS.
void ArcCloud::pollSerial() {
  static char line[1024];
  static size_t len = 0;
  static bool overflow = false;
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c != '\r' && c != '\n') {
      if (len < sizeof(line) - 1) line[len++] = c;
      else overflow = true;
      continue;
    }
    if (len == 0 && !overflow) continue;
    line[len] = 0;
    if (overflow) {
      Serial.println("[arc] input too long; ignored");
    } else if (strcmp(line, "STATUS") == 0) {
      printStatus();
    } else if (provisionedMode_ && strncmp(line, "PROVISION ", 10) == 0) {
      String err = applyProvision(line + 10);
      if (err.length()) {
        Serial.printf("[arc] PROVISION rejected: %s (nothing was changed)\n", err.c_str());
      } else {
        Serial.println("[arc] PROVISION saved. Restarting...");
        Serial.flush();
        delay(300);
        ESP.restart();
      }
    } else if (provisionedMode_ && strcmp(line, "FACTORY-RESET") == 0) {
      Preferences p;
      p.begin(ARC_NVS, false);
      p.clear();
      p.end();
      Serial.println("[arc] All settings erased. Restarting...");
      Serial.flush();
      delay(300);
      ESP.restart();
    } else if (strncmp(line, "PROVISION ", 10) == 0) {
      Serial.println("[arc] This sketch uses arc.begin(...) with the settings written in it; PROVISION needs arc.beginProvisioned().");
    }
    len = 0;
    overflow = false;
  }
}

// ---------------------------------------------------------------- connection

void ArcCloud::run() {
  pollSerial();
  runTimers();
  if (!ready_) return;
  ensureWiFi();
  if (WiFi.status() != WL_CONNECTED) return;
  ensureMqtt();
  if (mqtt_.connected()) mqtt_.loop();
}

bool ArcCloud::connected() { return ready_ && WiFi.status() == WL_CONNECTED && mqtt_.connected(); }

void ArcCloud::ensureWiFi() {
  if (WiFi.status() == WL_CONNECTED) {
    if (wifiStartedAt_) {
      ARC_LOG("[arc] Wi-Fi ok, ip %s, signal %d dBm\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
      wifiStartedAt_ = 0;
      if (!timeStarted_) {
        configTime(0, 0, "pool.ntp.org", "time.google.com");  // optional: readings get the board's timestamp when known
        timeStarted_ = true;
      }
    }
    return;
  }
  if (wifiStartedAt_ == 0) {  // lost the connection
    ARC_LOG("[arc] Wi-Fi lost, reconnecting\n");
    WiFi.disconnect();
    WiFi.begin(wifiSsid_.c_str(), wifiPassword_.c_str());
    wifiStartedAt_ = millis();
  } else if (millis() - wifiStartedAt_ > 20000) {
    ARC_LOG("[arc] Wi-Fi \"%s\" not connecting: check the name and password, and that it is 2.4 GHz. Retrying.\n", wifiSsid_.c_str());
    WiFi.disconnect();
    WiFi.begin(wifiSsid_.c_str(), wifiPassword_.c_str());
    wifiStartedAt_ = millis();
  }
}

// 5 s, 10 s, 20 s ... capped at 5 min, plus up to 25% jitter: a fleet does not hit the server at the same instant
// after an outage, and routers do not mistake fast retries for an attack.
unsigned long ArcCloud::backoffMs() {
  unsigned long base = 5000UL << (failures_ > 6 ? 6 : failures_);
  if (base > 300000UL) base = 300000UL;
  return base + esp_random() % (base / 4 + 1);
}

void ArcCloud::ensureMqtt() {
  if (mqtt_.connected() || (long)(millis() - nextMqttAttempt_) < 0) return;
  if (!configFetched_) {
    // Device key: ask ARC Cloud where to connect, once per start. Without an answer, use the copy in flash if there is one.
    if (fetchConfig()) {
      configFetched_ = true;
    } else if (topicBase_.length()) {
      ARC_LOG("[arc] using the settings saved on this board\n");
      configFetched_ = true;
      mqtt_.setServer(host_.c_str(), port_);
    } else {
      unsigned long wait = backoffMs();
      failures_++;
      nextMqttAttempt_ = millis() + wait;
      ARC_LOG("[arc] next try in %lu s\n", wait / 1000);
      return;
    }
  }
  ARC_LOG("[arc] cloud %s:%u connecting... ", host_.c_str(), port_);
  // Client ID and username are both the device ID; the token is the password.
  if (mqtt_.connect(deviceId_.c_str(), deviceId_.c_str(), token_.c_str())) {
    ARC_LOG("ok\n");
    failures_ = 0;
    mqtt_.subscribe(topic("/cmd").c_str(), 1);  // ARC Cloud re-sends the current switch values ~2 s after this
    publishState();
    return;
  }
  int rc = mqtt_.state();
  if (rc == 4 || rc == 5) {
    Serial.printf("refused (rc=%d): wrong device key (or ID/token), or the device is suspended/revoked in ARC Cloud\n", rc);
  } else {
    Serial.printf("failed (rc=%d)\n", rc);
    diagnose();
  }
  unsigned long wait = backoffMs();
  failures_++;
  nextMqttAttempt_ = millis() + wait;
  ARC_LOG("[arc] next try in %lu s\n", wait / 1000);
}

// Turns a bare "rc=-2" into the actual cause (DNS, blocked port, TLS, memory), at most every 30 s.
void ArcCloud::diagnose() {
  if (lastDiagnostics_ && millis() - lastDiagnostics_ < 30000) return;
  lastDiagnostics_ = millis();
  IPAddress ip;
  if (!WiFi.hostByName(host_.c_str(), ip) || ip == IPAddress(0, 0, 0, 0)) {
    Serial.printf("[arc] dns: cannot resolve %s (the network's DNS is not answering)\n", host_.c_str());
    return;
  }
  WiFiClient probe;  // plain TCP: separates "port blocked" from a TLS problem
  if (!probe.connect(ip, port_, 5000)) {
    Serial.printf("[arc] tcp: %s:%u not reachable (this network blocks the port, or the server is down)\n", ip.toString().c_str(), port_);
    return;
  }
  probe.stop();
  char err[120] = "";
  int code = net_.lastError(err, sizeof err);
  Serial.printf("[arc] tls: error %d %s; free memory %u bytes (TLS needs ~40 KB in one block, largest %u)\n", code, err,
                (unsigned)ESP.getFreeHeap(), (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_8BIT));
}

// ---------------------------------------------------------------- messages

bool ArcCloud::timeSynced() const { return time(nullptr) > 1700000000; }

static void isoNow(char *buf, size_t len) {
  time_t now = time(nullptr);
  struct tm t;
  gmtime_r(&now, &t);
  strftime(buf, len, "%Y-%m-%dT%H:%M:%SZ", &t);
}

void ArcCloud::publishState() {
  JsonDocument doc;
  doc["schemaVersion"] = 1;
  if (timeSynced()) {
    char ts[25];
    isoNow(ts, sizeof ts);
    doc["timestamp"] = ts;
  }
  JsonObject state = doc["state"].to<JsonObject>();
  state["firmwareVersion"] = firmwareVersion_;
  state["library"] = "ArcCloud/" ARC_CLOUD_LIBRARY_VERSION;
  state["uptimeS"] = millis() / 1000;
  state["freeHeap"] = ESP.getFreeHeap();
  char out[320];
  size_t n = serializeJson(doc, out, sizeof out);
  mqtt_.publish(topic("/state").c_str(), (const uint8_t *)out, n, false);
}

bool ArcCloud::add(const char *field, float value) {
  if (!validField(field)) {
    Serial.printf("[arc] field name \"%s\" is not valid: a letter, then letters, digits or _ (at most 32), as in ARC Cloud\n", field);
    return false;
  }
  if (isnan(value) || isinf(value)) {
    ARC_LOG("[arc] %s: no valid value (sensor read failed?), left out\n", field);
    return false;
  }
  for (uint8_t i = 0; i < nReadings_; i++) {
    if (strcmp(readings_[i].field, field) == 0) {
      readings_[i].value = value;
      return true;
    }
  }
  if (nReadings_ >= MAX_FIELDS) return false;
  strlcpy(readings_[nReadings_].field, field, sizeof readings_[nReadings_].field);
  readings_[nReadings_++].value = value;
  return true;
}

bool ArcCloud::send() {
  if (nReadings_ == 0) return false;
  if (!connected()) {
    ARC_LOG("[arc] offline: %u reading(s) not sent\n", nReadings_);
    nReadings_ = 0;
    return false;
  }
  JsonDocument doc;
  char msgId[32];
  snprintf(msgId, sizeof msgId, "%08lx-%lu", (unsigned long)bootId_, (unsigned long)++seq_);
  doc["schemaVersion"] = 1;
  doc["messageId"] = msgId;  // lets ARC Cloud drop duplicates after a reconnect
  if (timeSynced()) {
    char ts[25];
    isoNow(ts, sizeof ts);
    doc["timestamp"] = ts;
  }
  JsonObject metrics = doc["metrics"].to<JsonObject>();
  for (uint8_t i = 0; i < nReadings_; i++) metrics[readings_[i].field] = readings_[i].value;
  doc["metadata"]["firmwareVersion"] = firmwareVersion_;
  nReadings_ = 0;
  String out;
  serializeJson(doc, out);
  bool ok = mqtt_.publish(topic("/telemetry").c_str(), (const uint8_t *)out.c_str(), out.length(), false);
  ARC_LOG("[arc] %s %s\n", ok ? "sent" : "SEND FAILED", out.c_str());
  return ok;
}

bool ArcCloud::write(const char *field, float value) {
  if (!add(field, value)) return false;
  return send();
}

bool ArcCloud::onControl(const char *field, ControlHandler handler) {
  if (!validField(field) || nControls_ >= MAX_CONTROLS) return false;
  strlcpy(controls_[nControls_].field, field, sizeof controls_[nControls_].field);
  controls_[nControls_++].handler = handler;
  return true;
}

void ArcCloud::ack(const char *commandId, const char *error) {
  JsonDocument doc;
  doc["commandId"] = commandId;
  doc["status"] = error ? "error" : "ok";
  if (error) doc["error"] = error;
  char out[256];
  size_t n = serializeJson(doc, out, sizeof out);
  mqtt_.publish(topic("/cmd-ack").c_str(), (const uint8_t *)out, n, false);
}

// One topic carries both kinds of message:
//   control value  {"schemaVersion":1,"field":"led1","value":1,"ts":"..."}
//   command        {"type":"command","commandId":"...","name":"blink","payload":{...},"expiresAt":"..."}
void ArcCloud::handleMessage(char *topicName, byte *payload, unsigned int length) {
  (void)topicName;
  JsonDocument doc;
  if (deserializeJson(doc, payload, length)) return;
  if (strcmp(doc["type"] | "", "command") == 0) {
    const char *id = doc["commandId"] | "";
    const char *name = doc["name"] | "";
    ARC_LOG("[arc] command %s\n", name);
    const char *err = command_ ? command_(name, doc["payload"].as<JsonObjectConst>()) : "unknown command";
    ack(id, err);
    return;
  }
  const char *field = doc["field"] | "";
  float value = doc["value"] | 0.0f;
  for (uint8_t i = 0; i < nControls_; i++) {
    if (strcmp(controls_[i].field, field) == 0) {
      ARC_LOG("[arc] %s = %g\n", field, value);
      controls_[i].handler(value);
      return;
    }
  }
  if (anyControl_) anyControl_(field, value);
  else ARC_LOG("[arc] %s = %g (no onControl handler in this sketch)\n", field, value);
}

// ---------------------------------------------------------------- timers

bool ArcCloud::every(unsigned long ms, TimerHandler fn) {
  if (nTimers_ >= MAX_TIMERS || ms == 0 || !fn) return false;
  timers_[nTimers_++] = Timer{ms, millis(), fn};  // first run `ms` after this call
  return true;
}

void ArcCloud::runTimers() {
  unsigned long now = millis();
  for (uint8_t i = 0; i < nTimers_; i++) {
    if (now - timers_[i].last >= timers_[i].ms) {
      timers_[i].last = now;
      timers_[i].fn();
    }
  }
}
