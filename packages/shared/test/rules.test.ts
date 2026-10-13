import { describe, expect, it } from 'vitest';
import { authorizeDevice, commandMessage, compare, decide, parseCommandAck, validateCommandPayload } from '../src';

const now = new Date('2026-01-01T00:10:00Z');
const base = { breached: true, hasActiveAlert: false, breachSince: null, forSeconds: 0, lastResolvedAt: null, cooldownSeconds: 300, now };

describe('rules', () => {
  it('compares with every operator', () => {
    expect(compare(31, '>', 30)).toBe(true);
    expect(compare(30, '>', 30)).toBe(false);
    expect(compare(30, '>=', 30)).toBe(true);
    expect(compare(29, '<', 30)).toBe(true);
    expect(compare(30, '<=', 30)).toBe(true);
    expect(compare(1, '==', 1)).toBe(true);
    expect(compare(1, '!=', 1)).toBe(false);
  });
  it('triggers immediately without a duration', () => expect(decide(base)).toBe('trigger'));
  it('dedupes while an alert is active', () => expect(decide({ ...base, hasActiveAlert: true })).toBe('none'));
  it('waits for the breach duration', () => {
    expect(decide({ ...base, forSeconds: 120 })).toBe('pending');
    expect(decide({ ...base, forSeconds: 120, breachSince: new Date(now.getTime() - 60_000) })).toBe('pending');
    expect(decide({ ...base, forSeconds: 120, breachSince: new Date(now.getTime() - 121_000) })).toBe('trigger');
  });
  it('respects the cooldown after a resolve', () => {
    expect(decide({ ...base, lastResolvedAt: new Date(now.getTime() - 60_000) })).toBe('none');
    expect(decide({ ...base, lastResolvedAt: new Date(now.getTime() - 301_000) })).toBe('trigger');
  });
  it('resolves on recovery', () => {
    expect(decide({ ...base, breached: false, hasActiveAlert: true })).toBe('resolve');
    expect(decide({ ...base, breached: false })).toBe('none');
  });
});

describe('commands', () => {
  const params = [
    { key: 'seconds', type: 'number' as const, min: 1, max: 60, required: true },
    { key: 'force', type: 'boolean' as const },
  ];
  it('validates payloads against the allow-list', () => {
    expect(validateCommandPayload(params, { seconds: 5 })).toBeNull();
    expect(validateCommandPayload(params, {})).toMatch(/required/);
    expect(validateCommandPayload(params, { seconds: 99 })).toMatch(/at most/);
    expect(validateCommandPayload(params, { seconds: 5, rm: 1 })).toMatch(/unknown/);
    expect(validateCommandPayload(params, { seconds: 5, force: 'yes' })).toMatch(/true or false/);
  });
  it('builds and parses messages', () => {
    const id = '0b6f3c1e-1a2b-4c3d-8e9f-001122334455';
    const m = JSON.parse(commandMessage({ id, name: 'reboot', payload: {}, expiresAt: now }));
    expect(m).toMatchObject({ type: 'command', commandId: id, name: 'reboot' });
    expect(parseCommandAck(JSON.stringify({ commandId: id, status: 'ok' }))).toMatchObject({ status: 'ok' });
    expect(parseCommandAck('{"commandId":"x","status":"ok"}')).toBeNull();
    expect(parseCommandAck('nope')).toBeNull();
  });
  it('lets a device publish acks only on its own topic', () => {
    const d = { id: 'dev1', organizationId: 'org1', projectId: 'p1' };
    expect(authorizeDevice(d, 'publish', 'arc/v1/org1/p1/dev1/cmd-ack')).toBe(true);
    expect(authorizeDevice(d, 'publish', 'arc/v1/org1/p1/dev2/cmd-ack')).toBe(false);
    expect(authorizeDevice(d, 'publish', 'arc/v1/org1/p1/dev1/cmd')).toBe(false);
  });
});
