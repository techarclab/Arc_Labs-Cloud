/**
 * The console's Arduino sketch generator (apps/console/src/arduinoSketch.ts). CI also compiles its output for ESP32
 * (firmware-build job); these tests pin what the text must and must never contain.
 */
import { describe, expect, it } from 'vitest';
import { arduinoSketch, DEFAULT_HOST } from '../src/arduinoSketch';

const device = { id: '6f1c2d3e-0000-4000-8000-000000000001', displayName: 'Office board', expectedIntervalSeconds: 15 } as any;
const field = (metricKey: string, position: number, extra: Record<string, unknown> = {}) => ({ metricKey, label: metricKey, position, kind: 'data', unit: null, minValue: null, maxValue: null, ...extra }) as any;
const fields = [field('humidity', 2, { unit: '%', minValue: 0, maxValue: 100 }), field('temperature', 1, { unit: '°C' }), field('rssi', 3), field('led1', 4, { kind: 'control', minValue: 0, maxValue: 1 }), field('fan', 5, { kind: 'control', minValue: 0, maxValue: 255 })];
const gen = (over: Partial<Parameters<typeof arduinoSketch>[0]> = {}) =>
  arduinoSketch({ device, fields, provisioned: false, host: DEFAULT_HOST, port: 8883, topicBase: 'arc/v1/o/p/d', ...over });

describe('Arduino sketch generator', () => {
  it('quick start: the device key is the only credential, begin() takes it', () => {
    const s = gen({ token: 'arc_dk_key-123' });
    expect(s).toContain('#define DEVICE_KEY     "arc_dk_key-123"');
    expect(s).toContain('arc.begin(WIFI_SSID, WIFI_PASSWORD, DEVICE_KEY);');
    for (const old of ['DEVICE_ID', 'DEVICE_TOKEN', 'DEVICE_TOPIC', 'arc/v1/o/p/d']) expect(s).not.toContain(old);
  });
  it('a local test server spells the values out (the key is the token)', () => {
    const s = gen({ token: 'arc_dk_key-123', host: 'mqtt.local', port: 18883 });
    expect(s).toContain(`#define DEVICE_ID      "${device.id}"`);
    expect(s).toContain('#define DEVICE_TOKEN   "arc_dk_key-123"');
    expect(s).toContain('arc.begin(WIFI_SSID, WIFI_PASSWORD, DEVICE_ID, DEVICE_TOKEN, DEVICE_TOPIC, "mqtt.local", 18883);');
  });
  it('no secrets mode: no token, no Wi-Fi password, no device id in the text', () => {
    const s = gen({ token: 'arc_dk_key-123', provisioned: true });
    for (const secret of ['key-123', 'DEVICE_KEY', 'DEVICE_TOKEN', 'WIFI_PASSWORD', device.id]) expect(s).not.toContain(secret);
    expect(s).toContain('arc.beginProvisioned();');
    expect(s).toContain('arc.intervalSeconds() * 1000UL');
  });
  it('without a token it asks for one instead of inventing it', () => {
    expect(gen()).toContain('"arc_dk_paste-your-device-key-here"');
  });
  it('sensor fields become add() in field order; rssi is measured; controls become onControl()', () => {
    const s = gen();
    const order = ['"temperature"', '"humidity"', '"rssi"'].map((k) => s.indexOf(`arc.add(${k}`));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(s).toContain('arc.add("rssi", WiFi.RSSI());');
    expect(s).toContain('arc.add("temperature", NAN);');
    expect(s).toContain('arc.onControl("led1"');
    expect(s).toContain('digitalWrite(LED_PIN');
    expect(s).toContain('map((long)value, 0, 255, 0, 255)');
    expect(s).not.toContain('arc.add("led1"');
  });
  it('interval follows the device, at least 5 s', () => {
    expect(gen()).toContain('arc.every(15000UL');
    expect(gen({ device: { ...device, expectedIntervalSeconds: 1 } })).toContain('arc.every(5000UL');
  });
  it('the default host is left to the library; another host and port are passed explicitly', () => {
    expect(gen()).not.toContain(DEFAULT_HOST);
    expect(gen({ host: 'mqtt.local', port: 18883 })).toContain('DEVICE_TOPIC, "mqtt.local", 18883);');
    expect(gen({ host: 'mqtt.local', port: 18883, provisioned: true })).toContain('arc.beginProvisioned("mqtt.local", 18883);');
  });
  it('a channel with no sensor fields still produces a sketch that says what to do', () => {
    expect(gen({ fields: [] })).toContain('has no sensor fields yet');
  });
  it('names from users cannot break out of comments or strings', () => {
    const evil = gen({ device: { ...device, displayName: 'x */ int pwned; /* "q"\nnext' }, channelName: 'c */ #include', token: 'a"b\\c' });
    expect(evil.indexOf('*/')).toBe(evil.indexOf(' */\n#include <ArcCloud.h>') + 1);
    expect(evil).toContain('#define DEVICE_KEY     "a\\"b\\\\c"');
    expect(evil.split('\n').filter((l) => l.includes('next')).every((l) => l.includes('pwned'))).toBe(true);
  });
  it('field labels with */ cannot end the comment early either', () => {
    const s = gen({ fields: [field('t', 1, { label: 'bad */ label' })] });
    expect(s).toContain('bad * / label');
  });
});
