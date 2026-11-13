/**
 * The device key: one string that is everything a device needs to sign in.
 *
 *   arc_dk_<device id, 32 hex digits without dashes>_<secret>
 *
 * The secret is the device's password (base64url). MQTT: username = client ID = the device ID, password = the secret
 * (or the whole key). HTTP: send the whole key (or, as before, the secret alone) as the API key. The server stores
 * only hashes of the secret, so a key is shown once, when it is created.
 */
export const DEVICE_KEY_PREFIX = 'arc_dk_';

const KEY_RE = /^arc_dk_([0-9a-f]{32})_([A-Za-z0-9_-]{16,100})$/;

/** Builds the key for a device ID (UUID) and its secret. */
export function formatDeviceKey(deviceId: string, secret: string): string {
  return `${DEVICE_KEY_PREFIX}${deviceId.replace(/-/g, '').toLowerCase()}_${secret}`;
}

/** Splits a device key into the device ID (UUID with dashes) and the secret; null when it is not a device key. */
export function parseDeviceKey(key: string): { deviceId: string; secret: string } | null {
  const m = KEY_RE.exec(key.trim());
  if (!m) return null;
  const h = m[1];
  return { deviceId: `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`, secret: m[2] };
}
