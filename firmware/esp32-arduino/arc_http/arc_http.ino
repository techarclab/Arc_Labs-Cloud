/*
 * ARC Cloud — ESP32 over HTTPS (ThingSpeak-style). No MQTT.
 *
 * Every SEND_INTERVAL_MS it:
 *   1. sends readings:   GET {SERVER}/api/v1/update?field1=..&field2=..
 *   2. reads controls:   GET {SERVER}/api/v1/controls?field=relay   → "1" or "0"
 *      and switches RELAY_PIN accordingly (a dashboard Switch on the "relay" control field).
 *   3. fetches a command: GET {SERVER}/api/v1/commands/next  (204 = none)
 *      runs it and confirms: POST {SERVER}/api/v1/commands/{id}/ack {"status":"ok"}
 * Every request carries the device key in the header "Authorization: Bearer KEY" — never in the URL,
 * because URLs are written to proxy and server logs.
 *
 * Needs ArduinoJson (v7) from the Library Manager.
 *
 * Fill in the settings below. KEY is the device password shown when you added the device
 * (Devices → Add device → "HTTP API" tab). Field numbers match Channel settings → Fields.
 *
 * SERVER is the API address shown on the device's "HTTP API" tab, e.g.
 *   https://api.arclabs.in                    (hosted ARC Cloud)
 *   http://192.168.1.20:3000                  (local Docker on your PC: set ALLOW_PLAIN_HTTP to true)
 * The server certificate is always verified against SERVER_CA (public roots by default, see arc_roots.h).
 */
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

const char *WIFI_SSID     = "your-wifi";
const char *WIFI_PASSWORD = "your-wifi-password";
const char *SERVER        = "https://api.example.com";
const char *API_KEY       = "paste-the-device-key";

// Plain http:// sends the key unencrypted. Only for local Docker testing on a network you control.
const bool ALLOW_PLAIN_HTTP = false;

#define DEVICE_TYPE      "esp32"   // the device type registered in ARC Cloud (OTA releases target it)
#define FIRMWARE_VERSION "1.0.0"   // MAJOR.MINOR.PATCH; bump for every release (devices refuse downgrades)

// OTA signing PUBLIC key (ECDSA P-256): node tools/firmware-sign.mjs header firmware-signing-public.pem
// Until it is set, the device refuses every firmware update (fails closed).
static const char OTA_PUBLIC_KEY_PEM[] = R"PEM(
-----BEGIN PUBLIC KEY-----
...paste firmware-signing-public.pem here...
-----END PUBLIC KEY-----
)PEM";

#include "arc_roots.h"
#include "arc_ota.h"
#define SERVER_CA ARC_PUBLIC_ROOTS   // or a const char[] with your own CA's PEM

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
  while (WiFi.status() != WL_CONNECTED) { delay(500); Serial.print("."); arcOtaRollbackWatchdog(); }
  Serial.printf(" ok, ip=%s\n", WiFi.localIP().toString().c_str());
}

// Opens `url` on `http`, with certificate verification for https:// and the device key in a header.
bool openUrl(HTTPClient &http, WiFiClientSecure &tls, const String &url) {
  if (url.startsWith("https://")) {
    tls.setCACert(SERVER_CA);
    if (!http.begin(tls, url)) return false;
  } else if (ALLOW_PLAIN_HTTP && url.startsWith("http://")) {
    if (!http.begin(url)) return false;
  } else {
    Serial.println("refusing non-https URL (set ALLOW_PLAIN_HTTP only for local testing)");
    return false;
  }
  http.addHeader("Authorization", String("Bearer ") + API_KEY);
  return true;
}

// Returns the response body, or "" on failure / 204.
String httpGet(const String &url) {
  HTTPClient http;
  WiFiClientSecure tls;
  http.setTimeout(8000);
  if (!openUrl(http, tls, url)) return "";
  int code = http.GET();
  String body = code > 0 ? http.getString() : "";
  if (code != 200 && code != 204) Serial.printf("HTTP %d %s\n", code, body.c_str());
  http.end();
  return code == 200 ? body : "";
}

// POST helper for command acknowledgements.
void httpPost(const String &url, const String &json) {
  HTTPClient http;
  WiFiClientSecure tls;
  http.setTimeout(8000);
  if (!openUrl(http, tls, url)) return;
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
  httpPost(String(SERVER) + "/api/v1/commands/" + id + "/ack", body);
}

// Runs at most one pending command per cycle. Define commands in Channel settings → Commands.
void runCommand() {
  String body = httpGet(String(SERVER) + "/api/v1/commands/next");
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
    String err = arcOtaInstall(p, ARC_PUBLIC_ROOTS);   // verifies the signature before touching flash
    if (err == "up-to-date") { ack(id, nullptr); return; }
    if (err.length()) { Serial.printf("OTA refused: %s\n", err.c_str()); ack(id, err.c_str()); return; }
    ack(id, nullptr);
    delay(500);
    ESP.restart();
  } else {
    ack(id, "unknown command");
  }
}

void sendReadings() {
  String url = String(SERVER) + "/api/v1/update?field1=" + String(readTemperatureC(), 2) +
               "&field2=" + String(readHumidityPct(), 1) +
               "&firmware_version=" + FIRMWARE_VERSION;
  String body = httpGet(url);
  Serial.println(body.length() ? "sent" : "send failed");
  if (body.length()) arcOtaConfirmBoot();   // a freshly-updated image proved it can reach the cloud
}

void readControls() {
  String v = httpGet(String(SERVER) + "/api/v1/controls?field=relay");
  if (v.length()) {
    int on = v.toInt();
    digitalWrite(RELAY_PIN, on ? HIGH : LOW);
    Serial.printf("relay = %d\n", on);
  }
}

void setup() {
  Serial.begin(115200);
  arcOtaCheckRollback();   // records an image that was rolled back, so it is never reinstalled
  pinMode(RELAY_PIN, OUTPUT);
  connectWiFi();
}

void loop() {
  arcOtaRollbackWatchdog();
  connectWiFi();
  if (lastSend == 0 || millis() - lastSend >= SEND_INTERVAL_MS) {
    lastSend = millis();
    sendReadings();
    readControls();
    runCommand();
  }
  delay(100);
}
