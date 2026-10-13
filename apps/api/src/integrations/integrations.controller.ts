import { ApiTags } from '@nestjs/swagger';
import { Doc } from '../common/docs';
import { createHash, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { AccessService } from '../common/access.service';
import { AuditService } from '../common/audit.service';
import { safeEqual } from '../common/crypto';
import { WEBHOOK_EVENTS } from '../common/events';
import { actor, API_KEY_PREFIX, AuthUser, CurrentUser, pageQuery, parse, Public, requirePerson, userRef, Uuid } from '../common/http';
import { loadConfig } from '../config';
import { Db } from '../db/db.service';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// ======================================================================================
// API keys & service accounts
// ======================================================================================

const keyBody = z.object({
  organizationId: z.uuid(),
  name: z.string().trim().min(1).max(80),
  kind: z.enum(['api_key', 'service_account']).default('api_key'),
  role: z.enum(['viewer', 'engineer']).default('viewer'),
  projectIds: z.array(z.uuid()).max(100).nullable().default(null),
  expiresInDays: z.number().int().min(1).max(3650).nullable().default(null),
});

function mapKey(k: any) {
  return {
    id: k.id,
    name: k.name,
    kind: k.kind,
    prefix: k.prefix,
    role: k.role,
    projectIds: k.project_ids,
    expiresAt: k.expires_at,
    lastUsedAt: k.last_used_at,
    createdAt: k.created_at,
    createdBy: k.created_by_name ?? null,
    revokedAt: k.revoked_at,
  };
}

@ApiTags('API keys & service accounts')
@Controller('api/v1/api-keys')
export class ApiKeysController {
  constructor(
    private readonly db: Db,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  @Doc('List', { query: z.object({ organizationId: z.uuid() }) })
  @Get()
  async list(@CurrentUser() user: AuthUser, @Query() q: unknown) {
    const { organizationId } = parse(z.object({ organizationId: z.uuid() }), q);
    requirePerson(user);
    await this.access.requireOrg(user, organizationId, 'org_admin');
    const rows = await this.db.query(
      `SELECT k.*, u.display_name AS created_by_name FROM api_keys k LEFT JOIN users u ON u.id = k.created_by
       WHERE k.organization_id = $1 ORDER BY k.revoked_at NULLS FIRST, k.created_at DESC`,
      [organizationId],
    );
    return { items: rows.map(mapKey) };
  }

  /** Creates a key; the secret is returned once. Service accounts exchange it at /api/v1/oauth/token. */
  @Doc('Create', { body: keyBody })
  @Post()
  async create(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    requirePerson(user);
    const input = parse(keyBody, body);
    await this.access.requireOrg(user, input.organizationId, 'org_admin');
    await this.access.requireQuota(input.organizationId, 'api_keys');
    if (input.projectIds?.length) {
      const n = await this.db.one<{ n: number }>('SELECT count(*)::int AS n FROM projects WHERE organization_id = $1 AND id = ANY($2)', [input.organizationId, input.projectIds]);
      if (n!.n !== new Set(input.projectIds).size) throw new BadRequestException({ code: 'unknown_channel' });
    }
    const secret = API_KEY_PREFIX + randomBytes(32).toString('base64url');
    const key = await this.db.tx(async (c) => {
      const k = (
        await c.query(
          `INSERT INTO api_keys (organization_id, name, kind, prefix, key_hash, role, project_ids, expires_at, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $8::int IS NULL THEN NULL ELSE now() + make_interval(days => $8::int) END, $9) RETURNING *`,
          [input.organizationId, input.name, input.kind, secret.slice(0, 12), sha256(secret), input.role, input.projectIds?.length ? input.projectIds : null, input.expiresInDays, userRef(user)],
        )
      ).rows[0];
      await this.audit.record({ ...actor(user), organizationId: input.organizationId, action: `${input.kind}.create`, resourceType: 'api_key', resourceId: k.id, metadata: { name: k.name, role: k.role, projectIds: k.project_ids } }, c);
      return k;
    });
    const cfg = loadConfig();
    return {
      ...mapKey(key),
      secret,
      usage:
        key.kind === 'api_key'
          ? { header: `Authorization: Bearer ${secret}` }
          : { tokenUrl: `${cfg.HTTP_PUBLIC_URL}/api/v1/oauth/token`, clientId: key.id, clientSecret: secret, grantType: 'client_credentials' },
    };
  }

  @Doc('Revoke')
  @Delete(':id')
  @HttpCode(204)
  async revoke(@CurrentUser() user: AuthUser, @Param('id', Uuid()) id: string) {
    requirePerson(user);
    const k = await this.db.one('SELECT * FROM api_keys WHERE id = $1', [id]);
    if (!k) throw new NotFoundException({ code: 'not_found' });
    await this.access.requireOrg(user, k.organization_id, 'org_admin');
    await this.db.query('UPDATE api_keys SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1', [id]);
    await this.audit.record({ ...actor(user), organizationId: k.organization_id, action: `${k.kind}.revoke`, resourceType: 'api_key', resourceId: id, metadata: { name: k.name } });
  }
}

const tokenBody = z.object({
  grant_type: z.literal('client_credentials'),
  client_id: z.uuid(),
  client_secret: z.string().min(10).max(200),
  scope: z.string().max(200).optional(),
});

/** OAuth2 client-credentials grant for service accounts (e.g. ARC LMS servers). */
@ApiTags('OAuth')
@Controller('api/v1/oauth')
export class OAuthController {
  constructor(
    private readonly db: Db,
    private readonly jwt: JwtService,
  ) {}

  @Doc('Token')
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('token')
  @HttpCode(200)
  async token(@Body() body: unknown) {
    // Accept JSON or form-encoded bodies (both are parsed by the platform into an object).
    const parsed = tokenBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException({ error: 'invalid_request' });
    const { client_id, client_secret } = parsed.data;
    const k = await this.db.one(
      `SELECT id, key_hash, organization_id, role, project_ids FROM api_keys
       WHERE id = $1 AND kind = 'service_account' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`,
      [client_id],
    );
    if (!k || !safeEqual(k.key_hash, sha256(client_secret))) throw new UnauthorizedException({ error: 'invalid_client' });
    const expiresIn = 900;
    const accessToken = await this.jwt.signAsync({ sub: k.id, typ: 'svc' }, { expiresIn });
    await this.db.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [k.id]);
    return { access_token: accessToken, token_type: 'Bearer', expires_in: expiresIn, scope: `org:${k.organization_id} role:${k.role}` };
  }
}

// ======================================================================================
// Webhooks
// ======================================================================================

const webhookBody = z.object({
  organizationId: z.uuid(),
  name: z.string().trim().min(1).max(80),
  url: z.url().max(500),
  events: z.array(z.enum([...WEBHOOK_EVENTS, '*'] as [string, ...string[]])).min(1).max(20),
  enabled: z.boolean().default(true),
});
const webhookUpdate = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  url: z.url().max(500).optional(),
  events: z.array(z.enum([...WEBHOOK_EVENTS, '*'] as [string, ...string[]])).min(1).max(20).optional(),
  enabled: z.boolean().optional(),
});

