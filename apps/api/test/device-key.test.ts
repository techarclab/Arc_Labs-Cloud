import { describe, expect, it } from 'vitest';
import { extractDeviceKey } from '../src/device-http/device-key';

const KEY = 'k'.repeat(32);
const req = (r: Partial<{ headers: any; query: any; body: any }>) => ({ headers: {}, query: {}, ...r });
const code = (fn: () => unknown) => {
  try {
    fn();
    return 'ok';
  } catch (e: any) {
    return e.getResponse().code;
  }
};

describe('extractDeviceKey', () => {
  it('prefers Authorization: Bearer', () => {
    expect(extractDeviceKey(req({ headers: { authorization: `Bearer ${KEY}` }, query: { api_key: 'q'.repeat(20) } }), true)).toBe(KEY);
  });
  it('accepts X-API-Key and THINGSPEAKAPIKEY headers and a JSON body key', () => {
    expect(extractDeviceKey(req({ headers: { 'x-api-key': KEY } }), false)).toBe(KEY);
    expect(extractDeviceKey(req({ headers: { thingspeakapikey: KEY } }), false)).toBe(KEY);
    expect(extractDeviceKey(req({ body: { api_key: KEY } }), false)).toBe(KEY);
  });
  it('accepts ?api_key= only when allowed', () => {
    expect(extractDeviceKey(req({ query: { api_key: KEY } }), true)).toBe(KEY);
    expect(code(() => extractDeviceKey(req({ query: { api_key: KEY } }), false))).toBe('api_key_in_url_disabled');
  });
  it('rejects missing or malformed keys', () => {
    expect(code(() => extractDeviceKey(req({}), true))).toBe('missing_api_key');
    expect(code(() => extractDeviceKey(req({ headers: { authorization: 'Bearer short' } }), true))).toBe('missing_api_key');
    expect(code(() => extractDeviceKey(req({ headers: { authorization: `Basic ${KEY}` } }), true))).toBe('missing_api_key');
  });
});
