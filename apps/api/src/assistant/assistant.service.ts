import Anthropic from '@anthropic-ai/sdk';
import type { Pool } from 'pg';
import { audit } from '../audit/audit';
import type { SessionUser } from '../auth/auth.service';
import type { AppConfig } from '../config';
import { many, one, withTransaction } from '../database/db';
import { RuleError, RulesService } from '../rules/rules.service';
import { Conflict, NotFound } from '../studies/studies.service';
import { builtInAnswer, describeStudy, describeOperations } from './built-in';
import { operationsFacts, runTool, studyFacts, toolDefinitions, type ToolContext } from './tools';

type CreateParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
/** One call to the Messages API. Injected so tests can stand in for Claude. */
export type LlmCall = (params: CreateParams) => Promise<Anthropic.Beta.BetaMessage>;

export interface ToolUse {
  name: string;
  input: unknown;
  ok: boolean;
}

export interface Reply {
  conversationId: string;
  reply: string;
  tools: ToolUse[];
  engine: 'claude' | 'built-in';
  note?: string;
}

const MAX_TOOL_ROUNDS = 6;
const MAX_HISTORY = 20;

function systemPrompt(user: SessionUser): string {
  const now = new Date().toLocaleString('en-GB', { timeZone: 'Europe/London', dateStyle: 'full', timeStyle: 'short' });
  return [
    'You are the VerdFlow assistant, inside a teleradiology workflow system used by radiologists, reporting coordinators and administrators.',
    `The person asking is ${user.fullName} (roles: ${user.roles.join(', ')}). It is now ${now}, UK time.`,
    'Answer from VerdFlow data only, using the tools. If the tools do not hold the answer, say so plainly; never guess times, names or numbers.',
    'You can read but not change anything. When someone asks you to do something (cancel, reassign, approve), tell them where in VerdFlow to do it.',
    'Refer to studies by accession number. You never see patient names or identifiers, and must not ask for them.',
    'Write in plain UK English. Keep answers short: lead with the answer, then a brief list if there is more than one item. Show times as given by the tools (UK time).',
  ].join('\n');
}

/**
 * Configured from the environment: uses Claude when an Anthropic credential is present and the
 * assistant is enabled, and the built-in engine otherwise (or if a Claude call fails).
 */
export function defaultLlm(config: AppConfig): LlmCall | null {
  if (!config.aiEnabled || !(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN)) return null;
  const client = new Anthropic();
  return (params) => client.beta.messages.create(params);
}

export class AssistantService {
  constructor(
    private readonly pool: Pool,
    private readonly config: AppConfig,
    private readonly llm: LlmCall | null = defaultLlm(config),
  ) {}

  get engine(): 'claude' | 'built-in' {
    return this.llm ? 'claude' : 'built-in';
  }

  conversations(user: SessionUser) {
    return many(this.pool, 'SELECT id, title, created_at, updated_at FROM ai_conversations WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 50', [user.id]);
  }

  async conversation(user: SessionUser, id: string) {
    const c = await one<{ id: string; title: string }>(this.pool, 'SELECT id, title FROM ai_conversations WHERE id = $1 AND user_id = $2', [id, user.id]);
    if (!c) throw new NotFound();
    const messages = await many(this.pool, 'SELECT id, role, content, tools, engine, created_at FROM ai_messages WHERE conversation_id = $1 ORDER BY id', [id]);
    return { ...c, messages };
  }

  async ask(user: SessionUser, input: { conversationId?: string | null; message?: string }, ip?: string): Promise<Reply> {
    const message = String(input.message ?? '').trim();
    if (!message) throw new Conflict('Type a question');
    if (message.length > 2000) throw new Conflict('Please keep questions under 2,000 characters');

    let conversationId = input.conversationId ?? null;
    if (conversationId) {
      const own = await one(this.pool, 'SELECT 1 FROM ai_conversations WHERE id = $1 AND user_id = $2', [conversationId, user.id]);
      if (!own) throw new NotFound();
    } else {
      conversationId = (await one<{ id: string }>(this.pool, 'INSERT INTO ai_conversations (user_id, title) VALUES ($1, $2) RETURNING id', [user.id, message.slice(0, 60)]))!.id;
    }
    const history = (
      await many<{ role: 'user' | 'assistant'; content: string }>(
        this.pool,
        'SELECT role, content FROM (SELECT id, role, content FROM ai_messages WHERE conversation_id = $1 ORDER BY id DESC LIMIT $2) h ORDER BY id',
        [conversationId, MAX_HISTORY],
      )
    ).map((m) => ({ role: m.role, content: m.content }));

    const ctx: ToolContext = { pool: this.pool, config: this.config, user };
    let result: Omit<Reply, 'conversationId'>;
    if (this.llm) {
      try {
        result = { ...(await this.askClaude(ctx, history, message)), engine: 'claude' };
      } catch (err) {
        const built = await builtInAnswer(ctx, message);
        result = { ...built, engine: 'built-in', note: `Claude was not reachable (${errorKind(err)}), so this answer comes from the built-in assistant.` };
      }
    } else {
      result = { ...(await builtInAnswer(ctx, message)), engine: 'built-in' };
    }

    await withTransaction(this.pool, async (client) => {
      await client.query(`INSERT INTO ai_messages (conversation_id, role, content, engine) VALUES ($1, 'user', $2, NULL)`, [conversationId, message]);
      await client.query(`INSERT INTO ai_messages (conversation_id, role, content, tools, engine) VALUES ($1, 'assistant', $2, $3, $4)`, [
        conversationId,
        result.reply,
        JSON.stringify(result.tools),
        result.engine,
      ]);
      await client.query('UPDATE ai_conversations SET updated_at = now() WHERE id = $1', [conversationId]);
      // The question itself may contain anything the user typed, so only the shape of the exchange is audited.
      await audit(client, {
        actorType: 'user',
        actorId: user.id,
        action: 'assistant.asked',
        entityType: 'ai_conversation',
        entityId: conversationId,
        detail: { engine: result.engine, tools: result.tools.map((t) => t.name) },
        ip,
      });
    });
    return { conversationId: conversationId!, ...result };
  }