/** Blocks webhooks to private/loopback addresses in production (SSRF protection). */
export async function assertPublicUrl(raw: string) {
  const u = new URL(raw);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new BadRequestException({ code: 'invalid_url' });
  if (process.env.ALLOW_PRIVATE_WEBHOOKS === 'true') return;
  if (u.protocol !== 'https:') throw new BadRequestException({ code: 'https_required', message: 'Webhook URLs must use https://' });
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addrs.length) throw new BadRequestException({ code: 'unresolvable_host', message: `Can’t find ${host}` });
  for (const a of addrs) {
    if (/^(10\.|127\.|169\.254\.|192\.168\.|0\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(a) || /^172\.(1[6-9]|2\d|3[01])\./.test(a) || /^(::1|fc|fd|fe80)/i.test(a)) {
      throw new BadRequestException({ code: 'private_address', message: 'Webhooks can’t point to a private network address.' });
    }
  }
}

function mapWebhook(w: any) {
  return {
    id: w.id,
    name: w.name,
    url: w.url,
    events: w.events,
    enabled: w.enabled,
    createdAt: w.created_at,
    lastSuccessAt: w.last_success_at,
    lastFailureAt: w.last_failure_at,
    consecutiveFailures: w.consecutive_failures,
  };
}

@ApiTags('Webhooks')
@Controller('api/v1/webhooks')
export class WebhooksController {
  constructor(
    private readonly db: Db,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  @Doc('List', { query: z.object({ organizationId: z.uuid() }) })
  @Get()
  async list(@CurrentUser() user: AuthUser, @Query() q: unknown) {
    const { organizationId } = parse(z.object({ organizationId: z.uuid() }), q);
    await this.access.requireOrg(user, organizationId, 'org_admin');
    return { items: (await this.db.query('SELECT * FROM webhooks WHERE organization_id = $1 ORDER BY created_at', [organizationId])).map(mapWebhook), events: WEBHOOK_EVENTS };
  }

  @Doc('Create', { body: webhookBody })
  @Post()
  async create(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const input = parse(webhookBody, body);
    await this.access.requireOrg(user, input.organizationId, 'org_admin');
    await this.access.requireQuota(input.organizationId, 'webhooks');
    await assertPublicUrl(input.url);
    const secret = 'whsec_' + randomBytes(24).toString('base64url');
    const w = await this.db.one(
      'INSERT INTO webhooks (organization_id, name, url, secret, events, enabled, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [input.organizationId, input.name, input.url, secret, input.events, input.enabled, userRef(user)],
    );
    await this.audit.record({ ...actor(user), organizationId: input.organizationId, action: 'webhook.create', resourceType: 'webhook', resourceId: w.id, metadata: { url: input.url, events: input.events } });
    return { ...mapWebhook(w), secret };
  }

  @Doc('Update', { body: webhookUpdate })
  @Patch(':id')
  async update(@CurrentUser() user: AuthUser, @Param('id', Uuid()) id: string, @Body() body: unknown) {
    const w0 = await this.hook(user, id);
    const input = parse(webhookUpdate, body);
    if (input.url) await assertPublicUrl(input.url);
    const w = await this.db.one(
      `UPDATE webhooks SET name = COALESCE($2, name), url = COALESCE($3, url), events = COALESCE($4, events), enabled = COALESCE($5, enabled),
         consecutive_failures = CASE WHEN $5 THEN 0 ELSE consecutive_failures END WHERE id = $1 RETURNING *`,
      [id, input.name ?? null, input.url ?? null, input.events ?? null, input.enabled ?? null],
    );
    await this.audit.record({ ...actor(user), organizationId: w0.organization_id, action: 'webhook.update', resourceType: 'webhook', resourceId: id, metadata: input });
    return mapWebhook(w);
  }

  @Doc('Remove')
  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param('id', Uuid()) id: string) {
    const w = await this.hook(user, id);
    await this.db.query('DELETE FROM webhooks WHERE id = $1', [id]);
    await this.audit.record({ ...actor(user), organizationId: w.organization_id, action: 'webhook.delete', resourceType: 'webhook', resourceId: id, metadata: { url: w.url } });
  }

