import type { Pool } from 'pg';
import { audit } from '../audit/audit';
import { many, one, withTransaction } from '../database/db';
import { NotFound } from '../studies/studies.service';

/**
 * Turnaround timers and escalations. Stand-in for Temporal workflows: every tick is idempotent, so
 * several workers can run it and a missed tick only delays, never loses, a warning.
 */
export class TimerWorker {
  constructor(private readonly pool: Pool) {}

  async tick(): Promise<{ warned: number; breached: number; raised: number; resolved: number }> {
    const warned = await many<{ study_id: string; interval_code: string; due_at: string }>(
      this.pool,
      `UPDATE tat_clocks SET state = 'warning', warned_at = now()
        WHERE state = 'running' AND warn_at <= now() AND due_at > now()
        RETURNING study_id, interval_code, due_at`,
    );
    for (const c of warned) await this.raise(c.study_id, 'tat_warning', c.interval_code, { dueAt: c.due_at });

    const breached = await many<{ study_id: string; interval_code: string; due_at: string; target_minutes: number }>(
      this.pool,
      `UPDATE tat_clocks SET state = 'breached', breached_at = now()
        WHERE state IN ('running', 'warning') AND due_at <= now()
        RETURNING study_id, interval_code, due_at, target_minutes`,
    );
    for (const c of breached) {
      await this.pool.query(
        `UPDATE escalations SET resolved_at = now(), resolution = 'Became overdue'
          WHERE study_id = $1 AND kind = 'tat_warning' AND reason_code = $2 AND resolved_at IS NULL`,
        [c.study_id, c.interval_code],
      );
      await this.raise(c.study_id, 'tat_breach', c.interval_code, { dueAt: c.due_at, targetMinutes: c.target_minutes });
    }

    // Every study waiting for a coordinator has an open escalation, and none outlives the wait.
    const raised = await this.pool.query(
      `INSERT INTO escalations (study_id, kind, reason_code)
       SELECT s.id, 'manual_review', coalesce(s.state_reason, 'MANUAL_REVIEW') FROM studies s
        WHERE s.state = 'manual_review'
          AND NOT EXISTS (SELECT 1 FROM escalations e WHERE e.study_id = s.id AND e.kind = 'manual_review' AND e.resolved_at IS NULL
                            AND e.reason_code = coalesce(s.state_reason, 'MANUAL_REVIEW'))
       ON CONFLICT DO NOTHING`,
    );
    const resolved = await this.pool.query(
      `UPDATE escalations e SET resolved_at = now(), resolution = 'Study moved on'
         FROM studies s
        WHERE e.study_id = s.id AND e.kind = 'manual_review' AND e.resolved_at IS NULL
          AND (s.state <> 'manual_review' OR coalesce(s.state_reason, 'MANUAL_REVIEW') <> e.reason_code)`,
    );
    return { warned: warned.length, breached: breached.length, raised: raised.rowCount ?? 0, resolved: resolved.rowCount ?? 0 };
  }

  private async raise(studyId: string, kind: 'tat_warning' | 'tat_breach', reason: string, detail: Record<string, unknown>) {
    await withTransaction(this.pool, async (client) => {
      const r = await one(
        client,
        `INSERT INTO escalations (study_id, kind, reason_code, detail) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING id`,
        [studyId, kind, reason, JSON.stringify(detail)],
      );
      if (r) {
        await client.query(`INSERT INTO study_events (study_id, kind, detail) VALUES ($1, $2, $3)`, [studyId, kind, JSON.stringify({ interval: reason, ...detail })]);
      }
    });
  }
}

export class EscalationsService {
  constructor(private readonly pool: Pool) {}

  list(includeResolved = false) {
    return many(
      this.pool,
      `SELECT e.id, e.study_id, s.accession, s.priority, s.state, e.kind, e.reason_code, e.detail, e.raised_at,
              e.acknowledged_at, u.full_name AS acknowledged_by_name, e.resolved_at, e.resolution
         FROM escalations e JOIN studies s ON s.id = e.study_id LEFT JOIN users u ON u.id = e.acknowledged_by
        WHERE ($1 OR e.resolved_at IS NULL)
        ORDER BY (e.resolved_at IS NULL) DESC, CASE e.kind WHEN 'tat_breach' THEN 0 WHEN 'manual_review' THEN 1 ELSE 2 END, e.raised_at
        LIMIT 300`,
      [includeResolved],
    );
  }

  async acknowledge(id: string, userId: string, ip?: string) {
    return withTransaction(this.pool, async (client) => {
      const r = await one<{ study_id: string }>(
        client,
        `UPDATE escalations SET acknowledged_at = now(), acknowledged_by = $2 WHERE id = $1 AND acknowledged_at IS NULL RETURNING study_id`,
        [id, userId],
      );
      if (!r) throw new NotFound();
      await audit(client, { actorType: 'user', actorId: userId, action: 'escalation.acknowledged', entityType: 'escalation', entityId: id, detail: { studyId: r.study_id }, ip });
      return { ok: true };
    });
  }
}
