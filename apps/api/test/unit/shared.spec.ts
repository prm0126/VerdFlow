import {
  buildAck,
  buildAssignmentMessage,
  evaluateCondition,
  evaluateExclusions,
  evaluateRouting,
  get,
  parseHl7,
  readAck,
  ruleSetDefinitionSchema,
  toCanonicalOrder,
  type RuleSetDefinition,
} from '@vf/shared';

const ORDER = [
  'MSH|^~\\&|RIS|CITYH|VERDFLOW|VERDFLOW|20261020101500||ORM^O01|MSG1|P|2.5.1|||AL|NE',
  'PID|1||MRN1^^^CITYH^MR||Smith^Jane',
  'PV1|1|O|RAD^ROOM2||||||||||||||||ENC1',
  'ORC|NW|PL1|ACC1',
  'OBR|1|PL1|ACC1|CTHEAD^CT head|S|||||||||||||ACC1||||||CT',
].join('\r');

describe('HL7', () => {
  it('reads the intake profile into a canonical order', () => {
    const o = toCanonicalOrder(parseHl7(ORDER));
    expect(o).toMatchObject({
      orderControl: 'NW',
      sendingFacility: 'CITYH',
      patientId: 'MRN1',
      patientAuthority: 'CITYH',
      patientName: 'Jane Smith',
      encounterNumber: 'ENC1',
      accession: 'ACC1',
      serviceCode: 'CTHEAD',
      modality: 'CT',
      priority: 'STAT',
      location: 'RAD',
      room: 'ROOM2',
    });
  });

  it('accepts newline segment separators and MLLP framing', () => {
    const o = toCanonicalOrder(parseHl7('\u000b' + ORDER.replace(/\r/g, '\n') + '\u001c\r'));
    expect(o.accession).toBe('ACC1');
  });

  it('rejects messages without MSH, unsupported types and missing fields with reason codes', () => {
    expect(() => parseHl7('PID|1')).toThrow(expect.objectContaining({ code: 'NO_MSH' }));
    expect(() => toCanonicalOrder(parseHl7(ORDER.replace('ORM^O01', 'ADT^A01')))).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_TYPE' }));
    expect(() => toCanonicalOrder(parseHl7(ORDER.replace('||||||CT', '||||||')))).toThrow(expect.objectContaining({ code: 'MISSING_MODALITY' }));
  });

  it('unescapes values and escapes output', () => {
    const msg = parseHl7(ORDER.replace('Smith^Jane', 'O\\S\\Brien^Jane'));
    expect(get(msg, 'PID', 5, 1)).toBe('O^Brien');
    const out = buildAssignmentMessage({
      controlId: 'VF1',
      messageTime: new Date('2026-10-20T10:00:00Z'),
      receivingApplication: 'REP',
      receivingFacility: 'TR',
      orderControl: 'XO',
      patientId: 'MRN|1',
      patientAuthority: 'CITYH',
      accession: 'ACC1',
      serviceCode: 'CTHEAD',
      modality: 'CT',
      assignmentId: 'a1',
      assignmentVersion: 1,
      radiologistExternalId: 'EXT1',
      radiologistName: 'Dr A',
      teamCode: 'NEURO',
      ruleSetVersion: 3,
    });
    const parsed = parseHl7(out);
    expect(get(parsed, 'PID', 3, 1)).toBe('MRN|1');
    expect(get(parsed, 'OBR', 18)).toBe('ACC1');
    expect(get(parsed, 'OBR', 24)).toBe('CT');
    expect(get(parsed, 'ZAS', 3, 1)).toBe('EXT1');
    expect(get(parsed, 'MSH', 10)).toBe('VF1');
  });

  it('builds and reads acknowledgments correlated to the original control ID', () => {
    const ack = buildAck({ controlId: 'MSG1', sendingApplication: 'RIS', sendingFacility: 'CITYH', triggerEvent: 'O01' }, 'CA', 'A1');
    expect(readAck(ack)).toEqual({ code: 'CA', controlId: 'MSG1', text: undefined });
  });
});

