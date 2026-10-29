/*
 * ARC Cloud — ESP32 telemetry example (Arduino core for ESP32)
 *
 * Libraries (Arduino Library Manager): PubSubClient (Nick O'Leary), ArduinoJson (v7)
 * Fill in config.h from the `credentials` returned by POST /api/v1/devices.
 *
 * Behaviour per docs/device-protocol/README.md:
 *  - MQTT over TLS, clientId = username = device UUID, unique per-device password
 *  - publishes telemetry every PUBLISH_INTERVAL_MS with a unique messageId
 *  - sends an ISO-8601 UTC timestamp once NTP has synced (omits it before that)
 *  - publishes a state message after each (re)connect
 *  - receives control values (dashboard switches/sliders) on its cmd topic;
 *    a control field named "relay" drives RELAY_PIN (the on-board LED by default)
 *  - receives commands on the same topic and confirms each one on TOPIC_ACK
 *    ({"commandId":"…","status":"ok"|"error"}); the cloud only marks a command
 *    "acknowledged" after this. Example commands: "blink" {seconds}, "ota.update" (firmware update)
 *  - OTA: installs only images signed with the key in OTA_PUBLIC_KEY_PEM, never downgrades, and rolls
 *    back if the new image can't reach the cloud within 5 minutes (see arc_ota.h)
 */
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <time.h>
#include "config.h"
#include "arc_roots.h"
#include "arc_ota.h"

#ifndef TOPIC_ACK
#error "Add TOPIC_ACK (…/cmd-ack) to config.h - copy it from the device page"
#endif
#ifndef BROKER_CA
#define BROKER_CA CA_CERT          // config.h files generated before BROKER_CA existed
#endif
#ifndef OTA_CA
#define OTA_CA ARC_PUBLIC_ROOTS    // CA bundle for the HTTPS host that serves firmware images
#endif

WiFiClientSecure net;
PubSubClient mqtt(net);

#ifndef RELAY_PIN
#define RELAY_PIN 2   // on-board LED on most ESP32 dev boards; change to your relay pin
#endif

uint32_t bootId;          // random per boot, so messageIds stay unique across reboots
uint32_t seq = 0;
unsigned long lastPublish = 0;

void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("WiFi");
  while (WiFi.status() != WL_CONNECTED) { delay(500); Serial.print("."); arcOtaRollbackWatchdog(); }
  Serial.printf(" ok, ip=%s\n", WiFi.localIP().toString().c_str());
}

bool timeSynced() { return time(nullptr) > 1700000000; }

void isoNow(char *buf, size_t len) {
  time_t now = time(nullptr);
  struct tm t;
  gmtime_r(&now, &t);
  strftime(buf, len, "%Y-%m-%dT%H:%M:%SZ", &t);
}

void publishState() {
  JsonDocument doc;
  doc["schemaVersion"] = 1;
  if (timeSynced()) { char ts[25]; isoNow(ts, sizeof ts); doc["timestamp"] = ts; }
  JsonObject state = doc["state"].to<JsonObject>();
  state["firmwareVersion"] = FIRMWARE_VERSION;
  state["uptimeS"] = millis() / 1000;
  state["freeHeap"] = ESP.getFreeHeap();
  char out[256];
  size_t n = serializeJson(doc, out);
  mqtt.publish(TOPIC_STATE, (const uint8_t *)out, n, false);
}

void ackCommand(const char *commandId, const char *error, JsonObject result = JsonObject()) {
  JsonDocument ack;
  ack["commandId"] = commandId;
  ack["status"] = error ? "error" : "ok";
  if (error) ack["error"] = error;
  if (!result.isNull()) ack["result"] = result;
  char out[256];
  size_t n = serializeJson(ack, out);
  mqtt.publish(TOPIC_ACK, (const uint8_t *)out, n, false);
  Serial.printf("ack %s %s\n", commandId, error ? error : "ok");
}

