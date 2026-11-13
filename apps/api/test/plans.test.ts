/**
 * Plan limits (PLANS): the numbers customers are promised (Usage & limits page, Complete Reference section 3).
 * A change here changes what every organization may do, so it has to be deliberate: update this test with it.
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { PLANS } from '../src/organizations/org-ops.controller';

describe('plans', () => {
  it('free, pro and enterprise have the documented limits', () => {
    expect(PLANS).toEqual({
      free: { maxDevices: 5, maxProjects: 3, maxRules: 10, maxApiKeys: 3, maxWebhooks: 2, maxWidgets: 12, retentionDays: 30, maxMembers: 10 },
      pro: { maxDevices: 1000, maxProjects: 200, maxRules: 2000, maxApiKeys: 200, maxWebhooks: 50, maxWidgets: 64, retentionDays: 365, maxMembers: 500 },
      enterprise: { maxDevices: 100000, maxProjects: 5000, maxRules: 50000, maxApiKeys: 1000, maxWebhooks: 200, maxWidgets: 64, retentionDays: 1825, maxMembers: 10000 },
    });
  });
  it('a higher plan never allows less', () => {
    const order = ['free', 'pro', 'enterprise'] as const;
    for (const k of Object.keys(PLANS.free) as (keyof (typeof PLANS)['free'])[]) {
      for (let i = 1; i < order.length; i++) expect(PLANS[order[i]][k], `${order[i]}.${k}`).toBeGreaterThanOrEqual(PLANS[order[i - 1]][k]);
    }
  });
  it('every limit fits what the plan endpoint accepts (widgets ≤ 64, retention ≤ 3650 days)', () => {
    for (const p of Object.values(PLANS)) {
      expect(p.maxWidgets).toBeLessThanOrEqual(64);
      expect(p.retentionDays).toBeLessThanOrEqual(3650);
      for (const v of Object.values(p)) expect(Number.isInteger(v) && v >= 1).toBe(true);
    }
  });
});
