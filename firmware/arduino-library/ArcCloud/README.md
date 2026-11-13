# ArcCloud Arduino library

Connect an **ESP32** to [ARC Cloud](https://arcloud.arclabs.in): send sensor readings, react to dashboard
switches, receive commands. MQTT over TLS on port 8883; the server certificate is always verified against
pinned public root CAs (there is no insecure mode).

```cpp
#include <ArcCloud.h>
ArcCloud arc;

void setup() {
  Serial.begin(115200);
  arc.begin(WIFI_SSID, WIFI_PASSWORD, DEVICE_KEY);   // "arc_dk_..." from ARC Cloud
  arc.onControl("led1", [](float v) { digitalWrite(2, v >= 1); });
  arc.every(15000, [] { arc.add("temperature", readTemperature()); arc.send(); });
}
void loop() { arc.run(); }
```

## Install

1. Arduino IDE → **Sketch → Include Library → Add .ZIP Library…** → the `ArcCloud-<version>.zip` from
   ARC Cloud (device page → **Arduino code** → *Download the library*).
2. Library Manager: install **PubSubClient** (Nick O'Leary, ≥ 2.8) and **ArduinoJson** (Benoit Blanchon, v7).
3. Board: ESP32 (arduino-esp32 core 3.x), e.g. *ESP32 Dev Module*.

## Giving the board its credentials

Each device has one **device key** (`arc_dk_…`), shown when you add the device. With `arc.begin(ssid, pass, key)`
the library asks ARC Cloud (`https://api.arcloud.arclabs.in/api/v1/device/config`, certificate verified) for the
broker and the device's topic once at start-up, and keeps a copy in flash so the board still starts if the API is
unreachable. Moving the device to another channel needs no change in the sketch.

| | `arc.begin(ssid, pass, key)` | `arc.beginProvisioned()` |
|---|---|---|
| Where the key lives | in your sketch | in the ESP32's flash, pasted once over USB (`PROVISION {…}` line from ARC Cloud) |
| Good for | a first test, your own board | anything shared, several boards, over-the-air updates |
| Risk | the compiled file contains the key: never share it or host it for OTA | USB access can read flash unless flash encryption is on |

`arc.begin(ssid, pass, id, token, topic[, host, port])` (values spelled out) still works, e.g. for a local test
server. The **device key is a password**: anyone with it can send data as that device. If it leaks, use *New
device key* on the device page; the old key stops working at once.

## API

| Call | |
|---|---|
| `begin(...)` / `beginProvisioned()` | start (in `setup()`) |
| `run()` | call on every `loop()` pass; keep `delay()`s short |
| `add(field, value)` then `send()` | queue readings, publish them as one message (NaN values are skipped) |
| `write(field, value)` | one reading, sent at once |
| `onControl(field, fn)` | `fn(float)` when that dashboard control changes (and after each connect) |
| `onAnyControl(fn)` / `onCommand(fn)` | every other control; commands from *Channel settings → Commands* (return `nullptr` = done, or an error text) |
| `every(ms, fn)` | run `fn` periodically from `run()`, also offline |
| `connected()`, `intervalSeconds()`, `setFirmwareVersion()`, `setCACert()`, `setVerbose()` | |

Field names must match **Name in firmware** in the channel's fields; once a channel has fields, ARC Cloud
rejects readings with any other name (*Rejected data* shows why). A name is a letter followed by letters, digits
or `_`, at most 32 characters (`temperature`, `led1`, `humidity_pct`); `add()`, `write()` and `onControl()` refuse
anything else with a message on Serial, the same rule ARC Cloud applies. Readings sent while offline are dropped.
Reconnects back off 5 s → 5 min with jitter. Serial commands: `STATUS`; with `beginProvisioned()` also
`PROVISION {json}` and `FACTORY-RESET`.

Not in this version: ESP8266 (planned), signed over-the-air updates (use `firmware/esp32-arduino/arc_dht_mqtt`).

## Changes

- **1.1.0**: one device key. `arc.begin(ssid, pass, key)`; the topic and broker come from ARC Cloud and are kept in
  flash. `PROVISION` also accepts `{"deviceKey": "arc_dk_…"}`. Earlier sketches work unchanged.
- **1.0.1**: field names follow ARC Cloud's rule exactly (a letter, then letters, digits or `_`). 1.0.0 also
  accepted `-`, `.` and a leading digit or `_`, which ARC Cloud then rejected, so the board looked offline.
- **1.0.0**: first release.

## License

MIT, see `LICENSE`.
