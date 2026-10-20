import { readAck } from '@vf/shared';
import type { Pool, PoolClient } from 'pg';
import { releaseCapacity } from '../availability/capacity';
import type { AppConfig } from '../config';
import { one, withTransaction } from '../database/db';
import { absenceNow, onShiftNow } from '../rota/rota.service';
import { backoffSeconds } from '../processing/processor';

interface OutboundRow {
  id: string;
  study_id: string;
  assignment_id: string;
  kind: 'assignment' | 'cancellation';
  control_id: string;
  payload: string;
  attempts: number;
  possibly_delivered: boolean;
  created_at: Date;
  endpoint_url: string;
  timeout_ms: number;
}

export type Transport = (url: string, body: string, timeoutMs: number) => Promise<{ status: number; body: string }>;

/** Raised by a transport when the request certainly never reached the destination. */
export class NotSentError extends Error {}

export const httpTransport: Transport = async (url, body, timeoutMs) => {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'x-application/hl7-v2+er7; charset=utf-8' },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const code = (err as { cause?: { code?: string } }).cause?.code;
    if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') throw new NotSentError(code);
    throw err;
  }
  return { status: res.status, body: await res.text() };
};

export type DeliveryOutcome = 'accepted' | 'rejected' | 'retry' | 'unknown' | 'failed' | 'cancelled' | 'revalidation_failed';

export class DeliveryWorker {
  constructor(
    private readonly pool: Pool,
    private readonly config: AppConfig,
    private readonly transport: Transport = httpTransport,
  ) {}

  /** Marks sends whose worker vanished mid-request as uncertain, so they are retried with the same control ID. */
  async recoverExpiredLeases(): Promise<number> {
    const r = await this.pool.query(
      `UPDATE outbound_messages SET status = 'unknown', possibly_delivered = true, lease_until = NULL,
              last_error = 'Worker stopped during send', next_attempt_at = now()
        WHERE status = 'sending' AND lease_until < now()`,
    );
    return r.rowCount ?? 0;
  }

  async deliverNext(): Promise<{ id: string; outcome: DeliveryOutcome } | null> {
    const claimed = await withTransaction(this.pool, async (client) => {
      const row = await one<OutboundRow>(
        client,
        `SELECT o.id, o.study_id, o.assignment_id, o.kind, o.control_id, o.payload, o.attempts, o.possibly_delivered,
                o.created_at, p.endpoint_url, p.timeout_ms
           FROM outbound_messages o JOIN integration_partners p ON p.id = o.partner_id
          WHERE o.status IN ('pending', 'retry', 'unknown') AND o.next_attempt_at <= now() AND p.active
            -- a cancellation never overtakes its assignment message
            AND NOT EXISTS (SELECT 1 FROM outbound_messages a
                             WHERE o.kind = 'cancellation' AND a.assignment_id = o.assignment_id AND a.kind = 'assignment'
                               AND a.status IN ('pending', 'sending', 'retry', 'unknown'))
          ORDER BY o.next_attempt_at
          LIMIT 1
          FOR UPDATE OF o SKIP LOCKED`,
      );
      if (!row) return null;

      if (row.kind === 'assignment' && !row.possibly_delivered) {
        const check = await this.revalidateBeforeFirstSend(client, row);
        if (check) return { row, preOutcome: check };
      }
      await client.query(
        `UPDATE outbound_messages SET status = 'sending', attempts = attempts + 1,
                lease_until = now() + make_interval(secs => $2) WHERE id = $1`,
        [row.id, Math.ceil(row.timeout_ms / 1000) + 30],
      );
      if (row.kind === 'assignment') {
        await client.query(`UPDATE assignments SET status = 'sent' WHERE id = $1 AND status = 'reserved'`, [row.assignment_id]);
      }
      return { row, preOutcome: null };
    });
    if (!claimed) return null;
    if (claimed.preOutcome) return { id: claimed.row.id, outcome: claimed.preOutcome };

    const row = claimed.row;
    const attempt = row.attempts + 1;
    const attemptId = (
      await one<{ id: string }>(
        this.pool,
        `INSERT INTO delivery_attempts (outbound_message_id, attempt) VALUES ($1, $2) RETURNING id`,
        [row.id, attempt],
      )
    )!.id;

    // The network call happens outside any transaction and with no locks held.
    let outcome: DeliveryOutcome;
    try {
      const res = await this.transport(row.endpoint_url, row.payload, row.timeout_ms);
      outcome = await this.recordResponse(row, attempt, attemptId, res);
    } catch (err) {
      const notSent = err instanceof NotSentError;
      outcome = await this.recordFailure(row, attempt, attemptId, notSent, (err as Error).message);
    }
    return { id: row.id, outcome };
  }

