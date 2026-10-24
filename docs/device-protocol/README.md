# ARC Cloud device protocol — v1

Status: implemented in `packages/shared` and enforced by the broker ACL and the ingestion worker. Freeze before shipping firmware; breaking changes go to `arc/v2`.

## Connection

| Item | Value |
|---|---|
| Transport | MQTT 3.1.1 or 5 over TLS 1.2+ on port 8883 |
| Client ID | device UUID |
| Username | device UUID (must equal client ID) |
| Password | per-device secret from provisioning/rotation |
| Keep-alive | 30–60 s recommended |
| Server cert | verify against the ARC CA (dev: `infra/certs/out/ca.crt`) |

Connection is refused when the password is wrong, the credential was rotated or revoked, the device is `suspended`/`revoked`/`retired`, or the organization is suspended.

## Topics

```
arc/v1/{orgId}/{projectId}/{deviceId}/telemetry   publish, QoS 1   measurements
arc/v1/{orgId}/{projectId}/{deviceId}/state       publish, QoS 1   reported state (firmware, uptime, config)
arc/v1/{orgId}/{projectId}/{deviceId}/cmd         subscribe, QoS 1 control values and commands from the cloud
arc/v1/{orgId}/{projectId}/{deviceId}/cmd-ack     publish, QoS 1   command acknowledgements
```

A device may publish only to its own telemetry, state and cmd-ack topics, and subscribe only to its own cmd topic. Anything else disconnects the client. Retained messages are disabled.

## Control values (cmd)

When someone flips a switch or moves a slider on the dashboard, the cloud publishes:

```json
{ "schemaVersion": 1, "field": "relay", "value": 1, "ts": "2026-10-12T06:11:50.739Z" }
```

`field` is the control field's name from Channel settings. Values are kept inside the field's min/max. Every time the device connects, the cloud re-sends all current control values about 2 seconds later, so subscribe right after connecting.

## Commands (cmd → cmd-ack)

Commands are allow-listed per channel (Channel settings → Commands: name, parameters with type/min/max, time-to-live, who may send). The cloud publishes on `cmd`:

```json
{ "schemaVersion": 1, "type": "command", "commandId": "7f1c…", "name": "blink", "payload": { "seconds": 3 }, "expiresAt": "2026-10-12T06:16:50Z" }
```

The device runs it and publishes on `cmd-ack`:

```json
{ "commandId": "7f1c…", "status": "ok", "result": { "blinked": true } }
{ "commandId": "7f1c…", "status": "error", "error": "LED broken" }
```

