import { describe, expect, it } from 'vitest';
import { ACCOUNT_EMAIL_BACKOFF, BACKOFF, retryDelay } from '../src/jobs';

describe('delivery retry schedule', () => {
  it('alerts and webhooks: 6 retries over ~9 hours, then give up', () => {
    expect(BACKOFF.map((_, i) => retryDelay('alert.triggered', i + 1))).toEqual(BACKOFF);
    expect(retryDelay('alert.triggered', BACKOFF.length + 1)).toBeNull();
    expect(BACKOFF.reduce((a, b) => a + b, 0) / 3600).toBeLessThan(10);
  });

  it('account emails keep trying for more than a day (outlast a daily quota reset)', () => {
    const total = ACCOUNT_EMAIL_BACKOFF.reduce((a, b) => a + b, 0);
    expect(total / 3600).toBeGreaterThan(24);
    expect(total / 3600).toBeLessThan(27);
    expect(retryDelay('auth.verify_email', 1)).toBe(30);
    expect(retryDelay('auth.verify_email', 10)).toBe(3600);
    expect(retryDelay('auth.verify_email', ACCOUNT_EMAIL_BACKOFF.length + 1)).toBeNull();
  });
});
