import { describe, expect, it } from 'vitest';
import { loadConfig, obsoleteSettingWarnings } from '../src/config';

const base = {
  DATABASE_URL: 'postgres://u:p@localhost/db',
  JWT_SECRET: 'x'.repeat(32),
  INTERNAL_HOOK_TOKEN: 'y'.repeat(24),
  MQTT_SERVICE_PASSWORD: 'z'.repeat(16),
};

describe('PLATFORM_ADMIN_EMAILS (obsolete)', () => {
  it('still loads the configuration, so an old server environment does not crash the API', () => {
    const cfg = loadConfig({ ...base, PLATFORM_ADMIN_EMAILS: 'staff@arclabs.test' });
    expect(cfg.DATABASE_URL).toBe(base.DATABASE_URL);
    expect('PLATFORM_ADMIN_EMAILS' in cfg).toBe(false);
  });

  it('produces a clear startup warning that it is ignored', () => {
    const [w, ...rest] = obsoleteSettingWarnings({ PLATFORM_ADMIN_EMAILS: 'staff@arclabs.test' });
    expect(rest).toHaveLength(0);
    expect(w).toMatch(/PLATFORM_ADMIN_EMAILS is set but IGNORED/);
    expect(w).toMatch(/users\.is_platform_admin/);
    expect(w).not.toContain('staff@arclabs.test'); // the warning never echoes addresses into logs
  });

  it('warns about nothing when it is unset or blank', () => {
    expect(obsoleteSettingWarnings({})).toEqual([]);
    expect(obsoleteSettingWarnings({ PLATFORM_ADMIN_EMAILS: '  ' })).toEqual([]);
  });
});
