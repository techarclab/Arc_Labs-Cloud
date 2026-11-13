/**
 * Server-side sessions (phase 6). Signing in creates a session and returns a short-lived access token (JWT with
 * the session id) in the body, plus a refresh token in an httpOnly cookie that page scripts cannot read. The console
 * keeps the access token in memory and renews it at /auth/refresh.
 *
 * Refresh tokens rotate on every use. The previous one is still accepted for GRACE_SECONDS (two tabs refreshing at
 * the same moment share one cookie jar); after that, presenting it means it was copied, so the session is revoked.
 * Only SHA-256 hashes are stored. Clients that use the body token directly (scripts, tests) keep working; it lasts
 * JWT_TTL_SECONDS and dies with its session.
 */
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'node:crypto';
import { loadConfig } from '../config';
import { Db } from '../db/db.service';
import { AuditService } from './audit.service';

export const REFRESH_COOKIE = 'arc_refresh';
const COOKIE_PATH = '/api/v1/auth';
const GRACE_SECONDS = 60;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

interface Req {
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
}
interface Res {
  cookie(name: string, value: string, opts: Record<string, unknown>): void;
  clearCookie(name: string, opts: Record<string, unknown>): void;
}

/** The refresh cookie's value: "<session id>.<secret>". */
export function readRefreshCookie(req: Req): { sid: string; secret: string } | null {
  const raw = req.headers.cookie;
  const header = Array.isArray(raw) ? raw.join(';') : raw ?? '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k !== REFRESH_COOKIE) continue;
    const m = /^([0-9a-f-]{36})\.([A-Za-z0-9_-]{20,100})$/.exec(decodeURIComponent(v.join('=')));
    if (m) return { sid: m[1], secret: m[2] };
  }
  return null;
}

@Injectable()
export class SessionsService {
  constructor(
    private readonly db: Db,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
  ) {}

  private cookieOptions() {
    const cfg = loadConfig();
    return { httpOnly: true, secure: cfg.SESSION_COOKIE_SECURE, sameSite: cfg.SESSION_COOKIE_SAMESITE, path: COOKIE_PATH };
  }

  private setCookie(res: Res | undefined, sid: string, secret: string) {
    res?.cookie(REFRESH_COOKIE, `${sid}.${secret}`, { ...this.cookieOptions(), maxAge: loadConfig().SESSION_DAYS * 86_400_000 });
  }

  clearCookie(res: Res | undefined) {
    res?.clearCookie(REFRESH_COOKIE, this.cookieOptions());
  }

  async accessToken(userId: string, sid: string) {
    const ttl = loadConfig().JWT_TTL_SECONDS;
    const accessToken = await this.jwt.signAsync({ sub: userId, sid }, { expiresIn: ttl });
    return { accessToken, tokenType: 'Bearer', expiresIn: ttl };
  }

  /** A new session for a successful sign-in: sets the refresh cookie and returns the access token. */
  async signIn(userId: string, req?: Req, res?: Res) {
    const secret = randomBytes(32).toString('base64url');
    const ua = String(req?.headers['user-agent'] ?? '').slice(0, 300) || null;
    const s = await this.db.asSystem(() =>
      this.db.one<{ id: string }>(
        `INSERT INTO sessions (user_id, refresh_hash, expires_at, user_agent, ip)
         VALUES ($1, $2, now() + make_interval(days => $3), $4, $5) RETURNING id`,
        [userId, sha256(secret), loadConfig().SESSION_DAYS, ua, req?.ip?.slice(0, 64) ?? null],
      ),
    );
    this.setCookie(res, s!.id, secret);
    return this.accessToken(userId, s!.id);
  }

  /** Renews the access token from the refresh cookie, rotating the refresh token. */
  async refresh(req: Req, res: Res) {
    const c = readRefreshCookie(req);
    if (!c) throw new UnauthorizedException({ code: 'no_session' });
    const hash = sha256(c.secret);
    const result = await this.db.asSystem(() =>
      this.db.tx(async (q) => {
        const s = (
          await q.query(
            `SELECT s.id, s.user_id, s.refresh_hash, s.prev_refresh_hash, s.rotated_at > now() - make_interval(secs => $2) AS in_grace, u.status
             FROM sessions s JOIN users u ON u.id = s.user_id
             WHERE s.id = $1 AND s.revoked_at IS NULL AND s.expires_at > now() FOR UPDATE OF s`,
            [c.sid, GRACE_SECONDS],
          )
        ).rows[0];
        if (!s || s.status !== 'active') return { ok: false as const };
        if (s.refresh_hash === hash) {
          const secret = randomBytes(32).toString('base64url');
          await q.query(`UPDATE sessions SET prev_refresh_hash = refresh_hash, refresh_hash = $2, rotated_at = now(), last_seen_at = now() WHERE id = $1`, [s.id, sha256(secret)]);
          return { ok: true as const, userId: s.user_id as string, sid: s.id as string, secret };
        }
        if (s.prev_refresh_hash === hash && s.in_grace) {
          // Another tab rotated it a moment ago; the browser already holds the new cookie, so leave it be.
          return { ok: true as const, userId: s.user_id as string, sid: s.id as string, secret: null };
        }
        if (s.prev_refresh_hash === hash) {
          // An old refresh token came back: someone kept a copy. End the session for everyone holding it.
          await q.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'refresh_reuse' WHERE id = $1`, [s.id]);
          await this.audit.record({ actorType: 'system', actorId: 'sessions', action: 'session.reuse_detected', resourceType: 'user', resourceId: s.user_id, metadata: { sessionId: s.id } }, q);
          return { ok: false as const, reused: true };
        }
        return { ok: false as const };
      }),
    );
    if (!result.ok) {
      this.clearCookie(res);
      throw new UnauthorizedException({ code: 'session_revoked' });
    }
    if (result.secret) this.setCookie(res, result.sid, result.secret);
    return this.accessToken(result.userId, result.sid);
  }

  /** Ends one session (logging out, or signing out one device from the account page). */
  async revoke(sid: string, userId: string, reason: string) {
    const r = await this.db.asSystem(() =>
      this.db.one(`UPDATE sessions SET revoked_at = now(), revoked_reason = $3 WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id`, [sid, userId, reason]),
    );
    return !!r;
  }

  /** Ends every session of a person, except possibly the current one (password change keeps this browser). */
  async revokeAll(userId: string, reason: string, exceptSid?: string) {
    await this.db.asSystem(() =>
      this.db.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = $2 WHERE user_id = $1 AND revoked_at IS NULL AND ($3::uuid IS NULL OR id <> $3)`, [
        userId,
        reason,
        exceptSid ?? null,
      ]),
    );
  }

  /** The person's signed-in devices. */
  async list(userId: string, currentSid?: string) {
    const rows = await this.db.asSystem(() =>
      this.db.query(
        `SELECT id, created_at, last_seen_at, expires_at, user_agent, ip FROM sessions
         WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY last_seen_at DESC LIMIT 50`,
        [userId],
      ),
    );
    return rows.map((s) => ({ id: s.id, createdAt: s.created_at, lastSeenAt: s.last_seen_at, expiresAt: s.expires_at, userAgent: s.user_agent, ip: s.ip, current: s.id === currentSid }));
  }
}
