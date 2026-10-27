/*
 * ARC Cloud — ESP32 + DHT11/DHT22 + 2 LEDs over MQTT/TLS (production device path).
 *
 * Sends every intervalSeconds (provisioned; default PUBLISH_INTERVAL_S in config.h):
 *   temperature  (°C)    DHT sensor
 *   humidity     (%)     DHT sensor
 *   rssi         (dBm)   Wi-Fi signal
 * Receives (dashboard switches, delivered instantly over MQTT):
 *   led1  -> GPIO 25        led2  -> GPIO 26        (control fields, 0 = off, 1 = on)
 * Commands (Channel settings → Commands): "blink" {seconds} blinks LED 1; "ota.update" (signed firmware update)
 *
 * The field names above must match "Name in firmware" in ARC Cloud → Channel settings → Fields. Once a
 * channel has fields, the cloud rejects any reading whose name isn't defined there (see Rejected data).
 *
 * Wiring
 *   DHT module:  + / VCC -> 3V3    OUT / DATA -> GPIO 15    - / GND -> GND
 *                (a bare 4-pin DHT needs a 10 kΩ pull-up from DATA to 3V3; 3-pin modules have it)
 *   LED 1:       GPIO 25 -> 220–330 Ω resistor -> LED anode (long leg); cathode -> GND
 *   LED 2:       GPIO 26 -> 220–330 Ω resistor -> LED anode (long leg); cathode -> GND
 *   Note: GPIO 15 is a boot strapping pin. A DHT module (data line pulled up) is fine; anything that
 *   pulls GPIO 15 low at power-on only silences the boot log, but avoid hanging other loads on it.
 *
 * Setup
 *   1. Copy config.example.h to config.h (fleet-wide settings only) and paste your OTA public key into it.
 *   2. Libraries (Library Manager): PubSubClient (Nick O'Leary), ArduinoJson (v7),
 *      "DHT sensor library" (Adafruit) + "Adafruit Unified Sensor".
 *   3. Board: ESP32 Dev Module. Upload, open the Serial Monitor (115200 baud, line ending "New Line").
 *   4. Provision the device once: ARC Cloud → Devices → Add device (or Replace password) → tab
 *      "ESP32 over USB" → copy the PROVISION line, put in your Wi-Fi (2.4 GHz), paste it into the
 *      Serial Monitor, press Enter. The device stores it in NVS and reboots.
 *
 * The firmware image holds NO Wi-Fi or device credentials (see arc_provision.h): one image serves every
 * device of DEVICE_TYPE and can be hosted publicly for OTA. Credentials live in each device's NVS and
 * survive OTA updates.
 *
 * Security: MQTT over TLS with the broker certificate verified (no insecure fallback); per-device
 * username/password; OTA only installs images signed with OTA_PUBLIC_KEY_PEM (see arc_ota.h).
 * Physical/USB access can read NVS unless flash encryption is enabled (production hardening item).
 */
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <DHT.h>
#include <time.h>
#include "config.h"
#include "arc_roots.h"
#include "arc_ota.h"
#include "arc_provision.h"

#if defined(DEVICE_PASSWORD) || defined(WIFI_PASSWORD) || defined(DEVICE_ID)
#error "config.h contains device or Wi-Fi credentials. They would be compiled into the (public) OTA image. Start from config.example.h and provision the device over USB instead."
#endif
#ifndef PUBLISH_INTERVAL_S
#define PUBLISH_INTERVAL_S 15
#endif
#ifndef BROKER_CA
#define BROKER_CA ARC_PUBLIC_ROOTS
#endif
#ifndef OTA_CA
#define OTA_CA ARC_PUBLIC_ROOTS    // CA bundle for the HTTPS host that serves firmware images
#endif

// ---------- hardware ----------
#ifndef DHT_PIN
#define DHT_PIN 15
#endif
#ifndef DHT_TYPE
#define DHT_TYPE DHT11             // DHT22 for the white sensor
#endif
#ifndef LED1_PIN
#define LED1_PIN 25
#endif
#ifndef LED2_PIN
#define LED2_PIN 26
#endif
// ------------------------------

WiFiClientSecure net;
PubSubClient mqtt(net);
DHT dht(DHT_PIN, DHT_TYPE);

uint32_t bootId;          // random per boot, so messageIds stay unique across reboots
uint32_t seq = 0;
unsigned long lastPublish = 0;
String topicTelemetry, topicState, topicCommands, topicAck;   // derived from the provisioned topicBase

