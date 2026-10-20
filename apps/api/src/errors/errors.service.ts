import type { Pool } from 'pg';
import { audit } from '../audit/audit';
import { many, one, withTransaction } from '../database/db';
import { Conflict, NotFound } from '../studies/studies.service';

/** Owned exceptions: quarantined intake, control-ID collisions, and outbound messages that need a person. */
export class ErrorsService {
  constructor(private readonly pool: Pool) {}

  async list() {
    const [quarantined, collisions, outbound] = await Promise.all([
      many(
        this.pool,
        `SELECT m.id, p.code AS partner_code, m.control_id, m.message_type, m.reason_code, m.error, m.attempts, m.received_at, m.processed_at
           FROM intake_messages m JOIN integration_partners p ON p.id = m.partner_id
          WHERE m.status = 'quarantined' ORDER BY m.received_at DESC LIMIT 200`,
      ),
      many(
        this.pool,
        `SELECT c.id, c.intake_message_id, m.control_id, p.code AS partner_code, c.received_at
           FROM intake_collisions c JOIN intake_messages m ON m.id = c.intake_message_id JOIN integration_partners p ON p.id = m.partner_id
          WHERE c.resolved_at IS NULL ORDER BY c.received_at DESC LIMIT 200`,
      ),
      many(
        this.pool,
        `SELECT o.id, o.study_id, s.accession, o.kind, o.control_id, o.status, o.attempts, o.possibly_delivered, o.ack_code,
                o.ack_text, o.last_error, o.created_at, p.code AS partner_code
           FROM outbound_messages o JOIN studies s ON s.id = o.study_id JOIN integration_partners p ON p.id = o.partner_id
          WHERE o.status IN ('failed', 'unknown')
             -- a rejection stays listed until the study has been routed again or closed
             OR (o.status = 'rejected' AND s.state = 'manual_review'
                 AND NOT EXISTS (SELECT 1 FROM assignments a WHERE a.study_id = o.study_id AND a.created_at > o.created_at))
          ORDER BY o.created_at DESC LIMIT 200`,
      ),
    ]);
    return { quarantined, collisions, outbound };
  }

  /** Puts a quarantined message back in the queue, for example after a missing master record was added. */
  async requeueIntake(id: string, userId: string, ip?: string) {
    return withTransaction(this.pool, async (client) => {
      const r = await one(
        client,
        `UPDATE intake_messages SET status = 'received', attempts = 0, next_attempt_at = now(), error = NULL
          WHERE id = $1 AND status = 'quarantined' RETURNING id`,
        [id],
      );
      if (!r) throw new NotFound();
      await audit(client, { actorType: 'user', actorId: userId, action: 'intake.requeued', entityType: 'intake_message', entityId: id, ip });
      return { ok: true };
    });
  }

  /** Retries a failed delivery with the same control ID and payload, so the receiver can spot a repeat. */
  async retryOutbound(id: string, userId: string, ip?: string) {
    return withTransaction(this.pool, async (client) => {
      const o = await one<{ status: string; possibly_delivered: boolean; study_id: string }>(
        client,
        'SELECT status, possibly_delivered, study_id FROM outbound_messages WHERE id = $1 FOR UPDATE',
        [id],
      );
      if (!o) throw new NotFound();
      if (o.status !== 'failed' && o.status !== 'unknown') throw new Conflict('Only a failed or uncertain delivery can be retried');
      await client.query(
        `UPDATE outbound_messages SET status = $2, attempts = 0, next_attempt_at = now() WHERE id = $1`,
        [id, o.possibly_delivered ? 'unknown' : 'retry'],
      );
      await client.query(
        `UPDATE studies SET state = 'reserved', state_reason = NULL, version = version + 1, updated_at = now()
          WHERE id = $1 AND state = 'manual_review' AND state_reason IN ('DELIVERY_FAILED', 'DELIVERY_UNCERTAIN')`,
        [o.study_id],
      );
      await audit(client, { actorType: 'user', actorId: userId, action: 'outbound.retried', entityType: 'outbound_message', entityId: id, ip });
      return { ok: true };
    });
  }

  async resolveCollision(id: string, userId: string, ip?: string) {
    return withTransaction(this.pool, async (client) => {
      const r = await one(client, `UPDATE intake_collisions SET resolved_at = now(), resolved_by = $2 WHERE id = $1 AND resolved_at IS NULL RETURNING id`, [id, userId]);
      if (!r) throw new NotFound();
      await audit(client, { actorType: 'user', actorId: userId, action: 'intake.collision_resolved', entityType: 'intake_collision', entityId: id, ip });
      return { ok: true };
    });
  }
}
