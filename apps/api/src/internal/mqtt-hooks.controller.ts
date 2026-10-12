import { Body, CanActivate, Controller, ExecutionContext, HttpCode, Injectable, Logger, Post, UnauthorizedException, UseGuards } from '@nestjs/common';
import { authorizeDevice, authorizeIngestService } from '@arc/shared';
import { loadConfig } from '../config';
import { safeEqual, UUID_RE, verifySecret } from '../common/crypto';
import { Db } from '../db/db.service';
import { CONNECTABLE } from '../devices/devices.controller';

/** Only the broker may call these hooks: separate port + shared token. */
@Injectable()
class HookTokenGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const token = ctx.switchToHttp().getRequest().headers['x-internal-token'];
    if (typeof token !== 'string' || !safeEqual(token, loadConfig().INTERNAL_HOOK_TOKEN)) throw new UnauthorizedException();
    return true;
  }
}

interface AuthnBody { username?: string; password?: string; clientid?: string }
interface AuthzBody { username?: string; clientid?: string; topic?: string; action?: string }

const ALLOW = { result: 'allow', is_superuser: false };
const DENY = { result: 'deny' };

/**
 * EMQX HTTP authentication + authorization hooks.
 *  - Device identity: username = clientid = device UUID, password = per-device secret.
 *  - Revoking a device or rotating its credential takes effect on the next connect;
 *    the ACL check also re-reads lifecycle state (subject to the broker's authz cache TTL).
 */
@Controller('internal/mqtt')
@UseGuards(HookTokenGuard)
export class MqttHooksController {
  private readonly log = new Logger('MqttHooks');

  constructor(private readonly db: Db) {}

  @Post('authenticate')
  @HttpCode(200)
  async authenticate(@Body() body: AuthnBody) {
    const cfg = loadConfig();
    const { username = '', password = '', clientid = '' } = body ?? {};

    if (username === cfg.MQTT_SERVICE_USERNAME) {
      return safeEqual(password, cfg.MQTT_SERVICE_PASSWORD) ? ALLOW : DENY;
    }

    // Device: clientid must equal username so one device cannot take over another's session.
    if (!UUID_RE.test(username) || clientid !== username || !password) return this.deny('malformed', username);

    const row = await this.db.one(
      `SELECT d.lifecycle_status, o.status AS org_status, c.secret_hash
       FROM devices d
       JOIN organizations o ON o.id = d.organization_id
       JOIN device_credentials c ON c.device_id = d.id AND c.status = 'active'
       WHERE d.id = $1`,
      [username],
    );
    if (!row) return this.deny('unknown_or_no_active_credential', username);
    if (row.org_status !== 'active') return this.deny('org_inactive', username);
    if (!CONNECTABLE.includes(row.lifecycle_status)) return this.deny(`lifecycle_${row.lifecycle_status}`, username);
    if (!(await verifySecret(password, row.secret_hash))) return this.deny('bad_password', username);
    return ALLOW;
  }

  @Post('authorize')
  @HttpCode(200)
  async authorize(@Body() body: AuthzBody) {
    const cfg = loadConfig();
    const { username = '', topic = '', action = '' } = body ?? {};

    if (username === cfg.MQTT_SERVICE_USERNAME) {
      return authorizeIngestService(action, topic) ? { result: 'allow' } : DENY;
    }
    if (!UUID_RE.test(username)) return DENY;

    const d = await this.db.one(
      'SELECT id, organization_id, project_id, lifecycle_status FROM devices WHERE id = $1',
      [username],
    );
    if (!d || !CONNECTABLE.includes(d.lifecycle_status)) return DENY;
    const allowed = authorizeDevice({ id: d.id, organizationId: d.organization_id, projectId: d.project_id }, action, topic);
    if (!allowed) this.log.warn(`ACL deny device=${username} action=${action} topic=${topic}`);
    return allowed ? { result: 'allow' } : DENY;
  }

  private deny(reason: string, username: string) {
    // Logged, not persisted: failed auth must not become a database write amplifier.
    this.log.warn(`auth deny user=${username.slice(0, 64)} reason=${reason}`);
    return DENY;
  }
}
