import { Injectable, Logger } from '@nestjs/common';
import { loadConfig } from '../config';

/**
 * Disconnects device sessions on the broker right after a credential stops being valid (revoke, rotate,
 * suspend, retire). Without this, a connected device keeps its session until its next authentication and
 * can keep publishing for up to the broker's authorization-cache TTL (30 s).
 *
 * Uses the EMQX 5 REST API: DELETE {EMQX_API_URL}/api/v5/clients/{clientid}, HTTP Basic with an API key
 * provisioned through `api_key.bootstrap_file` (see infra/emqx/entrypoint.sh). Keep EMQX_API_URL on the
 * private network: that key can administer the broker.
 *
 * Best effort by design: the database change is already committed and is what the auth/ACL hooks enforce,
 * so a broker that is unreachable delays the disconnect (bounded by the cache TTL) but never re-allows access.
 */
@Injectable()
export class BrokerAdmin {
  private readonly log = new Logger('BrokerAdmin');
  private warned = false;

  async disconnect(clientId: string): Promise<'disconnected' | 'not_connected' | 'disabled' | 'failed'> {
    const cfg = loadConfig();
    if (!cfg.EMQX_API_URL || !cfg.EMQX_API_KEY || !cfg.EMQX_API_SECRET) {
      if (!this.warned) {
        this.log.warn('EMQX_API_URL/KEY/SECRET not set: revoked devices stay connected until the broker re-checks them (≤30 s)');
        this.warned = true;
      }
      return 'disabled';
    }
    try {
      const res = await fetch(`${cfg.EMQX_API_URL.replace(/\/+$/, '')}/api/v5/clients/${encodeURIComponent(clientId)}`, {
        method: 'DELETE',
        headers: { authorization: `Basic ${Buffer.from(`${cfg.EMQX_API_KEY}:${cfg.EMQX_API_SECRET}`).toString('base64')}` },
        signal: AbortSignal.timeout(3000),
      });
      if (res.status === 204 || res.status === 200) return 'disconnected';
      if (res.status === 404) return 'not_connected';
      this.log.warn(`broker refused disconnect of ${clientId}: HTTP ${res.status}`);
      return 'failed';
    } catch (e) {
      this.log.warn(`broker disconnect of ${clientId} failed: ${(e as Error).message}`);
      return 'failed';
    }
  }
}
