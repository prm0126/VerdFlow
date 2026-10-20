import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ruleSetDefinitionSchema } from '@vf/shared';
import { Pool } from 'pg';
import { audit } from '../audit/audit';
import { hashPassword, randomToken, sha256 } from '../common/crypto';
import { loadConfig } from '../config';
import { one, withTransaction } from '../database/db';
import { MastersService } from '../masters/masters.service';

/**
 * Local demo data: one hospital, modalities, teams, six radiologists, integration partners, two users
 * (an administrator and a separate rule approver) and a published rule set. Safe to run more than once.
 * Generated passwords and partner keys are printed once and written to .dev-keys.json (git-ignored).
 */
async function main() {
  const config = loadConfig();
  const pool = new Pool({ connectionString: config.databaseUrl });
  const masters = new MastersService(pool);
  const keysFile = resolve(__dirname, '../../../../.dev-keys.json');
  const out: Record<string, string> = {};

  try {
    const users = [
      { email: process.env.ADMIN_EMAIL ?? 'admin@verdflow.local', name: 'VerdFlow Administrator', roles: ['admin'] },
      { email: 'approver@verdflow.local', name: 'Rule Approver', roles: ['rule_approver', 'viewer'] },
      { email: 'coordinator@verdflow.local', name: 'Reporting Coordinator', roles: ['coordinator'] },
    ];
    let adminId = '';
    for (const u of users) {
      const existing = await one<{ id: string }>(pool, 'SELECT id FROM users WHERE lower(email) = lower($1)', [u.email]);
      if (existing) {
        adminId ||= existing.id;
        continue;
      }
      const password = u.roles.includes('admin') && process.env.ADMIN_PASSWORD ? process.env.ADMIN_PASSWORD : randomToken(12);
      const row = await one<{ id: string }>(pool, 'INSERT INTO users (email, full_name, password_hash) VALUES ($1, $2, $3) RETURNING id', [
        u.email,
        u.name,
        await hashPassword(password),
      ]);
      for (const r of u.roles) await pool.query('INSERT INTO user_roles (user_id, role_code) VALUES ($1, $2)', [row!.id, r]);
      adminId ||= row!.id;
      out[`password:${u.email}`] = password;
      console.log(`Created ${u.email} (${u.roles.join(', ')}) with password: ${password}`);
    }

    const save = (kind: Parameters<MastersService['save']>[0], input: unknown) => masters.save(kind, input, adminId);

    for (const p of [
      { code: 'RIS_SOURCE', name: 'Source Mirth (hospital RIS)', direction: 'inbound', allowedFacilities: ['CITYH'] },
      { code: 'PACS_PRESENCE', name: 'Reporting workstation presence', direction: 'inbound', allowedFacilities: [] },
      {
        code: 'THIRD_PARTY_MIRTH',
        name: 'Third-party Mirth (assignments)',
        direction: 'outbound',
        endpointUrl: 'http://localhost:4100/hl7',
        receivingApplication: 'REPORTING',
        receivingFacility: 'TELERAD',
        timeoutMs: 5000,
      },
    ]) {
      const r = await save('partners', p);
      if (r.apiKey) {
        out[`key:${p.code}`] = r.apiKey;
        console.log(`Partner ${p.code} API key: ${r.apiKey}`);
      }
    }

    await save('hospitals', { code: 'CITYH', name: 'City Hospital (900 beds)', timezone: 'Europe/London', outboundPartnerCode: 'THIRD_PARTY_MIRTH' });
    for (const m of [
      { code: 'CT', name: 'Computed tomography', workUnits: 2 },
      { code: 'MR', name: 'Magnetic resonance', workUnits: 3 },
      { code: 'XR', name: 'Plain film X-ray', workUnits: 0.5 },
      { code: 'US', name: 'Ultrasound', workUnits: 1 },
    ]) {
      await save('modalities', m);
    }
    for (const s of [
      { code: 'CTHEAD', name: 'CT head', modalityCode: 'CT' },
      { code: 'CTCAP', name: 'CT chest, abdomen and pelvis', modalityCode: 'CT', workUnits: 3 },
      { code: 'MRBRAIN', name: 'MR brain', modalityCode: 'MR' },
      { code: 'XRCHEST', name: 'X-ray chest', modalityCode: 'XR' },
      { code: 'USABDO', name: 'Ultrasound abdomen', modalityCode: 'US' },
    ]) {
      await save('services', s);
    }
    for (const t of [
      { code: 'NEURO', name: 'Neuroradiology' },
      { code: 'BODY', name: 'Body imaging' },
      { code: 'GENERAL', name: 'General reporting' },
    ]) {
      await save('teams', t);
    }
    const rads = [
      { code: 'R001', fullName: 'Dr Asha Patel', grade: 'CONSULTANT', specialties: ['NEURO'], modalities: ['CT', 'MR'], teams: ['NEURO', 'GENERAL'] },
      { code: 'R002', fullName: 'Dr Ben Okafor', grade: 'CONSULTANT', specialties: ['NEURO'], modalities: ['CT', 'MR'], teams: ['NEURO'] },
      { code: 'R003', fullName: 'Dr Chloe Martin', grade: 'CONSULTANT', specialties: ['BODY'], modalities: ['CT', 'US', 'XR'], teams: ['BODY', 'GENERAL'] },
      { code: 'R004', fullName: 'Dr Daniel Reyes', grade: 'REGISTRAR', specialties: ['BODY'], modalities: ['CT', 'US', 'XR'], teams: ['BODY'] },
      { code: 'R005', fullName: 'Dr Emma Walsh', grade: 'CONSULTANT', specialties: [], modalities: ['XR', 'US'], teams: ['GENERAL'] },
      { code: 'R006', fullName: 'Dr Farid Khan', grade: 'REGISTRAR', specialties: [], modalities: ['XR'], teams: ['GENERAL'] },
    ];
    for (const r of rads) {
      await save('radiologists', { ...r, externalId: `EXT-${r.code}`, hospitals: ['CITYH'], capacityUnits: 10 });
    }
    // Demo only: mark everyone ready. Presence still has to come from the simulator's heartbeats.
    await pool.query(`UPDATE radiologist_state SET status = 'ready' WHERE status = 'offline'`);

    const published = await one(pool, `SELECT 1 FROM rule_sets WHERE status = 'published'`);
    if (!published) {
      const definition = ruleSetDefinitionSchema.parse({
        continuity: { enabled: true },
        routing: [
          {
            id: 'neuro-head',
            name: 'Head and brain imaging to neuroradiology',
            priority: 10,
            when: { all: [{ fact: 'study.modality', op: 'in', value: ['CT', 'MR'] }, { fact: 'study.serviceCode', op: 'in', value: ['CTHEAD', 'MRBRAIN'] }] },
            teamCode: 'NEURO',
            reasonCode: 'NEURO_SERVICE',
          },
          {
            id: 'body-ct-us',
            name: 'Body CT and ultrasound to body imaging',
            priority: 20,
            when: { fact: 'study.modality', op: 'in', value: ['CT', 'US'] },
            teamCode: 'BODY',
            reasonCode: 'BODY_MODALITY',
          },
          {
            id: 'general',
            name: 'Everything else to general reporting',
            priority: 1000,
            when: { fact: 'study.modality', op: 'exists' },
            teamCode: 'GENERAL',
            reasonCode: 'DEFAULT_TEAM',
          },
        ],
        exclusions: [
          {
            id: 'stat-needs-consultant',
            name: 'STAT studies go to consultants only',
            when: { all: [{ fact: 'study.priority', op: 'eq', value: 'STAT' }, { fact: 'radiologist.grade', op: 'neq', value: 'CONSULTANT' }] },
            reasonCode: 'STAT_CONSULTANT_ONLY',
          },
        ],
      });
      await withTransaction(pool, async (client) => {
        const row = await one<{ id: string }>(
          client,
          `INSERT INTO rule_sets (version, status, definition, checksum, note, created_by, published_at, decided_at, decision_note)
           VALUES ((SELECT coalesce(max(version), 0) + 1 FROM rule_sets), 'published', $1, $2, 'Demo starting rules', NULL, now(), now(), 'Seeded for local development')
           RETURNING id`,
          [JSON.stringify(definition), sha256(JSON.stringify(definition))],
        );
        await audit(client, { actorType: 'system', action: 'rules.published', entityType: 'rule_set', entityId: row!.id, detail: { seeded: true } });
      });
      console.log('Published the demo rule set.');
    }

    if (Object.keys(out).length) {
      let existing: Record<string, string> = {};
      try {
        existing = JSON.parse(readFileSync(keysFile, 'utf8'));
      } catch {
        /* first run */
      }
      writeFileSync(keysFile, JSON.stringify({ ...existing, ...out }, null, 2), { mode: 0o600 });
      console.log(`Saved new passwords and keys to ${keysFile} (git-ignored, local only).`);
    }
    console.log('Seed complete.');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