  /** Manual tool loop: each tool call is permission-checked and validated before it runs. */
  private async askClaude(ctx: ToolContext, history: { role: 'user' | 'assistant'; content: string }[], message: string) {
    const tools = toolDefinitions(ctx.user);
    const messages: Anthropic.Beta.BetaMessageParam[] = [...history, { role: 'user', content: message }];
    const used: ToolUse[] = [];
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const res = await this.llm!({
        model: this.config.aiModel,
        max_tokens: 16000,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'low' },
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: systemPrompt(ctx.user),
        tools,
        messages,
      });
      if (res.stop_reason === 'refusal') {
        return { reply: 'I cannot help with that request. Try asking about schedules, studies, turnaround or escalations.', tools: used };
      }
      messages.push({ role: 'assistant', content: res.content });
      const calls = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
      if (res.stop_reason !== 'tool_use' || calls.length === 0) {
        const text = res.content
          .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('\n')
          .trim();
        return { reply: text || 'I could not find an answer to that.', tools: used };
      }
      // Run in parallel, record in the order Claude asked, and send every result back in one message.
      const results = await Promise.all(
        calls.map(async (c) => {
          const r = await runTool(ctx, c.name, c.input).catch((err: Error) => ({ ok: false, result: { error: err.message } }));
          return {
            type: 'tool_result' as const,
            tool_use_id: c.id,
            content: JSON.stringify(r.result).slice(0, 30_000),
            is_error: !r.ok,
          };
        }),
      );
      calls.forEach((c, i) => used.push({ name: c.name, input: c.input, ok: !results[i].is_error }));
      messages.push({ role: 'user', content: results });
    }
    return { reply: 'That needed more look-ups than I am allowed for one question. Try asking something narrower.', tools: used };
  }

  /** "Explain this study" on the study page. */
  async explainStudy(user: SessionUser, studyId: string): Promise<{ text: string; engine: 'claude' | 'built-in' }> {
    const s = await one<{ accession: string }>(this.pool, 'SELECT accession FROM studies WHERE id = $1', [studyId]);
    if (!s) throw new NotFound();
    const facts = await studyFacts(this.pool, s.accession);
    const text = await this.summarise(
      'Explain this study to a reporting coordinator in plain UK English, in at most 150 words: where it is now, why it was routed to this team and radiologist (or why it was not), anything that went wrong, and anything they should do next. Use only these facts.',
      facts,
    );
    await audit(this.pool, { actorType: 'user', actorId: user.id, action: 'assistant.explained_study', entityType: 'study', entityId: studyId, detail: { engine: text.engine } });
    return text.ok ? { text: text.text, engine: text.engine } : { text: describeStudy(facts), engine: 'built-in' };
  }

  /** Short operations briefing for the dashboard. */
  async briefing(): Promise<{ text: string; engine: 'claude' | 'built-in' }> {
    const facts = await operationsFacts(this.pool, this.config);
    const text = await this.summarise(
      'Write a short operations briefing (at most 6 bullet points, plain UK English) for the reporting coordinator from these figures. Lead with anything that needs action now. Do not invent figures.',
      facts,
    );
    return text.ok ? { text: text.text, engine: text.engine } : { text: describeOperations(facts as Record<string, number>), engine: 'built-in' };
  }

  private async summarise(instruction: string, facts: unknown): Promise<{ ok: boolean; text: string; engine: 'claude' | 'built-in' }> {
    if (!this.llm) return { ok: false, text: '', engine: 'built-in' };
    try {
      const res = await this.llm({
        model: this.config.aiModel,
        max_tokens: 16000,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'low' },
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        messages: [{ role: 'user', content: `${instruction}\n\n<facts>\n${JSON.stringify(facts)}\n</facts>` }],
      });
      const text = res.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text').map((b) => b.text).join('\n').trim();
      return res.stop_reason === 'refusal' || !text ? { ok: false, text: '', engine: 'built-in' } : { ok: true, text, engine: 'claude' };
    } catch {
      return { ok: false, text: '', engine: 'built-in' };
    }
  }

  /**
   * Turns a plain-English change into a proposed rule set. The proposal is validated like any draft
   * and returned for a person to review; it is never saved or published here.
   */
  async draftRules(user: SessionUser, instruction: string): Promise<{ definition: unknown; summary: string }> {
    if (!this.llm) throw new Conflict('Drafting rules from a description needs Claude. Set ANTHROPIC_API_KEY to turn it on.');
    const text = String(instruction ?? '').trim();
    if (!text) throw new Conflict('Describe the change you want');
    if (text.length > 2000) throw new Conflict('Please keep the description under 2,000 characters');
    const rules = new RulesService(this.pool);
    const current = (await rules.list()).find((r) => r.status === 'published');
    const [teams, modalities, services] = await Promise.all([
      many<{ code: string; name: string }>(this.pool, 'SELECT code, name FROM teams WHERE active ORDER BY code'),
      many<{ code: string }>(this.pool, 'SELECT code FROM modalities WHERE active ORDER BY code'),
      many<{ code: string; name: string }>(this.pool, 'SELECT code, name FROM services WHERE active ORDER BY code'),
    ]);
    const brief = [
      'You edit VerdFlow rule sets. Apply the requested change to the current rule set and return the complete new rule set.',
      'Return only one JSON object: {"summary": "<one or two sentences in plain UK English saying what changed>", "definition": <the full rule set>}.',
      'Rule set shape: {routing: RoutingRule[], exclusions: ExclusionRule[], continuity: {enabled}, tat: {warnAtPercent, profiles: [{priority, intervals: [{code, minutes}]}]}, peerReview: {enabled, percent, dailyCapPerReviewer}}.',
      'RoutingRule: {id (lowercase, digits, hyphens), name, priority (unique whole number; lowest wins), when: Condition, teamCode, reasonCode (CAPITALS_AND_UNDERSCORES)}.',
      'ExclusionRule: {id, name, when: Condition, reasonCode}. A radiologist is excluded when it matches.',
      'Condition: {fact, op, value?} | {all: Condition[]} | {any: Condition[]} | {not: Condition}. Ops: eq, neq, in, not_in (value is a list), contains, exists, missing (no value).',
      'Study facts: study.hospitalCode, study.modality, study.serviceCode, study.priority (STAT|URGENT|ROUTINE), study.location, study.room. Radiologist facts (exclusions only): radiologist.code, radiologist.grade, radiologist.specialties.',
      'Turnaround interval codes: received_to_ready, ready_to_delivered, ready_to_accepted, accepted_to_preliminary, accepted_to_final, preliminary_to_final, ready_to_final.',
      `Teams: ${teams.map((t) => `${t.code} (${t.name})`).join(', ')}. Modalities: ${modalities.map((m) => m.code).join(', ')}. Services: ${services.map((s) => `${s.code} (${s.name})`).join(', ')}.`,
      'Keep every rule the request does not mention exactly as it is.',
    ].join('\n');
    let prompt = `${brief}\n\n<current_rule_set>\n${JSON.stringify(current?.definition ?? {})}\n</current_rule_set>\n\n<requested_change>\n${text}\n</requested_change>`;
    let lastIssues: string[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.llm({
        model: this.config.aiModel,
        max_tokens: 16000,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'medium' },
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        messages: [{ role: 'user', content: prompt }],
      });
      if (res.stop_reason === 'refusal') throw new Conflict('That change could not be drafted. Try describing it differently.');
      const out = res.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text').map((b) => b.text).join('');
      let parsed: { summary?: unknown; definition?: unknown };
      try {
        parsed = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
      } catch {
        lastIssues = ['The proposal was not valid JSON'];
        prompt += `\n\nYour last answer was not valid JSON. Return only the JSON object.`;
        continue;
      }
      try {
        const definition = await rules.validate(parsed.definition);
        await audit(this.pool, { actorType: 'user', actorId: user.id, action: 'assistant.drafted_rules', detail: { attempt: attempt + 1 } });
        return { definition, summary: typeof parsed.summary === 'string' ? parsed.summary.slice(0, 500) : 'Proposed change' };
      } catch (err) {
        if (!(err instanceof RuleError)) throw err;
        lastIssues = err.issues;
        prompt += `\n\nYour last proposal failed validation:\n${err.issues.map((i) => `- ${i}`).join('\n')}\nFix these and return the whole JSON object again.`;
      }
    }
    throw new RuleError('The proposed rule set did not pass validation', 400, lastIssues);
  }
}

function errorKind(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return 'the API key was not accepted';
  if (err instanceof Anthropic.RateLimitError) return 'rate limited';
  if (err instanceof Anthropic.APIConnectionError) return 'no connection';
  if (err instanceof Anthropic.APIError) return `error ${err.status}`;
  return 'unexpected error';
}
