import { ApiTags } from '@nestjs/swagger';
import { Doc } from '../common/docs';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { AccessService } from '../common/access.service';
import { AuditService } from '../common/audit.service';
import { emitEvent } from '../common/events';
import { actor, AuthUser, CurrentUser, label, parse, userRef, Uuid } from '../common/http';
import { CommandsService, mapCommand } from '../commands/commands.service';
import { Db, Queryable } from '../db/db.service';

/** Canonical manifest that releases are signed over (keys in this exact order). */
export function canonicalManifest(m: { deviceType: string; version: string; url: string; sha256: string; sizeBytes: number }): string {
  return JSON.stringify({ deviceType: m.deviceType, sha256: m.sha256, sizeBytes: m.sizeBytes, url: m.url, version: m.version });
}

/**
 * Signing key algorithms.
 * - `ecdsa-p256`: ECDSA over SHA-256 on NIST P-256, DER signature. ESP32 firmware verifies these on the
 *   device with the mbedTLS that ships in the Arduino core, so this is the algorithm to use for OTA.
 * - `ed25519`: accepted for keys registered before device-side verification existed. The server verifies
 *   them, but the reference firmware cannot (mbedTLS has no Ed25519), so new keys should be P-256.
 */
export type SigningAlgorithm = 'ecdsa-p256' | 'ed25519';

export function keyAlgorithm(pem: string): SigningAlgorithm | null {
  try {
    const k = createPublicKey(pem);
    if (k.asymmetricKeyType === 'ed25519') return 'ed25519';
    if (k.asymmetricKeyType === 'ec' && k.asymmetricKeyDetails?.namedCurve === 'prime256v1') return 'ecdsa-p256';
    return null;
  } catch {
    return null;
  }
}

export function verifyManifest(manifest: string, publicKeyPem: string, signatureB64: string): boolean {
  try {
    const alg = keyAlgorithm(publicKeyPem);
    const sig = Buffer.from(signatureB64, 'base64');
    if (alg === 'ed25519') return verify(null, Buffer.from(manifest), createPublicKey(publicKeyPem), sig);
    if (alg === 'ecdsa-p256') return verify('sha256', Buffer.from(manifest), { key: createPublicKey(publicKeyPem), dsaEncoding: 'der' }, sig);
    return false;
  } catch {
    return false;
  }
}

const keyBody = z.object({ organizationId: z.uuid(), name: z.string().trim().min(1).max(80), publicKeyPem: z.string().min(40).max(2000) });
const releaseBody = z.object({
  organizationId: z.uuid(),
  deviceType: z.string().trim().min(1).max(64),
  version: z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9._+-]+$/),
  url: z.url().max(1000).refine((u) => u.startsWith('https://'), 'firmware must be served over https://'),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  sizeBytes: z.number().int().min(1).max(64 * 1024 * 1024),
  signature: z.string().min(40).max(200),
  signingKeyId: z.uuid(),
  notes: z.string().max(2000).default(''),
});
const rolloutBody = z.object({ releaseId: z.uuid(), projectId: z.uuid(), percent: z.number().int().min(1).max(100).default(10) });
const rolloutUpdate = z.object({ percent: z.number().int().min(1).max(100).optional(), status: z.enum(['active', 'paused', 'cancelled']).optional() });

const OTA_TTL_SECONDS = 24 * 3600;

/**
 * Expires the not-yet-acknowledged ota.update commands of the matching rollouts. Without this, cancelling a
 * rollout or withdrawing a release left its commands open for 24 h, and the worker re-delivers open commands on
 * every reconnect, so a device that rolled back reinstalled the same image again and again (seen on the pilot).
 */
