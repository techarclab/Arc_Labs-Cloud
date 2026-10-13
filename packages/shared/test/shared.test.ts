import { describe, expect, it } from 'vitest';
import {
  authorizeDevice,
  authorizeIngestService,
  buildTopic,
  computeConnectivity,
  parseTopic,
  validateTelemetry,
} from '../src';

const dev = { id: 'dev-1', organizationId: 'org-1', projectId: 'proj-1' };
const ids = { orgId: 'org-1', projectId: 'proj-1', deviceId: 'dev-1' };

describe('topics', () => {
  it('round-trips a topic', () => {
    const t = buildTopic(ids, 'telemetry');
    expect(t).toBe('arc/v1/org-1/proj-1/dev-1/telemetry');
    expect(parseTopic(t)).toEqual({ ...ids, channel: 'telemetry' });
  });
  it('rejects wildcards and unknown channels', () => {
    expect(parseTopic('arc/v1/+/proj-1/dev-1/telemetry')).toBeNull();
    expect(parseTopic('arc/v1/org-1/proj-1/dev-1/firmware')).toBeNull();
    expect(parseTopic('arc/v2/org-1/proj-1/dev-1/telemetry')).toBeNull();
    expect(() => buildTopic({ ...ids, deviceId: '#' }, 'telemetry')).toThrow();
  });
});

describe('device ACL', () => {
  it('allows publishing only to its own telemetry/state', () => {
    expect(authorizeDevice(dev, 'publish', 'arc/v1/org-1/proj-1/dev-1/telemetry')).toBe(true);
    expect(authorizeDevice(dev, 'publish', 'arc/v1/org-1/proj-1/dev-1/state')).toBe(true);
  });
  it('denies other devices, tenants, wildcards, commands and subscriptions', () => {
    expect(authorizeDevice(dev, 'publish', 'arc/v1/org-1/proj-1/dev-2/telemetry')).toBe(false);
    expect(authorizeDevice(dev, 'publish', 'arc/v1/org-2/proj-1/dev-1/telemetry')).toBe(false);
    expect(authorizeDevice(dev, 'publish', 'arc/v1/org-1/proj-2/dev-1/telemetry')).toBe(false);
    expect(authorizeDevice(dev, 'publish', 'arc/v1/org-1/proj-1/dev-1/cmd-ack')).toBe(true) // command acknowledgements (phase 7);
    expect(authorizeDevice(dev, 'subscribe', 'arc/v1/org-1/proj-1/dev-2/cmd')).toBe(false);
    expect(authorizeDevice(dev, 'subscribe', 'arc/v1/org-1/proj-1/+/cmd')).toBe(false);
    expect(authorizeDevice(dev, 'subscribe', 'arc/v1/org-1/proj-1/dev-1/telemetry')).toBe(false);
    expect(authorizeDevice(dev, 'publish', 'arc/v1/org-1/proj-1/dev-1/cmd')).toBe(false);
    expect(authorizeDevice(dev, 'subscribe', '#')).toBe(false);
  });
  it('lets a device subscribe to its own control topic only', () => {
    expect(authorizeDevice(dev, 'subscribe', 'arc/v1/org-1/proj-1/dev-1/cmd')).toBe(true);
  });
  it('limits the ingest service to its subscriptions', () => {
    expect(authorizeIngestService('subscribe', '$share/arc-ingest/arc/v1/+/+/+/telemetry')).toBe(true);
    expect(authorizeIngestService('subscribe', 'arc/v1/+/+/+/state')).toBe(true);
    expect(authorizeIngestService('subscribe', '#')).toBe(false);
    expect(authorizeIngestService('publish', 'arc/v1/org-1/proj-1/dev-1/telemetry')).toBe(false);
    expect(authorizeIngestService('publish', 'arc/v1/org-1/proj-1/dev-1/cmd')).toBe(true);
    expect(authorizeIngestService('publish', 'arc/v1/+/+/+/cmd')).toBe(false);
  });
});

describe('telemetry validation', () => {
  const now = new Date('2026-10-09T10:00:00Z');
  const good = {
    schemaVersion: 1,
    messageId: 'm-1',
    timestamp: '2026-10-09T09:59:30Z',
    metrics: { temperatureC: 29.4, humidityPct: 61 },
    metadata: { firmwareVersion: '1.0.0' },
  };

  it('accepts the documented payload', () => {
    const r = validateTelemetry(JSON.stringify(good), { now });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.deviceTime?.toISOString()).toBe('2026-10-09T09:59:30.000Z');
  });
  it('flags a missing timestamp but accepts', () => {
    const { timestamp, ...rest } = good;
    const r = validateTelemetry(JSON.stringify(rest), { now });
    expect(r.ok && r.warnings).toEqual(['missing_timestamp']);
  });
  it.each([
    ['invalid_json', '{not json'],
    ['schema_invalid', JSON.stringify({ ...good, metrics: { temperatureC: 'hot' } })],
    ['schema_invalid', JSON.stringify({ ...good, metrics: {} })],
    ['schema_invalid', JSON.stringify({ ...good, deviceId: 'spoofed' })],
    ['timestamp_out_of_range', JSON.stringify({ ...good, timestamp: '2026-10-09T11:00:00Z' })],
    ['payload_too_large', JSON.stringify({ ...good, metadata: { x: 'a'.repeat(200) } }).padEnd(20000, ' ')],
  ])('rejects %s', (reason, raw) => {
    const r = validateTelemetry(raw, { now });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe(reason);
  });
  it('enforces project metric definitions', () => {
    const rules = [{ metricKey: 'temperatureC', minValue: -40, maxValue: 85 }];
    const r1 = validateTelemetry(JSON.stringify(good), { now, metricRules: rules });
    expect(!r1.ok && r1.reason).toBe('metric_not_allowed');
    const r2 = validateTelemetry(JSON.stringify({ ...good, metrics: { temperatureC: 120 } }), { now, metricRules: rules });
    expect(!r2.ok && r2.reason).toBe('value_out_of_range');
  });
});

describe('connectivity', () => {
  const now = new Date('2026-10-09T10:00:00Z');
  const ago = (s: number) => new Date(now.getTime() - s * 1000);
  const base = { now, lastSeenAt: null, lastConnectedAt: null, lastDisconnectedAt: null, expectedIntervalSeconds: 60 };

  it('is unknown before first report', () => {
    expect(computeConnectivity(base).status).toBe('unknown');
  });
  it('is online within interval×3 + grace', () => {
    expect(computeConnectivity({ ...base, lastSeenAt: ago(200) }).status).toBe('online');
    expect(computeConnectivity({ ...base, lastSeenAt: ago(211) }).status).toBe('offline');
  });
  it('goes offline immediately on a newer broker disconnect', () => {
    const c = computeConnectivity({ ...base, lastSeenAt: ago(10), lastDisconnectedAt: ago(5) });
    expect(c).toMatchObject({ status: 'offline', source: 'broker_event' });
  });
});
