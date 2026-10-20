import type { Pool } from 'pg';
import { audit } from '../audit/audit';
import type { AppConfig } from '../config';
import { many, one, withTransaction } from '../database/db';
import { allocate, lockStudy } from '../processing/allocator';
import { cancelStudy } from '../processing/processor';

export class NotFound extends Error {}
export class Conflict extends Error {}

/** Masks a patient name to initials unless the viewer may see patient details. */
function mask(name: string | null, canSee: boolean): string | null {
  if (!name || canSee) return name;
  return name
    .split(/\s+/)
    .map((p) => (p ? `${p[0]}.` : ''))
    .join(' ');
}

export class StudiesService {
  constructor(
    private readonly pool: Pool,
    private readonly config: AppConfig,
  ) {}

  async dashboard() {
    const counts = await one<Record<string, number>>(
      this.pool,
      `SELECT
         (SELECT count(*)::int FROM intake_messages WHERE received_at > now() - interval '1 hour') AS intake_last_hour,
         (SELECT count(*)::int FROM intake_messages WHERE status = 'received') AS intake_backlog,
         (SELECT coalesce(extract(epoch FROM now() - min(received_at))::int, 0) FROM intake_messages WHERE status = 'received') AS oldest_backlog_seconds,
         (SELECT count(*)::int FROM intake_messages WHERE status = 'quarantined') AS quarantined,
         (SELECT count(*)::int FROM intake_collisions WHERE resolved_at IS NULL) AS collisions,
         (SELECT count(*)::int FROM studies WHERE state = 'manual_review') AS manual_review,
         (SELECT count(*)::int FROM studies WHERE state = 'reserved') AS reserved,
         (SELECT count(*)::int FROM studies WHERE state = 'awaiting_acceptance') AS awaiting_acceptance,
         (SELECT count(*)::int FROM studies WHERE created_at > now() - interval '24 hours') AS studies_24h,
         (SELECT count(*)::int FROM outbound_messages WHERE status IN ('pending', 'retry', 'sending')) AS outbound_pending,
         (SELECT count(*)::int FROM outbound_messages WHERE status = 'unknown') AS outbound_uncertain,
         (SELECT count(*)::int FROM outbound_messages WHERE status IN ('failed', 'rejected')) AS outbound_failed,
         (SELECT count(*)::int FROM radiologist_state WHERE status = 'ready'
             AND heartbeat_at > now() - make_interval(secs => $1)) AS radiologists_ready`,
      [this.config.presenceStaleSeconds],
    );
    const continuity = await one<{ preserved: number; broken: number }>(
      this.pool,
      `SELECT count(*) FILTER (WHERE (continuity->>'preserved')::boolean)::int AS preserved,
              count(*) FILTER (WHERE (continuity->>'preserved')::boolean = false)::int AS broken
         FROM evaluations WHERE created_at > now() - interval '24 hours'`,
    );
    const reasons = await many<{ reason_code: string; n: number }>(
      this.pool,
      `SELECT state_reason AS reason_code, count(*)::int AS n FROM studies
        WHERE state = 'manual_review' GROUP BY state_reason ORDER BY n DESC`,
    );
    return { ...counts, continuity, manualReviewReasons: reasons };
  }

  async list(params: { state?: string; q?: string; limit?: number }, canSeePhi: boolean) {
    const rows = await many<{ patient_name: string | null } & Record<string, unknown>>(
      this.pool,
      `SELECT s.id, s.accession, h.code AS hospital_code, s.modality_code, s.service_code, s.service_text, s.priority, s.state,
              s.state_reason, s.created_at, s.updated_at, p.display_name AS patient_name,
              r.full_name AS radiologist_name, a.team_code, a.status AS assignment_status
         FROM studies s
         JOIN hospitals h ON h.id = s.hospital_id
         JOIN patients p ON p.id = s.patient_id
         LEFT JOIN LATERAL (SELECT * FROM assignments x WHERE x.study_id = s.id ORDER BY x.version DESC LIMIT 1) a ON true
         LEFT JOIN radiologists r ON r.id = a.radiologist_id
        WHERE ($1::text IS NULL OR s.state = $1)
          AND ($2::text IS NULL OR s.accession ILIKE '%' || $2 || '%')
        ORDER BY s.created_at DESC
        LIMIT $3`,
      [params.state || null, params.q?.slice(0, 60) || null, Math.min(Math.max(params.limit ?? 100, 1), 500)],
    );
    return rows.map((r) => ({ ...r, patient_name: mask(r.patient_name, canSeePhi) }));
  }

