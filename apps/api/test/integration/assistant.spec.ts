import type Anthropic from '@anthropic-ai/sdk';
import { buildAck, parseHl7, readMsh } from '@vf/shared';
import { Pool } from 'pg';
import { AssistantService, type LlmCall } from '../../src/assistant/assistant.service';
import { runTool, TOOLS } from '../../src/assistant/tools';
import { AuthService, type SessionUser } from '../../src/auth/auth.service';
import { many, one } from '../../src/database/db';
import { IntakeService } from '../../src/intake/intake.service';
import { DeliveryWorker } from '../../src/outbound/delivery';
import { Processor } from '../../src/processing/processor';
import { order, resetDatabase, seed, TEST_URL, testConfig, type Fixture } from './helpers';

const config = testConfig();
const pool = new Pool({ connectionString: TEST_URL, max: 10 });
let fx: Fixture;

async function sessionFor(email: string): Promise<SessionUser> {
  const auth = new AuthService(pool, config);
  const s = await auth.login(email, 'correct horse battery');
  return (await auth.resolve(s!.token))!;
}

/** Signs in as the approver and links that account to radiologist R1, who has a shift today. */
async function radiologistUser(): Promise<SessionUser> {
  await pool.query(`UPDATE radiologists SET user_id = $1 WHERE code = 'R1'`, [fx.approverId]);
  return sessionFor('approver@test.local');
}

async function routeOne(accession: string) {
  await new IntakeService(pool).receive(fx.inboundKey, order({ accession, patient: 'MRN-SECRET-1' }));
  const p = new Processor(pool, config);
  while (await p.processNext());
  const accept = async (_u: string, body: string) => ({ status: 200, body: buildAck(readMsh(parseHl7(body)), 'AA', 'D1') });
  await new DeliveryWorker(pool, config, accept).deliverNext();
}

const message = (content: Anthropic.Beta.BetaContentBlock[], stop: Anthropic.Beta.BetaMessage['stop_reason']) =>
  ({ id: 'msg', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content, stop_reason: stop, stop_sequence: null, usage: {} }) as unknown as Anthropic.Beta.BetaMessage;
const text = (t: string) => ({ type: 'text', text: t, citations: null }) as unknown as Anthropic.Beta.BetaContentBlock;
const toolUse = (id: string, name: string, input: unknown) => ({ type: 'tool_use', id, name, input }) as unknown as Anthropic.Beta.BetaContentBlock;

beforeEach(async () => {
  await resetDatabase(pool);
  fx = await seed(pool);
});

afterAll(async () => {
  await pool.end();
});

describe('built-in assistant (no Claude credential)', () => {
  it('answers "what all scheduled available under my name" from the user\'s own rota', async () => {
    const user = await radiologistUser();
    const a = new AssistantService(pool, config, null);
    const r = await a.ask(user, { message: 'what all scheduled available under my name' });
    expect(r.engine).toBe('built-in');
    expect(r.tools.map((t) => t.name)).toEqual(['my_schedule']);
    expect(r.reply).toContain('Dr One');
    expect(r.reply).toContain('Reporting shift');
    expect(r.reply).toMatch(/Right now you are on shift/);
  });

  it('includes leave and says when nothing is scheduled', async () => {
    const user = await radiologistUser();
    const a = new AssistantService(pool, config, null);
    await pool.query(`DELETE FROM shifts`);
    expect((await a.ask(user, { message: 'Am I working tomorrow?' })).reply).toContain('Nothing is scheduled');
    const rid = (await one<{ id: string }>(pool, `SELECT id FROM radiologists WHERE code = 'R1'`))!.id;
    await pool.query(`INSERT INTO absences (radiologist_id, kind, starts_at, ends_at) VALUES ($1, 'leave', now() + interval '1 day', now() + interval '3 days')`, [rid]);
    expect((await a.ask(user, { message: 'show my rota for the next 7 days' })).reply).toContain('Leave:');
  });

  it('tells a user with no radiologist profile that nothing is under their name', async () => {
    const admin = await sessionFor('admin@test.local');
    const r = await new AssistantService(pool, config, null).ask(admin, { message: "What's scheduled under my name?" });
    expect(r.reply).toContain('not linked to a radiologist profile');
  });

  it('lists my assigned work and explains a study by accession', async () => {
    const user = await radiologistUser();
    await routeOne('ACC777');
    const a = new AssistantService(pool, config, null);
    const work = await a.ask(user, { message: 'What is assigned to me?' });
    expect(work.reply).toContain('ACC777');
    const explained = await a.ask(user, { message: 'Explain ACC777 please' });
    expect(explained.tools.map((t) => t.name)).toEqual(['explain_study']);
    expect(explained.reply).toContain('routed to team');
  });

  it('keeps conversations private to their owner and audits without the message text', async () => {
    const user = await radiologistUser();
    const a = new AssistantService(pool, config, null);
    const r = await a.ask(user, { message: 'who is on shift now?' });
    const again = await a.ask(user, { conversationId: r.conversationId, message: 'and any escalations?' });
    expect(again.conversationId).toBe(r.conversationId);
    expect((await a.conversation(user, r.conversationId)).messages).toHaveLength(4);
    const admin = await sessionFor('admin@test.local');
    await expect(a.conversation(admin, r.conversationId)).rejects.toThrow();
    await expect(a.ask(admin, { conversationId: r.conversationId, message: 'hello' })).rejects.toThrow();
    const audits = await many<{ detail: Record<string, unknown> }>(pool, `SELECT detail FROM audit_events WHERE action = 'assistant.asked'`);
    expect(audits).toHaveLength(2);
    expect(JSON.stringify(audits)).not.toContain('escalations?');
  });
});