// Waits while still accepting serial commands (so a device with wrong settings can be re-provisioned).
void waitMs(unsigned long ms) {
  unsigned long start = millis();
  while (millis() - start < ms) { arcPollSerial(); delay(20); }
}

void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;
  WiFi.mode(WIFI_STA);
  WiFi.begin(arcCfg.wifiSsid.c_str(), arcCfg.wifiPassword.c_str());
  Serial.printf("WiFi \"%s\"", arcCfg.wifiSsid.c_str());
  int tries = 0;
  while (WiFi.status() != WL_CONNECTED) {
    waitMs(500);
    Serial.print(".");
    arcOtaRollbackWatchdog();
    if (++tries == 40) {   // 20 s
      Serial.println("\nWi-Fi not connecting: check the name/password (STATUS shows the name; PROVISION {\"wifiSsid\":…,\"wifiPassword\":…} fixes it) and that it is 2.4 GHz. Retrying.");
      WiFi.disconnect();
      WiFi.begin(arcCfg.wifiSsid.c_str(), arcCfg.wifiPassword.c_str());
      tries = 0;
    }
  }
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
  mqtt.publish(topicState.c_str(), (const uint8_t *)out, n, false);
}

void ackCommand(const char *commandId, const char *error) {
  JsonDocument ack;
  ack["commandId"] = commandId;
  ack["status"] = error ? "error" : "ok";
  if (error) ack["error"] = error;
  char out[256];
  size_t n = serializeJson(ack, out);
  mqtt.publish(topicAck.c_str(), (const uint8_t *)out, n, false);
  Serial.printf("ack %s %s\n", commandId, error ? error : "ok");
}

// Commands: {"type":"command","commandId":"…","name":"blink","payload":{"seconds":3},"expiresAt":"…"}
void onCommand(JsonDocument &doc) {
  const char *id = doc["commandId"] | "";
  const char *name = doc["name"] | "";
  JsonObject p = doc["payload"];
  Serial.printf("command %s (%s)\n", name, id);

  if (strcmp(name, "blink") == 0) {
    int seconds = constrain((int)(p["seconds"] | 3), 1, 30);
    int before = digitalRead(LED1_PIN);
    for (int i = 0; i < seconds * 2; i++) { digitalWrite(LED1_PIN, i % 2 ? LOW : HIGH); delay(250); mqtt.loop(); }
    digitalWrite(LED1_PIN, before);   // back to what the dashboard switch says
    ackCommand(id, nullptr);
  } else if (strcmp(name, "ota.update") == 0) {
    Serial.printf("OTA to %s requested\n", (const char *)(p["version"] | "?"));
    String err = arcOtaInstall(p, OTA_CA);   // verifies the signature before touching flash
    if (err == "up-to-date") { ackCommand(id, nullptr); return; }
    if (err.length()) { Serial.printf("OTA refused: %s\n", err.c_str()); ackCommand(id, err.c_str()); return; }
    ackCommand(id, nullptr);
    mqtt.loop();
    delay(500);
    ESP.restart();
  } else {
    ackCommand(id, "unknown command");
  }
}

// Every message on the cmd topic: a control value or a command.
// Control value: {"schemaVersion":1,"field":"led1","value":1,"ts":"..."}
void onMessage(char *topic, byte *payload, unsigned int length) {
  (void)topic;
  JsonDocument doc;
  if (deserializeJson(doc, payload, length)) return;
  if (strcmp(doc["type"] | "", "command") == 0) { onCommand(doc); return; }
  const char *field = doc["field"] | "";
  float value = doc["value"] | 0.0;
  if (strcmp(field, "led1") == 0) {
    digitalWrite(LED1_PIN, value >= 1 ? HIGH : LOW);
    Serial.printf("LED 1 (GPIO %d) %s\n", LED1_PIN, value >= 1 ? "ON" : "OFF");
  } else if (strcmp(field, "led2") == 0) {
    digitalWrite(LED2_PIN, value >= 1 ? HIGH : LOW);
    Serial.printf("LED 2 (GPIO %d) %s\n", LED2_PIN, value >= 1 ? "ON" : "OFF");
  } else {
    Serial.printf("control %s = %.2f (not used by this sketch)\n", field, value);
  }
}

