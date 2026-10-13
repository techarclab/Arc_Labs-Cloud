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
  "payload": { "deviceType": "esp32", "version": "1.2.0", "url": "https://…/fw.bin", "sha256": "…", "sizeBytes": 1048576, "signature": "…", "rolloutId": "…" } }
```

The cloud has already verified the Ed25519 `signature` over the manifest. The device downloads `url`, checks size and SHA-256, installs, acks `ok`, restarts and reports the new `firmwareVersion` (telemetry `metadata` or `state`). The rollout counts a device as succeeded only when it reports the new version. On any mismatch the device acks `error` and keeps its current firmware. Example: `firmware/esp32-arduino/arc_device/arc_ota.h`.

## HTTP API (ThingSpeak-style)

For devices that don't use MQTT. The key is the device password (shown once when the device is added).

| Request | What it does |
|---|---|
| `GET/POST /api/v1/update?api_key=KEY&field1=23.5&field2=60` | Send readings. `fieldN` maps to field number N in Channel settings; names (`&temperature=23.5`) work too. Optional `created_at` (ISO time). At most 1 request/second per device. |
| `GET /api/v1/controls?api_key=KEY` | All control values as JSON, e.g. `{"relay":1,"fanSpeed":40}`. Also marks the device as seen. |
| `GET /api/v1/controls?api_key=KEY&field=relay` | One control value as plain text (`1`). `field=field3` works too. |
| `GET /api/v1/channels/{channelId}/feeds.json?api_key=READ_KEY&results=100` | Read the channel's data (also `feeds.csv`). Optional `device`, `start`, `end`. |
| `GET /api/v1/commands/next?api_key=KEY` | Oldest pending command (`{commandId,name,payload,expiresAt}`), or `204` when there is none. |
| `POST /api/v1/commands/{commandId}/ack?api_key=KEY` | Body `{"status":"ok"}` or `{"status":"error","error":"…"}`. |

Add `&firmware_version=1.2.0` to `/update` so firmware rollouts can confirm HTTP devices.

The key can also be sent as an `X-API-Key` header. Use HTTPS in production.

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