// Commands: {"type":"command","commandId":"…","name":"blink","payload":{"seconds":3},"expiresAt":"…"}
// Define allowed commands in ARC Cloud: Channel settings → Commands.
void onCommand(JsonDocument &doc) {
  const char *id = doc["commandId"] | "";
  const char *name = doc["name"] | "";
  JsonObject p = doc["payload"];
  Serial.printf("command %s (%s)\n", name, id);

  if (strcmp(name, "blink") == 0) {
    int seconds = p["seconds"] | 3;
    for (int i = 0; i < seconds * 2; i++) { digitalWrite(RELAY_PIN, i % 2 ? LOW : HIGH); delay(250); }
    ackCommand(id, nullptr);
  } else if (strcmp(name, "ota.update") == 0) {
    Serial.printf("OTA to %s requested\n", (const char *)(p["version"] | "?"));
    String err = arcOtaInstall(p, OTA_CA);   // verifies the signature before touching flash
    if (err == "up-to-date") { ackCommand(id, nullptr); return; }
    if (err.length()) { Serial.printf("OTA refused: %s\n", err.c_str()); ackCommand(id, err.c_str()); return; }
    ackCommand(id, nullptr);
    mqtt.loop();
    delay(500);
    ESP.restart();  // boots the new image; it reports its FIRMWARE_VERSION, completing the rollout
  } else {
    ackCommand(id, "unknown command");
  }
}

// Called for every message on the cmd topic: control values or commands.
// Control value: {"schemaVersion":1,"field":"relay","value":1,"ts":"..."}
void onControl(char *topic, byte *payload, unsigned int length) {
  JsonDocument doc;
  if (deserializeJson(doc, payload, length)) return;
  if (strcmp(doc["type"] | "", "command") == 0) { onCommand(doc); return; }
  const char *field = doc["field"] | "";
  float value = doc["value"] | 0.0;
  Serial.printf("control %s = %.2f\n", field, value);
  if (strcmp(field, "relay") == 0) {
    digitalWrite(RELAY_PIN, value >= 1 ? HIGH : LOW);
  }
  // Add more fields here, e.g. if (strcmp(field, "brightness") == 0) analogWrite(LED_PIN, value * 2.55);
}

void connectMqtt() {
  while (!mqtt.connected()) {
    Serial.print("MQTT connecting... ");
    // clientId and username must both be the device UUID.
    if (mqtt.connect(DEVICE_ID, DEVICE_ID, DEVICE_PASSWORD)) {
      Serial.println("ok");
      arcOtaConfirmBoot();                 // a freshly-updated image proved it can reach the cloud
      mqtt.subscribe(TOPIC_COMMANDS, 1);   // the cloud re-sends current control values right after this
      publishState();
    } else {
      // rc=4/5: bad credentials or device revoked — check the API, don't hammer the broker.
      Serial.printf("failed rc=%d, retry in 5s\n", mqtt.state());
      arcOtaRollbackWatchdog();
      delay(5000);
    }
  }
}

float readTemperatureC() { return 25.0 + (esp_random() % 1000) / 200.0; }   // replace with your sensor
float readHumidityPct()  { return 50.0 + (esp_random() % 1000) / 50.0; }    // replace with your sensor

void publishTelemetry() {
  JsonDocument doc;
  char msgId[32];
  snprintf(msgId, sizeof msgId, "%08lx-%lu", (unsigned long)bootId, (unsigned long)++seq);
  doc["schemaVersion"] = 1;
  doc["messageId"] = msgId;
  if (timeSynced()) { char ts[25]; isoNow(ts, sizeof ts); doc["timestamp"] = ts; }
  JsonObject metrics = doc["metrics"].to<JsonObject>();
  metrics["temperatureC"] = readTemperatureC();
  metrics["humidityPct"] = readHumidityPct();
  metrics["rssiDbm"] = WiFi.RSSI();
  doc["metadata"]["firmwareVersion"] = FIRMWARE_VERSION;

  char out[384];
  size_t n = serializeJson(doc, out);
  bool ok = mqtt.publish(TOPIC_TELEMETRY, (const uint8_t *)out, n, false);
  Serial.printf("%s %s\n", ok ? "sent" : "FAILED", out);
}

void setup() {
  Serial.begin(115200);
  arcOtaCheckRollback();   // records an image that was rolled back, so it is never reinstalled
  bootId = esp_random();
  connectWiFi();
  configTime(0, 0, "pool.ntp.org", "time.google.com");

  net.setCACert(BROKER_CA);        // verifies the broker certificate; there is no insecure fallback
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setBufferSize(4096);   // room for signed OTA manifests (the URL appears twice)
  mqtt.setCallback(onControl);
  pinMode(RELAY_PIN, OUTPUT);
  mqtt.setKeepAlive(30);
}

void loop() {
  arcOtaRollbackWatchdog();
  connectWiFi();
  connectMqtt();
  mqtt.loop();
  if (millis() - lastPublish >= PUBLISH_INTERVAL_MS) {
    lastPublish = millis();
    publishTelemetry();
  }
}