describe('assistant tools', () => {
  it('never return patient names or identifiers', async () => {
    const user = await sessionFor('admin@test.local');
    await routeOne('ACC1');
    const outputs: string[] = [];
    for (const t of TOOLS) {
      const input = t.name === 'explain_study' ? { accession: 'ACC1' } : Object.fromEntries(Object.keys((t.schema as { properties: object }).properties).map((k) => [k, null]));
      const r = await runTool({ pool, config, user }, t.name, input);
      expect(r.ok).toBe(true);
      outputs.push(JSON.stringify(r.result));
    }
    const all = outputs.join('\n');
    expect(all).toContain('ACC1');
    expect(all).not.toContain('MRN-SECRET-1');
    expect(all).not.toMatch(/Test\^?Patient|Patient Test|Test Patient/);
  });

  it('refuse tools the user has no permission for', async () => {
    const viewer = await sessionFor('viewer@test.local');
    const limited = { ...viewer, permissions: ['dashboard.view' as const] };
    expect((await runTool({ pool, config, user: limited }, 'find_studies', { state: null, accession: null, priority: null, turnaround: null })).ok).toBe(false);
  });
});

describe('Claude engine', () => {
  it('runs the tool loop with the user\'s permissions and the recommended request settings', async () => {
    const user = await radiologistUser();
    const calls: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming[] = [];
    const llm: LlmCall = async (p) => {
      calls.push(JSON.parse(JSON.stringify(p)));
      if (calls.length === 1) {
        return message([toolUse('t1', 'my_schedule', { fromDate: null, days: 7 }), toolUse('t2', 'audit_everything', {})], 'tool_use');
      }
      return message([text('You have a reporting shift today.')], 'end_turn');
    };
    const r = await new AssistantService(pool, config, llm).ask(user, { message: 'What is scheduled under my name?' });
    expect(r).toMatchObject({ engine: 'claude', reply: 'You have a reporting shift today.' });
    expect(r.tools).toEqual([
      { name: 'my_schedule', input: { fromDate: null, days: 7 }, ok: true },
      { name: 'audit_everything', input: {}, ok: false },
    ]);

    const first = calls[0] as unknown as Record<string, unknown>;
    expect(first).toMatchObject({ model: 'claude-opus-5-5', thinking: { type: 'adaptive' }, fallbacks: 'default', betas: ['server-side-fallback-2026-07-01'] });
    const tools = first.tools as { name: string; strict: boolean }[];
    expect(tools.every((t) => t.strict)).toBe(true);
    expect(tools.map((t) => t.name)).toContain('my_schedule');

    // Both tool results go back in one user message; the unknown tool is an error result.
    const second = calls[1].messages;
    const results = second[second.length - 1].content as { tool_use_id: string; is_error: boolean; content: string }[];
    expect(results.map((x) => [x.tool_use_id, x.is_error])).toEqual([['t1', false], ['t2', true]]);
    expect(results[0].content).toContain('Dr One');
  });

  it('falls back to the built-in assistant when Claude cannot be reached', async () => {
    const user = await radiologistUser();
    const llm: LlmCall = async () => {
      throw new Error('socket hang up');
    };
    const r = await new AssistantService(pool, config, llm).ask(user, { message: 'my shifts this week' });
    expect(r.engine).toBe('built-in');
    expect(r.note).toContain('built-in assistant');
    expect(r.reply).toContain('Reporting shift');
  });

  it('drafts a rule change for review, retrying once on validation errors, and never saves it', async () => {
    const user = await sessionFor('admin@test.local');
    const current = (await one<{ definition: Record<string, unknown> }>(pool, `SELECT definition FROM rule_sets WHERE status = 'published'`))!.definition;
    let n = 0;
    const llm: LlmCall = async () => {
      n++;
      const bad = { ...current, routing: [{ id: 'x-ray', name: 'XR', priority: 5, when: { fact: 'study.modality', op: 'eq', value: 'XR' }, teamCode: 'NOPE', reasonCode: 'XR_TEAM' }] };
      const good = { ...current, routing: [...(current.routing as unknown[]), { id: 'x-ray', name: 'XR to general', priority: 5, when: { fact: 'study.modality', op: 'eq', value: 'XR' }, teamCode: 'GENERAL', reasonCode: 'XR_TEAM' }] };
      return message([text(JSON.stringify({ summary: 'Send X-rays to general reporting.', definition: n === 1 ? bad : good }))], 'end_turn');
    };
    const drafts = (await many(pool, 'SELECT 1 FROM rule_sets')).length;
    const r = await new AssistantService(pool, config, llm).draftRules(user, 'Send all X-rays to the general team');
    expect(n).toBe(2);
    expect(r.summary).toBe('Send X-rays to general reporting.');
    expect((r.definition as { routing: { id: string }[] }).routing.map((x) => x.id)).toContain('x-ray');
    expect((await many(pool, 'SELECT 1 FROM rule_sets')).length).toBe(drafts);

    await expect(new AssistantService(pool, config, null).draftRules(user, 'anything')).rejects.toThrow('needs Claude');
  });
});
