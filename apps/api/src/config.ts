import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3000),
  /** Broker hooks listen on a separate port that must never be exposed publicly. */
  INTERNAL_PORT: z.coerce.number().int().default(3001),
  DATABASE_URL: z.string().min(1),
  /** Read for every new DB connection (rotated passwords); DATABASE_URL then has no password. */
  DATABASE_PASSWORD_FILE: z.string().min(1).optional(),
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
  /**
   * EMQX management API (private network only), used to disconnect devices the moment they are revoked,
   * rotated, suspended or retired. Optional: without it the broker's 30 s authorization cache bounds the delay.
   */
  EMQX_API_URL: z.string().trim().optional().transform((v) => v || undefined),
  EMQX_API_KEY: z.string().trim().optional().transform((v) => v || undefined),
  EMQX_API_SECRET: z.string().trim().optional().transform((v) => v || undefined),
  /** Public base URL of this API, shown in HTTP examples (e.g. http://192.168.1.20:3000). */
  HTTP_PUBLIC_URL: z.string().default('http://localhost:3000'),
  CORS_ORIGINS: z.string().default(''),
  /** Number of reverse proxies in front of the API (1 behind Caddy or Railway). 0 = use the socket address. */
  TRUST_PROXY: z.coerce.number().int().min(0).max(3).default(0),
  /**
   * Accept device keys in the URL (?api_key=…), as ThingSpeak does. URLs are written to proxy and load
   * balancer logs, so set this to false in production once firmware sends the Authorization header.
   */
  DEVICE_KEY_IN_QUERY: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /** Organizations a person may create (platform admins: unlimited). Each starts on the free plan. */
  ORGS_PER_USER: z.coerce.number().int().min(1).max(100).default(1),
  /**
   * New email/password accounts must confirm their address (link sent by the worker, so the worker needs SMTP_URL).
   * "off" only for local development without email.
   */
  EMAIL_VERIFICATION: z.enum(['required', 'off']).default('required'),
  /** Console origin, used in links sent by email (e.g. https://arcloud.arclabs.in). */
  CONSOLE_URL: z.string().default('http://localhost:5173'),
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

/**
 * Settings that no longer do anything, with the warning to log at startup. They are ignored rather than
 * rejected, so a server still carrying old configuration starts normally instead of crash-looping.
 */
export function obsoleteSettingWarnings(env: NodeJS.ProcessEnv = process.env): string[] {
  const warnings: string[] = [];
  if (env.PLATFORM_ADMIN_EMAILS?.trim()) {
    warnings.push(
      'PLATFORM_ADMIN_EMAILS is set but IGNORED: it grants no privileges. Platform admins come only from ' +
        'users.is_platform_admin, managed with the operator CLI (node apps/api/dist/tools/platform-admin.js). ' +
        'Remove PLATFORM_ADMIN_EMAILS from the environment.',
    );
  }
  return warnings;
}
