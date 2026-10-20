/**
 * Minimal HL7 v2 (pipe-delimited) parsing and building. Enough for the agreed ORM^O01 intake profile and
 * the VerdFlow assignment output; partner conformance profiles add their own checks on top.
 */

export const MAX_HL7_BYTES = 1_000_000;

export interface Hl7Delimiters {
  field: string;
  component: string;
  repetition: string;
  escape: string;
  subcomponent: string;
}

export interface Hl7Message {
  delimiters: Hl7Delimiters;
  /** Segments in order; each segment is its list of fields, with fields[0] the segment name. */
  segments: string[][];
}

export class Hl7ParseError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export function parseHl7(raw: string): Hl7Message {
  if (new TextEncoder().encode(raw).length > MAX_HL7_BYTES) throw new Hl7ParseError('Message is too large', 'TOO_LARGE');
  const text = raw.replace(/^\u000b/, '').replace(/\u001c\r?$/, '');
  const lines = text.split(/\r\n|\r|\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0 || !lines[0].startsWith('MSH') || lines[0].length < 8) {
    throw new Hl7ParseError('Message does not start with an MSH segment', 'NO_MSH');
  }
  const field = lines[0][3];
  const enc = lines[0].slice(4, 8);
  if (new Set([field, ...enc]).size !== 5) throw new Hl7ParseError('MSH delimiters are invalid', 'BAD_DELIMITERS');
  const delimiters: Hl7Delimiters = {
    field,
    component: enc[0],
    repetition: enc[1],
    escape: enc[2],
    subcomponent: enc[3],
  };
  const segments = lines.map((line, i) => {
    const fields = line.split(field);
    if (!/^[A-Z][A-Z0-9]{2}$/.test(fields[0])) {
      throw new Hl7ParseError(`Segment ${i + 1} has an invalid name`, 'BAD_SEGMENT');
    }
    if (i === 0) {
      // MSH-1 is the field separator itself, so MSH fields are shifted by one compared with other segments.
      return ['MSH', field, ...fields.slice(1)];
    }
    return fields;
  });
  return { delimiters, segments };
}

function unescape(value: string, d: Hl7Delimiters): string {
  if (!value.includes(d.escape)) return value;
  const e = d.escape;
  return value
    .split(`${e}F${e}`).join(d.field)
    .split(`${e}S${e}`).join(d.component)
    .split(`${e}R${e}`).join(d.repetition)
    .split(`${e}T${e}`).join(d.subcomponent)
    .split(`${e}E${e}`).join(e);
}

export function escapeHl7(value: string): string {
  return value
    .replace(/\\/g, '\\E\\')
    .replace(/\|/g, '\\F\\')
    .replace(/\^/g, '\\S\\')
    .replace(/~/g, '\\R\\')
    .replace(/&/g, '\\T\\')
    .replace(/[\r\n]+/g, ' ');
}

export function segment(msg: Hl7Message, name: string): string[] | undefined {
  return msg.segments.find((s) => s[0] === name);
}

/**
 * Read a value by HL7 position, e.g. get(msg, 'PID', 3, 1) for the first component of the first
 * repetition of PID-3. Returns undefined for absent or empty values.
 */
export function get(msg: Hl7Message, seg: string, fieldNo: number, component = 1, rep = 0): string | undefined {
  const s = segment(msg, seg);
  const f = s?.[fieldNo];
  if (!f) return undefined;
  const r = f.split(msg.delimiters.repetition)[rep];
  if (r === undefined) return undefined;
  const c = r.split(msg.delimiters.component)[component - 1];
  if (c === undefined || c === '') return undefined;
  return unescape(c.split(msg.delimiters.subcomponent)[0], msg.delimiters);
}

export interface MshHeader {
  sendingApplication?: string;
  sendingFacility?: string;
  receivingApplication?: string;
  receivingFacility?: string;
  messageTime?: string;
  messageType?: string;
  triggerEvent?: string;
  controlId?: string;
  processingId?: string;
  version?: string;
  acceptAckType?: string;
  applicationAckType?: string;
}

