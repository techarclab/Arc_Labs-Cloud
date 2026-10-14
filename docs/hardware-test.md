# Testing ARC Cloud with real hardware

About 30 minutes. You need any ESP32 board (ESP32 DevKit, ESP32-S3, ESP32-C3…), a USB cable that carries data, a 2.4 GHz Wi-Fi network with internet, and a computer with the Arduino IDE.

The test sketch is `firmware/esp32-arduino/arc_hardware_test/arc_hardware_test.ino`. It needs no sensors and no extra libraries: it sends the board's own chip temperature, Wi-Fi signal, uptime, free memory and BOOT-button state, lets a dashboard switch control the on-board LED, and runs commands sent from the console.

---

## Part A: prepare ARC Cloud (10 min)

1. Sign in at **arc-labs-cloud.vercel.app**.
2. **New channel** (the **+** next to *Channels*): name it `Hardware test`.
3. **Channel settings → Fields**: set these six fields and **Save**:

   | Field | Firmware name | Label | Kind | Unit |
   |---|---|---|---|---|
   | 1 | `chipTempC` | Chip temperature | Sensor | °C |
   | 2 | `wifiDbm` | Wi-Fi signal | Sensor | dBm |
   | 3 | `uptimeMin` | Uptime | Sensor | min |
   | 4 | `freeKb` | Free memory | Sensor | KB |
   | 5 | `button` | BOOT button | Sensor | (min 0, max 1) |
   | 6 | `led` | LED | **Control** | (min 0, max 1, step 1) |

4. **Devices → Add device**: name `My ESP32`, kind `esp32`, *Sends data every* **15 seconds**. Open the **HTTP API** tab and copy:
   - the **device key** (shown only once; keep it safe),
   - the **server address** (the part before `/api/v1/update`, e.g. `https://arcapi-production-30bb.up.railway.app`).
5. **Commands → New command**: add `blink` with a number setting `seconds` (1–30). Optionally also add `set_interval` (number `seconds`, 5–3600) and `reboot` (no settings).
6. **Dashboard → Create a starter dashboard**, then **Edit dashboard → Add widget → Switch** on the `LED` field, and **Save dashboard**.
7. Optional, to test alerts: **Rules → New rule**:
   - “BOOT button pressed”: *A reading crosses a limit*, BOOT button **is at or above** 1, severity Warning.
   - “ESP32 offline”: *A device goes offline*, device My ESP32.

## Part B: set up the Arduino IDE (first time only, 10 min)

1. Install the Arduino IDE 2 from arduino.cc.
2. **File → Preferences → Additional boards manager URLs**, add
   `https://espressif.github.io/arduino-esp32/package_esp32_index.json`
3. **Tools → Board → Boards Manager**, search **esp32** (by Espressif Systems), **Install**.
4. Windows only: if the board doesn't appear under **Tools → Port** when plugged in, install the USB driver printed on its USB chip (CP210x or CH340).

## Part C: flash the test sketch (5 min)

1. Open `C:\arc-cloud\firmware\esp32-arduino\arc_hardware_test\arc_hardware_test.ino`.
2. Fill in the four settings at the top:
   ```cpp
   const char *WIFI_SSID     = "your Wi-Fi name";
   const char *WIFI_PASSWORD = "your Wi-Fi password";
   const char *SERVER        = "https://arcapi-production-30bb.up.railway.app";
   const char *API_KEY       = "the device key from step A4";
   ```
3. **Tools → Board**: your board (e.g. *ESP32 Dev Module*). **Tools → Port**: the COM port that appears when you plug it in.
4. Click **Upload**. If it stops at `Connecting....`, hold the **BOOT** button until the upload starts.
5. Open **Tools → Serial Monitor** at **115200 baud** and press the board's **EN/RST** button.

## Part D: what a passing run looks like

