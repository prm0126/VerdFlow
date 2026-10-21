import { ruleSetDefinitionSchema, TAT_INTERVALS, type TatEvent, type TatIntervalCode } from '@vf/shared';
import type { PoolClient } from 'pg';
import { many, one } from '../database/db';

const MILESTONE_COLUMN: Partial<Record<TatEvent, string>> = {
  ready: 'ready_at',
  delivered: 'delivered_at',
  accepted: 'accepted_at',
  preliminary: 'preliminary_at',
  final: 'finalized_at',
};

/**
 * Records a workflow event for a study, inside the caller's transaction (which holds the study lock).
 * Stops the clocks that end at this event and starts the clocks that begin at it. A clock copies its
 * target from the published rule set when it starts, so later rule changes do not move it.
 * Recording the same event twice is a no-op.
 */
export async function recordMilestone(client: PoolClient, studyId: string, event: TatEvent): Promise<void> {
  const column = MILESTONE_COLUMN[event];
  if (column) {
    const first = await one(client, `UPDATE studies SET ${column} = now() WHERE id = $1 AND ${column} IS NULL RETURNING 1`, [studyId]);
    if (!first) return;
  }

  // Stop clocks ending here.
  const ending = (Object.keys(TAT_INTERVALS) as TatIntervalCode[]).filter((c) => TAT_INTERVALS[c].to === event);
  if (ending.length) {
    const stopped = await many<{ interval_code: string; state: string }>(
      client,
      `UPDATE tat_clocks SET stopped_at = now(),
              state = CASE WHEN state = 'breached' THEN 'met_late' ELSE 'met' END
        WHERE study_id = $1 AND interval_code = ANY($2) AND state IN ('running', 'warning', 'breached') AND stopped_at IS NULL
        RETURNING interval_code, state`,
      [studyId, ending],
    );
    for (const c of stopped) {
      await client.query(
        `UPDATE escalations SET resolved_at = now(), resolution = $3
          WHERE study_id = $1 AND kind IN ('tat_warning', 'tat_breach') AND reason_code = $2 AND resolved_at IS NULL`,
        [studyId, c.interval_code, c.state === 'met_late' ? 'Completed after the target' : 'Completed within the target'],
      );
    }
  }

  // Start clocks beginning here.
  const starting = (Object.keys(TAT_INTERVALS) as TatIntervalCode[]).filter((c) => TAT_INTERVALS[c].from === event);
  if (!starting.length) return;
  const rs = await one<{ version: number; definition: unknown; priority: string }>(
    client,
    `SELECT rs.version, rs.definition, s.priority FROM rule_sets rs, studies s WHERE rs.status = 'published' AND s.id = $1`,
    [studyId],
  );
  if (!rs) return;
  const def = ruleSetDefinitionSchema.parse(rs.definition);
  const profile = def.tat.profiles.find((p) => p.priority === rs.priority);
  for (const i of profile?.intervals ?? []) {
    if (!starting.includes(i.code)) continue;
    const warnMinutes = Math.max(1, Math.floor((i.minutes * def.tat.warnAtPercent) / 100));
    await client.query(
      `INSERT INTO tat_clocks (study_id, interval_code, rule_set_version, target_minutes, started_at, warn_at, due_at)
       VALUES ($1, $2, $3, $4, now(), now() + make_interval(mins => $5), now() + make_interval(mins => $4))
       ON CONFLICT (study_id, interval_code) DO NOTHING`,
      [studyId, i.code, rs.version, i.minutes, warnMinutes],
    );
  }
}

/** Stops every open clock, for a cancelled or rejected study, and closes its escalations. */
export async function cancelClocks(client: PoolClient, studyId: string, resolution: string): Promise<void> {
  await client.query(
    `UPDATE tat_clocks SET state = 'cancelled', stopped_at = now() WHERE study_id = $1 AND stopped_at IS NULL`,
    [studyId],
  );
  await client.query(`UPDATE escalations SET resolved_at = now(), resolution = $2 WHERE study_id = $1 AND resolved_at IS NULL`, [
    studyId,
    resolution,
  ]);
}
