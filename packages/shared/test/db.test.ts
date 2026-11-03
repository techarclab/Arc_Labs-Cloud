import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pgConnectionConfig } from '../src/db';

describe('pgConnectionConfig (rotated database passwords)', () => {
  const dirs: string[] = [];
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), 'arc-db-'));
    dirs.push(d);
    return d;
  };
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  it('without a password file, passes the URL through unchanged (development, CI)', () => {
    expect(pgConnectionConfig('postgres://arc:arc@127.0.0.1:5432/arc')).toEqual({ connectionString: 'postgres://arc:arc@127.0.0.1:5432/arc' });
  });

  it('reads the password file for every new connection, so a rotation needs no restart', () => {
    const dir = tmp();
    const file = join(dir, 'password');
    writeFileSync(file, 'first\n');
    const cfg = pgConnectionConfig('postgres://arc_admin@db.example:5432/arc?sslmode=verify-full', file);
    expect(cfg.connectionString).toBeUndefined();
    expect(cfg.user).toBe('arc_admin');
    expect(cfg.host).toBe('db.example');
    expect(cfg.database).toBe('arc');
    expect(cfg.ssl).toBeTruthy(); // verify-full keeps certificate verification on
    expect(cfg.password()).toBe('first');
    // The host replaces the file atomically (write + rename), as write-env.py does.
    writeFileSync(join(dir, 'password.tmp'), 'second\n');
    renameSync(join(dir, 'password.tmp'), file);
    expect(cfg.password()).toBe('second');
  });

  it('refuses a URL that also carries a password (it would silently override the file)', () => {
    expect(() => pgConnectionConfig('postgres://arc_admin:stale@db.example/arc', join(tmp(), 'password'))).toThrow(/must not contain a password/);
  });

  it('fails loudly on an empty password file instead of trying an empty password', () => {
    const file = join(tmp(), 'password');
    writeFileSync(file, '\n');
    expect(() => pgConnectionConfig('postgres://arc_admin@db.example/arc', file).password()).toThrow(/empty/);
  });
});
