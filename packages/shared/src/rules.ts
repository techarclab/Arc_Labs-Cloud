/** Pure rule logic shared by the rules engine and tests. */
export type Operator = '>' | '>=' | '<' | '<=' | '==' | '!=';
export const OPERATORS: readonly Operator[] = ['>', '>=', '<', '<=', '==', '!='];

export function compare(value: number, op: Operator, threshold: number): boolean {
  switch (op) {
    case '>':
      return value > threshold;
    case '>=':
      return value >= threshold;
    case '<':
      return value < threshold;
    case '<=':
      return value <= threshold;
    case '==':
      return Math.abs(value - threshold) < 1e-9;
    case '!=':
      return Math.abs(value - threshold) >= 1e-9;
  }
}

export type RuleDecision = 'trigger' | 'pending' | 'resolve' | 'none';

/**
 * Decides what to do for one rule/device on one evaluation.
 * - breached && no active alert: trigger once the breach has lasted `forSeconds` (else pending),
 *   unless a previous alert was resolved less than `cooldownSeconds` ago.
 * - not breached && active alert: resolve (recovery).
 */
export function decide(input: {
  breached: boolean;
  hasActiveAlert: boolean;
  breachSince: Date | null;
  forSeconds: number;
  lastResolvedAt: Date | null;
  cooldownSeconds: number;
  now: Date;
}): RuleDecision {
  const { breached, hasActiveAlert, breachSince, forSeconds, lastResolvedAt, cooldownSeconds, now } = input;
  if (!breached) return hasActiveAlert ? 'resolve' : 'none';
  if (hasActiveAlert) return 'none';
  if (lastResolvedAt && now.getTime() - lastResolvedAt.getTime() < cooldownSeconds * 1000) return 'none';
  if (forSeconds > 0) {
    if (!breachSince) return 'pending';
    if (now.getTime() - breachSince.getTime() < forSeconds * 1000) return 'pending';
  }
  return 'trigger';
}

/** Validates command parameters against an allow-listed command type. */
export interface CommandParam {
  key: string;
  type: 'number' | 'boolean' | 'string';
  min?: number;
  max?: number;
  maxLength?: number;
  required?: boolean;
}

export function validateCommandPayload(params: CommandParam[], payload: Record<string, unknown>): string | null {
  const known = new Set(params.map((p) => p.key));
  for (const k of Object.keys(payload)) if (!known.has(k)) return `unknown parameter "${k}"`;
  for (const p of params) {
    const v = payload[p.key];
    if (v === undefined || v === null) {
      if (p.required) return `"${p.key}" is required`;
      continue;
    }
    if (p.type === 'number') {
      if (typeof v !== 'number' || !Number.isFinite(v)) return `"${p.key}" must be a number`;
      if (p.min !== undefined && v < p.min) return `"${p.key}" must be at least ${p.min}`;
      if (p.max !== undefined && v > p.max) return `"${p.key}" must be at most ${p.max}`;
    } else if (p.type === 'boolean') {
      if (typeof v !== 'boolean') return `"${p.key}" must be true or false`;
    } else {
      if (typeof v !== 'string') return `"${p.key}" must be text`;
      if (v.length > (p.maxLength ?? 200)) return `"${p.key}" is too long`;
    }
  }
  return null;
}