```
ARC Cloud hardware test test-1.0
[1/5] Wi-Fi: connecting to "MyWiFi"....
   OK  ip 192.168.1.42, signal -54 dBm
[2/5] Server https://arcapi-production-30bb.up.railway.app: OK  reachable
[3/5] Device key accepted, readings stored. OK
      Open the device page in ARC Cloud: it should now show Online.
   sent #1  temp 46.1 C  wifi -54 dBm  button 0
[4/5] Controls: "led" = off. OK  Flip the Switch widget and watch the LED.
[5/5] Commands: listening. OK  Send "blink" from the device page.
```

Every failure line explains itself (wrong key, suspended device, unreachable server, missing field…). See Part F.

## Part E: test checklist

Tick each one; together they cover the whole device path of the platform.

| # | Do this | Expect | Feature tested |
|---|---|---|---|
| 1 | Watch the device page | **Online**, readings update every 15 s, firmware `test-1.0` | MQTT/HTTP ingestion, device state |
| 2 | Hold the **BOOT** button for 20 s | `button` reads 1 on the next message; with the rule from A7, an alert appears under **Alerts** (and email/webhook if set up) | Rules & alerts |
| 3 | Release it, wait 30 s | The alert resolves on its own (“recovered”) | Alert recovery |
| 4 | Flip the **LED** switch on the dashboard | The board's LED changes within 15 s | Controls (downlink) |
| 5 | Device page → **Send a command… → blink**, seconds 3 | LED flashes; the command shows **Done** | Commands with acknowledgement |
| 6 | Send **set_interval** 30 | Serial shows “now sending every 30 s”; set *Sends data every* to 30 on the device page | Command settings validation |
| 7 | Unplug the board for 2 minutes | Device shows **Offline**; the “ESP32 offline” alert opens | Offline detection |
| 8 | Plug it back in | Back to **Online**; the alert resolves | Recovery |
| 9 | Change `API_KEY` to a wrong value and upload | Serial: `401: the API_KEY is wrong` | Device authentication |
| 10 | Device page → **Suspend**, then **Mark as active again** | Serial shows `403` while suspended, then recovers | Lifecycle |
| 11 | **Channel → API keys & export → Download CSV** | A file with your readings | Data export |
| 12 | Leave it running for an hour | Gap-free heartbeat strip and history chart | Reliability |

## Part F: troubleshooting

| Serial Monitor says | What to do |
|---|---|
| Wi-Fi keeps printing dots | Wrong name/password, or a 5 GHz-only network. Phone hotspots work: set them to 2.4 GHz / “maximize compatibility”. |
| `Can't reach the server` | `SERVER` must start with `https://` and have no `/api/v1` at the end; check the Wi-Fi has internet; open `SERVER/health/ready` in a browser — it must say `{"status":"ok"}`. |
| `401` | Copy the key again; if lost, device page → **Replace password** gives a new one (update the sketch). |
| `403` | The device is suspended or revoked. |
| `404` on controls | Add the Control field `led` (step A3). The test carries on without it. |
| `400 … not allowed / out of range` | A value is outside the field's min/max. Check Channel settings → Fields. |
| `5xx` | The server is having trouble: run `bash tools/railway-doctor.sh` and check the logs. |
| Upload fails | Hold BOOT during “Connecting…”, try another USB cable/port, pick the right board. |

## Next: real sensors and MQTT

- **Real sensors**: in your own sketch, send any values the same way, e.g. `&field1=<DHT22 temperature>&field2=<humidity>`. Start from `firmware/esp32-arduino/arc_http` (adds signed over-the-air updates).
- **MQTT over TLS** (instant controls and commands, less data): `firmware/esp32-arduino/arc_device`. Copy `config.example.h` to `config.h` and fill it from the device's **MQTT** tab; the broker is the Railway TCP proxy (e.g. `centerbeam.proxy.rlwy.net:54894`), and the CA certificate is `infra/certs/out/ca.crt`.
- **Firmware update test**: see **Firmware & OTA** in the console and `tools/firmware-sign.mjs`.