  async detail(id: string, canSeePhi: boolean) {
    const study = await one<Record<string, unknown> & { patient_name: string | null; patient_identifier: string }>(
      this.pool,
      `SELECT s.*, h.code AS hospital_code, h.name AS hospital_name, p.display_name AS patient_name,
              p.identifier AS patient_identifier, p.authority AS patient_authority
         FROM studies s JOIN hospitals h ON h.id = s.hospital_id JOIN patients p ON p.id = s.patient_id
        WHERE s.id = $1`,
      [id],
    );
    if (!study) throw new NotFound();
    const [events, evaluations, assignments, outbound, intake] = await Promise.all([
      many(this.pool, `SELECT id, kind, detail, created_at FROM study_events WHERE study_id = $1 ORDER BY id`, [id]),
      many(
        this.pool,
        `SELECT e.id, e.rule_set_version, e.facts, e.routing, e.candidates, e.continuity, e.outcome, e.reason_code,
                e.created_at, r.full_name AS selected_name
           FROM evaluations e LEFT JOIN radiologists r ON r.id = e.selected_radiologist_id
          WHERE e.study_id = $1 ORDER BY e.created_at`,
        [id],
      ),
      many(
        this.pool,
        `SELECT a.id, a.version, a.status, a.team_code, a.work_units, a.created_at, a.ended_at, a.end_reason, r.full_name AS radiologist_name, r.code AS radiologist_code
           FROM assignments a JOIN radiologists r ON r.id = a.radiologist_id WHERE a.study_id = $1 ORDER BY a.version`,
        [id],
      ),
      many(
        this.pool,
        `SELECT o.id, o.kind, o.control_id, o.status, o.attempts, o.possibly_delivered, o.ack_code, o.ack_text, o.last_error,
                o.created_at, o.completed_at, p.code AS partner_code,
                (SELECT coalesce(json_agg(d ORDER BY d.attempt), '[]') FROM
                   (SELECT attempt, started_at, finished_at, outcome, http_status, ack_code, error FROM delivery_attempts
                     WHERE outbound_message_id = o.id) d) AS attempts_detail
           FROM outbound_messages o JOIN integration_partners p ON p.id = o.partner_id
          WHERE o.study_id = $1 ORDER BY o.created_at`,
        [id],
      ),
      many(
        this.pool,
        `SELECT DISTINCT m.id, m.control_id, m.message_type, m.status, m.reason_code, m.received_at
           FROM intake_messages m
          WHERE m.study_id = $1 OR m.id IN (SELECT intake_message_id FROM study_events WHERE study_id = $1 AND intake_message_id IS NOT NULL)
          ORDER BY m.received_at`,
        [id],
      ),
    ]);
    return {
      ...study,
      patient_name: mask(study.patient_name, canSeePhi),
      patient_identifier: canSeePhi ? study.patient_identifier : '••••' + String(study.patient_identifier).slice(-2),
      events,
      evaluations,
      assignments,
      outbound,
      intake,
    };
  }

  /** Raw HL7 is shown only with its own permission, and every view is audited. */
  async rawMessage(kind: 'intake' | 'outbound', id: string, userId: string, ip?: string): Promise<string> {
    const row = await one<{ payload: string }>(
      this.pool,
      kind === 'intake' ? 'SELECT payload FROM intake_messages WHERE id = $1' : 'SELECT payload FROM outbound_messages WHERE id = $1',
      [id],
    );
    if (!row) throw new NotFound();
    await audit(this.pool, { actorType: 'user', actorId: userId, action: 'hl7.raw_viewed', entityType: `${kind}_message`, entityId: id, ip });
    return row.payload;
  }

  /** Runs allocation again for a study waiting for a coordinator, for example once a radiologist is ready. */
  async reallocate(id: string, userId: string, ip?: string) {
    return withTransaction(this.pool, async (client) => {
      const study = await lockStudy(client, id).catch(() => null);
      if (!study) throw new NotFound();
      if (study.state !== 'manual_review' && study.state !== 'ready') throw new Conflict('Only a study waiting for a coordinator can be re-routed');
      const active = await one(client, `SELECT 1 FROM assignments WHERE study_id = $1 AND status IN ('reserved','sent','delivered')`, [id]);
      if (active) throw new Conflict('This study still has an active assignment');
      const result = await allocate(client, study, this.config);
      await audit(client, { actorType: 'user', actorId: userId, action: 'study.reallocated', entityType: 'study', entityId: id, detail: { ...result }, ip });
      return result;
    });
  }

  async cancel(id: string, reason: string, userId: string, ip?: string) {
    if (!reason?.trim()) throw new Conflict('A reason is required');
    return withTransaction(this.pool, async (client) => {
      const s = await one<{ state: string }>(client, 'SELECT state FROM studies WHERE id = $1 FOR UPDATE', [id]);
      if (!s) throw new NotFound();
      if (s.state === 'cancelled') throw new Conflict('The study is already cancelled');
      await cancelStudy(client, id, null, 'COORDINATOR_CANCELLED');
      await audit(client, { actorType: 'user', actorId: userId, action: 'study.cancelled', entityType: 'study', entityId: id, detail: { reason: reason.slice(0, 500) }, ip });
      return { ok: true };
    });
  }
}
