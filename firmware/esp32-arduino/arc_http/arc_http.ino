/*
 * ARC Cloud — ESP32 over plain HTTP (ThingSpeak-style). No MQTT, no certificates.
 *
 * Every SEND_INTERVAL_MS it:
 *   1. sends readings:   GET {SERVER}/api/v1/update?api_key=KEY&field1=..&field2=..
 *   2. reads controls:   GET {SERVER}/api/v1/controls?api_key=KEY&field=relay   → "1" or "0"
 *      and switches RELAY_PIN accordingly (a dashboard Switch on the "relay" control field).
 *   3. fetches a command: GET {SERVER}/api/v1/commands/next?api_key=KEY  (204 = none)
 *      runs it and confirms: POST {SERVER}/api/v1/commands/{id}/ack?api_key=KEY {"status":"ok"}
 *      Needs ArduinoJson (v7) from the Library Manager.
 *
 * Fill in the settings below. KEY is the device password shown when you added the device
 * (Devices → Add device → "HTTP API" tab). Field numbers match Channel settings → Fields.
 *
 * SERVER is the AWS API Gateway address shown on the device's "HTTP API" tab, e.g.
 *   https://lku7dufiw0.execute-api.ap-southeast-1.amazonaws.com
 *   http://192.168.1.20:3000                            (local Docker on your PC)
 * https:// is encrypted. By default the sketch does not verify the server's certificate
 * (fine for getting started); paste a root CA into ROOT_CA to verify it as well.
 */
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include "arc_ota.h"

const char *WIFI_SSID     = "your-wifi";
const char *WIFI_PASSWORD = "your-wifi-password";
const char *SERVER        = "https://lku7dufiw0.execute-api.ap-southeast-1.amazonaws.com";
const char *API_KEY       = "paste-the-device-key";

const char *ROOT_CA = nullptr;                 // optional: PEM root certificate of SERVER

const int RELAY_PIN = 2;                       // on-board LED on most ESP32 boards
const unsigned long SEND_INTERVAL_MS = 15000;  // set the device's "sends data every" to match

unsigned long lastSend = 0;

float readTemperatureC() { return 25.0 + (esp_random() % 1000) / 200.0; }  // replace with your sensor
float readHumidityPct()  { return 50.0 + (esp_random() % 1000) / 50.0; }   // replace with your sensor

void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("WiFi");
  while (WiFi.status() != WL_CONNECTED) { delay(500); Serial.print("."); }
  Serial.printf(" ok, ip=%s\n", WiFi.localIP().toString().c_str());
}

// Returns the response body, or "" on failure.
String httpGet(const String &url) {
  HTTPClient http;
  http.setTimeout(8000);
  WiFiClientSecure tls;
  if (url.startsWith("https://")) {
    if (ROOT_CA) tls.setCACert(ROOT_CA); else tls.setInsecure();
    http.begin(tls, url);
  } else {
    http.begin(url);
  }
  int code = http.GET();
  String body = code > 0 ? http.getString() : "";
  if (code != 200) Serial.printf("HTTP %d %s\n", code, body.c_str());
  http.end();
  return code == 200 ? body : "";
}

#define FIRMWARE_VERSION "1.0.0"

// POST helper for command acknowledgements.
void httpPost(const String &url, const String &json) {
  HTTPClient http;
  WiFiClientSecure tls;
  if (url.startsWith("https://")) {
    if (ROOT_CA) tls.setCACert(ROOT_CA); else tls.setInsecure();
    http.begin(tls, url);
  } else {
    http.begin(url);
  }
  http.addHeader("content-type", "application/json");
  int code = http.POST(json);
  if (code != 200) Serial.printf("ack HTTP %d\n", code);
  http.end();
}

void ack(const char *id, const char *error) {
  JsonDocument d;
  d["status"] = error ? "error" : "ok";
  if (error) d["error"] = error;
  String body;
  serializeJson(d, body);
  httpPost(String(SERVER) + "/api/v1/commands/" + id + "/ack?api_key=" + API_KEY, body);
}

// Runs at most one pending command per cycle. Define commands in Channel settings → Commands.
void runCommand() {
  String body = httpGet(String(SERVER) + "/api/v1/commands/next?api_key=" + API_KEY);
  if (!body.length()) return;  // 204: nothing to do
  JsonDocument doc;
  if (deserializeJson(doc, body)) return;
  const char *id = doc["commandId"] | "";
  const char *name = doc["name"] | "";
  JsonObject p = doc["payload"];
  Serial.printf("command %s\n", name);
  if (strcmp(name, "blink") == 0) {
    int seconds = p["seconds"] | 3;
    for (int i = 0; i < seconds * 2; i++) { digitalWrite(RELAY_PIN, i % 2 ? LOW : HIGH); delay(250); }
    ack(id, nullptr);
  } else if (strcmp(name, "ota.update") == 0) {
    if (strcmp(p["version"] | "", FIRMWARE_VERSION) == 0) { ack(id, nullptr); return; }
    String err = arcOtaInstall(p["url"] | "", p["sha256"] | "", p["sizeBytes"] | 0);
    if (err.length()) { ack(id, err.c_str()); return; }
    ack(id, nullptr);
    delay(500);
    ESP.restart();
  } else {
    ack(id, "unknown command");
  }
}

void sendReadings() {
  String url = String(SERVER) + "/api/v1/update?api_key=" + API_KEY +
               "&field1=" + String(readTemperatureC(), 2) +
               "&field2=" + String(readHumidityPct(), 1) +
               "&firmware_version=" + FIRMWARE_VERSION;
  String body = httpGet(url);
  Serial.println(body.length() ? "sent" : "send failed");
}

void readControls() {
  String v = httpGet(String(SERVER) + "/api/v1/controls?api_key=" + API_KEY + "&field=relay");
  if (v.length()) {
    int on = v.toInt();
    digitalWrite(RELAY_PIN, on ? HIGH : LOW);
    Serial.printf("relay = %d\n", on);
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(RELAY_PIN, OUTPUT);
  connectWiFi();
}

void loop() {
  connectWiFi();
  if (lastSend == 0 || millis() - lastSend >= SEND_INTERVAL_MS) {
    lastSend = millis();
    sendReadings();
    readControls();
    runCommand();
  }
  delay(100);
}
