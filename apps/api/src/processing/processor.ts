import { Hl7ParseError, parseHl7, toCanonicalOrder, type CanonicalOrder } from '@vf/shared';
import type { Pool, PoolClient } from 'pg';
import type { AppConfig } from '../config';
import { isTransientDbError, one, withTransaction } from '../database/db';
import { allocate, enqueueOutbound, lockStudy } from './allocator';
import { releaseCapacity } from '../availability/capacity';

/** Raised when a message cannot be processed yet (for example a cancel before its order) and should be retried. */
export class RetryLater extends Error {
  constructor(readonly reasonCode: string) {
    super(reasonCode);
  }
}

/** Raised for a permanent problem: the message goes to quarantine with this reason. */
export class Quarantine extends Error {
  constructor(
    readonly reasonCode: string,
    message: string,
  ) {
    super(message);
  }
}

interface IntakeRow {
  id: string;
  payload: string;
  attempts: number;
}

export type ProcessResult = { id: string; status: 'processed' | 'ignored' | 'quarantined' | 'retry'; reasonCode?: string; studyId?: string };

const MAX_PROCESS_ATTEMPTS = 6;

export class Processor {
  constructor(
    private readonly pool: Pool,
    private readonly config: AppConfig,
  ) {}

  /** Processes the next due intake message, if any. Messages for the same study are taken in arrival order. */
  async processNext(): Promise<ProcessResult | null> {
    let claimed: IntakeRow | null = null;
    try {
      return await withTransaction(this.pool, async (client) => {
        claimed = await one<IntakeRow>(
          client,
          `SELECT m.id, m.payload, m.attempts FROM intake_messages m
            WHERE m.status = 'received' AND m.next_attempt_at <= now()
              AND (m.ordering_key IS NULL OR NOT EXISTS (
                    SELECT 1 FROM intake_messages p
                     WHERE p.status = 'received' AND p.ordering_key = m.ordering_key
                       AND (p.received_at, p.id) < (m.received_at, m.id)))
            ORDER BY m.received_at, m.id
            LIMIT 1
            FOR UPDATE SKIP LOCKED`,
        );
        if (!claimed) return null;
        // Savepoint so a permanent failure can roll back partial work but still record the quarantine.
        await client.query('SAVEPOINT handle');
        try {
          const { status, reasonCode, studyId } = await this.handle(client, claimed);
          await client.query(
            `UPDATE intake_messages SET status = $2, reason_code = $3, study_id = $4, processed_at = now(), attempts = attempts + 1
              WHERE id = $1`,
            [claimed.id, status, reasonCode ?? null, studyId ?? null],
          );
          return { id: claimed.id, status, reasonCode, studyId };
        } catch (err) {
          if (!(err instanceof Quarantine)) throw err;
          await client.query('ROLLBACK TO SAVEPOINT handle');
          await client.query(
            `UPDATE intake_messages SET status = 'quarantined', reason_code = $2, error = $3, processed_at = now(), attempts = attempts + 1
              WHERE id = $1`,
            [claimed.id, err.reasonCode, err.message.slice(0, 500)],
          );
          return { id: claimed.id, status: 'quarantined' as const, reasonCode: err.reasonCode };
        }
      });
    } catch (err) {
      const row = claimed as IntakeRow | null;
      if (!row) throw err;
      const retryable = err instanceof RetryLater || isTransientDbError(err);
      const reasonCode = err instanceof RetryLater ? err.reasonCode : retryable ? 'TRANSIENT_DB_ERROR' : 'PROCESSING_ERROR';
      const giveUp = !retryable || row.attempts + 1 >= MAX_PROCESS_ATTEMPTS;
      await this.pool.query(
        giveUp
          ? `UPDATE intake_messages SET status = 'quarantined', reason_code = $2, error = $3, attempts = attempts + 1, processed_at = now() WHERE id = $1`
          : `UPDATE intake_messages SET reason_code = $2, error = $3, attempts = attempts + 1,
                    next_attempt_at = now() + make_interval(secs => $4) WHERE id = $1`,
        giveUp
          ? [row.id, reasonCode, String((err as Error).message).slice(0, 500)]
          : [row.id, reasonCode, String((err as Error).message).slice(0, 500), backoffSeconds(row.attempts)],
      );
      return { id: row.id, status: giveUp ? 'quarantined' : 'retry', reasonCode };
    }
  }