async function closePendingOtaCommands(c: Queryable, rolloutFilter: string, params: unknown[], reason: string) {
  const closed = (
    await c.query(
      `UPDATE commands SET status = 'expired', completed_at = now(), error = $${params.length + 1}
       WHERE status IN ('queued', 'published')
         AND id IN (SELECT command_id FROM firmware_rollout_devices WHERE ${rolloutFilter} AND command_id IS NOT NULL)
       RETURNING *`,
      [...params, reason],
    )
  ).rows;
  for (const r of closed) await emitEvent(c, r.organization_id, 'command.updated', mapCommand(r));
  return closed.length;
}
const ORDER_SQL = `md5(d.id::text || $2)`; // stable pseudo-random order per rollout

function mapRelease(r: any) {
  return {
    id: r.id,
    deviceType: r.device_type,
    version: r.version,
    url: r.url,
    sha256: r.sha256,
    sizeBytes: Number(r.size_bytes),
    signature: r.signature,
    signingKeyId: r.signing_key_id,
    signingKeyName: r.key_name ?? undefined,
    notes: r.notes,
    status: r.status,
    createdAt: r.created_at,
  };
}

@ApiTags('Firmware & OTA')
@Controller('api/v1/firmware')
export class FirmwareController {
  constructor(
    private readonly db: Db,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly commands: CommandsService,
  ) {}

  // ---- signing keys ----

  @Doc('Keys', { query: z.object({ organizationId: z.uuid() }) })
  @Get('signing-keys')
  async keys(@CurrentUser() user: AuthUser, @Query() q: unknown) {
    const { organizationId } = parse(z.object({ organizationId: z.uuid() }), q);
    await this.access.requireOrg(user, organizationId, 'viewer');
    const rows = await this.db.query('SELECT id, name, public_key_pem, created_at, revoked_at FROM firmware_signing_keys WHERE organization_id = $1 ORDER BY created_at', [organizationId]);
    return {
      items: rows.map((k) => {
        const algorithm = keyAlgorithm(k.public_key_pem);
        return { id: k.id, name: k.name, algorithm, deviceVerifiable: algorithm === 'ecdsa-p256', publicKeyPem: k.public_key_pem, createdAt: k.created_at, revokedAt: k.revoked_at };
      }),
    };
  }

  @Doc('Add key', { body: keyBody })
  @Post('signing-keys')
  async addKey(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const input = parse(keyBody, body);
    await this.access.requireOrg(user, input.organizationId, 'org_admin');
    const algorithm = keyAlgorithm(input.publicKeyPem);
    if (!algorithm) {
      throw new BadRequestException({ code: 'invalid_key', message: 'Use an ECDSA P-256 public key in PEM form (node tools/firmware-sign.mjs keygen).' });
    }
    const k = await this.db.one('INSERT INTO firmware_signing_keys (organization_id, name, public_key_pem) VALUES ($1, $2, $3) RETURNING *', [input.organizationId, input.name, input.publicKeyPem.trim()]);
    await this.audit.record({ ...actor(user), organizationId: input.organizationId, action: 'firmware.key_add', resourceType: 'firmware_signing_key', resourceId: k.id, metadata: { name: k.name, algorithm } });
    return { id: k.id, name: k.name, algorithm, deviceVerifiable: algorithm === 'ecdsa-p256', createdAt: k.created_at };
  }

  @Doc('Revoke key')
  @Delete('signing-keys/:id')
  @HttpCode(204)
  async revokeKey(@CurrentUser() user: AuthUser, @Param('id', Uuid()) id: string) {
    const k = await this.db.one('SELECT * FROM firmware_signing_keys WHERE id = $1', [id]);
    if (!k) throw new NotFoundException({ code: 'not_found' });
    await this.access.requireOrg(user, k.organization_id, 'org_admin');
    await this.db.query('UPDATE firmware_signing_keys SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1', [id]);
    await this.audit.record({ ...actor(user), organizationId: k.organization_id, action: 'firmware.key_revoke', resourceType: 'firmware_signing_key', resourceId: id });
  }

  // ---- releases ----

