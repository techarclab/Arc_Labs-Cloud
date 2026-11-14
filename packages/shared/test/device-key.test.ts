import { describe, expect, it } from 'vitest';
import { formatDeviceKey, parseDeviceKey } from '../src';

const id = '5402576d-db43-4a23-ac21-9550be304264';

describe('device key', () => {
  it('round-trips the device ID and a secret that contains _ and -', () => {
    const secret = 'Ab_cd-EF0123456789_xyz-AbCdEfGhIjKlMnOpQrS';
    const key = formatDeviceKey(id, secret);
    expect(key).toBe(`arc_dk_5402576ddb434a23ac219550be304264_${secret}`);
    expect(parseDeviceKey(key)).toEqual({ deviceId: id, secret });
    expect(parseDeviceKey(`  ${key}\n`)).toEqual({ deviceId: id, secret }); // pasted with spaces or a new line
  });

  it('lowercases the ID', () => {
    expect(formatDeviceKey(id.toUpperCase(), 'x'.repeat(43))).toContain('5402576ddb434a23ac219550be304264');
  });

  it('rejects anything that is not a device key', () => {
    for (const k of ['', 'x'.repeat(43), `arc_dk_${'0'.repeat(31)}_${'x'.repeat(43)}`, `arc_dk_${'0'.repeat(32)}_short`, `arc_sk_${'0'.repeat(32)}_${'x'.repeat(43)}`, `arc_dk_${'0'.repeat(32)}_${'x'.repeat(42)}!`]) {
      expect(parseDeviceKey(k)).toBeNull();
    }
  });
});
