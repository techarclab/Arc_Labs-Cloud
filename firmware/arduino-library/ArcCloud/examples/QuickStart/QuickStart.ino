/*
 * ArcCloud quick start: the board's Wi-Fi signal goes to ARC Cloud every 15 s, and a dashboard switch named "led1"
 * turns the on-board LED on and off. No sensor needed.
 *
 * 1. ARC Cloud: open your channel -> Channel settings -> Fields. Add
 *      rssi  (kind Sensor, unit dBm, min -120, max 0)     and     led1  (kind Control, min 0, max 1)
 * 2. Devices -> Add device. Copy the device ID, token (password) and topic from the "Arduino" tab into the
 *    five lines below, with your 2.4 GHz Wi-Fi. (The tab can also generate this whole sketch for your channel.)
 * 3. Board "ESP32 Dev Module", upload, open the Serial Monitor at 115200 baud.
 *
 * This file holds the device token, which works like a password: don't share the sketch or the compiled file,
 * and don't host this build for over-the-air updates. The "Provisioned" example keeps it out of the sketch.
 */
#include <ArcCloud.h>

#define WIFI_SSID      "your-wifi"
#define WIFI_PASSWORD  "your-wifi-password"
#define DEVICE_ID      "00000000-0000-0000-0000-000000000000"
#define DEVICE_TOKEN   "paste-the-device-token-here"
#define DEVICE_TOPIC   "arc/v1/<org>/<channel>/00000000-0000-0000-0000-000000000000"

#define LED_PIN 2   // the blue LED on most ESP32 Dev boards

ArcCloud arc;

void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);

  arc.setFirmwareVersion("1.0.0");
  arc.begin(WIFI_SSID, WIFI_PASSWORD, DEVICE_ID, DEVICE_TOKEN, DEVICE_TOPIC);

  // Dashboard switch "led1": 1 = on, 0 = off. Also called right after each connect with the switch's current value.
  arc.onControl("led1", [](float value) { digitalWrite(LED_PIN, value >= 1 ? HIGH : LOW); });

  // Every 15 s: one reading. Several add() calls before send() go out as one message.
  arc.every(15000, [] {
    arc.add("rssi", WiFi.RSSI());
    arc.send();
  });
}

void loop() {
  arc.run();   // keep this, and avoid long delay() calls: they stop the connection and the switches
}
