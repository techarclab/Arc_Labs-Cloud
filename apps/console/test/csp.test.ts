/**
 * The console's Content Security Policy is delivered twice: as a <meta> tag (vite.config.ts, every host) and as a
 * header by nginx (infra/console/nginx.conf, the Docker/VM build). Browsers enforce both, so they must not drift.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { consoleCsp } from '../vite.config';

const nginx = readFileSync(resolve(__dirname, '../../../infra/console/nginx.conf'), 'utf8');
const header = /add_header Content-Security-Policy "([^"]+)" always;/.exec(nginx)?.[1];

describe('console CSP', () => {
  it('nginx sends the same policy as the build-time <meta> tag, plus frame-ancestors', () => {
    expect(header).toBe(`${consoleCsp(undefined)}; frame-ancestors 'none'`);
  });
  it('scripts only from the console and Google sign-in; no inline scripts or eval', () => {
    const script = consoleCsp(undefined).split('; ').find((d) => d.startsWith('script-src'));
    expect(script).toBe("script-src 'self' https://accounts.google.com/gsi/client");
    expect(consoleCsp(undefined)).not.toMatch(/'unsafe-eval'|script-src[^;]*'unsafe-inline'/);
  });
  it('names the API origin when the console is hosted separately', () => {
    expect(consoleCsp('https://api.example.com/x')).toContain("connect-src 'self' https://api.example.com https://accounts.google.com/gsi/");
  });
});
