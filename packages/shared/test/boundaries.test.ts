/**
 * Edge cases and exact boundaries of the device-facing rules (payload validation, timestamps, online/offline,
 * control messages, ACL). The happy paths are in shared.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { authorizeDevice, computeConnectivity, controlMessage, MAX_METRICS_PER_MESSAGE, METRIC_KEY, validateState, validateTelemetry } from '../src';

const now = new Date('2026-10-09T10:00:00Z');
const base = { schemaVersion: 1, messageId: 'm-1', metrics: { t: 1 } };
const tel = (over: Record<string, unknown>, opts = {}) => validateTelemetry(JSON.stringify({ ...base, ...over }), { now, ...opts });
const reason = (r: { ok: boolean; reason?: string }) => (r.ok ? 'ok' : r.reason);

describe('metric names (METRIC_KEY: what the ArcCloud library must also accept)', () => {
  it.each(['t', 'temperature', 'led1', 'humidity_pct', 'A'.repeat(64)])('accepts %s', (k) => expect(METRIC_KEY.test(k)).toBe(true));
  it.each(['', '1st', '_x', 'temp-c', 'temp.c', 'temp c', 'é', 'A'.repeat(65)])('rejects %j', (k) => expect(METRIC_KEY.test(k)).toBe(false));
  it('a payload with one bad key is rejected as a whole', () => {
    expect(reason(tel({ metrics: { good: 1, 'bad-key': 2 } }))).toBe('schema_invalid');
  });
});

describe('telemetry payload limits', () => {
  it(`accepts exactly ${MAX_METRICS_PER_MESSAGE} metrics and rejects one more`, () => {
    const m = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`m${i}`, i]));
    expect(reason(tel({ metrics: m(MAX_METRICS_PER_MESSAGE) }))).toBe('ok');
    expect(reason(tel({ metrics: m(MAX_METRICS_PER_MESSAGE + 1) }))).toBe('schema_invalid');
  });
  it('accepts 16 KB and rejects one byte more', () => {
    const at = (bytes: number) => {
      const shell = JSON.stringify({ ...base, metadata: { pad: '' } });
      return JSON.stringify({ ...base, metadata: { pad: 'x'.repeat(bytes - shell.length) } });
    };
    expect(Buffer.byteLength(at(16 * 1024))).toBe(16 * 1024);
    expect(reason(validateTelemetry(at(16 * 1024), { now }))).not.toBe('payload_too_large');
    expect(reason(validateTelemetry(at(16 * 1024 + 1), { now }))).toBe('payload_too_large');
  });
  it('rejects non-finite and non-numeric values, a wrong schema version and a bad message id', () => {
    expect(reason(validateTelemetry('{"schemaVersion":1,"messageId":"m","metrics":{"t":1e999}}', { now }))).toBe('schema_invalid');
    expect(reason(tel({ metrics: { t: true } }))).toBe('schema_invalid');
    expect(reason(tel({ metrics: { t: null } }))).toBe('schema_invalid');
    expect(reason(tel({ schemaVersion: 2 }))).toBe('schema_invalid');
    expect(reason(tel({ messageId: 'has space' }))).toBe('schema_invalid');
    expect(reason(tel({ messageId: 'x'.repeat(129) }))).toBe('schema_invalid');
  });
  it('rejects a JSON array or a bare number at the top level', () => {
    expect(reason(validateTelemetry('[1,2]', { now }))).toBe('schema_invalid');
    expect(reason(validateTelemetry('42', { now }))).toBe('schema_invalid');
  });
});

describe('device timestamps (5 min ahead, 7 days old)', () => {
  const at = (ms: number) => new Date(now.getTime() + ms).toISOString();
  it('accepts exactly 5 minutes ahead and rejects later', () => {
    expect(reason(tel({ timestamp: at(5 * 60_000) }))).toBe('ok');
    expect(reason(tel({ timestamp: at(5 * 60_000 + 1000) }))).toBe('timestamp_out_of_range');
  });
  it('accepts exactly 7 days old and rejects older', () => {
    expect(reason(tel({ timestamp: at(-7 * 86_400_000) }))).toBe('ok');
    expect(reason(tel({ timestamp: at(-7 * 86_400_000 - 1000) }))).toBe('timestamp_out_of_range');
  });
  it('rejects a timestamp without a time zone', () => {
    expect(reason(tel({ timestamp: '2026-10-09T09:59:00' }))).not.toBe('ok');
  });
});

describe('metric definitions (channel fields)', () => {
  it('open-ended bounds: a null min or max is not a limit', () => {
    const rules = [{ metricKey: 't', minValue: null, maxValue: 10 }];
    expect(reason(tel({ metrics: { t: -1e9 } }, { metricRules: rules }))).toBe('ok');
    expect(reason(tel({ metrics: { t: 10 } }, { metricRules: rules }))).toBe('ok');
    expect(reason(tel({ metrics: { t: 10.0001 } }, { metricRules: rules }))).toBe('value_out_of_range');
  });
  it('no fields defined: any valid key is accepted', () => {
    expect(reason(tel({ metrics: { anything: 1 } }, { metricRules: [] }))).toBe('ok');
  });
});

describe('state payload', () => {
  const st = (over: Record<string, unknown>) => validateState(JSON.stringify({ schemaVersion: 1, state: { uptimeS: 5 }, ...over }), { now });
  it('accepts a valid state and rejects a nested object, too many keys, a bad timestamp', () => {
    expect(reason(st({}))).toBe('ok');
    expect(reason(st({ state: { nested: { a: 1 } } }))).toBe('schema_invalid');
    expect(reason(st({ state: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`k${i}`, i])) }))).toBe('schema_invalid');
    expect(reason(st({ timestamp: new Date(now.getTime() + 3_600_000).toISOString() }))).toBe('timestamp_out_of_range');
    expect(reason(validateState('{', { now }))).toBe('invalid_json');
  });
});

describe('online / offline (interval × 3 + 30 s)', () => {
  const ago = (s: number) => new Date(now.getTime() - s * 1000);
  const c = (lastSeenAt: Date | null, extra: Partial<Parameters<typeof computeConnectivity>[0]> = {}) =>
    computeConnectivity({ now, lastSeenAt, lastConnectedAt: null, lastDisconnectedAt: null, expectedIntervalSeconds: 15, ...extra });
  it('is online at exactly 75 s for a 15 s device and offline after', () => {
    expect(c(ago(75)).status).toBe('online');
    expect(c(ago(76)).status).toBe('offline');
    expect(c(ago(76)).thresholdSeconds).toBe(75);
  });
  it('a reconnect after a disconnect is online again', () => {
    expect(c(null, { lastDisconnectedAt: ago(10), lastConnectedAt: ago(5) }).status).toBe('online');
  });
  it('a disconnect at the same instant as the last activity does not count as newer', () => {
    expect(c(ago(5), { lastDisconnectedAt: ago(5) }).status).toBe('online');
  });
});

describe('control messages (cloud → device)', () => {
  it('have the documented shape', () => {
    expect(JSON.parse(controlMessage('led1', 1, now))).toEqual({ schemaVersion: 1, field: 'led1', value: 1, ts: '2026-10-09T10:00:00.000Z' });
  });
});

describe('device ACL', () => {
  const device = { id: 'd', organizationId: 'o', projectId: 'p' };
  it('denies unknown actions even on its own topic', () => {
    expect(authorizeDevice(device, 'retain' as never, 'arc/v1/o/p/d/telemetry')).toBe(false);
  });
});