export function readMsh(msg: Hl7Message): MshHeader {
  return {
    sendingApplication: get(msg, 'MSH', 3),
    sendingFacility: get(msg, 'MSH', 4),
    receivingApplication: get(msg, 'MSH', 5),
    receivingFacility: get(msg, 'MSH', 6),
    messageTime: get(msg, 'MSH', 7),
    messageType: get(msg, 'MSH', 9, 1),
    triggerEvent: get(msg, 'MSH', 9, 2),
    controlId: get(msg, 'MSH', 10),
    processingId: get(msg, 'MSH', 11),
    version: get(msg, 'MSH', 12),
    acceptAckType: get(msg, 'MSH', 15),
    applicationAckType: get(msg, 'MSH', 16),
  };
}

/** Canonical radiology order taken from an ORM^O01 message under the VerdFlow intake profile. */
export interface CanonicalOrder {
  orderControl: 'NW' | 'XO' | 'CA';
  sendingFacility: string;
  patientId: string;
  patientAuthority: string;
  patientName?: string;
  encounterNumber?: string;
  placerOrder?: string;
  accession: string;
  serviceCode: string;
  serviceText?: string;
  modality: string;
  priority: 'STAT' | 'URGENT' | 'ROUTINE';
  location?: string;
  room?: string;
}

const ORDER_CONTROLS = new Set(['NW', 'XO', 'CA']);

/** Validates the intake profile and returns the canonical order. Throws Hl7ParseError with a reason code. */
export function toCanonicalOrder(msg: Hl7Message): CanonicalOrder {
  const msh = readMsh(msg);
  if (msh.messageType !== 'ORM' || msh.triggerEvent !== 'O01') {
    throw new Hl7ParseError(`Unsupported message type ${msh.messageType ?? '?'}^${msh.triggerEvent ?? '?'}`, 'UNSUPPORTED_TYPE');
  }
  const need = (value: string | undefined, label: string, code: string) => {
    if (!value) throw new Hl7ParseError(`${label} is missing`, code);
    return value;
  };
  const orderControl = need(get(msg, 'ORC', 1), 'ORC-1 order control', 'MISSING_ORDER_CONTROL');
  if (!ORDER_CONTROLS.has(orderControl)) {
    throw new Hl7ParseError(`Order control ${orderControl} is not supported`, 'UNSUPPORTED_ORDER_CONTROL');
  }
  const accession = get(msg, 'OBR', 18) ?? get(msg, 'ORC', 3) ?? get(msg, 'OBR', 3);
  const priorityRaw = (get(msg, 'OBR', 5) ?? get(msg, 'ORC', 7, 6) ?? 'R').toUpperCase();
  const priority = priorityRaw === 'S' || priorityRaw === 'STAT' ? 'STAT' : priorityRaw === 'A' || priorityRaw === 'U' ? 'URGENT' : 'ROUTINE';
  const familyName = get(msg, 'PID', 5, 1);
  const givenName = get(msg, 'PID', 5, 2);
  return {
    orderControl: orderControl as CanonicalOrder['orderControl'],
    sendingFacility: need(msh.sendingFacility, 'MSH-4 sending facility', 'MISSING_FACILITY'),
    patientId: need(get(msg, 'PID', 3, 1), 'PID-3 patient identifier', 'MISSING_PATIENT_ID'),
    patientAuthority: need(get(msg, 'PID', 3, 4) ?? msh.sendingFacility, 'PID-3 assigning authority', 'MISSING_AUTHORITY'),
    patientName: [givenName, familyName].filter(Boolean).join(' ') || undefined,
    encounterNumber: get(msg, 'PV1', 19),
    placerOrder: get(msg, 'ORC', 2),
    accession: need(accession, 'Accession (OBR-18, ORC-3 or OBR-3)', 'MISSING_ACCESSION'),
    serviceCode: need(get(msg, 'OBR', 4, 1), 'OBR-4 service code', 'MISSING_SERVICE'),
    serviceText: get(msg, 'OBR', 4, 2),
    modality: need(get(msg, 'OBR', 24), 'OBR-24 modality', 'MISSING_MODALITY').toUpperCase(),
    priority,
    location: get(msg, 'PV1', 3, 1),
    room: get(msg, 'PV1', 3, 2),
  };
}

