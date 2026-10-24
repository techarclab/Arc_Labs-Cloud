import { UnauthorizedException } from '@nestjs/common';

export interface KeyedRequest {
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, unknown>;
  body?: unknown;
}

const HEADER_HINT = 'Send the device key in a header: "Authorization: Bearer YOUR_DEVICE_KEY".';
const first = (v: unknown) => (Array.isArray(v) ? v[0] : v);

/**
 * Device key, in order of preference: `Authorization: Bearer KEY`, `X-API-Key`, `THINGSPEAKAPIKEY` header,
 * a JSON body `api_key`, and last the `?api_key=` query string. Keys in URLs leak into proxy, load balancer
 * and browser logs, so production should run with allowQuery=false (DEVICE_KEY_IN_QUERY=false).
 */
export function extractDeviceKey(req: KeyedRequest, allowQuery: boolean): string {
  const auth = first(req.headers.authorization);
  const bearer = typeof auth === 'string' && /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, '').trim() : undefined;
  const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>).api_key : undefined;
  let key = bearer ?? first(req.headers['x-api-key']) ?? first(req.headers['thingspeakapikey']) ?? first(body);
  if (key === undefined) {
    const q = first(req.query.api_key);
    if (q !== undefined && !allowQuery) throw new UnauthorizedException({ code: 'api_key_in_url_disabled', message: HEADER_HINT });
    key = q;
  }
  if (typeof key !== 'string' || key.length < 16 || key.length > 128) throw new UnauthorizedException({ code: 'missing_api_key', message: HEADER_HINT });
  return key;
}
