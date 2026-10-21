import type { Pool } from 'pg';
import { z } from 'zod';
import { audit } from '../audit/audit';
import type { AppConfig } from '../config';
import { many, one, withTransaction } from '../database/db';
import { allocate, lockStudy } from '../processing/allocator';
import { Conflict, NotFound } from '../studies/studies.service';
import { cancelClocks, recordMilestone } from '../workflow/milestones';

const decisionSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('approve'), protocol: z.string().trim().max(80).optional(), note: z.string().trim().max(1000).optional() }),
  z.object({ decision: z.literal('reject'), note: z.string().trim().min(1, 'Give a reason').max(1000) }),
]);

/** Vetting: a radiologist approves a request (with a protocol) before it is routed, or rejects it. */
export class VettingService {
  constructor(
    private readonly pool: Pool,
    private readonly config: AppConfig,
  ) {}

  list() {
    return many(
      this.pool,
      `SELECT s.id, s.accession, h.code AS hospital_code, s.modality_code, s.service_code, coalesce(s.service_text, sv.name) AS service_name,
              s.priority, s.created_at, sv.vetting_protocols AS protocols,
              (SELECT state FROM tat_clocks c WHERE c.study_id = s.id AND c.interval_code = 'received_to_ready') AS clock_state,
              (SELECT due_at FROM tat_clocks c WHERE c.study_id = s.id AND c.interval_code = 'received_to_ready') AS due_at
         FROM studies s JOIN hospitals h ON h.id = s.hospital_id LEFT JOIN services sv ON sv.code = s.service_code
        WHERE s.state = 'awaiting_vetting'
        ORDER BY CASE s.priority WHEN 'STAT' THEN 0 WHEN 'URGENT' THEN 1 ELSE 2 END, s.created_at`,
    );
  }

  async decide(studyId: string, input: unknown, userId: string, ip?: string) {
    const parsed = decisionSchema.safeParse(input);
    if (!parsed.success) throw new Conflict(parsed.error.issues.map((i) => i.message).join('; '));
    const d = parsed.data;
    return withTransaction(this.pool, async (client) => {
      const s = await one<{ state: string; issuer: string; accession: string; protocols: string[] | null }>(
        client,
        `SELECT s.state, s.issuer, s.accession, sv.vetting_protocols AS protocols
           FROM studies s LEFT JOIN services sv ON sv.code = s.service_code WHERE s.id = $1`,
        [studyId],
      );
      if (!s) throw new NotFound();
      // Same per-study lock the intake processor takes, so a cancel cannot cross a vetting decision.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 7))', [`${s.issuer}|${s.accession}`]);
      const study = await lockStudy(client, studyId);
      if (study.state !== 'awaiting_vetting') throw new Conflict('This study is no longer waiting for vetting');

      if (d.decision === 'reject') {
        await client.query(
          `UPDATE studies SET state = 'vetting_rejected', state_reason = 'VETTING_REJECTED', vetted_by = $2, vetted_at = now(),
                  vetting_note = $3, version = version + 1, updated_at = now() WHERE id = $1`,
          [studyId, userId, d.note],
        );
        await cancelClocks(client, studyId, 'Not approved at vetting');
        await client.query(`INSERT INTO study_events (study_id, kind, detail, actor_id) VALUES ($1, 'vetting_rejected', $2, $3)`, [
          studyId,
          JSON.stringify({ note: d.note }),
          userId,
        ]);
        await audit(client, { actorType: 'user', actorId: userId, action: 'vetting.rejected', entityType: 'study', entityId: studyId, ip });
        return { outcome: 'rejected' };
      }

      const protocols = s.protocols ?? [];
      if (protocols.length > 0 && (!d.protocol || !protocols.includes(d.protocol))) throw new Conflict(`Choose a protocol: ${protocols.join(', ')}`);
      await client.query(
        `UPDATE studies SET state = 'ready', vetted_by = $2, vetted_at = now(), vetting_protocol = $3, vetting_note = $4,
                version = version + 1, updated_at = now() WHERE id = $1`,
        [studyId, userId, d.protocol ?? null, d.note ?? null],
      );
      await client.query(`INSERT INTO study_events (study_id, kind, detail, actor_id) VALUES ($1, 'vetting_approved', $2, $3)`, [
        studyId,
        JSON.stringify({ protocol: d.protocol ?? null }),
        userId,
      ]);
      await recordMilestone(client, studyId, 'ready');
      const result = await allocate(client, await lockStudy(client, studyId), this.config);
      await audit(client, { actorType: 'user', actorId: userId, action: 'vetting.approved', entityType: 'study', entityId: studyId, detail: { protocol: d.protocol ?? null, allocation: result.outcome }, ip });
      return { outcome: 'approved', allocation: result.outcome, reasonCode: result.reasonCode };
    });
  }
}