export function hl7Timestamp(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}+0000`;
}

export function buildSegment(name: string, fields: (string | undefined)[]): string {
  return [name, ...fields.map((f) => f ?? '')].join('|').replace(/\|+$/, '');
}

/** Builds an acknowledgment. code: AA/AE/AR (original mode) or CA/CE/CR (enhanced accept). */
export function buildAck(
  original: MshHeader | undefined,
  code: 'AA' | 'AE' | 'AR' | 'CA' | 'CE' | 'CR',
  controlId: string,
  text?: string,
  now = new Date(),
): string {
  return [
    `MSH|^~\\&|VERDFLOW|VERDFLOW|${escapeHl7(original?.sendingApplication ?? '')}|${escapeHl7(original?.sendingFacility ?? '')}|${hl7Timestamp(now)}||ACK^${escapeHl7(original?.triggerEvent ?? '')}^ACK|${escapeHl7(controlId)}|P|${escapeHl7(original?.version ?? '2.5.1')}`,
    buildSegment('MSA', [code, escapeHl7(original?.controlId ?? ''), text ? escapeHl7(text).slice(0, 80) : undefined]),
  ].join('\r') + '\r';
}

export interface AckResult {
  code: string;
  controlId?: string;
  text?: string;
}

export function readAck(raw: string): AckResult {
  const msg = parseHl7(raw);
  const code = get(msg, 'MSA', 1);
  if (!code) throw new Hl7ParseError('ACK has no MSA-1', 'BAD_ACK');
  return { code, controlId: get(msg, 'MSA', 2), text: get(msg, 'MSA', 3) ?? get(msg, 'ERR', 8) };
}

export interface AssignmentOutput {
  controlId: string;
  messageTime: Date;
  receivingApplication: string;
  receivingFacility: string;
  orderControl: 'XO' | 'CA';
  patientId: string;
  patientAuthority: string;
  placerOrder?: string;
  accession: string;
  serviceCode: string;
  modality: string;
  assignmentId: string;
  assignmentVersion: number;
  radiologistExternalId: string;
  radiologistName: string;
  teamCode: string;
  ruleSetVersion: number;
}

/**
 * VerdFlow assignment output, profile VF-ASSIGN-1: ORM^O01 with a ZAS segment carrying the assignment.
 * The real partner mapping must come from the signed interface specification; this profile is the
 * starting proposal.
 */
export function buildAssignmentMessage(a: AssignmentOutput): string {
  const e = escapeHl7;
  return (
    [
      `MSH|^~\\&|VERDFLOW|VERDFLOW|${e(a.receivingApplication)}|${e(a.receivingFacility)}|${hl7Timestamp(a.messageTime)}||ORM^O01^ORM_O01|${e(a.controlId)}|P|2.5.1|||AL|NE`,
      buildSegment('PID', ['1', undefined, `${e(a.patientId)}^^^${e(a.patientAuthority)}`]),
      buildSegment('ORC', [a.orderControl, a.placerOrder ? e(a.placerOrder) : undefined, e(a.accession)]),
      buildSegment('OBR', ['1', a.placerOrder ? e(a.placerOrder) : undefined, e(a.accession), e(a.serviceCode), undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, e(a.accession), undefined, undefined, undefined, undefined, undefined, e(a.modality)]),
      buildSegment('ZAS', [
        e(a.assignmentId),
        String(a.assignmentVersion),
        `${e(a.radiologistExternalId)}^${e(a.radiologistName)}`,
        e(a.teamCode),
        String(a.ruleSetVersion),
        a.orderControl === 'CA' ? 'CANCELLED' : 'ASSIGNED',
      ]),
    ].join('\r') + '\r'
  );
}
