/*
 * ARC Cloud — ESP32 + DHT11/DHT22 temperature & humidity sensor.
 *
 * Sends every 15 seconds:  field1 = temperature (°C), field2 = humidity (%), field3 = Wi-Fi signal (dBm)
 * Receives:                the dashboard Switch on the control field "led" turns the on-board LED (GPIO 2) on/off
 *                          (checked every 3 seconds).
 *
 * Wiring (3-pin DHT module):  + / VCC -> 3V3    OUT / DATA -> GPIO 4    - / GND -> GND
 * Library: Arduino IDE -> Sketch -> Include Library -> Manage Libraries -> "DHT sensor library" (Adafruit) -> Install all
 * Board:   Tools -> Board -> esp32 -> ESP32 Dev Module.   Serial Monitor: 115200 baud.
 * Full steps: docs/hardware-test.md (section "DHT sensor").
 */
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <DHT.h>

// ---------- your settings ----------
const char* WIFI_NAME = "your-wifi-name";          // must be 2.4 GHz
const char* WIFI_PASS = "your-wifi-password";
const char* SERVER    = "https://lku7dufiw0.execute-api.ap-southeast-1.amazonaws.com";
const char* API_KEY   = "paste-the-device-key";    // from the device's "HTTP API" tab
#define SENSOR_TYPE DHT11                           // change to DHT22 if you have a DHT22 (white sensor)
// -----------------------------------

const int SENSOR_PIN = 4;
const int LED_PIN = 2;
const unsigned long SEND_EVERY_MS = 15000;

DHT dht(SENSOR_PIN, SENSOR_TYPE);

void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;
  Serial.print("Connecting to Wi-Fi \"");
  Serial.print(WIFI_NAME);
  Serial.print("\"");
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_NAME, WIFI_PASS);
  int tries = 0;
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
    if (++tries == 40) {  // 20 seconds
      Serial.println("\nStill not connected: check the name, password and that it's 2.4 GHz. Trying again...");
      WiFi.disconnect();
      WiFi.begin(WIFI_NAME, WIFI_PASS);
      tries = 0;
    }
  }
  Serial.print("\nWi-Fi connected. IP address: ");
  Serial.println(WiFi.localIP());
}

int lastLed = -2;  // -2 = never checked, -1 = not set, 0 = off, 1 = on

// Asks ARC Cloud for the "led" control value and switches the LED. Prints only when it changes.
void readLedSwitch() {
  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;
  http.setTimeout(10000);
  http.begin(client, String(SERVER) + "/api/v1/controls?api_key=" + API_KEY + "&field=led");
  int code = http.GET();
  if (code == 200) {
    String v = http.getString();
    v.trim();
    int state = v.length() == 0 ? -1 : (v.toInt() != 0 ? 1 : 0);
    if (state >= 0) digitalWrite(LED_PIN, state == 1 ? HIGH : LOW);
    if (state != lastLed) {
      if (state == -1) Serial.println("LED switch: not set yet (flip the switch on the dashboard)");
      else Serial.println(state == 1 ? "LED switch: ON  -> LED on" : "LED switch: OFF -> LED off");
      lastLed = state;
    }
  } else if (code == 404) {
    if (lastLed != -3) Serial.println("LED switch: add a Control field named \"led\" in Channel settings -> Fields");
    lastLed = -3;
  } else {
    Serial.printf("LED switch: server replied %d\n", code);
  }
  http.end();
}

void setup() {
  Serial.begin(115200);
  delay(500);
  pinMode(LED_PIN, OUTPUT);
  dht.begin();
  Serial.println("\n=== ARC Cloud DHT sensor ===");
  connectWiFi();
}

void loop() {
  connectWiFi();

  float temp = dht.readTemperature();  // °C
  float hum = dht.readHumidity();      // %
  if (isnan(temp) || isnan(hum)) {
    Serial.println("Sensor not responding: check the wiring (DATA on GPIO 4, + on 3V3, - on GND) and SENSOR_TYPE.");
    delay(5000);
    return;
  }

  String url = String(SERVER) + "/api/v1/update?api_key=" + API_KEY +
               "&field1=" + String(temp, 1) +
               "&field2=" + String(hum, 1) +
               "&field3=" + String(WiFi.RSSI());

  WiFiClientSecure client;
  client.setInsecure();  // HTTPS without certificate check (fine for testing)
  HTTPClient http;
  http.setTimeout(10000);
  http.begin(client, url);
  int code = http.GET();

  Serial.printf("Temperature %.1f C   Humidity %.1f %%   -> ", temp, hum);
  if (code == 200) {
    Serial.println("sent to ARC Cloud (200 OK)");
  } else if (code < 0) {
    Serial.println("can't reach the server: check the hotspot has internet and the SERVER address");
  } else if (code == 401) {
    Serial.println("401: wrong API_KEY (copy it again from the device page)");
  } else if (code == 403) {
    Serial.println("403: the device is suspended or revoked in ARC Cloud");
  } else {
    Serial.printf("server replied %d: %s\n", code, http.getString().c_str());
  }
  http.end();

  // Until the next reading is due, check the LED switch every 3 seconds.
  unsigned long start = millis();
  while (millis() - start < SEND_EVERY_MS) {
    readLedSwitch();
    delay(3000);
  }
}
