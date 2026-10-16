/*
 * ARC Cloud — hardware test for any ESP32 board. No sensors and no extra libraries needed.
 *
 * What it sends every SEND_SECONDS (over HTTPS to the ARC Cloud API):
 *   field1  Chip temperature (°C)   from the ESP32's internal sensor (rough, but real)
 *   field2  Wi-Fi signal (dBm)      e.g. -55 is good, -85 is weak
 *   field3  Uptime (minutes)        resets to 0 when the board restarts
 *   field4  Free memory (KB)
 *   field5  BOOT button (1 = pressed)  press the BOOT button and watch it change
 * What it receives:
 *   control field "led"   a dashboard Switch turns the on-board LED (GPIO 2) on and off
 *   commands              "blink" (seconds), "set_interval" (seconds), "reboot"
 *
 * The Serial Monitor (115200 baud) prints a numbered checklist and explains any error.
 *
 * Fill in the 4 settings below, then Upload. Full steps: docs/hardware-test.md
 */
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>

// ---------------- your settings ----------------
const char *WIFI_SSID     = "your-wifi-name";        // 2.4 GHz network (ESP32 can't join 5 GHz)
const char *WIFI_PASSWORD = "your-wifi-password";
const char *SERVER        = "https://lku7dufiw0.execute-api.ap-southeast-1.amazonaws.com";  // AWS API Gateway
const char *API_KEY       = "paste-the-device-key";  // shown once when you add the device
// ------------------------------------------------

const int LED_PIN = 2;           // on-board LED on most ESP32 DevKit boards
const int BUTTON_PIN = 0;        // BOOT button
unsigned long sendSeconds = 15;  // match "Sends data every" on the device page
#define FIRMWARE_VERSION "test-1.0"

unsigned long lastSend = 0;
int okCount = 0, failCount = 0;
bool checkedServer = false, checkedKey = false, checkedControls = false, checkedCommands = false;

// ---------------- helpers ----------------
void line() { Serial.println(F("------------------------------------------------------------")); }

void explain(int code, const String &body) {
  if (code < 0) Serial.printf("   Can't reach the server (%s).\n   Check SERVER, and that this Wi-Fi has internet.\n", HTTPClient::errorToString(code).c_str());
  else if (code == 401) Serial.println(F("   401: the API_KEY is wrong. Copy it again from the device page (or Replace password)."));
  else if (code == 403) Serial.println(F("   403: this device is suspended or revoked. Mark it active on its device page."));
  else if (code == 404) Serial.println(F("   404: wrong address, or the control field \"led\" doesn't exist in Channel settings."));
  else if (code == 429) Serial.println(F("   429: sending too often. Use at least 1 second between messages."));
  else if (code == 400) Serial.printf("   400: the server rejected the data: %s\n", body.c_str());
  else if (code >= 500) Serial.println(F("   5xx: the server had a problem. Check the AWS API and CloudWatch logs."));
  else Serial.printf("   HTTP %d %s\n", code, body.c_str());
}

// One HTTP(S) request. Returns the status code; the body goes into *out.
int request(const char *method, const String &url, const String &json, String *out) {
  WiFiClientSecure tls;
  tls.setInsecure();  // encrypted; add a CA with tls.setCACert() to also verify the server
  HTTPClient http;
  http.setTimeout(10000);
  bool ok = url.startsWith("https://") ? http.begin(tls, url) : http.begin(url);
  if (!ok) return -1;
  int code;
  if (strcmp(method, "POST") == 0) {
    http.addHeader("content-type", "application/json");
    code = http.POST(json);
  } else {
    code = http.GET();
  }
  if (out) *out = code > 0 ? http.getString() : "";
  http.end();
  return code;
}

String keyed(const char *path) { return String(SERVER) + path + (strchr(path, '?') ? "&" : "?") + "api_key=" + API_KEY; }

// Tiny JSON readers for the command message (avoids an extra library).
String jsonString(const String &j, const char *key) {
  String k = String("\"") + key + "\":\"";
  int i = j.indexOf(k);
  if (i < 0) return "";
  i += k.length();
  return j.substring(i, j.indexOf('"', i));
}
long jsonNumber(const String &j, const char *key, long fallback) {
  String k = String("\"") + key + "\":";
  int i = j.indexOf(k);
  return i < 0 ? fallback : j.substring(i + k.length()).toInt();
}

// ---------------- steps ----------------
void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;
  Serial.printf("[1/5] Wi-Fi: connecting to \"%s\"", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print('.');
    if (millis() - t0 > 20000) {
      Serial.println(F("\n   FAILED. Check the name and password, and that it's a 2.4 GHz network. Retrying..."));
      WiFi.disconnect();
      delay(2000);
      WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
      t0 = millis();
    }
  }
  Serial.printf("\n   OK  ip %s, signal %d dBm\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
}