  private async handle(client: PoolClient, m: IntakeRow): Promise<Omit<ProcessResult, 'id'>> {
    let order: CanonicalOrder;
    try {
      order = toCanonicalOrder(parseHl7(m.payload));
    } catch (err) {
      if (err instanceof Hl7ParseError) throw new Quarantine(err.code, err.message);
      throw err;
    }

    const hospital = await one<{ id: string }>(client, 'SELECT id FROM hospitals WHERE code = $1 AND active', [order.sendingFacility]);
    if (!hospital) throw new Quarantine('UNKNOWN_HOSPITAL', `No active hospital has code ${order.sendingFacility}`);
    const modality = await one(client, 'SELECT 1 FROM modalities WHERE code = $1 AND active', [order.modality]);
    if (!modality) throw new Quarantine('UNKNOWN_MODALITY', `Modality ${order.modality} is not in the modality master`);

    const issuer = order.sendingFacility;
    // Serialise work on one study across workers, even before the study row exists.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 7))', [`${issuer}|${order.accession}`]);
    const existing = await one<{ id: string; state: string }>(
      client,
      'SELECT id, state FROM studies WHERE issuer = $1 AND accession = $2 FOR UPDATE',
      [issuer, order.accession],
    );

    if (order.orderControl === 'NW') {
      if (existing) {
        // Same business order under a new message ID: never a second assignment.
        await event(client, existing.id, m.id, 'duplicate_order', {});
        return { status: 'ignored', reasonCode: 'DUPLICATE_ORDER', studyId: existing.id };
      }
      const patient = await one<{ id: string }>(
        client,
        `INSERT INTO patients (authority, identifier, display_name) VALUES ($1, $2, $3)
         ON CONFLICT (authority, identifier) DO UPDATE SET display_name = coalesce(EXCLUDED.display_name, patients.display_name)
         RETURNING id`,
        [order.patientAuthority, order.patientId, order.patientName ?? null],
      );
      const study = await one<{ id: string }>(
        client,
        `INSERT INTO studies (hospital_id, issuer, accession, placer_order, patient_id, encounter_number, modality_code,
                              service_code, service_text, priority, location, room, state)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'ready') RETURNING id`,
        [
          hospital.id,
          issuer,
          order.accession,
          order.placerOrder ?? null,
          patient!.id,
          order.encounterNumber ?? null,
          order.modality,
          order.serviceCode,
          order.serviceText ?? null,
          order.priority,
          order.location ?? null,
          order.room ?? null,
        ],
      );
      await event(client, study!.id, m.id, 'order_received', { priority: order.priority });
      const row = await lockStudy(client, study!.id);
      const result = await allocate(client, row, this.config);
      return { status: 'processed', reasonCode: result.reasonCode, studyId: study!.id };
    }

    if (!existing) throw new RetryLater(order.orderControl === 'CA' ? 'CANCEL_FOR_UNKNOWN_STUDY' : 'UPDATE_FOR_UNKNOWN_STUDY');
    if (existing.state === 'cancelled') {
      await event(client, existing.id, m.id, 'stale_message', { orderControl: order.orderControl });
      return { status: 'ignored', reasonCode: 'STUDY_ALREADY_CANCELLED', studyId: existing.id };
    }

    if (order.orderControl === 'XO') {
      await client.query(
        `UPDATE studies SET priority = $2, location = $3, room = $4, service_code = $5, service_text = $6,
                            version = version + 1, updated_at = now() WHERE id = $1`,
        [existing.id, order.priority, order.location ?? null, order.room ?? null, order.serviceCode, order.serviceText ?? null],
      );
      await event(client, existing.id, m.id, 'order_updated', { priority: order.priority });
      return { status: 'processed', reasonCode: 'ORDER_UPDATED', studyId: existing.id };
    }

    await cancelStudy(client, existing.id, m.id, 'SOURCE_CANCELLED');
    return { status: 'processed', reasonCode: 'ORDER_CANCELLED', studyId: existing.id };
  }
}

