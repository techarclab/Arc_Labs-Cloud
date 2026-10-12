/**
 * Pretends to be an ESP32 with a temperature/humidity sensor.
 *
 *   npm run simulate -- --creds device.json [--interval 5] [--count 0] [--url mqtts://localhost:8883] [--ca infra/certs/out/ca.crt]
 *
 * `device.json` is the `credentials` object returned by POST /api/v1/devices
 * (or the whole response — both shapes are accepted).
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import mqtt from 'mqtt';

const { values } = parseArgs({
  options: {
    creds: { type: 'string' },
    url: { type: 'string' },
    ca: { type: 'string' },
    interval: { type: 'string', default: '5' },
    count: { type: 'string', default: '0' },
    insecure: { type: 'boolean', default: false },
  },
});

if (!values.creds) {
  console.error('usage: npm run simulate -- --creds device.json [--interval 5] [--count 0] [--url mqtts://host:8883] [--ca ca.crt]');
  process.exit(1);
}

// Resolve paths from where the user ran npm (INIT_CWD), not the workspace folder.
const base = process.env.INIT_CWD ?? process.cwd();
const fromBase = (p: string) => resolve(base, p);

const raw = JSON.parse(readFileSync(fromBase(values.creds), 'utf8'));
const creds = raw.credentials ?? raw;
const url = values.url ?? `${creds.tls ? 'mqtts' : 'mqtt'}://${creds.mqttHost}:${creds.mqttPort}`;
const intervalMs = Number(values.interval) * 1000;
const limit = Number(values.count);

const client = mqtt.connect(url, {
  protocolVersion: 5,
  clientId: creds.clientId,
  username: creds.username,
  password: creds.password,
  ca: values.ca ? readFileSync(fromBase(values.ca)) : undefined,
  rejectUnauthorized: !values.insecure,
  reconnectPeriod: 3000,
});

let sent = 0;
let temperature = 28 + Math.random() * 2;
let humidity = 55 + Math.random() * 10;
let timer: NodeJS.Timeout | undefined;

function publishOnce() {
  temperature += (Math.random() - 0.5) * 0.4;
  humidity = Math.min(100, Math.max(0, humidity + (Math.random() - 0.5) * 1.5));
  const payload = {
    schemaVersion: 1,
    messageId: randomUUID(),
    timestamp: new Date().toISOString(),
    metrics: { temperatureC: +temperature.toFixed(2), humidityPct: +humidity.toFixed(1), rssiDbm: -50 - Math.round(Math.random() * 20) },
    metadata: { firmwareVersion: '1.0.0' },
  };
  client.publish(creds.topics.telemetry, JSON.stringify(payload), { qos: 1 }, (err) => {
    if (err) return console.error('publish failed:', err.message);
    sent++;
    console.log(`#${sent} ${payload.timestamp} temp=${payload.metrics.temperatureC}°C hum=${payload.metrics.humidityPct}%`);
    if (limit && sent >= limit) {
      clearInterval(timer);
      client.end();
    }
  });
}

const controls: Record<string, number> = {};
client.on('message', (topic, payload) => {
  try {
    const msg = JSON.parse(payload.toString());
    controls[msg.field] = msg.value;
    console.log(`>> control received: ${msg.field} = ${msg.value}`);
  } catch {
    console.log(`>> unreadable control message on ${topic}`);
  }
});

client.on('connect', () => {
  console.log(`connected to ${url} as ${creds.clientId}`);
  if (creds.topics.commands) {
    client.subscribe(creds.topics.commands, { qos: 1 }, (err) => {
      if (err) console.error('could not subscribe to controls:', err.message);
      else console.log('listening for controls (switches and sliders on the dashboard)');
    });
  }
  client.publish(creds.topics.state, JSON.stringify({ schemaVersion: 1, timestamp: new Date().toISOString(), state: { firmwareVersion: '1.0.0', uptimeS: Math.round(process.uptime()) } }), { qos: 1 });
  if (!timer) {
    publishOnce();
    timer = setInterval(publishOnce, intervalMs);
  }
});
client.on('error', (err) => console.error('mqtt error:', err.message));
client.on('close', () => console.log('connection closed'));
