import type { Pool } from 'pg';
import { audit } from '../audit/audit';
import type { AppConfig } from '../config';
import { many, one, withTransaction } from '../database/db';
import { allocate, lockStudy } from '../processing/allocator';
import { cancelStudy, withdrawAssignment } from '../processing/processor';

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
             AND heartbeat_at > now() - make_interval(secs => $1)) AS radiologists_ready,
         (SELECT count(*)::int FROM studies WHERE state = 'awaiting_vetting') AS awaiting_vetting,
         (SELECT count(*)::int FROM studies WHERE state IN ('assigned', 'preliminary')) AS reporting,
         (SELECT count(*)::int FROM studies WHERE state = 'finalized' AND finalized_at > now() - interval '24 hours') AS finalized_24h,
         (SELECT count(*)::int FROM escalations WHERE resolved_at IS NULL) AS escalations_open,
         (SELECT count(*)::int FROM escalations WHERE resolved_at IS NULL AND acknowledged_at IS NULL) AS escalations_unacknowledged,
         (SELECT count(*)::int FROM tat_clocks WHERE state = 'breached') AS tat_overdue,
         (SELECT count(*)::int FROM tat_clocks WHERE state = 'warning') AS tat_at_risk,
         (SELECT count(*)::int FROM tat_clocks WHERE state IN ('met', 'met_late') AND stopped_at > now() - interval '24 hours') AS tat_closed_24h,
         (SELECT count(*)::int FROM tat_clocks WHERE state = 'met_late' AND stopped_at > now() - interval '24 hours') AS tat_late_24h,
         (SELECT count(*)::int FROM peer_review_tasks WHERE status = 'open') AS reviews_open`,
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
              r.full_name AS radiologist_name, a.team_code, a.status AS assignment_status,
              tat.state AS tat_state, tat.due_at AS tat_due_at, tat.interval_code AS tat_interval
         FROM studies s
         JOIN hospitals h ON h.id = s.hospital_id
         JOIN patients p ON p.id = s.patient_id
         -- the radiologist who has the study now, or who reported it; not one who declined or was replaced
         LEFT JOIN LATERAL (SELECT * FROM assignments x WHERE x.study_id = s.id
                             AND x.status IN ('reserved', 'sent', 'delivered', 'accepted', 'completed')
                             ORDER BY x.version DESC LIMIT 1) a ON true
         LEFT JOIN radiologists r ON r.id = a.radiologist_id
         -- the most urgent open clock: overdue, then at risk, then soonest due
         LEFT JOIN LATERAL (SELECT c.state, c.due_at, c.interval_code FROM tat_clocks c
                             WHERE c.study_id = s.id AND c.stopped_at IS NULL
                             ORDER BY CASE c.state WHEN 'breached' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, c.due_at LIMIT 1) tat ON true
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
    const [events, evaluations, assignments, outbound, intake, clocks, escalations, review] = await Promise.all([
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
      many(
        this.pool,
        `SELECT interval_code, rule_set_version, target_minutes, started_at, warn_at, due_at, stopped_at, state
           FROM tat_clocks WHERE study_id = $1 ORDER BY started_at, interval_code`,
        [id],
      ),
      many(
        this.pool,
        `SELECT e.id, e.kind, e.reason_code, e.raised_at, e.acknowledged_at, u.full_name AS acknowledged_by_name, e.resolved_at, e.resolution
           FROM escalations e LEFT JOIN users u ON u.id = e.acknowledged_by WHERE e.study_id = $1 ORDER BY e.raised_at`,
        [id],
      ),
      one(
        this.pool,
        `SELECT t.id, t.status, t.skip_reason, t.outcome, t.comment, t.created_at, t.completed_at, rev.full_name AS reviewer_name
           FROM peer_review_tasks t LEFT JOIN radiologists rev ON rev.id = t.reviewer_id WHERE t.study_id = $1`,
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
      clocks,
      escalations,
      review,
    };
  }

  /** Raw HL7 is shown only with its own permission, and every view is audited. */
  async rawMessage(kind: 'intake' | 'outbound', id: string, userId: string, ip?: string): Promise<string> {
    // Every view is audited, including a request for a message whose payload has been archived.
    const row = await one<{ payload: string | null; archive_ref: string | null }>(
      this.pool,
      kind === 'intake'
        ? 'SELECT payload, archive_ref FROM intake_messages WHERE id = $1'
        : 'SELECT payload, NULL::text AS archive_ref FROM outbound_messages WHERE id = $1',
      [id],
    );
    if (!row) throw new NotFound();
    await audit(this.pool, { actorType: 'user', actorId: userId, action: 'hl7.raw_viewed', entityType: `${kind}_message`, entityId: id, ip });
    if (row.payload === null) return `(Archived in ${row.archive_ref}. Ask an integration engineer to retrieve it from the archive.)`;
    return row.payload;
  }

  /** Runs allocation again for a study waiting for a coordinator, for example once a radiologist is ready. */
  async reallocate(id: string, userId: string, ip?: string) {
    return withTransaction(this.pool, async (client) => {
      const study = await lockStudy(client, id).catch(() => null);
      if (!study) throw new NotFound();
      if (study.state !== 'manual_review' && study.state !== 'ready') throw new Conflict('Only a study waiting for a coordinator can be re-routed');
      const active = await one(client, `SELECT 1 FROM assignments WHERE study_id = $1 AND status IN ('reserved','sent','delivered','accepted')`, [id]);
      if (active) throw new Conflict('This study still has an active assignment');
      const result = await allocate(client, study, this.config);
      await audit(client, { actorType: 'user', actorId: userId, action: 'study.reallocated', entityType: 'study', entityId: id, detail: { ...result }, ip });
      return result;
    });
  }

  /**
   * Takes a study back from its radiologist before a report exists and routes it again, never to the
   * same person. The destination is told if it may already have the assignment.
   */
  async reassign(id: string, reason: string, userId: string, ip?: string) {
    if (!reason?.trim()) throw new Conflict('A reason is required');
    return withTransaction(this.pool, async (client) => {
      const s = await one<{ issuer: string; accession: string }>(client, 'SELECT issuer, accession FROM studies WHERE id = $1', [id]);
      if (!s) throw new NotFound();
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 7))', [`${s.issuer}|${s.accession}`]);
      const study = await lockStudy(client, id);
      if (!['reserved', 'awaiting_acceptance', 'assigned'].includes(study.state)) {
        throw new Conflict('Only a study that is assigned but not yet reported can be reassigned');
      }
      const assignmentId = await withdrawAssignment(client, study, 'released', 'COORDINATOR_REASSIGNED');
      await client.query(`UPDATE studies SET state = 'ready', state_reason = NULL, version = version + 1, updated_at = now() WHERE id = $1`, [id]);
      await client.query(`INSERT INTO study_events (study_id, kind, detail, actor_id) VALUES ($1, 'reassigned', $2, $3)`, [
        id,
        JSON.stringify({ reason: reason.slice(0, 500), assignmentId }),
        userId,
      ]);
      const result = await allocate(client, await lockStudy(client, id), this.config);
      await audit(client, { actorType: 'user', actorId: userId, action: 'study.reassigned', entityType: 'study', entityId: id, detail: { reason: reason.slice(0, 500), assignmentId, outcome: result.outcome }, ip });
      return result;
    });
  }

  async cancel(id: string, reason: string, userId: string, ip?: string) {
    if (!reason?.trim()) throw new Conflict('A reason is required');
    return withTransaction(this.pool, async (client) => {
      const s = await one<{ state: string }>(client, 'SELECT state FROM studies WHERE id = $1 FOR UPDATE', [id]);
      if (!s) throw new NotFound();
      if (s.state === 'cancelled') throw new Conflict('The study is already cancelled');
      if (s.state === 'finalized' || s.state === 'vetting_rejected') throw new Conflict('A finished study cannot be cancelled');
      await cancelStudy(client, id, null, 'COORDINATOR_CANCELLED');
      await audit(client, { actorType: 'user', actorId: userId, action: 'study.cancelled', entityType: 'study', entityId: id, detail: { reason: reason.slice(0, 500) }, ip });
      return { ok: true };
    });
  }
}