/**
 * Cancels a study and its active assignment. An unsent assignment is withdrawn; one that may already
 * have reached the destination gets a cancellation message, never a silent release.
 */
export async function cancelStudy(client: PoolClient, studyId: string, intakeMessageId: string | null, reason: string): Promise<void> {
  const study = await lockStudy(client, studyId);
  const active = await one<{ id: string; radiologist_id: string; version: number; work_units: number; team_code: string }>(
    client,
    `SELECT id, radiologist_id, version, work_units, team_code FROM assignments
      WHERE study_id = $1 AND purpose = 'primary' AND status IN ('reserved', 'sent', 'delivered') FOR UPDATE`,
    [studyId],
  );
  if (active) {
    const out = await one<{ id: string; status: string; possibly_delivered: boolean; partner_id: string }>(
      client,
      `SELECT id, status, possibly_delivered, partner_id FROM outbound_messages
        WHERE assignment_id = $1 AND kind = 'assignment' FOR UPDATE`,
      [active.id],
    );
    await client.query(`UPDATE assignments SET status = 'cancelled', ended_at = now(), end_reason = $2 WHERE id = $1`, [active.id, reason]);
    await releaseCapacity(client, active.radiologist_id, active.work_units);
    const unsent = out && !out.possibly_delivered && (out.status === 'pending' || out.status === 'retry');
    if (out && unsent) {
      await client.query(`UPDATE outbound_messages SET status = 'cancelled', completed_at = now() WHERE id = $1`, [out.id]);
    } else if (out) {
      const radiologist = await one<{ code: string; external_id: string; full_name: string }>(
        client,
        'SELECT code, external_id, full_name FROM radiologists WHERE id = $1',
        [active.radiologist_id],
      );
      const dest = await one<{ receiving_application: string | null; receiving_facility: string | null }>(
        client,
        'SELECT receiving_application, receiving_facility FROM integration_partners WHERE id = $1',
        [out.partner_id],
      );
      const rs = await one<{ rule_set_version: number | null }>(
        client,
        'SELECT e.rule_set_version FROM assignments a JOIN evaluations e ON e.id = a.evaluation_id WHERE a.id = $1',
        [active.id],
      );
      await enqueueOutbound(client, {
        kind: 'cancellation',
        partnerId: out.partner_id,
        receivingApplication: dest?.receiving_application ?? '',
        receivingFacility: dest?.receiving_facility ?? '',
        study,
        assignmentId: active.id,
        assignmentVersion: active.version,
        radiologist: radiologist!,
        teamCode: active.team_code,
        ruleSetVersion: rs?.rule_set_version ?? 0,
      });
    }
  }
  await client.query(
    `UPDATE studies SET state = 'cancelled', state_reason = $2, version = version + 1, updated_at = now() WHERE id = $1`,
    [studyId, reason],
  );
  await event(client, studyId, intakeMessageId, 'cancelled', { reason, assignmentId: active?.id ?? null });
}

async function event(client: PoolClient, studyId: string, intakeMessageId: string | null, kind: string, detail: Record<string, unknown>) {
  await client.query('INSERT INTO study_events (study_id, intake_message_id, kind, detail) VALUES ($1, $2, $3, $4)', [
    studyId,
    intakeMessageId,
    kind,
    JSON.stringify(detail),
  ]);
}

export function backoffSeconds(attempt: number): number {
  const base = Math.min(300, 2 ** attempt * 2);
  return Math.round(base * (0.75 + Math.random() * 0.5));
}
