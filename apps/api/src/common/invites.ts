import { createHash, randomInt } from 'node:crypto';

/** Version of the privacy notice shown at sign-up (apps/console/src/pages/Privacy.tsx). Bump when it changes. */
export const TERMS_VERSION = '2026-10-29';

// No 0/O, 1/I/L: codes are read aloud in classrooms and typed from slides.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** A new invite code, e.g. ARC-7KQ3-M9TX-4HPW (12 random symbols ≈ 59 bits). */
export function newInviteCode(): string {
  const pick = () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  return `ARC-${pick()}-${pick()}-${pick()}`;
}

/** Canonical form for hashing: case, spaces and dashes don't matter, and the ARC- prefix is optional. */
export function normalizeInviteCode(code: string): string {
  const s = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s.length === 12 ? `ARC${s}` : s;
}

export function hashInviteCode(code: string): string {
  return createHash('sha256').update(normalizeInviteCode(code)).digest('hex');
}
