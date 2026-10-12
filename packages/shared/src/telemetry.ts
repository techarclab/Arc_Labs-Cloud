import { z } from 'zod';

export const METRIC_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
export const MESSAGE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export const MAX_PAYLOAD_BYTES = 16 * 1024;
export const MAX_METRICS_PER_MESSAGE = 64;

const metadataValue = z.union([z.string().max(256), z.number().finite(), z.boolean()]);

export const telemetryPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    messageId: z.string().regex(MESSAGE_ID, 'messageId must be 1-128 chars of [A-Za-z0-9._:-]'),
    timestamp: z.iso.datetime({ offset: true }).optional(),
    metrics: z
      .record(z.string().regex(METRIC_KEY, 'invalid metric key'), z.number().finite())
      .refine((m) => Object.keys(m).length > 0, 'metrics must not be empty')
      .refine((m) => Object.keys(m).length <= MAX_METRICS_PER_MESSAGE, `at most ${MAX_METRICS_PER_MESSAGE} metrics`),
    metadata: z
      .record(z.string().max(64), metadataValue)
      .refine((m) => Object.keys(m).length <= 32, 'at most 32 metadata keys')
      .optional(),
  })
  .strict();

export type TelemetryPayload = z.infer<typeof telemetryPayloadSchema>;

export const statePayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    timestamp: z.iso.datetime({ offset: true }).optional(),
    state: z.record(z.string().max(64), metadataValue).refine((s) => Object.keys(s).length <= 64),
  })
  .strict();

export type StatePayload = z.infer<typeof statePayloadSchema>;

export interface MetricRule {
  metricKey: string;
  minValue: number | null;
  maxValue: number | null;
}

export interface TimestampPolicy {
  /** Device clocks ahead of server by more than this are rejected. */
  maxFutureSkewMs: number;
  /** Messages older than this (e.g. buffered offline) are rejected. */
  maxAgeMs: number;
}

export const DEFAULT_TIMESTAMP_POLICY: TimestampPolicy = {
  maxFutureSkewMs: 5 * 60 * 1000,
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
};

export type RejectReason =
  | 'payload_too_large'
  | 'invalid_json'
  | 'schema_invalid'
  | 'timestamp_out_of_range'
  | 'metric_not_allowed'
  | 'value_out_of_range';

export type ValidationResult<T> =
  | { ok: true; value: T; deviceTime: Date | null; warnings: string[] }
  | { ok: false; reason: RejectReason; detail: string };

function parseJson(raw: Buffer | string, maxBytes: number): { ok: true; data: unknown } | { ok: false; reason: RejectReason; detail: string } {
  const size = typeof raw === 'string' ? Buffer.byteLength(raw) : raw.length;
  if (size > maxBytes) return { ok: false, reason: 'payload_too_large', detail: `${size} > ${maxBytes} bytes` };
  try {
    return { ok: true, data: JSON.parse(raw.toString()) };
  } catch {
    return { ok: false, reason: 'invalid_json', detail: 'payload is not valid JSON' };
  }
}

function checkTimestamp(ts: string | undefined, now: Date, policy: TimestampPolicy) {
  if (!ts) return { ok: true as const, deviceTime: null, warnings: ['missing_timestamp'] };
  const t = new Date(ts);
  const delta = t.getTime() - now.getTime();
  if (delta > policy.maxFutureSkewMs) return { ok: false as const, detail: 'timestamp is too far in the future' };
  if (-delta > policy.maxAgeMs) return { ok: false as const, detail: 'timestamp is too old' };
  return { ok: true as const, deviceTime: t, warnings: [] as string[] };
}

export function validateTelemetry(
  raw: Buffer | string,
  opts: {
    now?: Date;
    maxBytes?: number;
    policy?: TimestampPolicy;
    /** When a project defines metrics, only those keys are accepted and ranges are enforced. */
    metricRules?: MetricRule[];
  } = {},
): ValidationResult<TelemetryPayload> {
  const now = opts.now ?? new Date();
  const json = parseJson(raw, opts.maxBytes ?? MAX_PAYLOAD_BYTES);
  if (!json.ok) return json;

  const parsed = telemetryPayloadSchema.safeParse(json.data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, reason: 'schema_invalid', detail: `${issue.path.join('.') || '(root)'}: ${issue.message}` };
  }

  const ts = checkTimestamp(parsed.data.timestamp, now, opts.policy ?? DEFAULT_TIMESTAMP_POLICY);
  if (!ts.ok) return { ok: false, reason: 'timestamp_out_of_range', detail: ts.detail };

  if (opts.metricRules && opts.metricRules.length > 0) {
    const rules = new Map(opts.metricRules.map((r) => [r.metricKey, r]));
    for (const [key, value] of Object.entries(parsed.data.metrics)) {
      const rule = rules.get(key);
      if (!rule) return { ok: false, reason: 'metric_not_allowed', detail: `metric "${key}" is not defined for this project` };
      if ((rule.minValue !== null && value < rule.minValue) || (rule.maxValue !== null && value > rule.maxValue)) {
        return { ok: false, reason: 'value_out_of_range', detail: `metric "${key}"=${value} outside [${rule.minValue ?? '-inf'}, ${rule.maxValue ?? 'inf'}]` };
      }
    }
  }

  return { ok: true, value: parsed.data, deviceTime: ts.deviceTime, warnings: ts.warnings };
}

export function validateState(
  raw: Buffer | string,
  opts: { now?: Date; maxBytes?: number; policy?: TimestampPolicy } = {},
): ValidationResult<StatePayload> {
  const now = opts.now ?? new Date();
  const json = parseJson(raw, opts.maxBytes ?? MAX_PAYLOAD_BYTES);
  if (!json.ok) return json;
  const parsed = statePayloadSchema.safeParse(json.data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, reason: 'schema_invalid', detail: `${issue.path.join('.') || '(root)'}: ${issue.message}` };
  }
  const ts = checkTimestamp(parsed.data.timestamp, now, opts.policy ?? DEFAULT_TIMESTAMP_POLICY);
  if (!ts.ok) return { ok: false, reason: 'timestamp_out_of_range', detail: ts.detail };
  return { ok: true, value: parsed.data, deviceTime: ts.deviceTime, warnings: ts.warnings };
}