void connectMqtt() {
  while (!mqtt.connected()) {
    Serial.printf("MQTT %s:%d connecting... ", MQTT_HOST, MQTT_PORT);
    // clientId and username must both be the device UUID.
    if (mqtt.connect(arcCfg.deviceId.c_str(), arcCfg.deviceId.c_str(), arcCfg.devicePassword.c_str())) {
      Serial.println("ok");
      arcOtaConfirmBoot();                 // a freshly-updated image proved it can reach the cloud
      mqtt.subscribe(topicCommands.c_str(), 1);   // the cloud re-sends current switch values ~2 s after this
      publishState();
    } else {
      int rc = mqtt.state();
      if (rc == 4 || rc == 5) Serial.printf("refused rc=%d: wrong deviceId/devicePassword (re-provision with a new PROVISION line), or the device is suspended/revoked\n", rc);
      else if (rc == -2) Serial.println("failed rc=-2: no TCP/TLS connection (check internet, MQTT_HOST, port 8883 not blocked, BROKER_CA)");
      else Serial.printf("failed rc=%d\n", rc);
      Serial.println("retry in 5 s");
      arcOtaRollbackWatchdog();
      waitMs(5000);
    }
  }
}

void publishTelemetry() {
  float t = dht.readTemperature();   // °C
  float h = dht.readHumidity();      // %

  JsonDocument doc;
  char msgId[32];
  snprintf(msgId, sizeof msgId, "%08lx-%lu", (unsigned long)bootId, (unsigned long)++seq);
  doc["schemaVersion"] = 1;
  doc["messageId"] = msgId;
  if (timeSynced()) { char ts[25]; isoNow(ts, sizeof ts); doc["timestamp"] = ts; }
  JsonObject metrics = doc["metrics"].to<JsonObject>();
  // Only finite numbers are valid: a failed read (NaN) is left out instead of breaking the whole message.
  if (!isnan(t)) metrics["temperature"] = roundf(t * 10) / 10;
  if (!isnan(h)) metrics["humidity"] = roundf(h * 10) / 10;
  metrics["rssi"] = WiFi.RSSI();
  doc["metadata"]["firmwareVersion"] = FIRMWARE_VERSION;
  if (isnan(t) || isnan(h)) Serial.printf("DHT read failed: check wiring (DATA on GPIO %d, + on 3V3, - on GND) and DHT_TYPE\n", DHT_PIN);

  char out[384];
  size_t n = serializeJson(doc, out);
  bool ok = mqtt.publish(topicTelemetry.c_str(), (const uint8_t *)out, n, false);
  Serial.printf("%s %s\n", ok ? "sent" : "FAILED", out);
}

bool provisioned = false;

void setup() {
  Serial.setRxBufferSize(2048);   // a PROVISION line is ~300 bytes; the default 256-byte buffer can overflow
  Serial.begin(115200);
  delay(300);
  Serial.printf("\n=== ARC Cloud: DHT + 2 LEDs (MQTT/TLS), firmware %s ===\n", FIRMWARE_VERSION);
  pinMode(LED1_PIN, OUTPUT);
  pinMode(LED2_PIN, OUTPUT);
  digitalWrite(LED1_PIN, LOW);
  digitalWrite(LED2_PIN, LOW);
  dht.begin();
  bootId = esp_random();

  arcLoadSettings(PUBLISH_INTERVAL_S);
  provisioned = arcCfg.complete();
  if (!provisioned) { arcPrintProvisionHelp(); return; }
  topicTelemetry = arcCfg.topicBase + "/telemetry";
  topicState = arcCfg.topicBase + "/state";
  topicCommands = arcCfg.topicBase + "/cmd";
  topicAck = arcCfg.topicBase + "/cmd-ack";
  Serial.printf("device %s, sending every %lu s\n", arcCfg.deviceId.c_str(), (unsigned long)arcCfg.intervalS);

  connectWiFi();
  configTime(0, 0, "pool.ntp.org", "time.google.com");

  net.setCACert(BROKER_CA);        // verifies the broker certificate; there is no insecure fallback
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setBufferSize(4096);        // room for signed OTA manifests
  mqtt.setCallback(onMessage);
  mqtt.setKeepAlive(30);
}

void loop() {
  arcPollSerial();
  arcOtaRollbackWatchdog();
  if (!provisioned) {
    static unsigned long lastHelp = 0;
    if (millis() - lastHelp > 30000) { lastHelp = millis(); arcPrintProvisionHelp(); }
    delay(20);
    return;
  }
  connectWiFi();
  connectMqtt();
  mqtt.loop();
  if (lastPublish == 0 || millis() - lastPublish >= arcCfg.intervalS * 1000UL) {
    lastPublish = millis();
    if (lastPublish == 0) lastPublish = 1;
    publishTelemetry();
  }
}