  /** Queues a `webhook.test` delivery to this endpoint. */
  @Doc('Test')
  @Post(':id/test')
  @HttpCode(202)
  async test(@CurrentUser() user: AuthUser, @Param('id', Uuid()) id: string) {
    const w = await this.hook(user, id);
    const payload = { id: randomBytes(8).toString('hex'), type: 'webhook.test', organizationId: w.organization_id, createdAt: new Date().toISOString(), data: { message: 'Hello from ARC Cloud' } };
    const d = await this.db.one(
      `INSERT INTO deliveries (organization_id, kind, webhook_id, recipient, event_type, payload) VALUES ($1, 'webhook', $2, $3, 'webhook.test', $4) RETURNING id`,
      [w.organization_id, id, w.url, payload],
    );
    return { queued: true, deliveryId: d.id };
  }

  @Doc('Deliveries', { query: pageQuery })
  @Get(':id/deliveries')
  async deliveries(@CurrentUser() user: AuthUser, @Param('id', Uuid()) id: string, @Query() q: unknown) {
    await this.hook(user, id);
    const { limit, offset } = parse(pageQuery, q);
    const rows = await this.db.query(
      `SELECT id, event_type, status, attempts, response_code, last_error, created_at, sent_at, next_attempt_at FROM deliveries
       WHERE webhook_id = $1 ORDER BY id DESC LIMIT $2 OFFSET $3`,
      [id, limit, offset],
    );
    return {
      items: rows.map((d) => ({
        id: d.id,
        eventType: d.event_type,
        status: d.status,
        attempts: d.attempts,
        responseCode: d.response_code,
        lastError: d.last_error,
        createdAt: d.created_at,
        sentAt: d.sent_at,
        nextAttemptAt: d.status === 'pending' ? d.next_attempt_at : null,
      })),
    };
  }

  private async hook(user: AuthUser, id: string) {
    const w = await this.db.one('SELECT * FROM webhooks WHERE id = $1', [id]);
    if (!w) throw new NotFoundException({ code: 'not_found' });
    await this.access.requireOrg(user, w.organization_id, 'org_admin');
    return w;
  }
}

// ======================================================================================
// ARC LMS links (time-limited learner access)
// ======================================================================================

const linkBody = z.object({
  projectId: z.uuid(),
  lmsRef: z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9_./:-]+$/),
  title: z.string().trim().min(1).max(120),
  deviceIds: z.array(z.uuid()).max(200).nullable().default(null),
  maxTokenMinutes: z.number().int().min(5).max(1440).default(240),
  expiresAt: z.iso.datetime().nullable().default(null),
});
const learnerBody = z.object({
  learnerRef: z.string().trim().min(1).max(120),
  minutes: z.number().int().min(5).max(1440).default(60),
});

function mapLink(l: any) {
  return {
    id: l.id,
    projectId: l.project_id,
    projectName: l.project_name ?? undefined,
    lmsRef: l.lms_ref,
    title: l.title,
    deviceIds: l.device_ids,
    maxTokenMinutes: l.max_token_minutes,
    expiresAt: l.expires_at,
    createdAt: l.created_at,
    revokedAt: l.revoked_at,
  };
}

