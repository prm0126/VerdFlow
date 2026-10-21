import { ruleSetDefinitionSchema } from '@vf/shared';
import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { audit } from '../audit/audit';
import { many, one, withTransaction } from '../database/db';
import { Conflict, NotFound } from '../studies/studies.service';

/** Stable 0–99 bucket for a study, so a retry or replay never changes whether it was sampled. */
export function sampleBucket(studyId: string): number {
  return createHash('sha256').update(`peer-review:${studyId}`).digest().readUInt32BE(0) % 100;
}

/**
 * Called when a report is final, in the same transaction. Samples the study, then picks an independent
 * reviewer (never the reporter) who may report this modality for this hospital and is under today's cap.
 * The cap row is locked, so concurrent finals cannot overrun it. Records a skipped task, with the reason,
 * when a sampled study cannot be reviewed.
 */
export async function maybeCreateReview(client: PoolClient, studyId: string, reporterId: string): Promise<'created' | 'skipped' | 'not_sampled' | 'disabled'> {
  const rs = await one<{ version: number; definition: unknown }>(client, `SELECT version, definition FROM rule_sets WHERE status = 'published'`);
  if (!rs) return 'disabled';
  const cfg = ruleSetDefinitionSchema.parse(rs.definition).peerReview;
  if (!cfg.enabled || cfg.percent === 0) return 'disabled';
  if (sampleBucket(studyId) >= cfg.percent) return 'not_sampled';

  const exists = await one(client, 'SELECT 1 FROM peer_review_tasks WHERE study_id = $1', [studyId]);
  if (exists) return 'created';

  const candidates = await many<{ id: string; assigned: number }>(
    client,
    `SELECT r.id, coalesce(d.assigned, 0) AS assigned
       FROM studies s
       JOIN radiologists r ON r.active AND r.id <> $2
       LEFT JOIN peer_review_daily d ON d.reviewer_id = r.id AND d.day = CURRENT_DATE
      WHERE s.id = $1
        AND EXISTS (SELECT 1 FROM radiologist_privileges rp WHERE rp.radiologist_id = r.id AND rp.modality_code = s.modality_code
                      AND (rp.valid_to IS NULL OR rp.valid_to >= CURRENT_DATE))
        AND EXISTS (SELECT 1 FROM radiologist_hospitals rh WHERE rh.radiologist_id = r.id AND rh.hospital_id = s.hospital_id)
      ORDER BY coalesce(d.assigned, 0), r.code`,
    [studyId, reporterId],
  );

  let reviewerId: string | null = null;
  for (const c of candidates) {
    await client.query(`INSERT INTO peer_review_daily (reviewer_id, day) VALUES ($1, CURRENT_DATE) ON CONFLICT DO NOTHING`, [c.id]);
    const day = await one<{ assigned: number }>(
      client,
      'SELECT assigned FROM peer_review_daily WHERE reviewer_id = $1 AND day = CURRENT_DATE FOR UPDATE',
      [c.id],
    );
    if (day!.assigned < cfg.dailyCapPerReviewer) {
      await client.query('UPDATE peer_review_daily SET assigned = assigned + 1 WHERE reviewer_id = $1 AND day = CURRENT_DATE', [c.id]);
      reviewerId = c.id;
      break;
    }
  }
  const skipReason = reviewerId ? null : candidates.length ? 'ALL_REVIEWERS_AT_DAILY_CAP' : 'NO_ELIGIBLE_REVIEWER';
  await client.query(
    `INSERT INTO peer_review_tasks (study_id, reporter_id, reviewer_id, rule_set_version, status, skip_reason)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (study_id) DO NOTHING`,
    [studyId, reporterId, reviewerId, rs.version, reviewerId ? 'open' : 'skipped', skipReason],
  );
  await client.query(`INSERT INTO study_events (study_id, kind, detail) VALUES ($1, $2, $3)`, [
    studyId,
    reviewerId ? 'peer_review_created' : 'peer_review_skipped',
    JSON.stringify({ reviewerId, skipReason }),
  ]);
  return reviewerId ? 'created' : 'skipped';
}

const outcomeSchema = z.object({
  outcome: z.enum(['agree', 'minor_discrepancy', 'major_discrepancy']),
  comment: z.string().trim().max(2000).optional(),
});

export class PeerReviewService {
  constructor(private readonly pool: Pool) {}

  list(params: { mine?: string; status?: string }) {
    return many(
      this.pool,
      `SELECT t.id, t.study_id, s.accession, s.modality_code, s.service_text, s.service_code, h.code AS hospital_code,
              t.status, t.skip_reason, t.outcome, t.comment, t.created_at, t.completed_at,
              rep.full_name AS reporter_name, rev.full_name AS reviewer_name, rev.user_id AS reviewer_user_id
         FROM peer_review_tasks t
         JOIN studies s ON s.id = t.study_id JOIN hospitals h ON h.id = s.hospital_id
         JOIN radiologists rep ON rep.id = t.reporter_id
         LEFT JOIN radiologists rev ON rev.id = t.reviewer_id
        WHERE ($1::uuid IS NULL OR rev.user_id = $1) AND ($2::text IS NULL OR t.status = $2)
        ORDER BY t.created_at DESC LIMIT 300`,
      [params.mine ?? null, params.status ?? null],
    );
  }

  async summary() {
    return one(
      this.pool,
      `SELECT count(*) FILTER (WHERE status = 'open')::int AS open,
              count(*) FILTER (WHERE status = 'completed')::int AS completed,
              count(*) FILTER (WHERE status = 'skipped')::int AS skipped,
              count(*) FILTER (WHERE outcome = 'major_discrepancy')::int AS major,
              (SELECT count(*)::int FROM studies WHERE state = 'finalized') AS finalized
         FROM peer_review_tasks`,
    );
  }

  /** Only the assigned reviewer, signed in as themselves, can record the outcome. */
  async complete(taskId: string, input: unknown, userId: string, ip?: string) {
    const parsed = outcomeSchema.safeParse(input);
    if (!parsed.success) throw new Conflict('Choose an outcome');
    return withTransaction(this.pool, async (client) => {
      const t = await one<{ status: string; reviewer_user_id: string | null; study_id: string }>(
        client,
        `SELECT t.status, r.user_id AS reviewer_user_id, t.study_id FROM peer_review_tasks t
           LEFT JOIN radiologists r ON r.id = t.reviewer_id WHERE t.id = $1 FOR UPDATE OF t`,
        [taskId],
      );
      if (!t) throw new NotFound();
      if (t.status !== 'open') throw new Conflict('This review is not open');
      if (!t.reviewer_user_id || t.reviewer_user_id !== userId) throw new Conflict('Only the assigned reviewer can record this review');
      await client.query(
        `UPDATE peer_review_tasks SET status = 'completed', outcome = $2, comment = $3, completed_at = now(), completed_by = $4 WHERE id = $1`,
        [taskId, parsed.data.outcome, parsed.data.comment ?? null, userId],
      );
      await audit(client, { actorType: 'user', actorId: userId, action: 'peer_review.completed', entityType: 'peer_review_task', entityId: taskId, detail: { outcome: parsed.data.outcome, studyId: t.study_id }, ip });
      return { ok: true };
    });
  }
}
