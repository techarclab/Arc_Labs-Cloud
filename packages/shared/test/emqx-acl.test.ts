/**
 * infra/emqx/acl.conf authorizes the ingest service inside EMQX (before the HTTP hook, DEF-014). It must grant exactly
 * what authorizeIngestService() grants, or the two paths would disagree depending on which one answered.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { authorizeIngestService, INGEST_PROBE_TOPIC, INGEST_TOPIC_FILTERS, SYS_CLIENT_EVENT_FILTERS } from '../src';

const acl = readFileSync(resolve(__dirname, '../../../infra/emqx/acl.conf'), 'utf8')
  .split('\n')
  .filter((l) => !l.trim().startsWith('%%'))
  .join('\n');
const rule = (action: string) => {
  const m = new RegExp(`\\{allow, \\{username, "arc-ingest"\\}, ${action}, \\[([\\s\\S]*?)\\]\\}\\.`).exec(acl);
  if (!m) throw new Error(`no ${action} rule`);
  return [...m[1].matchAll(/(\{eq, )?"([^"]+)"\}?/g)].map((x) => ({ exact: !!x[1], topic: x[2] }));
};

describe('EMQX file ACL for the ingest service', () => {
  it('subscribe: exactly the ingest filters and client events (shared subscriptions are checked by topic)', () => {
    const subs = rule('subscribe');
    expect(subs.every((s) => s.exact)).toBe(true);
    expect(subs.map((s) => s.topic).sort()).toEqual([...INGEST_TOPIC_FILTERS, ...SYS_CLIENT_EVENT_FILTERS].sort());
    for (const s of subs) expect(authorizeIngestService('subscribe', s.topic)).toBe(true);
  });
  it('publish: device cmd topics and the probe topic, nothing else', () => {
    const pubs = rule('publish');
    expect(pubs).toEqual([
      { exact: false, topic: 'arc/v1/+/+/+/cmd' },
      { exact: true, topic: INGEST_PROBE_TOPIC },
    ]);
    expect(authorizeIngestService('publish', INGEST_PROBE_TOPIC)).toBe(true);
    expect(authorizeIngestService('publish', 'arc/v1/o/p/d/cmd')).toBe(true);
  });
  it('has no deny rules: anything it does not match goes on to the HTTP hook', () => {
    expect(acl).not.toMatch(/\{deny/);
    expect((acl.match(/\{allow,/g) ?? []).length).toBe(2);
  });
});
