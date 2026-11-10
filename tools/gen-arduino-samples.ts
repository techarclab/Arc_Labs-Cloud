// CI: writes sketches made by the console's generator (apps/console/src/arduinoSketch.ts) so the firmware job can
// compile them against the ArcCloud library. Includes awkward labels (quotes, comment markers) on purpose.
//   node --experimental-strip-types tools/gen-arduino-samples.ts <outDir>
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { arduinoSketch } from '../apps/console/src/arduinoSketch.ts';

const out = process.argv[2] ?? 'gen-sketches';
const id = '2aa25a4a-c7ed-4afd-84c6-a4b573c3ee8f';
const device = { id, displayName: 'Office "Monitor" */ 1', projectId: 'p', expectedIntervalSeconds: 10 } as any;
const f = (metricKey: string, kind: 'data' | 'control', label: string, unit = '', minValue: number | null = null, maxValue: number | null = null, position = 0) =>
  ({ metricKey, kind, label, unit, minValue, maxValue, position, decimals: 1, step: null }) as any;
const fields = [
  f('temperature', 'data', 'Temperature */ "inside"', '°C', -40, 85, 0),
  f('humidity', 'data', 'Humidity', '%', 0, 100, 1),
  f('rssi', 'data', 'Wi-Fi signal', 'dBm', -120, 0, 2),
  f('led1', 'control', 'LED 1', '', 0, 1, 3),
  f('fan.speed', 'control', 'Fan speed', 'rpm', 0, 3000, 4),
];
const topicBase = `arc/v1/b1ad0de6-ced6-4ceb-873d-ceda985af2c8/01d0f346-5bbe-4ba0-863e-6c5419df4cfd/${id}`;
const samples: Record<string, string> = {
  gen_quick: arduinoSketch({ device, channelName: 'Office', fields, token: 'tok"en\\with*/odd', provisioned: false, host: 'mqtt.arcloud.arclabs.in', port: 8883, topicBase }),
  gen_provisioned: arduinoSketch({ device, fields, provisioned: true, host: 'mqtt.example.test', port: 18883, topicBase }),
  gen_no_fields: arduinoSketch({ device, fields: [], provisioned: false, host: 'mqtt.arcloud.arclabs.in', port: 8883, topicBase }),
};
for (const [name, code] of Object.entries(samples)) {
  mkdirSync(join(out, name), { recursive: true });
  writeFileSync(join(out, name, `${name}.ino`), code);
}
console.log(`[gen-arduino-samples] ${Object.keys(samples).length} sketches in ${out}`);