@ApiTags('ARC LMS')
@Controller('api/v1/lms')
export class LmsController {
  constructor(
    private readonly db: Db,
    private readonly jwt: JwtService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  @Doc('List', { query: z.object({ organizationId: z.uuid() }) })
  @Get('links')
  async list(@CurrentUser() user: AuthUser, @Query() q: unknown) {
    const { organizationId } = parse(z.object({ organizationId: z.uuid() }), q);
    await this.access.requireOrg(user, organizationId, user.scope ? 'viewer' : 'org_admin');
    const rows = await this.db.query(
      `SELECT l.*, p.name AS project_name FROM lms_links l JOIN projects p ON p.id = l.project_id
       WHERE l.organization_id = $1 ORDER BY l.revoked_at NULLS FIRST, l.created_at DESC`,
      [organizationId],
    );
    return { items: rows.map(mapLink) };
  }

  /** Maps an LMS course/lab to an ARC Cloud channel (and optionally specific devices). */
  @Doc('Create', { body: linkBody })
  @Post('links')
  async create(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    requirePerson(user);
    const input = parse(linkBody, body);
    const project = await this.access.requireProject(user, input.projectId, 'org_admin');
    if (input.deviceIds?.length) {
      const n = await this.db.one<{ n: number }>('SELECT count(*)::int AS n FROM devices WHERE project_id = $1 AND id = ANY($2)', [project.id, input.deviceIds]);
      if (n!.n !== new Set(input.deviceIds).size) throw new BadRequestException({ code: 'device_not_in_channel' });
    }
    try {
      const l = await this.db.one(
        `INSERT INTO lms_links (organization_id, project_id, lms_ref, title, device_ids, max_token_minutes, expires_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [project.organization_id, project.id, input.lmsRef, input.title, input.deviceIds?.length ? input.deviceIds : null, input.maxTokenMinutes, input.expiresAt, userRef(user)],
      );
      await this.audit.record({ ...actor(user), organizationId: project.organization_id, action: 'lms_link.create', resourceType: 'lms_link', resourceId: l.id, metadata: { lmsRef: input.lmsRef } });
      return mapLink(l);
    } catch (e: any) {
      if (e.code === '23505') throw new BadRequestException({ code: 'lms_ref_taken', message: 'That LMS reference is already linked.' });
      throw e;
    }
  }

  @Doc('Revoke')
  @Delete('links/:id')
  @HttpCode(204)
  async revoke(@CurrentUser() user: AuthUser, @Param('id', Uuid()) id: string) {
    requirePerson(user);
    const l = await this.link(id);
    await this.access.requireOrg(user, l.organization_id, 'org_admin');
    await this.db.query('UPDATE lms_links SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1', [id]);
    await this.audit.record({ ...actor(user), organizationId: l.organization_id, action: 'lms_link.revoke', resourceType: 'lms_link', resourceId: id });
  }

  /**
   * Issues a short-lived, read-only token for one learner, limited to the link's channel/devices.
   * Called by the ARC LMS server with a service-account token (or by an admin for testing).
   * The learner never sees device credentials.
   */
  @Doc('Learner token', { body: learnerBody })
  @Post('links/:id/learner-tokens')
  async learnerToken(@CurrentUser() user: AuthUser, @Param('id', Uuid()) id: string, @Body() body: unknown) {
    const l = await this.link(id);
    if (l.revoked_at || (l.expires_at && new Date(l.expires_at) < new Date())) throw new NotFoundException({ code: 'link_inactive' });
    await this.access.requireProject(user, l.project_id, user.scope ? 'viewer' : 'org_admin');
    if (user.scope && user.kind !== 'service_account' && user.kind !== 'api_key') throw new NotFoundException({ code: 'not_found' });
    const input = parse(learnerBody, body ?? {});
    const minutes = Math.min(input.minutes, l.max_token_minutes);
    const token = await this.jwt.signAsync({ sub: l.id, typ: 'lab', lms: input.learnerRef }, { expiresIn: minutes * 60 });
    await this.audit.record({ ...actor(user), organizationId: l.organization_id, action: 'lms.learner_token', resourceType: 'lms_link', resourceId: l.id, metadata: { learnerRef: input.learnerRef, minutes } });
    const console = (process.env.CONSOLE_URL ?? '').replace(/\/+$/, '');
    return {
      accessToken: token,
      tokenType: 'Bearer',
      expiresIn: minutes * 60,
      projectId: l.project_id,
      deviceIds: l.device_ids,
      viewerUrl: console ? `${console}/lab#${token}` : null,
    };
  }

  private async link(id: string) {
    const l = await this.db.one('SELECT * FROM lms_links WHERE id = $1', [id]);
    if (!l) throw new NotFoundException({ code: 'not_found' });
    return l;
  }
}