  /** Before the first transmission: drop withdrawn work, and re-check a reservation that waited too long. */
  private async revalidateBeforeFirstSend(client: PoolClient, row: OutboundRow): Promise<DeliveryOutcome | null> {
    const a = await one<{ status: string; radiologist_id: string; work_units: number; study_state: string; ok: boolean }>(
      client,
      `SELECT a.status, a.radiologist_id, a.work_units, s.state AS study_state,
              (r.active AND st.status = 'ready' AND (${onShiftNow('r.id')} OR NOT $2::boolean) AND ${absenceNow('r.id')} IS NULL
               AND EXISTS (SELECT 1 FROM radiologist_privileges rp WHERE rp.radiologist_id = r.id AND rp.modality_code = s.modality_code
                             AND (rp.valid_to IS NULL OR rp.valid_to >= CURRENT_DATE))) AS ok
         FROM assignments a JOIN studies s ON s.id = a.study_id JOIN radiologists r ON r.id = a.radiologist_id
         JOIN radiologist_state st ON st.radiologist_id = r.id
        WHERE a.id = $1
        FOR UPDATE OF a, s`,
      [row.assignment_id, this.config.rotaRequired],
    );
    if (!a || a.status === 'cancelled' || a.study_state === 'cancelled') {
      await client.query(`UPDATE outbound_messages SET status = 'cancelled', completed_at = now() WHERE id = $1`, [row.id]);
      return 'cancelled';
    }
    const waited = (Date.now() - new Date(row.created_at).getTime()) / 1000;
    if (waited > this.config.revalidateAfterSeconds && !a.ok) {
      await client.query(`UPDATE outbound_messages SET status = 'cancelled', completed_at = now(), last_error = 'Reservation no longer valid' WHERE id = $1`, [row.id]);
      await client.query(`UPDATE assignments SET status = 'released', ended_at = now(), end_reason = 'STALE_RESERVATION' WHERE id = $1`, [row.assignment_id]);
      await releaseCapacity(client, a.radiologist_id, a.work_units);
      await client.query(
        `UPDATE studies SET state = 'manual_review', state_reason = 'STALE_RESERVATION', version = version + 1, updated_at = now() WHERE id = $1`,
        [row.study_id],
      );
      await client.query(`INSERT INTO study_events (study_id, kind, detail) VALUES ($1, 'reservation_released', $2)`, [
        row.study_id,
        JSON.stringify({ assignmentId: row.assignment_id, reason: 'STALE_RESERVATION' }),
      ]);
      return 'revalidation_failed';
    }
    return null;
  }

