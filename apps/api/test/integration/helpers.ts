import { Pool } from 'pg';
import { hashPassword } from '../../src/common/crypto';
import { loadConfig, type AppConfig } from '../../src/config';
import { one } from '../../src/database/db';
import { migrate } from '../../src/database/migrator';
import { migrations } from '../../src/database/migrations';
import { MastersService } from '../../src/masters/masters.service';
import { RulesService } from '../../src/rules/rules.service';

export const TEST_URL = process.env.TEST_DATABASE_URL;
if (!TEST_URL) throw new Error('TEST_DATABASE_URL is not set. The integration tests need a PostgreSQL database they may wipe.');

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  process.env.NODE_ENV = 'test';
  return loadConfig({ databaseUrl: TEST_URL, ...overrides });
}

/** Drops and recreates the schema, then applies every migration. */
export async function resetDatabase(pool: Pool): Promise<void> {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(TEST_URL!, migrations);
}

export interface Fixture {
  adminId: string;
  approverId: string;
  inboundKey: string;
  presenceKey: string;
  reportingKey: string;
  masters: MastersService;
}

/** Hospital CITYH, CT/XR, teams NEURO and GENERAL, three radiologists (all ready and present), published rules. */
export async function seed(pool: Pool): Promise<Fixture> {
  const user = async (email: string, roles: string[]) => {
    const u = await one<{ id: string }>(pool, 'INSERT INTO users (email, full_name, password_hash) VALUES ($1, $2, $3) RETURNING id', [
      email,
      email.split('@')[0],
      await hashPassword('correct horse battery'),
    ]);
    for (const r of roles) await pool.query('INSERT INTO user_roles (user_id, role_code) VALUES ($1, $2)', [u!.id, r]);
    return u!.id;
  };
  const adminId = await user('admin@test.local', ['admin']);
  const approverId = await user('approver@test.local', ['rule_approver']);
  await user('viewer@test.local', ['viewer']);

  const masters = new MastersService(pool);
  const save = (kind: Parameters<MastersService['save']>[0], input: unknown) => masters.save(kind, input, adminId);
  const inbound = await save('partners', { code: 'RIS', name: 'RIS', direction: 'inbound', allowedFacilities: ['CITYH'] });
  const presence = await save('partners', { code: 'PACS', name: 'PACS', direction: 'inbound', role: 'presence', allowedFacilities: [] });
  const reporting = await save('partners', { code: 'REPORTING', name: 'Reporting return', direction: 'inbound', role: 'reporting', allowedFacilities: ['TELERAD'] });
  await save('partners', { code: 'DEST', name: 'Destination', direction: 'outbound', endpointUrl: 'http://dest.invalid/hl7', receivingApplication: 'REP', receivingFacility: 'TR', timeoutMs: 1000 });
  await save('hospitals', { code: 'CITYH', name: 'City Hospital', outboundPartnerCode: 'DEST' });
  await save('modalities', { code: 'CT', name: 'CT', workUnits: 2 });
  await save('modalities', { code: 'XR', name: 'X-ray', workUnits: 1 });
  await save('teams', { code: 'NEURO', name: 'Neuro' });
  await save('teams', { code: 'GENERAL', name: 'General' });
  for (const r of [
    { code: 'R1', fullName: 'Dr One', grade: 'CONSULTANT', teams: ['NEURO', 'GENERAL'] },
    { code: 'R2', fullName: 'Dr Two', grade: 'CONSULTANT', teams: ['NEURO', 'GENERAL'] },
    { code: 'R3', fullName: 'Dr Three', grade: 'REGISTRAR', teams: ['NEURO', 'GENERAL'] },
  ]) {
    await save('radiologists', { ...r, externalId: `EXT-${r.code}`, modalities: ['CT', 'XR'], hospitals: ['CITYH'], capacityUnits: 10 });
  }
  await pool.query(`UPDATE radiologist_state SET status = 'ready', heartbeat_at = now()`);
  await pool.query(`INSERT INTO shifts (radiologist_id, starts_at, ends_at) SELECT id, now() - interval '1 hour', now() + interval '12 hours' FROM radiologists`);

  const rules = new RulesService(pool);
  const draft = await rules.createDraft(
    {
      continuity: { enabled: true },
      routing: [
        { id: 'neuro', name: 'Neuro', priority: 10, when: { fact: 'study.serviceCode', op: 'eq', value: 'CTHEAD' }, teamCode: 'NEURO', reasonCode: 'NEURO_SERVICE' },
        { id: 'general', name: 'General', priority: 100, when: { fact: 'study.modality', op: 'exists' }, teamCode: 'GENERAL', reasonCode: 'DEFAULT_TEAM' },
      ],
      exclusions: [
        {
          id: 'stat',
          name: 'STAT consultants only',
          when: { all: [{ fact: 'study.priority', op: 'eq', value: 'STAT' }, { fact: 'radiologist.grade', op: 'neq', value: 'CONSULTANT' }] },
          reasonCode: 'STAT_CONSULTANT_ONLY',
        },
      ],
    },
    'test rules',
    adminId,
  );
  await rules.submit(draft.id, adminId);
  await rules.decide(draft.id, true, 'ok', approverId);
  return { adminId, approverId, inboundKey: inbound.apiKey!, presenceKey: presence.apiKey!, reportingKey: reporting.apiKey!, masters };
}

let seq = 0;
export interface OrderOpts {
  control?: string;
  orderControl?: 'NW' | 'XO' | 'CA';
  accession?: string;
  patient?: string;
  encounter?: string;
  service?: string;
  modality?: string;
  priority?: 'S' | 'R';
  facility?: string;
  messageType?: string;
}

export function order(o: OrderOpts = {}): string {
  seq++;
  const acc = o.accession ?? `ACC${seq}`;
  return [
    `MSH|^~\\&|RIS|${o.facility ?? 'CITYH'}|VERDFLOW|VERDFLOW|20261020101500||${o.messageType ?? 'ORM^O01'}|${o.control ?? `M${seq}`}|P|2.5.1|||AL|NE`,
    `PID|1||${o.patient ?? `P${seq}`}^^^CITYH^MR||Test^Patient`,
    `PV1|1|O|RAD^ROOM1||||||||||||||||${o.encounter ?? ''}`,
    `ORC|${o.orderControl ?? 'NW'}|PL${acc}|${acc}`,
    `OBR|1|PL${acc}|${acc}|${o.service ?? 'CTCAP'}^Service|${o.priority ?? 'R'}|||||||||||||${acc}||||||${o.modality ?? 'CT'}`,
  ].join('\r');
}