const DEF: RuleSetDefinition = ruleSetDefinitionSchema.parse({
  continuity: { enabled: true },
  routing: [
    { id: 'general', name: 'General', priority: 100, when: { fact: 'study.modality', op: 'exists' }, teamCode: 'GENERAL', reasonCode: 'DEFAULT' },
    { id: 'neuro', name: 'Neuro', priority: 10, when: { fact: 'study.serviceCode', op: 'in', value: ['CTHEAD'] }, teamCode: 'NEURO', reasonCode: 'NEURO' },
  ],
  exclusions: [
    {
      id: 'stat',
      name: 'STAT consultants only',
      when: { all: [{ fact: 'study.priority', op: 'eq', value: 'STAT' }, { fact: 'radiologist.grade', op: 'neq', value: 'CONSULTANT' }] },
      reasonCode: 'STAT_CONSULTANT_ONLY',
    },
  ],
});

describe('rules', () => {
  it('routes by lowest priority number, not by list order', () => {
    expect(evaluateRouting(DEF, { 'study.modality': 'CT', 'study.serviceCode': 'CTHEAD' }).teamCode).toBe('NEURO');
    expect(evaluateRouting(DEF, { 'study.modality': 'CT', 'study.serviceCode': 'CTCAP' }).teamCode).toBe('GENERAL');
  });

  it('treats a missing fact as unknown: never a routing match, always an exclusion', () => {
    const r = evaluateRouting(DEF, { 'study.modality': undefined });
    expect(r.teamCode).toBeNull();
    expect(r.unknownRuleIds).toEqual(['neuro']);
    expect(evaluateExclusions(DEF, { 'study.priority': 'STAT', 'radiologist.grade': undefined })).toEqual([
      { ruleId: 'stat', reasonCode: 'UNKNOWN_FACT_STAT_CONSULTANT_ONLY' },
    ]);
    expect(evaluateExclusions(DEF, { 'study.priority': 'ROUTINE', 'radiologist.grade': undefined })).toEqual([]);
  });

  it('uses three-valued logic for not, all and any', () => {
    expect(evaluateCondition({ not: { fact: 'study.room', op: 'eq', value: 'R1' } }, {})).toBeNull();
    expect(evaluateCondition({ any: [{ fact: 'study.room', op: 'eq', value: 'R1' }, { fact: 'study.modality', op: 'eq', value: 'CT' }] }, { 'study.modality': 'CT' })).toBe(true);
    expect(evaluateCondition({ all: [{ fact: 'study.room', op: 'eq', value: 'R1' }, { fact: 'study.modality', op: 'eq', value: 'XR' }] }, { 'study.modality': 'CT' })).toBe(false);
  });

  it('rejects shared priorities, unknown facts, code-like values and deep nesting at publication', () => {
    const base = { continuity: { enabled: true }, exclusions: [] };
    const rule = (id: string, priority: number) => ({ id, name: id, priority, when: { fact: 'study.modality', op: 'exists' }, teamCode: 'GENERAL', reasonCode: 'X_X' });
    expect(ruleSetDefinitionSchema.safeParse({ ...base, routing: [rule('a1', 5), rule('b1', 5)] }).success).toBe(false);
    expect(ruleSetDefinitionSchema.safeParse({ ...base, routing: [{ ...rule('a1', 1), when: { fact: 'process.env', op: 'exists' } }] }).success).toBe(false);
    let deep: unknown = { fact: 'study.modality', op: 'exists' };
    for (let i = 0; i < 6; i++) deep = { not: deep };
    expect(ruleSetDefinitionSchema.safeParse({ ...base, routing: [{ ...rule('a1', 1), when: deep }] }).success).toBe(false);
    expect(ruleSetDefinitionSchema.safeParse({ ...base, routing: [{ ...rule('a1', 1), when: { fact: 'study.modality', op: 'in' } }] }).success).toBe(false);
  });
});
