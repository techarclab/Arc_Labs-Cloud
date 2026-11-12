import { describe, expect, it } from 'vitest';
import { SubscriptionWatchdog } from '../src/watchdog';

describe('SubscriptionWatchdog (DEF-014)', () => {
  it('is not stalled while probes keep coming back', () => {
    const w = new SubscriptionWatchdog(15_000, 45_000);
    w.onConnect(0);
    for (let t = 15_000; t <= 300_000; t += 15_000) {
      w.onProbe(t);
      expect(w.stalled(t + 1000)).toBe(false);
    }
  });
  it('is stalled once no probe has returned for longer than staleAfter', () => {
    const w = new SubscriptionWatchdog(15_000, 45_000);
    w.onConnect(0);
    w.onProbe(15_000);
    expect(w.stalled(60_000)).toBe(false);
    expect(w.stalled(60_001)).toBe(true);
    expect(w.silenceMs(60_001)).toBe(45_001);
  });
  it('a fresh connect gives a full grace period; disconnected is never "stalled"', () => {
    const w = new SubscriptionWatchdog(15_000, 45_000);
    w.onConnect(0);
    expect(w.stalled(100_000)).toBe(true);
    w.onDisconnect();
    expect(w.stalled(200_000)).toBe(false);
    w.onConnect(200_000);
    expect(w.stalled(244_000)).toBe(false);
  });
  it('a late probe from before a reconnect does not move the clock back', () => {
    const w = new SubscriptionWatchdog(15_000, 45_000);
    w.onConnect(100_000);
    w.onProbe(90_000);
    expect(w.silenceMs(110_000)).toBe(10_000);
  });
  it('refuses settings that would fire between two probes', () => {
    expect(() => new SubscriptionWatchdog(15_000, 20_000)).toThrow();
  });
});
