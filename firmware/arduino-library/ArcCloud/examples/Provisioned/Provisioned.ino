/*
 * ArcCloud with NO secrets in the sketch: Wi-Fi and the device token are pasted once over USB and kept in the
 * ESP32's flash (NVS). The same compiled file then works on every board, can be shared, and can be hosted for
 * over-the-air updates. Recommended for anything beyond a first test.
 *
 * 1. Channel settings -> Fields: rssi (Sensor) and led1 (Control, 0-1), as in QuickStart.
 * 2. Upload this sketch, open the Serial Monitor (115200 baud, line ending "New Line").
 * 3. ARC Cloud -> Devices -> Add device (or New device key) -> tab "ESP32 over USB": copy the PROVISION line,
 *    put in your Wi-Fi, paste it into the Serial Monitor and press Enter. The board saves it and restarts.
 *    Serial commands: STATUS (what is stored; the token is never printed), FACTORY-RESET (erase everything).
 *
 * Note: anyone with physical USB access can read flash unless flash encryption is enabled on the chip.
 */
#include <ArcCloud.h>

#define LED_PIN 2

ArcCloud arc;

void setup() {
  Serial.setRxBufferSize(2048);   // a PROVISION line is ~300 characters; the default buffer is too small
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);

  arc.setFirmwareVersion("1.0.0");
  arc.beginProvisioned();

  arc.onControl("led1", [](float value) { digitalWrite(LED_PIN, value >= 1 ? HIGH : LOW); });

  // Sends at the interval set in ARC Cloud (part of the PROVISION line; 15 s if none).
  arc.every(arc.intervalSeconds() * 1000UL, [] {
    arc.add("rssi", WiFi.RSSI());
    arc.send();
  });
}

void loop() {
  arc.run();
}
