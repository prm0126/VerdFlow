import { buildLifecycleMessage, hl7Timestamp, parseHl7, readMsh, type LifecycleEvent } from '@vf/shared';
import type { Pool } from 'pg';
import { audit } from '../audit/audit';
import { many, one } from '../database/db';
import { IntakeService } from '../intake/intake.service';
import { Conflict, NotFound } from '../studies/studies.service';

/**
 * The HL7 message log (what came in, what went out) and manual sending. Lists show message metadata
 * only; the raw content is opened one message at a time through the audited raw-HL7 view.
 */
export class MessagesService {
  private readonly intake: IntakeService;

  constructor(private readonly pool: Pool) {
    this.intake = new IntakeService(pool);
  }

  received(params: { q?: string; status?: string; partner?: string }) {
    return many(
      this.pool,
      `SELECT m.id, m.received_at, p.code AS partner_code, p.role AS partner_role, m.control_id, m.message_type, m.status, m.reason_code,
              m.error, m.attempts, m.processed_at, m.study_id, s.accession, m.archived_at IS NOT NULL AS archived,
              octet_length(coalesce(m.payload, '')) AS bytes
         FROM intake_messages m JOIN integration_partners p ON p.id = m.partner_id
         LEFT JOIN studies s ON s.id = m.study_id
        WHERE ($1::text IS NULL OR m.control_id ILIKE '%' || $1 || '%' OR s.accession ILIKE '%' || $1 || '%')
          AND ($2::text IS NULL OR m.status = $2)
          AND ($3::text IS NULL OR p.code = $3)
        ORDER BY m.received_at DESC LIMIT 200`,
      [params.q?.trim().slice(0, 60) || null, params.status || null, params.partner || null],
    );
  }

  sent(params: { q?: string; status?: string }) {
    return many(
      this.pool,
      `SELECT o.id, o.created_at, p.code AS partner_code, o.kind, o.control_id, o.status, o.attempts, o.possibly_delivered,
              o.ack_code, o.ack_text, o.last_error, o.completed_at, o.study_id, s.accession, r.full_name AS radiologist,
              (SELECT coalesce(json_agg(d ORDER BY d.attempt), '[]') FROM
                 (SELECT attempt, started_at, finished_at, outcome, http_status, ack_code, error FROM delivery_attempts
                   WHERE outbound_message_id = o.id) d) AS attempts_detail
         FROM outbound_messages o JOIN integration_partners p ON p.id = o.partner_id
         JOIN studies s ON s.id = o.study_id
         JOIN assignments a ON a.id = o.assignment_id JOIN radiologists r ON r.id = a.radiologist_id
        WHERE ($1::text IS NULL OR o.control_id ILIKE '%' || $1 || '%' OR s.accession ILIKE '%' || $1 || '%')
          AND ($2::text IS NULL OR o.status = $2)
        ORDER BY o.created_at DESC LIMIT 200`,
      [params.q?.trim().slice(0, 60) || null, params.status || null],
    );
  }

  partners() {
    return many(
      this.pool,
      `SELECT code, name, direction, role, allowed_facilities AS "allowedFacilities", active FROM integration_partners ORDER BY direction, code`,
    );
  }

  /**
   * Sends a message as if it came from one of the inbound partners. It goes through exactly the same
   * receipt checks and processing as a message from Mirth; only the API key step is replaced by the
   * signed-in user's permission. Audited, without the message content.
   */
  async send(partnerCode: string, payload: string, userId: string, ip?: string) {
    const partner = await this.intake.findPartner(String(partnerCode ?? ''));
    if (!partner) throw new NotFound();
    if (partner.role === 'presence') throw new Conflict('A presence partner does not send HL7. Choose a source or reporting partner.');
    // Pasted text usually has newline line endings; HL7 segments end with a carriage return.
    const raw = String(payload ?? '').replace(/\r\n|\n/g, '\r').trim();
    if (!raw) throw new Conflict('Paste or build a message first');
    const result = await this.intake.receiveFromPartner(partner, raw);
    let controlId: string | undefined;
    try {
      controlId = readMsh(parseHl7(raw)).controlId;
    } catch {
      /* rejected at the boundary; the ACK says why */
    }
    await audit(this.pool, {
      actorType: 'user',
      actorId: userId,
      action: 'hl7.manual_send',
      entityType: 'intake_message',
      entityId: result.intakeMessageId ?? null,
      detail: { partner: partner.code, controlId: controlId ?? null, outcome: result.outcome, httpStatus: result.httpStatus },
      ip,
    });
    return { ...result, partner: partner.code };
  }

