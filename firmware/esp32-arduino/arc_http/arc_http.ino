/*
 * ARC Cloud — ESP32 over plain HTTP (ThingSpeak-style). No MQTT, no certificates.
 *
 * Every SEND_INTERVAL_MS it:
 *   1. sends readings:   GET {SERVER}/api/v1/update?api_key=KEY&field1=..&field2=..
 *   2. reads controls:   GET {SERVER}/api/v1/controls?api_key=KEY&field=relay   → "1" or "0"
 *      and switches RELAY_PIN accordingly (a dashboard Switch on the "relay" control field).
 *
 * Fill in the settings below. KEY is the device password shown when you added the device
 * (Devices → Add device → "HTTP API" tab). Field numbers match Channel settings → Fields.
 *
 * For local testing, SERVER is your computer's Wi-Fi IP with port 3000, e.g. http://192.168.1.20:3000
 * In production use https:// so the key is encrypted.
 */
#include <WiFi.h>
#include <HTTPClient.h>

const char *WIFI_SSID     = "your-wifi";
const char *WIFI_PASSWORD = "your-wifi-password";
const char *SERVER        = "http://192.168.1.20:3000";
const char *API_KEY       = "paste-the-device-key";

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
  http.begin(url);
  int code = http.GET();
  String body = code > 0 ? http.getString() : "";
  if (code != 200) Serial.printf("HTTP %d %s\n", code, body.c_str());
  http.end();
  return code == 200 ? body : "";
}

void sendReadings() {
  String url = String(SERVER) + "/api/v1/update?api_key=" + API_KEY +
               "&field1=" + String(readTemperatureC(), 2) +
               "&field2=" + String(readHumidityPct(), 1);
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
  }
  delay(100);
}
