import { All, BadRequestException, Controller, ForbiddenException, Get, HttpCode, HttpException, NotFoundException, Param, Query, Req, Res, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Throttle } from '@nestjs/throttler';
import { validateTelemetry } from '@arc/shared';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { AccessService } from '../common/access.service';
import { apiKeyHash, safeEqual, UUID_RE } from '../common/crypto';
import { Public } from '../common/http';
import { INGESTIBLE, IngestDevice, IngestService } from '../common/ingest.service';
import { Db } from '../db/db.service';

/** Per-device token bucket for the HTTP API (1 request/second sustained, burst 5). */
class Buckets {
  private readonly b = new Map<string, { t: number; at: number }>();
  constructor(private readonly rate: number, private readonly burst: number) {}
  take(key: string) {
    const now = Date.now();
    const e = this.b.get(key) ?? { t: this.burst, at: now };
    e.t = Math.min(this.burst, e.t + ((now - e.at) / 1000) * this.rate);
    e.at = now;
    const ok = e.t >= 1;
    if (ok) e.t -= 1;
    this.b.set(key, e);
    if (this.b.size > 50_000) this.b.clear();
    return ok;
  }
}

const RESERVED = new Set(['api_key', 'created_at', 'timestamp', 'status', 'format', 'message_id']);

function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (s === 'true' || s === 'on') return 1;
  if (s === 'false' || s === 'off') return 0;
  if (s === '' || !/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return null;
  return Number(s);
}

/**
 * ThingSpeak/Blynk-style HTTP API for devices that don't use MQTT.
 *
 *   GET or POST /api/v1/update?api_key=KEY&field1=23.5&field2=60
 *   GET         /api/v1/controls?api_key=KEY            → {"relay":1,"brightness":40}
 *   GET         /api/v1/controls?api_key=KEY&field=relay → 1   (plain text)
 *   GET         /api/v1/channels/{id}/feeds.json?api_key=READ_KEY&results=100   (also feeds.csv)
 *
 * KEY is the device's password from registration. Use HTTPS in production: the key travels in the request.
 */
@Controller('api/v1')
export class DeviceHttpController {
  private readonly buckets = new Buckets(1, 5);

  constructor(
    private readonly db: Db,
    private readonly ingest: IngestService,
    private readonly jwt: JwtService,
    private readonly access: AccessService,
  ) {}

  private apiKey(req: Request): string {
    const q = req.query.api_key ?? (req.body && typeof req.body === 'object' ? (req.body as any).api_key : undefined);
    const h = req.headers['x-api-key'] ?? req.headers['thingspeakapikey'];
    const key = (Array.isArray(q) ? q[0] : q) ?? (Array.isArray(h) ? h[0] : h);
    if (typeof key !== 'string' || key.length < 16 || key.length > 128) throw new UnauthorizedException({ code: 'missing_api_key', message: 'Add ?api_key=YOUR_DEVICE_KEY to the URL.' });
    return key;
  }

  private async deviceFor(key: string): Promise<IngestDevice> {
    const d = await this.db.one(
      `SELECT d.id, d.organization_id, d.project_id, d.lifecycle_status, o.status AS org_status
       FROM device_credentials c JOIN devices d ON d.id = c.device_id JOIN organizations o ON o.id = d.organization_id
       WHERE c.api_key_hash = $1 AND c.status = 'active'`,
      [apiKeyHash(key)],
    );
    if (!d) throw new UnauthorizedException({ code: 'invalid_api_key', message: 'Unknown API key. Copy the key from the device page, or replace the device password to get one.' });
    if (d.org_status !== 'active' || !INGESTIBLE.includes(d.lifecycle_status)) {
      throw new ForbiddenException({ code: 'device_inactive', message: `This device is ${d.lifecycle_status}.` });
    }
    return d;
  }