Status in the cloud: `queued` (device offline) → `published` (sent) → `acknowledged` / `failed` (only from the device's ack) or `expired` (no ack before `expiresAt`). Queued commands are delivered when the device reconnects. Acks for unknown, finished or expired commands are ignored. Tell control values and commands apart by `type`.

### Firmware update (`ota.update`)

A reserved command sent by firmware rollouts:

```json
{ "type": "command", "name": "ota.update", "commandId": "…",
  "payload": {
    "manifest": "{\"deviceType\":\"esp32\",\"sha256\":\"…\",\"sizeBytes\":1048576,\"url\":\"https://…/fw.bin\",\"version\":\"1.2.0\"}",
    "signature": "MEUCIQ…",
    "signingKeyId": "…", "rolloutId": "…",
    "deviceType": "esp32", "version": "1.2.0", "url": "https://…/fw.bin", "sha256": "…", "sizeBytes": 1048576 } }
```

**Device rules (do not skip any):**

1. Verify `signature` (ECDSA P-256 over SHA-256, DER, base64) over the exact bytes of `manifest` with the OTA public key **compiled into the firmware**. The cloud also checks it, but the device must not trust the cloud, broker or network for firmware integrity.
2. Read `url`, `sha256`, `sizeBytes`, `version` and `deviceType` **only from the signed `manifest`**. The loose copies next to it are for display and older firmware.
3. Refuse a `deviceType` other than your own, and any `version` that is not newer than the running one (MAJOR.MINOR.PATCH, compared numerically). This stops a replayed old, signed release from downgrading the device.
4. Download over certificate-verified HTTPS, check size and SHA-256 while writing, and switch the boot partition only when both match.
5. After rebooting into the new image, mark it valid only once it has reached the cloud, and roll back if it never does. The reference firmware does this (5-minute window), using the Arduino-ESP32 3.x bootloader's rollback support.

Then ack `ok`, restart and report the new `firmwareVersion` (telemetry `metadata` or `state`). The rollout counts a device as succeeded only when it reports the new version. If a check fails, ack `error` with the reason and keep the current firmware. Reference implementation: `firmware/esp32-arduino/arc_device/arc_ota.h` and `arc_ota_verify.h`. CI cross-checks it against `tools/firmware-sign.mjs` (`tests/firmware`).

Signing: `node tools/firmware-sign.mjs keygen` (P-256 by default), add the public key under **Firmware → Signing keys**, put it in the firmware with `node tools/firmware-sign.mjs header firmware-signing-public.pem`, and sign each image with `node tools/firmware-sign.mjs sign …`. Keep the private key offline (a password manager or hardware token, or a protected CI secret), never in the repo. Ed25519 keys registered earlier still work server-side, but the reference firmware can't verify them, so migrate to P-256.

## HTTP API (ThingSpeak-style)

For devices that don't use MQTT. The key is the device password (shown once when the device is added). Send it as a header, `Authorization: Bearer KEY` (or `X-API-Key: KEY`), never in the URL: URLs are recorded in proxy, load balancer and server logs. HTTPS only, with the server certificate verified (the reference sketches pin public root CAs in `arc_roots.h`).

| Request | What it does |
|---|---|
| `GET/POST /api/v1/update?field1=23.5&field2=60` | Send readings. `fieldN` maps to field number N in Channel settings; names (`&temperature=23.5`) work too. Optional `created_at` (ISO time). At most 1 request/second per device. |
| `GET /api/v1/controls` | All control values as JSON, e.g. `{"relay":1,"fanSpeed":40}`. Also marks the device as seen. |
| `GET /api/v1/controls?field=relay` | One control value as plain text (`1`). `field=field3` works too. |
| `GET /api/v1/channels/{channelId}/feeds.json?results=100` | Read the channel's data (also `feeds.csv`) with the channel **read** key in `X-API-Key` (or `?api_key=`: it is read-only and rotatable). Optional `device`, `start`, `end`. |
| `GET /api/v1/commands/next` | Oldest pending command (`{commandId,name,payload,expiresAt}`), or `204` when there is none. |
| `POST /api/v1/commands/{commandId}/ack` | Body `{"status":"ok"}` or `{"status":"error","error":"…"}`. |

Add `&firmware_version=1.2.0` to `/update` so firmware rollouts can confirm HTTP devices.

ThingSpeak-style `?api_key=KEY` in the URL still works while the API runs with `DEVICE_KEY_IN_QUERY=true` (the default, for existing devices). Set it to `false` in production once your firmware sends the header; the API then answers `401 api_key_in_url_disabled`.

## Telemetry payload

```json
{
  "schemaVersion": 1,
  "messageId": "a1b2c3d4-42",
  "timestamp": "2026-10-09T10:00:00Z",
  "metrics": { "temperatureC": 29.4, "humidityPct": 61.0 },
  "metadata": { "firmwareVersion": "1.0.0" }
}
```

| Field | Rule |
|---|---|
| `schemaVersion` | must be `1` |
| `messageId` | required, 1–128 chars `[A-Za-z0-9._:-]`, unique per device for at least 7 days. Re-sends with the same ID are stored once. Tip: `<random boot id>-<counter>`. |
| `timestamp` | optional ISO-8601 with offset/`Z`. Rejected if > 5 min in the future or > 7 days old. If omitted, server receive time is used. |
| `metrics` | 1–64 keys matching `^[A-Za-z][A-Za-z0-9_]{0,63}$`, finite numbers only. If the project has metric definitions, only defined keys within min/max are accepted. |
| `metadata` | optional, ≤ 32 string/number/boolean values. `firmwareVersion` updates the device record. |
| Unknown fields | rejected (e.g. a `deviceId` in the payload is never trusted). |
| Size | ≤ 16 KB |

## State payload

```json
{ "schemaVersion": 1, "timestamp": "2026-10-09T10:00:00Z", "state": { "firmwareVersion": "1.0.0", "uptimeS": 3600 } }
```

`state` replaces the device's `reportedState` (≤ 64 string/number/boolean values).

## Online / offline

- Broker connect/disconnect events update `lastConnectedAt` / `lastDisconnectedAt`.
- A disconnect newer than the last activity → **offline** immediately.
- Otherwise **online** if the last message/connect is within `expectedIntervalSeconds × 3 + 30 s`.
- Never reported → **unknown**.

Set `expectedIntervalSeconds` per device to match its publish interval (battery and cellular devices: set it to their real wake interval).

## Rate limits

Per device, per worker: 5 msg/s sustained, burst 20 (configurable). Excess messages are dropped and counted, not stored.

## Rejections

Rejected messages are logged with a reason (`invalid_json`, `schema_invalid`, `timestamp_out_of_range`, `metric_not_allowed`, `value_out_of_range`, `payload_too_large`, `device_inactive`, `topic_mismatch`) and a 512-byte excerpt. Read them at `GET /api/v1/organizations/{orgId}/rejected-messages`.
