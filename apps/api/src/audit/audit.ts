import type { Queryable } from '../database/db';

export interface AuditEntry {
  actorType: 'user' | 'system' | 'partner';
  actorId?: string | null;
  action: string;
  entityType?: string;
  entityId?: string | null;
  detail?: Record<string, unknown>;
  ip?: string | null;
}

/** Writes an audit event in the caller's transaction, so the event and the change commit together. */
export async function audit(db: Queryable, e: AuditEntry): Promise<void> {
  await db.query(
    `INSERT INTO audit_events (actor_type, actor_id, action, entity_type, entity_id, detail, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [e.actorType, e.actorId ?? null, e.action, e.entityType ?? null, e.entityId ?? null, JSON.stringify(e.detail ?? {}), e.ip ?? null],
  );
}
