/**
 * MQTT topic convention (docs/device-protocol/README.md):
 *   arc/v1/{orgId}/{projectId}/{deviceId}/{channel}
 *
 * Devices publish `telemetry`, `state` and `cmd-ack` (command acknowledgements) and
 * subscribe to their own `cmd` topic (control values and commands).
 */

export const TOPIC_ROOT = 'arc';
export const TOPIC_VERSION = 'v1';

export const DEVICE_PUBLISH_CHANNELS = ['telemetry', 'state', 'cmd-ack'] as const;
export const RESERVED_CHANNELS = ['cmd'] as const;

export type DevicePublishChannel = (typeof DEVICE_PUBLISH_CHANNELS)[number];
export type TopicChannel = DevicePublishChannel | (typeof RESERVED_CHANNELS)[number];

/** IDs are UUIDs in practice; this allows any safe, wildcard-free segment. */
const SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;

export interface TopicIds {
  orgId: string;
  projectId: string;
  deviceId: string;
}

export interface ParsedTopic extends TopicIds {
  channel: TopicChannel;
}

export function isSafeSegment(value: string): boolean {
  return SEGMENT.test(value);
}

export function buildTopic(ids: TopicIds, channel: TopicChannel): string {
  for (const v of [ids.orgId, ids.projectId, ids.deviceId]) {
    if (!isSafeSegment(v)) throw new Error(`Unsafe topic segment: ${v}`);
  }
  return `${TOPIC_ROOT}/${TOPIC_VERSION}/${ids.orgId}/${ids.projectId}/${ids.deviceId}/${channel}`;
}

/** Parses a concrete (wildcard-free) topic. Returns null for anything outside the convention. */
export function parseTopic(topic: string): ParsedTopic | null {
  const parts = topic.split('/');
  if (parts.length !== 6) return null;
  const [root, version, orgId, projectId, deviceId, channel] = parts;
  if (root !== TOPIC_ROOT || version !== TOPIC_VERSION) return null;
  if (![orgId, projectId, deviceId].every(isSafeSegment)) return null;
  const all: readonly string[] = [...DEVICE_PUBLISH_CHANNELS, ...RESERVED_CHANNELS];
  if (!all.includes(channel)) return null;
  return { orgId, projectId, deviceId, channel: channel as TopicChannel };
}

/** Subscriptions used by the ingestion worker (MQTT 5 shared subscriptions). */
export const INGEST_SHARE_GROUP = 'arc-ingest';
export const INGEST_TOPIC_FILTERS = DEVICE_PUBLISH_CHANNELS.map(
  (c) => `${TOPIC_ROOT}/${TOPIC_VERSION}/+/+/+/${c}`,
);
export const SYS_CLIENT_EVENT_FILTERS = [
  '$SYS/brokers/+/clients/+/connected',
  '$SYS/brokers/+/clients/+/disconnected',
];

/** Payload the cloud publishes on .../cmd when a control field changes (also re-sent on connect). */
export interface ControlMessage {
  schemaVersion: 1;
  field: string;
  value: number;
  ts: string;
}

export function controlMessage(field: string, value: number, ts = new Date()): string {
  const msg: ControlMessage = { schemaVersion: 1, field, value, ts: ts.toISOString() };
  return JSON.stringify(msg);
}

/** Command published on .../cmd (distinguished from control values by `type`). */
export interface CommandMessage {
  schemaVersion: 1;
  type: 'command';
  commandId: string;
  name: string;
  payload: Record<string, unknown>;
  expiresAt: string;
}

export function commandMessage(c: { id: string; name: string; payload: Record<string, unknown>; expiresAt: Date }): string {
  const msg: CommandMessage = { schemaVersion: 1, type: 'command', commandId: c.id, name: c.name, payload: c.payload, expiresAt: c.expiresAt.toISOString() };
  return JSON.stringify(msg);
}

/** What a device publishes on .../cmd-ack. */
export interface CommandAck {
  commandId: string;
  status: 'ok' | 'error';
  result?: Record<string, unknown>;
  error?: string;
}

export function parseCommandAck(payload: Buffer | string): CommandAck | null {
  let j: any;
  try {
    j = JSON.parse(payload.toString());
  } catch {
    return null;
  }
  if (!j || typeof j !== 'object') return null;
  if (typeof j.commandId !== 'string' || !/^[0-9a-f-]{36}$/i.test(j.commandId)) return null;
  if (j.status !== 'ok' && j.status !== 'error') return null;
  const result = j.result && typeof j.result === 'object' && !Array.isArray(j.result) ? j.result : undefined;
  const error = typeof j.error === 'string' ? j.error.slice(0, 500) : undefined;
  return { commandId: j.commandId, status: j.status, result, error };
}