void checkServer() {
  String body;
  int code = request("GET", String(SERVER) + "/health/live", "", &body);
  Serial.printf("[2/5] Server %s: ", SERVER);
  if (code == 200) {
    Serial.println(F("OK  reachable"));
    checkedServer = true;
  } else {
    Serial.println(F("FAILED"));
    explain(code, body);
  }
}

void sendReadings() {
  int button = digitalRead(BUTTON_PIN) == LOW ? 1 : 0;
  String url = keyed("/api/v1/update") +
               "&field1=" + String(temperatureRead(), 1) +
               "&field2=" + String(WiFi.RSSI()) +
               "&field3=" + String(millis() / 60000.0, 1) +
               "&field4=" + String(ESP.getFreeHeap() / 1024) +
               "&field5=" + String(button) +
               "&firmware_version=" FIRMWARE_VERSION;
  String body;
  int code = request("GET", url, "", &body);
  if (code == 200) {
    okCount++;
    if (!checkedKey) {
      Serial.println(F("[3/5] Device key accepted, readings stored. OK"));
      Serial.println(F("      Open the device page in ARC Cloud: it should now show Online."));
      checkedKey = true;
    }
    Serial.printf("   sent #%d  temp %.1f C  wifi %d dBm  button %d\n", okCount, temperatureRead(), WiFi.RSSI(), button);
  } else {
    failCount++;
    Serial.println(F("[3/5] Sending readings FAILED"));
    explain(code, body);
  }
}

void readControls() {
  String body;
  int code = request("GET", keyed("/api/v1/controls?field=led"), "", &body);
  if (code == 200) {
    body.trim();
    bool on = body.toInt() != 0;
    digitalWrite(LED_PIN, on ? HIGH : LOW);
    if (!checkedControls) {
      Serial.printf("[4/5] Controls: \"led\" = %s. OK  Flip the Switch widget and watch the LED.\n", on ? "on" : "off");
      checkedControls = true;
    }
  } else if (!checkedControls) {
    Serial.println(F("[4/5] Controls: skipped (add a Control field named \"led\" to test the LED)."));
    checkedControls = true;
  }
}

void ack(const String &id, const char *error) {
  String json = error ? String("{\"status\":\"error\",\"error\":\"") + error + "\"}" : String("{\"status\":\"ok\"}");
  String body;
  int code = request("POST", keyed((String("/api/v1/commands/") + id + "/ack").c_str()), json, &body);
  if (code != 200) {
    Serial.println(F("   acknowledging the command FAILED"));
    explain(code, body);
  }
}

void runCommand() {
  String body;
  int code = request("GET", keyed("/api/v1/commands/next"), "", &body);
  if (!checkedCommands) {
    Serial.println(code == 204 || code == 200 ? F("[5/5] Commands: listening. OK  Send \"blink\" from the device page.") : F("[5/5] Commands: FAILED"));
    if (code != 204 && code != 200) explain(code, body);
    checkedCommands = true;
    line();
  }
  if (code != 200) return;  // 204 = nothing to do
  String id = jsonString(body, "commandId");
  String name = jsonString(body, "name");
  Serial.printf(">> command \"%s\"\n", name.c_str());
  if (name == "blink") {
    long seconds = constrain(jsonNumber(body, "seconds", 3), 1L, 30L);
    for (long i = 0; i < seconds * 4; i++) { digitalWrite(LED_PIN, i % 2 ? LOW : HIGH); delay(125); }
    ack(id, nullptr);
  } else if (name == "set_interval") {
    long s = jsonNumber(body, "seconds", 0);
    if (s < 5 || s > 3600) { ack(id, "seconds must be 5 to 3600"); return; }
    sendSeconds = s;
    Serial.printf("   now sending every %lu s (update \"Sends data every\" to match)\n", sendSeconds);
    ack(id, nullptr);
  } else if (name == "reboot") {
    ack(id, nullptr);
    Serial.println(F("   restarting..."));
    delay(500);
    ESP.restart();
  } else {
    ack(id, "unknown command");
  }
}

void setup() {
  Serial.begin(115200);
  delay(400);
  pinMode(LED_PIN, OUTPUT);
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  line();
  Serial.println(F("ARC Cloud hardware test " FIRMWARE_VERSION));
  line();
  connectWiFi();
  checkServer();
}

void loop() {
  connectWiFi();
  if (!checkedServer) {
    checkServer();
    if (!checkedServer) { delay(10000); return; }
  }
  if (lastSend == 0 || millis() - lastSend >= sendSeconds * 1000UL) {
    lastSend = millis();
    sendReadings();
    readControls();
    runCommand();
  }
  delay(50);
}
