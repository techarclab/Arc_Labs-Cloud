import {
  DEVICE_PUBLISH_CHANNELS,
  INGEST_SHARE_GROUP,
  INGEST_TOPIC_FILTERS,
  SYS_CLIENT_EVENT_FILTERS,
  parseTopic,
} from './topics';

export type MqttAction = 'publish' | 'subscribe' | string;

export interface DeviceAclSubject {
  id: string;
  organizationId: string;
  projectId: string;
}

/**
 * Least-privilege ACL for a device identity.
 * - publish: only its own telemetry, state and cmd-ack topics
 * - subscribe: only its own cmd topic (exact, no wildcards) to receive control values
 * The device identity comes from the authenticated connection, never the payload.
 */
export function authorizeDevice(device: DeviceAclSubject, action: MqttAction, topic: string): boolean {
  const parsed = parseTopic(topic);
  if (!parsed) return false;
  const own =
    parsed.orgId === device.organizationId &&
    parsed.projectId === device.projectId &&
    parsed.deviceId === device.id;
  if (!own) return false;
  if (action === 'publish') return (DEVICE_PUBLISH_CHANNELS as readonly string[]).includes(parsed.channel);
  if (action === 'subscribe') return parsed.channel === 'cmd';
  return false;
}

/**
 * The service account (ingestion worker, API) may subscribe to the ingest filters and client
 * events, and publish control values to concrete device cmd topics only.
 */
export function authorizeIngestService(action: MqttAction, topic: string): boolean {
  if (action === 'publish') return parseTopic(topic)?.channel === 'cmd';
  if (action !== 'subscribe') return false;
  const allowed = new Set<string>([
    ...INGEST_TOPIC_FILTERS,
    ...INGEST_TOPIC_FILTERS.map((f) => `$share/${INGEST_SHARE_GROUP}/${f}`),
    ...SYS_CLIENT_EVENT_FILTERS,
  ]);
  return allowed.has(topic);
}
