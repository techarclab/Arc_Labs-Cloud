import { Injectable } from '@nestjs/common';
import { Db, Queryable } from '../db/db.service';

export interface AuditEntry {
  actorType: 'user' | 'device' | 'service' | 'system';
  actorId?: string | null;
  organizationId?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class AuditService {
  constructor(private readonly db: Db) {}

  /** Pass the transaction client so the audit row commits atomically with the change. */
  async record(e: AuditEntry, q: Queryable = this.db.scoped): Promise<void> {
    await q.query(
      `INSERT INTO audit_logs (actor_type, actor_id, organization_id, action, resource_type, resource_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [e.actorType, e.actorId ?? null, e.organizationId ?? null, e.action, e.resourceType, e.resourceId ?? null, e.metadata ?? {}],
    );
  }
}