  @Public()
  @Throttle({ default: { limit: 6000, ttl: 60_000 } })
  @All('update')
  @HttpCode(200)
  async update(@Req() req: Request) {
    if (req.method !== 'GET' && req.method !== 'POST') throw new NotFoundException();
    const key = this.apiKey(req);
    const device = await this.deviceFor(key);
    if (!this.buckets.take(device.id)) {
      throw new HttpException({ code: 'rate_limited', message: 'Too many updates. Send at most one per second.' }, 429);
    }

    const input: Record<string, unknown> = { ...(req.query as Record<string, unknown>), ...(req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {}) };
    const rules = await this.ingest.metricRules(device.project_id);
    const byPosition = new Map(rules.map((r) => [r.position, r.metricKey]));

    const metrics: Record<string, number> = {};
    const bad: string[] = [];
    for (const [k, raw] of Object.entries(input)) {
      if (RESERVED.has(k)) continue;
      const v = toNumber(Array.isArray(raw) ? raw[0] : raw);
      if (v === null) {
        bad.push(k);
        continue;
      }
      const m = /^field(\d{1,2})$/.exec(k);
      const name = m && byPosition.has(Number(m[1])) ? byPosition.get(Number(m[1]))! : k;
      metrics[name] = v;
    }
    const source = `http:/api/v1/update`;
    const excerpt = JSON.stringify({ ...input, api_key: undefined }).slice(0, 512);
    if (bad.length) {
      await this.ingest.rejected(device, source, 'schema_invalid', `not a number: ${bad.join(', ')}`, excerpt);
      throw new BadRequestException({ code: 'schema_invalid', message: `These values aren't numbers: ${bad.join(', ')}.` });
    }
    if (!Object.keys(metrics).length) {
      throw new BadRequestException({ code: 'no_fields', message: 'Send at least one value, for example &field1=23.5' });
    }

    const receivedAt = new Date();
    const createdAt = (input.created_at ?? input.timestamp) as string | undefined;
    const messageId = typeof input.message_id === 'string' ? input.message_id : `http-${randomUUID()}`;
    const payload = { schemaVersion: 1, messageId, ...(createdAt ? { timestamp: createdAt } : {}), metrics };
    const v = validateTelemetry(JSON.stringify(payload), { now: receivedAt, metricRules: rules });
    if (!v.ok) {
      await this.ingest.rejected(device, source, v.reason, v.detail, excerpt);
      throw new BadRequestException({ code: v.reason, message: v.detail });
    }
    const stored = await this.ingest.write(device, v.value.metrics, v.deviceTime ?? receivedAt, receivedAt, messageId, null);
    return { ok: true, duplicate: !stored, deviceId: device.id, receivedAt, values: v.value.metrics };
  }

  @Public()
  @Throttle({ default: { limit: 6000, ttl: 60_000 } })
  @Get('controls')
  async controls(@Req() req: Request, @Res() res: Response, @Query('field') field?: string) {
    const device = await this.deviceFor(this.apiKey(req));
    const [defs, values] = await Promise.all([
      this.db.query(`SELECT metric_key, position FROM metric_definitions WHERE project_id = $1 AND kind = 'control' ORDER BY position`, [device.project_id]),
      this.db.query('SELECT field_key, value FROM control_values WHERE device_id = $1', [device.id]),
      this.db.query('UPDATE devices SET last_seen_at = GREATEST(COALESCE(last_seen_at, now()), now()) WHERE id = $1', [device.id]),
    ]);
    const current = new Map(values.map((r) => [r.field_key, r.value]));
    const out: Record<string, number | null> = {};
    for (const d of defs) out[d.metric_key] = current.get(d.metric_key) ?? null;

    if (field) {
      const m = /^field(\d{1,2})$/.exec(field);
      const name = m ? (defs.find((d) => d.position === Number(m[1]))?.metric_key ?? field) : field;
      if (!(name in out)) {
        res.status(404).type('text/plain').send('unknown control field');
        return;
      }
      res.type('text/plain').send(out[name] === null ? '' : String(out[name]));
      return;
    }
    res.json(out);
  }

