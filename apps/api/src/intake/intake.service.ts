import { buildAck, get, Hl7ParseError, MAX_HL7_BYTES, parseHl7, readMsh, type MshHeader } from '@vf/shared';
import type { Pool } from 'pg';
import { sha256 } from '../common/crypto';
import { one } from '../database/db';

export interface IntakeResult {
  httpStatus: number;
  ack: string;
  outcome: 'accepted' | 'duplicate' | 'collision' | 'rejected' | 'unauthorised';
  intakeMessageId?: string;
}

interface Partner {
  id: string;
  code: string;
  role: 'source' | 'reporting' | 'presence';
  allowed_facilities: string[];
}

/**
 * HL7 intake boundary. The commit acknowledgment (CA) is returned only after the message is committed
 * to intake_messages; nothing is acknowledged from memory. Clinical processing happens later, in the worker.
 */
export class IntakeService {
  constructor(private readonly pool: Pool) {}

  async authenticate(apiKey: string | undefined): Promise<Partner | null> {
    if (!apiKey || apiKey.length < 20 || apiKey.length > 200) return null;
    return one<Partner>(
      this.pool,
      `SELECT id, code, role, allowed_facilities FROM integration_partners
        WHERE api_key_hash = $1 AND direction = 'inbound' AND active`,
      [sha256(apiKey)],
    );
  }

  async receive(apiKey: string | undefined, raw: string): Promise<IntakeResult> {
    const ackId = () => `VFA${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const partner = await this.authenticate(apiKey);
    if (!partner) {
      return { httpStatus: 401, outcome: 'unauthorised', ack: buildAck(undefined, 'CR', ackId(), 'Not authorised') };
    }
    if (!raw || new TextEncoder().encode(raw).length > MAX_HL7_BYTES) {
      return { httpStatus: 413, outcome: 'rejected', ack: buildAck(undefined, 'CR', ackId(), 'Message is empty or too large') };
    }

    let msh: MshHeader;
    let orderingKey: string | null = null;
    try {
      const msg = parseHl7(raw);
      msh = readMsh(msg);
      const accession = get(msg, 'OBR', 18) ?? get(msg, 'ORC', 3) ?? get(msg, 'OBR', 3);
      if (msh.sendingFacility && accession) orderingKey = `${msh.sendingFacility}|${accession}`;
    } catch (err) {
      const reason = err instanceof Hl7ParseError ? err.message : 'Message could not be read';
      return { httpStatus: 400, outcome: 'rejected', ack: buildAck(undefined, 'CR', ackId(), reason) };
    }
    if (!msh.controlId || !msh.sendingFacility) {
      return { httpStatus: 400, outcome: 'rejected', ack: buildAck(msh, 'CR', ackId(), 'MSH-4 and MSH-10 are required') };
    }
    if (partner.role === 'presence') {
      return { httpStatus: 403, outcome: 'rejected', ack: buildAck(msh, 'CR', ackId(), 'This partner may only send presence') };
    }
    if (!partner.allowed_facilities.includes(msh.sendingFacility)) {
      return { httpStatus: 403, outcome: 'rejected', ack: buildAck(msh, 'CR', ackId(), 'Sending facility is not allowed for this partner') };
    }

    const messageKey = `${msh.sendingApplication ?? ''}|${msh.sendingFacility}|${msh.controlId}`;
    const payloadHash = sha256(raw);
    const inserted = await one<{ id: string }>(
      this.pool,
      `INSERT INTO intake_messages (partner_id, message_key, control_id, message_type, ordering_key, payload_hash, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (partner_id, message_key) DO NOTHING
       RETURNING id`,
      [partner.id, messageKey, msh.controlId, `${msh.messageType ?? ''}^${msh.triggerEvent ?? ''}`, orderingKey, payloadHash, raw],
    );
    if (inserted) {
      return { httpStatus: 200, outcome: 'accepted', intakeMessageId: inserted.id, ack: buildAck(msh, 'CA', ackId()) };
    }

    const existing = await one<{ id: string; payload_hash: string }>(
      this.pool,
      'SELECT id, payload_hash FROM intake_messages WHERE partner_id = $1 AND message_key = $2',
      [partner.id, messageKey],
    );
    if (!existing) throw new Error('Intake conflict without an existing row');
    if (existing.payload_hash === payloadHash) {
      // A retry of a message we already hold: acknowledge again, process once.
      return { httpStatus: 200, outcome: 'duplicate', intakeMessageId: existing.id, ack: buildAck(msh, 'CA', ackId()) };
    }
    // Same control ID, different content. Held for investigation and never processed automatically.
    await this.pool.query(
      'INSERT INTO intake_collisions (intake_message_id, payload_hash, payload) VALUES ($1, $2, $3)',
      [existing.id, payloadHash, raw],
    );
    return {
      httpStatus: 200,
      outcome: 'collision',
      intakeMessageId: existing.id,
      ack: buildAck(msh, 'CA', ackId(), 'Control ID reused with different content; held for investigation'),
    };
  }
}
