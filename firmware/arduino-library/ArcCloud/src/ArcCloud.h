/*
 * ArcCloud: connect an ESP32 to ARC Cloud (https://arcloud.arclabs.in).
 *
 *   #include <ArcCloud.h>
 *   ArcCloud arc;
 *   void setup() {
 *     arc.begin(WIFI_SSID, WIFI_PASSWORD, DEVICE_ID, DEVICE_TOKEN, DEVICE_TOPIC);
 *     arc.onControl("led1", [](float v) { digitalWrite(2, v >= 1); });
 *     arc.every(15000, [] { arc.add("temperature", readTemp()); arc.send(); });
 *   }
 *   void loop() { arc.run(); }
 *
 * Field names ("temperature", "led1") must match "Name in firmware" in the channel's settings; once a channel has
 * fields, ARC Cloud rejects readings with any other name (see Rejected data).
 *
 * Two ways to give the board its credentials:
 *   begin(ssid, pass, id, token, topic)  quick start: the values are in your sketch. Fine for your own board, but the
 *                                        compiled file then contains the token: never share it or host it for OTA.
 *   beginProvisioned()                    nothing secret in the sketch: paste the PROVISION line from ARC Cloud
 *                                        ("ESP32 over USB") into the Serial Monitor once; it is kept in flash (NVS).
 *
 * Security: MQTT over TLS on port 8883, the server certificate is always verified against pinned public roots
 * (there is no insecure mode). The device token is a password: anyone who has it can send data as this device.
 */
#pragma once

#include <Arduino.h>
#include <ArduinoJson.h>
#include <PubSubClient.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>

#include "ArcCloudRoots.h"

#ifndef ARC_HOST
#define ARC_HOST "mqtt.arcloud.arclabs.in"
#endif
#ifndef ARC_PORT
#define ARC_PORT 8883
#endif
#define ARC_CLOUD_LIBRARY_VERSION "1.0.1"

class ArcCloud {
 public:
  using ControlHandler = void (*)(float value);
  using AnyControlHandler = void (*)(const char *field, float value);
  /** Return nullptr when done, or a short error text (sent back to ARC Cloud as the command's result). */
  using CommandHandler = const char *(*)(const char *name, JsonObjectConst payload);
  using TimerHandler = void (*)();

  static const uint8_t MAX_FIELDS = 16;
  static const uint8_t MAX_CONTROLS = 16;
  static const uint8_t MAX_TIMERS = 8;

  /** Quick start: credentials in the sketch. `topic` is the device's topic base, arc/v1/<org>/<channel>/<device>. */
  void begin(const char *wifiSsid, const char *wifiPassword, const char *deviceId, const char *deviceToken, const char *topic,
             const char *host = ARC_HOST, uint16_t port = ARC_PORT);
  /** No secrets in the sketch: Wi-Fi and device settings come from flash, written once with a PROVISION line over USB. */
  void beginProvisioned(const char *host = ARC_HOST, uint16_t port = ARC_PORT);

  /** Call on every pass of loop(). Keeps Wi-Fi and the cloud connection up, receives switches, runs every() timers. */
  void run();
  bool connected();

  /** Queue a reading for the next send(). Not-a-number values (failed sensor reads) are skipped. */
  bool add(const char *field, float value);
  /** Publish the queued readings as one message. False (readings dropped) while offline. */
  bool send();
  /** add() + send() for a single reading. */
  bool write(const char *field, float value);

  /** Called when the dashboard changes this control field (and right after each connect with its current value). */
  bool onControl(const char *field, ControlHandler handler);
  /** Called for control fields that have no onControl() handler. */
  void onAnyControl(AnyControlHandler handler) { anyControl_ = handler; }
  /** Commands sent from Channel settings → Commands. Without a handler every command is answered "unknown command". */
  void onCommand(CommandHandler handler) { command_ = handler; }

  /** Run `fn` every `ms` milliseconds from run(), also while offline. Up to MAX_TIMERS. */
  bool every(unsigned long ms, TimerHandler fn);

  /** Reported to ARC Cloud on each connect (Device details). Call before begin(). */
  void setFirmwareVersion(const char *version) { firmwareVersion_ = version; }
  /** Your own CA for a local test server (Docker). The hosted ARC Cloud needs nothing. Call before begin(). */
  void setCACert(const char *pem) { caCert_ = pem; }
  /** Fewer messages on Serial. */
  void setVerbose(bool verbose) { verbose_ = verbose; }

  const char *deviceId() const { return deviceId_.c_str(); }
  /** Interval from the PROVISION line (seconds), or 15. Use it with every() to follow the cloud's setting. */
  uint32_t intervalSeconds() const { return intervalS_; }
  bool ready() const { return ready_; }

 private:
  struct Reading { char field[33]; float value; };
  struct Control { char field[33]; ControlHandler handler; };
  struct Timer { unsigned long ms, last; TimerHandler fn; };

  WiFiClientSecure net_;
  PubSubClient mqtt_{net_};
  String wifiSsid_, wifiPassword_, deviceId_, token_, topicBase_, host_;
  uint16_t port_ = ARC_PORT;
  uint32_t intervalS_ = 15;
  const char *firmwareVersion_ = "sketch";
  const char *caCert_ = ARC_PUBLIC_ROOTS;
  bool verbose_ = true, ready_ = false, provisionedMode_ = false, timeStarted_ = false;
  unsigned long wifiStartedAt_ = 0, nextMqttAttempt_ = 0, lastDiagnostics_ = 0;
  uint32_t failures_ = 0, bootId_ = 0, seq_ = 0;
  Reading readings_[MAX_FIELDS];
  uint8_t nReadings_ = 0;
  Control controls_[MAX_CONTROLS];
  uint8_t nControls_ = 0;
  AnyControlHandler anyControl_ = nullptr;
  CommandHandler command_ = nullptr;
  Timer timers_[MAX_TIMERS];
  uint8_t nTimers_ = 0;

  void start();
  bool validate();
  void loadSettings();
  void pollSerial();
  String applyProvision(const char *json);
  void printStatus();
  void ensureWiFi();
  void ensureMqtt();
  void diagnose();
  void publishState();
  void ack(const char *commandId, const char *error);
  void handleMessage(char *topic, byte *payload, unsigned int length);
  void runTimers();
  unsigned long backoffMs();
  bool timeSynced() const;
  String topic(const char *suffix) const { return topicBase_ + suffix; }
};
