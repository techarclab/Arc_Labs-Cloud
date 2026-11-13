import { describe, expect, it } from 'vitest';
import { CliError, parseArgs } from '../src/tools/platform-admin';

describe('platform-admin CLI arguments', () => {
  it('parses list, grant and revoke', () => {
    expect(parseArgs(['list'])).toEqual({ cmd: 'list' });
    expect(parseArgs(['grant', 'a@b.test'])).toEqual({ cmd: 'grant', email: 'a@b.test', reason: undefined });
    expect(parseArgs(['revoke', 'a@b.test', '--reason', 'left the team'])).toEqual({ cmd: 'revoke', email: 'a@b.test', reason: 'left the team' });
  });

  it('rejects anything else, so a typo never changes privileges', () => {
    for (const argv of [[], ['grnat', 'a@b.test'], ['grant'], ['grant', 'not-an-email'], ['grant', 'a@b.test', 'c@d.test'], ['grant', 'a@b.test', '--reason'], ['list', 'extra']]) {
      expect(() => parseArgs(argv), JSON.stringify(argv)).toThrow(CliError);
    }
  });
});