  @Doc('Releases', { query: z.object({ organizationId: z.uuid() }) })
  @Get('releases')
  async releases(@CurrentUser() user: AuthUser, @Query() q: unknown) {
    const { organizationId } = parse(z.object({ organizationId: z.uuid() }), q);
    await this.access.requireOrg(user, organizationId, 'viewer');
    const rows = await this.db.query(
      `SELECT r.*, k.name AS key_name FROM firmware_releases r JOIN firmware_signing_keys k ON k.id = r.signing_key_id
       WHERE r.organization_id = $1 ORDER BY r.created_at DESC`,
      [organizationId],
    );
    return { items: rows.map(mapRelease) };
  }

  /** Registers a release. The manifest signature is verified here; unsigned or mis-signed releases are refused. */
  @Doc('Add release', { body: releaseBody })
  @Post('releases')
  async addRelease(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const input = parse(releaseBody, body);
    await this.access.requireOrg(user, input.organizationId, 'org_admin');
    const key = await this.db.one('SELECT * FROM firmware_signing_keys WHERE id = $1 AND organization_id = $2 AND revoked_at IS NULL', [input.signingKeyId, input.organizationId]);
    if (!key) throw new BadRequestException({ code: 'unknown_signing_key' });
    const manifest = canonicalManifest(input);
    if (!verifyManifest(manifest, key.public_key_pem, input.signature)) throw new BadRequestException({ code: 'bad_signature', message: 'The signature doesn’t match this manifest and key. Sign it with tools/firmware-sign.mjs.' });
    try {
      const r = await this.db.one(
        `INSERT INTO firmware_releases (organization_id, device_type, version, url, sha256, size_bytes, signature, signing_key_id, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [input.organizationId, input.deviceType, input.version, input.url, input.sha256, input.sizeBytes, input.signature, key.id, input.notes, userRef(user)],
      );
      await this.audit.record({ ...actor(user), organizationId: input.organizationId, action: 'firmware.release', resourceType: 'firmware_release', resourceId: r.id, metadata: { deviceType: r.device_type, version: r.version, sha256: r.sha256 } });
      return { ...mapRelease(r), manifestSha256: createHash('sha256').update(manifest).digest('hex') };
    } catch (e: any) {
      if (e.code === '23505') throw new ConflictException({ code: 'version_exists' });
      throw e;
    }
  }

  @Doc('Withdraw')
  @Post('releases/:id/withdraw')
  @HttpCode(200)
  async withdraw(@CurrentUser() user: AuthUser, @Param('id', Uuid()) id: string) {
    const r = await this.release(id);
    await this.access.requireOrg(user, r.organization_id, 'org_admin');
    await this.db.tx(async (c) => {
      await c.query(`UPDATE firmware_releases SET status = 'withdrawn' WHERE id = $1`, [id]);
      await c.query(`UPDATE firmware_rollouts SET status = 'cancelled', updated_at = now() WHERE release_id = $1 AND status IN ('active', 'paused')`, [id]);
      // Every rollout of a withdrawn release, including ones cancelled earlier: none of its images may be installed.
      await closePendingOtaCommands(c, `rollout_id IN (SELECT id FROM firmware_rollouts WHERE release_id = $1)`, [id], 'release withdrawn');
      await this.audit.record({ ...actor(user), organizationId: r.organization_id, action: 'firmware.withdraw', resourceType: 'firmware_release', resourceId: id }, c);
    });
    return { status: 'withdrawn' };
  }

  // ---- rollouts ----

  @Doc('Rollouts', { query: z.object({ organizationId: z.uuid() }) })
  @Get('rollouts')
  async rollouts(@CurrentUser() user: AuthUser, @Query() q: unknown) {
    const { organizationId } = parse(z.object({ organizationId: z.uuid() }), q);
    await this.access.requireOrg(user, organizationId, 'viewer');
    const rows = await this.db.query(
      `SELECT o.*, r.version, r.device_type, p.name AS project_name,
         (SELECT jsonb_object_agg(status, n) FROM (SELECT status, count(*)::int AS n FROM firmware_rollout_devices WHERE rollout_id = o.id GROUP BY status) s) AS counts,
         (SELECT count(*)::int FROM devices d WHERE d.project_id = o.project_id AND d.device_type = r.device_type AND d.lifecycle_status IN ('active','provisioned','maintenance')) AS eligible
       FROM firmware_rollouts o JOIN firmware_releases r ON r.id = o.release_id JOIN projects p ON p.id = o.project_id
       WHERE o.organization_id = $1 ORDER BY o.created_at DESC`,
      [organizationId],
    );
    return { items: rows.map((o) => this.mapRollout(o)) };
  }

  @Doc('Rollout')
  @Get('rollouts/:id')
  async rollout(@CurrentUser() user: AuthUser, @Param('id', Uuid()) id: string) {
    const o = await this.db.one('SELECT o.*, r.version, r.device_type FROM firmware_rollouts o JOIN firmware_releases r ON r.id = o.release_id WHERE o.id = $1', [id]);
    if (!o) throw new NotFoundException({ code: 'not_found' });
    await this.access.requireProject(user, o.project_id, 'viewer');
    const devices = await this.db.query(
      `SELECT rd.*, d.display_name, d.firmware_version FROM firmware_rollout_devices rd JOIN devices d ON d.id = rd.device_id WHERE rd.rollout_id = $1 ORDER BY d.display_name`,
      [id],
    );
    return {
      ...this.mapRollout(o),
      devices: devices.map((d) => ({ deviceId: d.device_id, name: d.display_name, firmwareVersion: d.firmware_version, status: d.status, detail: d.detail, commandId: d.command_id, updatedAt: d.updated_at })),
    };
  }

  /** Starts a staged rollout to `percent` of the channel's devices of the release's device type. */
  @Doc('Start rollout', { body: rolloutBody })
  @Post('rollouts')
  async startRollout(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const input = parse(rolloutBody, body);
    const r = await this.release(input.releaseId);
    const project = await this.access.requireProject(user, input.projectId, 'org_admin');
    if (project.organization_id !== r.organization_id) throw new NotFoundException({ code: 'not_found' });
    if (r.status !== 'released') throw new ConflictException({ code: 'release_withdrawn' });
    const o = await this.db.one(
      `INSERT INTO firmware_rollouts (organization_id, release_id, project_id, percent, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [r.organization_id, r.id, project.id, input.percent, userRef(user)],
    );
    await this.audit.record({ ...actor(user), organizationId: r.organization_id, action: 'firmware.rollout_start', resourceType: 'firmware_rollout', resourceId: o.id, metadata: { version: r.version, percent: input.percent } });
    await this.dispatch(o.id, user);
    return this.rollout(user, o.id);
  }

  /** Widen (percent), pause, resume or cancel a rollout. */
  @Doc('Update rollout', { body: rolloutUpdate })
  @Patch('rollouts/:id')
  async updateRollout(@CurrentUser() user: AuthUser, @Param('id', Uuid()) id: string, @Body() body: unknown) {
    const input = parse(rolloutUpdate, body);
    const o = await this.db.one('SELECT * FROM firmware_rollouts WHERE id = $1', [id]);
    if (!o) throw new NotFoundException({ code: 'not_found' });
    await this.access.requireProject(user, o.project_id, 'org_admin');
    if (['completed', 'cancelled'].includes(o.status)) throw new ConflictException({ code: 'rollout_finished' });
    if (input.percent !== undefined && input.percent < o.percent) throw new BadRequestException({ code: 'cannot_shrink', message: 'A rollout can only be widened.' });
    await this.db.tx(async (c) => {
      await c.query(
        `UPDATE firmware_rollouts SET percent = COALESCE($2, percent), status = COALESCE($3, status), updated_at = now() WHERE id = $1`,
        [id, input.percent ?? null, input.status ?? null],
      );
      if (input.status === 'cancelled') await closePendingOtaCommands(c, `rollout_id = $1`, [id], 'rollout cancelled');
    });
    await this.audit.record({ ...actor(user), organizationId: o.organization_id, action: 'firmware.rollout_update', resourceType: 'firmware_rollout', resourceId: id, metadata: input });
    if ((input.status ?? o.status) === 'active') await this.dispatch(id, user);
    return this.rollout(user, id);
  }

  /** Adds newly-in-scope devices and sends each pending device an `ota.update` command. */
  private async dispatch(rolloutId: string, user: AuthUser) {
    const created: any[] = await this.db.tx(async (c) => {
      const o = (await c.query('SELECT o.*, r.* , o.id AS rollout_id, o.status AS rollout_status FROM firmware_rollouts o JOIN firmware_releases r ON r.id = o.release_id WHERE o.id = $1 FOR UPDATE OF o', [rolloutId])).rows[0];
      if (!o || o.rollout_status !== 'active') return [];
      const eligible = (
        await c.query(
          `SELECT d.id FROM devices d WHERE d.project_id = $1 AND d.device_type = $3 AND d.lifecycle_status IN ('active','provisioned','maintenance')
           ORDER BY ${ORDER_SQL}`,
          [o.project_id, rolloutId, o.device_type],
        )
      ).rows.map((x: any) => x.id as string);
      const target = eligible.slice(0, Math.ceil((eligible.length * o.percent) / 100));
      if (target.length) {
        await c.query(
          `INSERT INTO firmware_rollout_devices (rollout_id, device_id) SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING`,
          [rolloutId, target],
        );
      }
      // Devices already on the version succeed without an update.
      await c.query(
        `UPDATE firmware_rollout_devices rd SET status = 'succeeded', detail = 'already on this version', updated_at = now()
         FROM devices d WHERE rd.rollout_id = $1 AND rd.device_id = d.id AND rd.status = 'pending' AND d.firmware_version = $2`,
        [rolloutId, o.version],
      );
      const pending = (
        await c.query(
          `SELECT d.id, d.organization_id, d.project_id FROM firmware_rollout_devices rd JOIN devices d ON d.id = rd.device_id
           WHERE rd.rollout_id = $1 AND rd.status = 'pending'`,
          [rolloutId],
        )
      ).rows;
      // `manifest` is the exact byte string the signature covers. Firmware verifies the signature over it
      // and takes url/sha256/size/version ONLY from it; the loose fields stay for older firmware and the console.
      const fields = { deviceType: o.device_type, version: o.version, url: o.url, sha256: o.sha256, sizeBytes: Number(o.size_bytes) };
      const manifest = { ...fields, manifest: canonicalManifest(fields), signature: o.signature, signingKeyId: o.signing_key_id, rolloutId };
      const cmds: any[] = [];
      for (const d of pending) {
        const cmd = await this.commands.create(c, d, 'ota.update', manifest, OTA_TTL_SECONDS, userRef(user), label(user));
        await c.query(`UPDATE firmware_rollout_devices SET status = 'sent', command_id = $3, updated_at = now() WHERE rollout_id = $1 AND device_id = $2`, [rolloutId, d.id, cmd.id]);
        cmds.push(cmd);
      }
      await emitEvent(c, o.organization_id, 'firmware.rollout_updated', { rolloutId, version: o.version, percent: o.percent, sent: cmds.length });
      return cmds;
    });
    for (const cmd of created) await this.commands.publish(cmd);
  }

  private async release(id: string) {
    const r = await this.db.one('SELECT * FROM firmware_releases WHERE id = $1', [id]);
    if (!r) throw new NotFoundException({ code: 'not_found' });
    return r;
  }

  private mapRollout(o: any) {
    return {
      id: o.id,
      releaseId: o.release_id,
      version: o.version,
      deviceType: o.device_type,
      projectId: o.project_id,
      projectName: o.project_name ?? undefined,
      percent: o.percent,
      status: o.status,
      counts: o.counts ?? {},
      eligible: o.eligible ?? undefined,
      createdAt: o.created_at,
      updatedAt: o.updated_at,
    };
  }
}