  private async recordResponse(row: OutboundRow, attempt: number, attemptId: string, res: { status: number; body: string }) {
    let ackCode: string | null = null;
    let ackText: string | null = null;
    let problem: string | null = null;
    if (res.status >= 200 && res.status < 300) {
      try {
        const ack = readAck(res.body);
        ackCode = ack.code;
        ackText = ack.text ?? null;
        if (ack.controlId !== row.control_id) problem = `ACK refers to ${ack.controlId ?? 'nothing'}, expected ${row.control_id}`;
      } catch {
        problem = 'Response was not a readable HL7 ACK';
      }
    } else {
      problem = `HTTP ${res.status}`;
    }

    let outcome: DeliveryOutcome;
    if (problem) outcome = 'unknown';
    else if (ackCode === 'AA' || ackCode === 'CA') outcome = 'accepted';
    else if (ackCode === 'AE' || ackCode === 'CE') outcome = 'rejected';
    else outcome = 'retry'; // AR / CR: the receiver could not take it now

    return withTransaction(this.pool, async (client) => {
      await client.query(
        `UPDATE delivery_attempts SET finished_at = now(), outcome = $2, http_status = $3, ack_code = $4, error = $5 WHERE id = $1`,
        [attemptId, outcome, res.status, ackCode, problem],
      );
      if (outcome === 'accepted') {
        await client.query(
          `UPDATE outbound_messages SET status = 'accepted', possibly_delivered = true, ack_code = $2, ack_text = $3,
                  lease_until = NULL, completed_at = now(), last_error = NULL WHERE id = $1`,
          [row.id, ackCode, ackText],
        );
        if (row.kind === 'assignment') {
          const a = await one<{ status: string }>(
            client,
            `UPDATE assignments SET status = 'delivered' WHERE id = $1 AND status IN ('reserved', 'sent') RETURNING status`,
            [row.assignment_id],
          );
          if (a) {
            await client.query(
              `UPDATE studies SET state = 'awaiting_acceptance', state_reason = NULL, version = version + 1, updated_at = now()
                WHERE id = $1 AND state = 'reserved'`,
              [row.study_id],
            );
          }
        }
        await studyEvent(client, row, 'delivery_accepted', { ackCode });
        return outcome;
      }
      if (outcome === 'rejected') {
        await client.query(
          `UPDATE outbound_messages SET status = 'rejected', possibly_delivered = true, ack_code = $2, ack_text = $3,
                  lease_until = NULL, completed_at = now() WHERE id = $1`,
          [row.id, ackCode, ackText],
        );
        if (row.kind === 'assignment') {
          const a = await one<{ radiologist_id: string; work_units: number }>(
            client,
            `UPDATE assignments SET status = 'released', ended_at = now(), end_reason = 'DESTINATION_REJECTED'
              WHERE id = $1 AND status IN ('reserved', 'sent') RETURNING radiologist_id, work_units`,
            [row.assignment_id],
          );
          if (a) {
            await releaseCapacity(client, a.radiologist_id, a.work_units);
            await client.query(
              `UPDATE studies SET state = 'manual_review', state_reason = 'DESTINATION_REJECTED', version = version + 1, updated_at = now()
                WHERE id = $1 AND state <> 'cancelled'`,
              [row.study_id],
            );
          }
        }
        await studyEvent(client, row, 'delivery_rejected', { ackCode, ackText });
        return outcome;
      }
      return this.scheduleRetry(client, row, attempt, outcome === 'unknown', problem ?? `ACK ${ackCode}`, outcome);
    });
  }

  private recordFailure(row: OutboundRow, attempt: number, attemptId: string, notSent: boolean, error: string) {
    return withTransaction(this.pool, async (client) => {
      await client.query(`UPDATE delivery_attempts SET finished_at = now(), outcome = $2, error = $3 WHERE id = $1`, [
        attemptId,
        notSent ? 'not_sent' : 'unknown',
        error.slice(0, 500),
      ]);
      return this.scheduleRetry(client, row, attempt, !notSent, error, notSent ? 'retry' : 'unknown');
    });
  }

  /**
   * Retries reuse the same control ID and payload. After the last attempt the message is "failed" and
   * the reservation is kept: if it may have been delivered, a coordinator must reconcile it, and a
   * conflicting assignment is never sent automatically.
   */
  private async scheduleRetry(
    client: PoolClient,
    row: OutboundRow,
    attempt: number,
    mayHaveArrived: boolean,
    error: string,
    outcome: DeliveryOutcome,
  ): Promise<DeliveryOutcome> {
    const possiblyDelivered = row.possibly_delivered || mayHaveArrived;
    if (attempt >= this.config.outboundMaxAttempts) {
      await client.query(
        `UPDATE outbound_messages SET status = 'failed', possibly_delivered = $2, lease_until = NULL, last_error = $3 WHERE id = $1`,
        [row.id, possiblyDelivered, error.slice(0, 500)],
      );
      await client.query(
        `UPDATE studies SET state = 'manual_review', state_reason = $2, version = version + 1, updated_at = now()
          WHERE id = $1 AND state <> 'cancelled'`,
        [row.study_id, possiblyDelivered ? 'DELIVERY_UNCERTAIN' : 'DELIVERY_FAILED'],
      );
      await studyEvent(client, row, 'delivery_failed', { possiblyDelivered, error });
      return 'failed';
    }
    await client.query(
      `UPDATE outbound_messages SET status = $2, possibly_delivered = $3, lease_until = NULL, last_error = $4,
              next_attempt_at = now() + make_interval(secs => $5) WHERE id = $1`,
      [row.id, possiblyDelivered ? 'unknown' : 'retry', possiblyDelivered, error.slice(0, 500), backoffSeconds(attempt)],
    );
    return outcome;
  }
}

async function studyEvent(client: PoolClient, row: OutboundRow, kind: string, detail: Record<string, unknown>) {
  await client.query(`INSERT INTO study_events (study_id, kind, detail) VALUES ($1, $2, $3)`, [
    row.study_id,
    kind,
    JSON.stringify({ outboundId: row.id, messageKind: row.kind, controlId: row.control_id, ...detail }),
  ]);
}
