/*
 * ArcCloud: DHT11/DHT22 temperature and humidity + 2 LEDs switched from the dashboard (the ARC LABS demo board).
 * Same wiring and field names as firmware/esp32-arduino/arc_dht_mqtt, in ~40 lines.
 *
 * Fields (Channel settings -> Fields):
 *   temperature  Sensor, °C        humidity  Sensor, %        rssi  Sensor, dBm (-120..0)
 *   led1         Control, 0..1     led2      Control, 0..1
 * Wiring:
 *   DHT  + -> 3V3, OUT -> GPIO 15, - -> GND        LED 1: GPIO 25 -> 220 Ω -> LED -> GND        LED 2: GPIO 26 -> 220 Ω -> LED -> GND
 * Libraries: ArcCloud, PubSubClient, ArduinoJson, "DHT sensor library" + "Adafruit Unified Sensor".
 * Credentials: provisioned over USB (see the Provisioned example), so this build holds no secret.
 */
#include <ArcCloud.h>
#include <DHT.h>

#define DHT_PIN 15
#define DHT_TYPE DHT11   // DHT22 for the white sensor
#define LED1_PIN 25
#define LED2_PIN 26

ArcCloud arc;
DHT dht(DHT_PIN, DHT_TYPE);

void setup() {
  Serial.setRxBufferSize(2048);
  Serial.begin(115200);
  pinMode(LED1_PIN, OUTPUT);
  pinMode(LED2_PIN, OUTPUT);
  dht.begin();

  arc.setFirmwareVersion("1.0.0");
  arc.beginProvisioned();
  arc.onControl("led1", [](float v) { digitalWrite(LED1_PIN, v >= 1 ? HIGH : LOW); });
  arc.onControl("led2", [](float v) { digitalWrite(LED2_PIN, v >= 1 ? HIGH : LOW); });

  arc.every(arc.intervalSeconds() * 1000UL, [] {
    arc.add("temperature", dht.readTemperature());   // a failed read (NaN) is left out, the rest still goes
    arc.add("humidity", dht.readHumidity());
    arc.add("rssi", WiFi.RSSI());
    arc.send();
  });
}

void loop() {
  arc.run();
}
