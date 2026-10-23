import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3000),
  /** Broker hooks listen on a separate port that must never be exposed publicly. */
  INTERNAL_PORT: z.coerce.number().int().default(3001),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  /** Google OAuth Web client ID; also published to the console for Google Identity Services. */
  GOOGLE_CLIENT_ID: z.string().trim().optional().transform((value) => value || undefined),
  ALLOW_SIGNUP: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  INTERNAL_HOOK_TOKEN: z.string().min(24, 'INTERNAL_HOOK_TOKEN must be at least 24 characters'),
  MQTT_SERVICE_USERNAME: z.string().default('arc-ingest'),
  MQTT_SERVICE_PASSWORD: z.string().min(16, 'MQTT_SERVICE_PASSWORD must be at least 16 characters'),
  /** What devices are told to connect to. */
  MQTT_PUBLIC_HOST: z.string().default('localhost'),
  MQTT_PUBLIC_PORT: z.coerce.number().int().default(8883),
  /** Broker URL the API uses to push control values (service account). Optional. */
  MQTT_URL: z.string().optional(),
  /** Public base URL of this API, shown in HTTP examples (e.g. http://192.168.1.20:3000). */
  HTTP_PUBLIC_URL: z.string().default('http://localhost:3000'),
  CORS_ORIGINS: z.string().default(''),
  /**
   * Accept device keys in the URL (?api_key=…), as ThingSpeak does. URLs are written to proxy and load
   * balancer logs, so set this to false in production once firmware sends the Authorization header.
   */
  DEVICE_KEY_IN_QUERY: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /** Comma-separated emails of ARC LABS staff who manage plans for every organization. */
  PLATFORM_ADMIN_EMAILS: z.string().default(''),
});

export type AppConfig = z.infer<typeof schema>;

let cached: AppConfig | undefined;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (cached) return cached;
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  cached = parsed.data;
  return cached;
}

/** True when the email is listed in PLATFORM_ADMIN_EMAILS. */
export function isPlatformAdminEmail(email: string): boolean {
  const list = loadConfig().PLATFORM_ADMIN_EMAILS.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  return list.includes(email.toLowerCase());
}
