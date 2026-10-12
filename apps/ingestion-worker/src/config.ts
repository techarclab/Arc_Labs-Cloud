import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  MQTT_URL: z.string().default('mqtt://localhost:1883'),
  /** PEM CA used to verify the broker certificate when MQTT_URL is mqtts:// */
  MQTT_CA_FILE: z.string().optional(),
  MQTT_PROTOCOL_VERSION: z.enum(['4', '5']).default('5').transform((v) => Number(v) as 4 | 5),
  MQTT_SERVICE_USERNAME: z.string().default('arc-ingest'),
  MQTT_SERVICE_PASSWORD: z.string().min(16),
  /** Stable per instance so the persistent session survives restarts. */
  WORKER_ID: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/).default('ingest-1'),
  /** Use MQTT 5 shared subscriptions so several workers split the load. */
  SHARED_SUBSCRIPTION: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  HEALTH_PORT: z.coerce.number().int().default(9100),
  /** Per-device token bucket: sustained messages/second and burst. */
  DEVICE_RATE_PER_SEC: z.coerce.number().positive().default(5),
  DEVICE_BURST: z.coerce.number().int().positive().default(20),
  DEDUPE_WINDOW_HOURS: z.coerce.number().int().positive().default(168),
  CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(30),
});

export type WorkerConfig = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error('Invalid configuration:\n' + parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n'));
  }
  return parsed.data;
}
