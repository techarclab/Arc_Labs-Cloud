/**
 * The console's Raspberry Pi script generator (apps/console/src/pythonScript.ts). Pins what the text must contain,
 * and, where python3 is installed (CI runners and most dev machines), runs the generated script against a stand-in
 * paho-mqtt to check the messages it sends follow docs/device-protocol/README.md.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { isLinuxDevice, pythonScript } from '../src/pythonScript';

const device = { id: '6f1c2d3e-0000-4000-8000-000000000001', displayName: 'Lab "Pi"\nnorth', deviceType: 'raspberry-pi', expectedIntervalSeconds: 15 } as any;
const field = (metricKey: string, position: number, extra: Record<string, unknown> = {}) => ({ metricKey, label: metricKey, position, kind: 'data', unit: null, minValue: null, maxValue: null, ...extra }) as any;
const fields = [field('humidity', 2, { unit: '%', minValue: 0, maxValue: 100 }), field('temperature', 1, { unit: '°C' }), field('led1', 3, { kind: 'control', minValue: 0, maxValue: 1 }), field('fan', 4, { kind: 'control', minValue: 0, maxValue: 255 })];
const gen = (over: Partial<Parameters<typeof pythonScript>[0]> = {}) =>
  pythonScript({ device, fields, token: 'tok-123', host: 'mqtt.arcloud.arclabs.in', port: 8883, topicBase: 'arc/v1/o/p/d', ...over });

const hasPython = spawnSync('python3', ['--version']).status === 0;
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('Raspberry Pi script generator', () => {
  it('is used for Linux boards only', () => {
    expect(isLinuxDevice('raspberry-pi')).toBe(true);
    expect(isLinuxDevice('gateway')).toBe(true);
    expect(isLinuxDevice('esp32')).toBe(false);
  });
  it('credentials, topic and interval as constants; TLS verified', () => {
    const s = gen();
    expect(s).toContain(`DEVICE_ID = "${device.id}"`);
    expect(s).toContain('DEVICE_TOKEN = "tok-123"');
    expect(s).toContain('TOPIC = "arc/v1/o/p/d"');
    expect(s).toContain('INTERVAL_SECONDS = 15');
    expect(s).toContain('ssl.create_default_context()');
    expect(s).not.toContain('CERT_NONE');
  });
  it('without a token it asks for one instead of inventing it', () => {
    expect(gen({ token: undefined })).toContain('"paste-the-device-token-here"  # TODO');
  });
  it('sensor fields in field order, controls get handlers', () => {
    const s = gen();
    expect(s.indexOf('"temperature": None')).toBeLessThan(s.indexOf('"humidity": None'));
    expect(s).toContain('def on_led1(value):');
    expect(s).toContain('"fan": on_fan,');
  });
  it('a name with quotes and a newline cannot break out of the comment', () => {
    expect(gen().split('\n')[1]).toContain('Lab "Pi" north');
  });

  it.skipIf(!hasPython)('compiles, and sends protocol-shaped telemetry, state, control calls and command acks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'arc-py-'));
    dirs.push(dir);
    // A stand-in for paho-mqtt: records publishes and subscriptions instead of connecting.
    mkdirSync(join(dir, 'paho', 'mqtt'), { recursive: true });
    writeFileSync(join(dir, 'paho', '__init__.py'), '');
    writeFileSync(join(dir, 'paho', 'mqtt', '__init__.py'), '');
    writeFileSync(
      join(dir, 'paho', 'mqtt', 'client.py'),
      ['class CallbackAPIVersion:', '    VERSION2 = 2', 'class Client:', '    def __init__(self, *a, **k):', '        self.sent = []; self.subs = []',
       '    def publish(self, topic, payload, qos=0):', '        self.sent.append((topic, payload, qos))', '    def subscribe(self, topic, qos=0):', '        self.subs.append((topic, qos))', ''].join('\n'),
    );
    writeFileSync(join(dir, 'arc_cloud.py'), gen().replace('"temperature": None', '"temperature": 21.5'));
    writeFileSync(
      join(dir, 'drive.py'),
      [
        'import json, sys',
        `sys.path.insert(0, ${JSON.stringify(dir)})`,
        'import arc_cloud as a',
        'from paho.mqtt.client import Client',
        'calls = []',
        'a.CONTROLS["led1"] = lambda v: calls.append(v)',
        'def boom(name, payload): raise RuntimeError("no such thing")',
        'a.run_command = boom',
        'class RC:', '    is_failure = False',
        'class Msg:', '    def __init__(self, d): self.payload = json.dumps(d).encode()',
        'c = Client()',
        'a.on_connect(c, None, None, RC(), None)',
        'a.send_readings(c)',
        'a.on_message(c, None, Msg({"schemaVersion": 1, "field": "led1", "value": 1}))',
        'a.on_message(c, None, Msg({"schemaVersion": 1, "type": "command", "commandId": "c1", "name": "x", "payload": {}}))',
        'class Refused:', '    is_failure = True', '    value = 135', '    def __str__(self): return "Not authorized"',
        'c.disconnect = lambda: calls.append("disconnected")',
        'ud = {"stop": False}',
        'a.on_connect(c, ud, None, Refused(), None)',
        'assert ud["stop"] is True',
        'print(json.dumps({"subs": c.subs, "sent": [[t, json.loads(p), q] for t, p, q in c.sent], "calls": calls}))',
      ].join('\n'),
    );
    execFileSync('python3', ['-m', 'py_compile', join(dir, 'arc_cloud.py')]);
    const out = JSON.parse(execFileSync('python3', [join(dir, 'drive.py')], { encoding: 'utf8' }).trim().split('\n').pop()!); // last line: the script prints too
    expect(out.subs).toEqual([['arc/v1/o/p/d/cmd', 1]]);
    const [state, telemetry, ack] = out.sent;
    expect(state[0]).toBe('arc/v1/o/p/d/state');
    expect(state[1].state.firmwareVersion).toBe('1.0.0');
    expect(telemetry[0]).toBe('arc/v1/o/p/d/telemetry');
    expect(telemetry[1]).toMatchObject({ schemaVersion: 1, metrics: { temperature: 21.5 }, metadata: { firmwareVersion: '1.0.0' } });
    expect(Object.keys(telemetry[1].metrics)).toEqual(['temperature']); // humidity is None: not sent
    expect(telemetry[1].messageId).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);
    expect(telemetry[1].timestamp).toMatch(/Z$/);
    expect(telemetry[2]).toBe(1);
    expect(ack).toEqual(['arc/v1/o/p/d/cmd-ack', { commandId: 'c1', status: 'error', error: 'no such thing' }, 1]);
    expect(out.calls).toEqual([1, 'disconnected']); // a refused token stops the script instead of retrying forever
  });
});
