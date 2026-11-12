import { describe, expect, it } from 'vitest';
import { authorizeDevice, authorizeIngestService, INGEST_PROBE_TOPIC, INGEST_TOPIC_FILTERS, NIL_UUID } from '../src';

describe('ingest probe topic (DEF-014)', () => {
  it('is matched by the worker telemetry subscription', () => {
    const telemetry = INGEST_TOPIC_FILTERS.find((f) => f.endsWith('/telemetry'))!;
    const re = new RegExp(`^${telemetry.replace(/\+/g, '[^/]+')}$`);
    expect(re.test(INGEST_PROBE_TOPIC)).toBe(true);
    expect(INGEST_PROBE_TOPIC).toBe(`arc/v1/${NIL_UUID}/${NIL_UUID}/${NIL_UUID}/telemetry`);
  });
  it('only the ingest service may publish it', () => {
    expect(authorizeIngestService('publish', INGEST_PROBE_TOPIC)).toBe(true);
    expect(authorizeIngestService('publish', 'arc/v1/o/p/d/telemetry')).toBe(false);
    expect(authorizeDevice({ id: 'a1b2', organizationId: 'o', projectId: 'p' }, 'publish', INGEST_PROBE_TOPIC)).toBe(false);
  });
});
