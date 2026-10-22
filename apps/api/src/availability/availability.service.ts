import { AVAILABILITY_STATES, type AvailabilityState } from '@vf/shared';
import type { Pool } from 'pg';
import { audit } from '../audit/audit';
import type { AppConfig } from '../config';
import { many, one, withTransaction } from '../database/db';
import { absenceNow, onShiftNow } from '../rota/rota.service';

export interface AvailabilityRow {
  radiologist_id: string;
  code: string;
  full_name: string;
  status: AvailabilityState;
  heartbeat_at: string | null;
  present: boolean;
  capacity_units: number;
  active_units: number;
  active_assignments: number;
  teams: string[];
  on_shift: boolean;
  absence: string | null;
  shift_ends_at: string | null;
  clocked_in_at: string | null;
  /** Why the radiologist cannot take new work now; empty when they can (capacity aside). */
  blockers: string[];
}

export class AvailabilityService {
  constructor(
    private readonly pool: Pool,
    private readonly config: AppConfig,
  ) {}

  async list(): Promise<AvailabilityRow[]> {
    const rows = await many<Omit<AvailabilityRow, 'blockers'>>(
      this.pool,
      `SELECT r.id AS radiologist_id, r.code, r.full_name, st.status, st.heartbeat_at,
              (st.heartbeat_at IS NOT NULL AND st.heartbeat_at > now() - make_interval(secs => $1)) AS present,
              ${onShiftNow('r.id')} AS on_shift, ${absenceNow('r.id')} AS absence,
              (SELECT max(sh.ends_at) FROM shifts sh WHERE sh.radiologist_id = r.id AND sh.starts_at <= now() AND sh.ends_at > now()) AS shift_ends_at,
              st.clocked_in_at,
              st.capacity_units, st.active_units,
              (SELECT count(*)::int FROM assignments a WHERE a.radiologist_id = r.id AND a.status IN ('reserved','sent','delivered','accepted')) AS active_assignments,
              coalesce((SELECT array_agg(t.code ORDER BY t.code) FROM team_members tm JOIN teams t ON t.id = tm.team_id
                         WHERE tm.radiologist_id = r.id AND tm.valid_from <= CURRENT_DATE
                           AND (tm.valid_to IS NULL OR tm.valid_to >= CURRENT_DATE)), '{}') AS teams
         FROM radiologists r JOIN radiologist_state st ON st.radiologist_id = r.id
        WHERE r.active
        ORDER BY r.full_name`,
      [this.config.presenceStaleSeconds],
    );
    return rows.map((r) => {
      const blockers: string[] = [];
      if (this.config.rotaRequired && !r.on_shift) blockers.push('Not on shift');
      if (r.absence) blockers.push(r.absence === 'break' ? 'On a break' : r.absence === 'leave' ? 'On leave' : r.absence === 'training' ? 'Training' : 'Absent');
      if (r.status !== 'ready') blockers.push(`Status is ${r.status.replace(/_/g, ' ')}`);
      else if (!r.present) blockers.push('No recent workstation heartbeat');
      return { ...r, blockers };
    });
  }

  /** A coordinator or the radiologist changes status. Locks the state row the allocation gate locks. */
  async setStatus(radiologistId: string, status: string, capacityUnits: number | undefined, actorId: string, ip?: string) {
    if (!(AVAILABILITY_STATES as readonly string[]).includes(status)) throw new Error('Unknown availability status');
    if (capacityUnits !== undefined && (!Number.isFinite(capacityUnits) || capacityUnits < 0 || capacityUnits > 1000)) {
      throw new Error('Capacity must be between 0 and 1000');
    }
    return withTransaction(this.pool, async (client) => {
      const before = await one<{ status: string; capacity_units: number }>(
        client,
        'SELECT status, capacity_units FROM radiologist_state WHERE radiologist_id = $1 FOR UPDATE',
        [radiologistId],
      );
      if (!before) return null;
      // Going offline ends the session, so the next clock-in starts afresh.
      await client.query(
        `UPDATE radiologist_state SET status = $2, capacity_units = coalesce($3, capacity_units),
                clocked_in_at = CASE WHEN $2 = 'offline' THEN NULL ELSE clocked_in_at END,
                version = version + 1, updated_at = now()
          WHERE radiologist_id = $1`,
        [radiologistId, status, capacityUnits ?? null],
      );
      await audit(client, {
        actorType: 'user',
        actorId,
        action: 'availability.changed',
        entityType: 'radiologist',
        entityId: radiologistId,
        detail: { from: before.status, to: status, capacityFrom: before.capacity_units, capacityTo: capacityUnits ?? before.capacity_units },
        ip,
      });
      return { radiologistId, status };
    });
  }

  /**
   * Presence heartbeats from the authoritative source (the reporting workstation, PACS or RIS), sent by an
   * inbound integration partner. Logging in to VerdFlow does not count as presence.
   */
  async heartbeat(radiologistCodes: string[]): Promise<{ updated: number }> {
    const codes = [...new Set(radiologistCodes)].slice(0, 1000);
    // The clock-in survives while presence is continuous, or when they clocked in by signing in and this
    // is their first heartbeat since. A gap longer than the presence window starts a new session.
    const r = await this.pool.query(
      `UPDATE radiologist_state st
          SET clocked_in_at = CASE WHEN st.clocked_in_at IS NOT NULL
                                    AND (st.heartbeat_at > now() - make_interval(secs => $2) OR st.heartbeat_at IS NULL OR st.heartbeat_at < st.clocked_in_at)
                                   THEN st.clocked_in_at ELSE now() END,
              heartbeat_at = now(), updated_at = now()
         FROM radiologists r WHERE r.id = st.radiologist_id AND r.code = ANY($1::text[]) AND r.active`,
      [codes, this.config.presenceStaleSeconds],
    );
    return { updated: r.rowCount ?? 0 };
  }
}