  /** ThingSpeak-style channel feed. Auth: ?api_key=<channel read key> or a signed-in user's token. */
  @Public()
  @Get(['channels/:id/feeds.json', 'channels/:id/feeds.csv'])
  async feeds(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    if (!UUID_RE.test(id)) throw new NotFoundException({ code: 'not_found' });
    const project = await this.db.one('SELECT * FROM projects WHERE id = $1', [id]);
    const readKey = typeof req.query.api_key === 'string' ? req.query.api_key : null;
    if (readKey) {
      if (!project || !safeEqual(readKey, project.read_api_key)) throw new UnauthorizedException({ code: 'invalid_api_key', message: 'Wrong read API key for this channel.' });
    } else {
      const header = req.headers.authorization;
      if (!header?.startsWith('Bearer ')) throw new UnauthorizedException({ code: 'missing_api_key', message: 'Add ?api_key=<channel read key>.' });
      let sub: string;
      try {
        sub = (await this.jwt.verifyAsync(header.slice(7))).sub;
      } catch {
        throw new UnauthorizedException({ code: 'invalid_token' });
      }
      const user = await this.db.one(`SELECT id, email, is_platform_admin FROM users WHERE id = $1 AND status = 'active'`, [sub]);
      if (!user) throw new UnauthorizedException({ code: 'invalid_token' });
      await this.access.requireProject({ id: user.id, email: user.email, isPlatformAdmin: user.is_platform_admin }, id, 'viewer');
    }
    if (!project) throw new NotFoundException({ code: 'not_found' });

    const results = Math.min(Math.max(Number(req.query.results) || 100, 1), 8000);
    const end = typeof req.query.end === 'string' ? new Date(req.query.end) : new Date();
    const start = typeof req.query.start === 'string' ? new Date(req.query.start) : new Date(end.getTime() - 31 * 86400e3);
    if (isNaN(+start) || isNaN(+end)) throw new BadRequestException({ code: 'invalid_range', message: 'start and end must be ISO dates.' });
    const deviceFilter = typeof req.query.device === 'string' && UUID_RE.test(req.query.device) ? req.query.device : null;

    const [defs, rows] = await Promise.all([
      this.db.query('SELECT metric_key, label, unit, position FROM metric_definitions WHERE project_id = $1 ORDER BY position', [id]),
      this.db.query(
        `SELECT t.ts, t.device_id, d.display_name, jsonb_object_agg(t.metric_key, t.metric_value) AS v
         FROM telemetry_measurements t JOIN devices d ON d.id = t.device_id
         WHERE t.project_id = $1 AND t.organization_id = $2 AND t.ts >= $3 AND t.ts < $4 AND ($5::uuid IS NULL OR t.device_id = $5)
         GROUP BY t.ts, t.device_id, d.display_name, t.message_id
         ORDER BY t.ts DESC LIMIT $6`,
        [id, project.organization_id, start, end, deviceFilter, results],
      ),
    ]);
    rows.reverse();
    const keys: string[] = defs.map((d) => d.metric_key);
    for (const r of rows) for (const k of Object.keys(r.v)) if (!keys.includes(k)) keys.push(k);
    const posOf = new Map(defs.map((d) => [d.metric_key, d.position]));
    const col = (k: string) => (posOf.has(k) ? `field${posOf.get(k)}` : k);

    if (req.path.endsWith('.csv')) {
      const esc = (v: unknown) => {
        const s = v === null || v === undefined ? '' : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const labels = keys.map((k) => {
        const d = defs.find((x) => x.metric_key === k);
        return d ? `${d.label}${d.unit ? ` (${d.unit})` : ''}` : k;
      });
      const lines = [['created_at', 'device_id', 'device_name', ...labels].map(esc).join(',')];
      for (const r of rows) lines.push([new Date(r.ts).toISOString(), r.device_id, r.display_name, ...keys.map((k) => r.v[k])].map(esc).join(','));
      res
        .type('text/csv')
        .setHeader('Content-Disposition', `attachment; filename="${project.name.replace(/[^A-Za-z0-9_-]+/g, '-').toLowerCase() || 'channel'}-feeds.csv"`)
        .send(lines.join('\n') + '\n');
      return;
    }

    const channel: Record<string, unknown> = { id: project.id, name: project.name, description: project.description, last_entry_at: rows.at(-1)?.ts ?? null };
    for (const d of defs) channel[`field${d.position}`] = d.label;
    res.json({
      channel,
      fields: defs.map((d) => ({ field: `field${d.position}`, key: d.metric_key, label: d.label, unit: d.unit })),
      feeds: rows.map((r) => {
        const out: Record<string, unknown> = { created_at: r.ts, device_id: r.device_id, device_name: r.display_name };
        for (const k of keys) if (r.v[k] !== undefined) out[col(k)] = r.v[k];
        return out;
      }),
    });
  }
}