  /**
   * Ready-made messages to start from. "new_order" and "cancel" come from a source partner; "accept",
   * "decline", "preliminary" and "final" are replies from the reporting side for the study's current
   * assignment, so they carry the right assignment ID and version.
   */
  async template(kind: string, accession?: string) {
    const now = new Date();
    const stamp = String(now.getTime()).slice(-6);
    const facility = (await one<{ code: string }>(this.pool, `SELECT code FROM hospitals WHERE active ORDER BY code LIMIT 1`))?.code ?? 'CITYH';
    const order = (control: string, acc: string, orc: string, modality: string, service: string) =>
      [
        `MSH|^~\\&|RIS|${facility}|VERDFLOW|VERDFLOW|${hl7Timestamp(now)}||ORM^O01|${control}|P|2.5.1|||AL|NE`,
        `PID|1||MRN${stamp}^^^${facility}^MR||Test^Patient`,
        `PV1|1|O|RAD^ROOM1||||||||||||||||ENC${stamp}`,
        `ORC|${orc}|PL${acc}|${acc}`,
        `OBR|1|PL${acc}|${acc}|${service}|R|||||||||||||${acc}||||||${modality}`,
      ].join('\n');

    if (kind === 'new_order') {
      const source = await one<{ code: string }>(this.pool, `SELECT code FROM integration_partners WHERE direction = 'inbound' AND role = 'source' AND active ORDER BY code LIMIT 1`);
      return { partner: source?.code ?? null, payload: order(`MAN${stamp}`, `MAN${stamp}`, 'NW', 'CT', 'CTCAP^CT chest abdomen pelvis') };
    }
    if (!accession?.trim()) throw new Conflict('Enter the accession number of an existing study');
    const s = await one<{ accession: string; modality_code: string; service_code: string; service_text: string | null }>(
      this.pool,
      'SELECT accession, modality_code, service_code, service_text FROM studies WHERE accession = $1 ORDER BY created_at DESC LIMIT 1',
      [accession.trim()],
    );
    if (!s) throw new Conflict(`No study has accession ${accession.trim()}`);
    if (kind === 'cancel') {
      const source = await one<{ code: string }>(this.pool, `SELECT code FROM integration_partners WHERE direction = 'inbound' AND role = 'source' AND active ORDER BY code LIMIT 1`);
      return { partner: source?.code ?? null, payload: order(`MANCA${stamp}`, s.accession, 'CA', s.modality_code, `${s.service_code}^${s.service_text ?? ''}`) };
    }
    const lifecycle: Record<string, LifecycleEvent['kind']> = { accept: 'accepted', decline: 'declined', preliminary: 'preliminary', final: 'final' };
    if (!lifecycle[kind]) throw new Conflict('Unknown template');
    const a = await one<{ id: string; version: number }>(
      this.pool,
      `SELECT a.id, a.version FROM assignments a JOIN studies st ON st.id = a.study_id
        WHERE st.accession = $1 AND a.status IN ('sent', 'delivered', 'accepted') ORDER BY a.version DESC LIMIT 1`,
      [s.accession],
    );
    if (!a) throw new Conflict(`${s.accession} has no assignment that has been sent, so there is nothing to reply to`);
    const reporting = await one<{ code: string; allowed_facilities: string[] }>(
      this.pool,
      `SELECT code, allowed_facilities FROM integration_partners WHERE direction = 'inbound' AND role = 'reporting' AND active ORDER BY code LIMIT 1`,
    );
    const payload = buildLifecycleMessage({
      kind: lifecycle[kind],
      assignmentId: a.id,
      assignmentVersion: a.version,
      accession: s.accession,
      reason: kind === 'decline' ? 'Outside my subspecialty' : undefined,
      controlId: `MANRPT${stamp}`,
      sendingFacility: reporting?.allowed_facilities[0] ?? 'TELERAD',
      messageTime: now,
    });
    return { partner: reporting?.code ?? null, payload: payload.replace(/\r/g, '\n').trim() };
  }
}
