import { z } from 'zod';

/**
 * Typed, bounded rule model. Users build condition trees from approved facts and operators only:
 * no expressions, code, SQL or regular expressions. Evaluation uses three-valued logic so a missing
 * fact is "unknown", never silently a match for eligibility.
 */

export const STUDY_FACTS = [
  'study.hospitalCode',
  'study.modality',
  'study.serviceCode',
  'study.priority',
  'study.location',
  'study.room',
] as const;

export const RADIOLOGIST_FACTS = ['radiologist.code', 'radiologist.grade', 'radiologist.specialties'] as const;

export type StudyFact = (typeof STUDY_FACTS)[number];
export type RadiologistFact = (typeof RADIOLOGIST_FACTS)[number];
export type Fact = StudyFact | RadiologistFact;

export const OPERATORS = ['eq', 'neq', 'in', 'not_in', 'contains', 'exists', 'missing'] as const;
export type Operator = (typeof OPERATORS)[number];

export const MAX_CONDITION_DEPTH = 5;
export const MAX_CONDITION_NODES = 100;

export type Condition =
  | { fact: Fact; op: Operator; value?: string | string[] }
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition };

const value = z.string().max(200);

const leaf = (facts: readonly [string, ...string[]]) =>
  z
    .object({
      fact: z.enum(facts),
      op: z.enum(OPERATORS),
      value: z.union([value, z.array(value).max(500)]).optional(),
    })
    .strict()
    .superRefine((c, ctx) => {
      if (c.op === 'exists' || c.op === 'missing') {
        if (c.value !== undefined) ctx.addIssue({ code: 'custom', message: `${c.op} takes no value` });
      } else if (c.op === 'in' || c.op === 'not_in') {
        if (!Array.isArray(c.value) || c.value.length === 0) ctx.addIssue({ code: 'custom', message: `${c.op} needs a list of values` });
      } else if (typeof c.value !== 'string') {
        ctx.addIssue({ code: 'custom', message: `${c.op} needs a single value` });
      }
    });

function conditionSchema(facts: readonly [string, ...string[]]): z.ZodType<Condition> {
  const node: z.ZodType<Condition> = z.lazy(() =>
    z.union([
      leaf(facts),
      z.object({ all: z.array(node).min(1).max(50) }).strict(),
      z.object({ any: z.array(node).min(1).max(50) }).strict(),
      z.object({ not: node }).strict(),
    ]),
  ) as z.ZodType<Condition>;
  return node.superRefine((c, ctx) => {
    const { depth, nodes } = measure(c);
    if (depth > MAX_CONDITION_DEPTH) ctx.addIssue({ code: 'custom', message: `Conditions may be nested at most ${MAX_CONDITION_DEPTH} deep` });
    if (nodes > MAX_CONDITION_NODES) ctx.addIssue({ code: 'custom', message: `A rule may have at most ${MAX_CONDITION_NODES} conditions` });
  });
}

function measure(c: Condition): { depth: number; nodes: number } {
  const kids = 'all' in c ? c.all : 'any' in c ? c.any : 'not' in c ? [c.not] : [];
  let depth = 0;
  let nodes = 1;
  for (const k of kids) {
    const m = measure(k);
    depth = Math.max(depth, m.depth);
    nodes += m.nodes;
  }
  return { depth: depth + 1, nodes };
}

const code = z.string().regex(/^[A-Z0-9_]{2,40}$/, 'Use capitals, digits and underscores');

export const routingRuleSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{2,40}$/),
    name: z.string().min(1).max(120),
    priority: z.number().int().min(1).max(10_000),
    when: conditionSchema(STUDY_FACTS),
    teamCode: code,
    reasonCode: code,
  })
  .strict();

export const exclusionRuleSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{2,40}$/),
    name: z.string().min(1).max(120),
    when: conditionSchema([...STUDY_FACTS, ...RADIOLOGIST_FACTS]),
    reasonCode: code,
  })
  .strict();

export const ruleSetDefinitionSchema = z
  .object({
    routing: z.array(routingRuleSchema).max(500),
    exclusions: z.array(exclusionRuleSchema).max(500),
    continuity: z.object({ enabled: z.boolean() }).strict(),
  })
  .strict()
  .superRefine((d, ctx) => {
    const ids = new Set<string>();
    for (const r of [...d.routing, ...d.exclusions]) {
      if (ids.has(r.id)) ctx.addIssue({ code: 'custom', message: `Rule id ${r.id} is used more than once` });
      ids.add(r.id);
    }
    // Unique priorities make routing deterministic: two rules can never tie at runtime.
    const priorities = new Map<number, string>();
    for (const r of d.routing) {
      const other = priorities.get(r.priority);
      if (other) ctx.addIssue({ code: 'custom', message: `Routing rules ${other} and ${r.id} share priority ${r.priority}` });
      priorities.set(r.priority, r.id);
    }
  });

export type RoutingRule = z.infer<typeof routingRuleSchema>;
export type ExclusionRule = z.infer<typeof exclusionRuleSchema>;
export type RuleSetDefinition = z.infer<typeof ruleSetDefinitionSchema>;

export type FactValue = string | string[] | undefined | null;
export type Facts = Partial<Record<Fact, FactValue>>;

/** true, false, or null for unknown. */
export type Tri = boolean | null;

export function evaluateCondition(c: Condition, facts: Facts): Tri {
  if ('all' in c) {
    let unknown = false;
    for (const k of c.all) {
      const r = evaluateCondition(k, facts);
      if (r === false) return false;
      if (r === null) unknown = true;
    }
    return unknown ? null : true;
  }
  if ('any' in c) {
    let unknown = false;
    for (const k of c.any) {
      const r = evaluateCondition(k, facts);
      if (r === true) return true;
      if (r === null) unknown = true;
    }
    return unknown ? null : false;
  }
  if ('not' in c) {
    const r = evaluateCondition(c.not, facts);
    return r === null ? null : !r;
  }
  const v = facts[c.fact];
  const absent = v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
  if (c.op === 'exists') return !absent;
  if (c.op === 'missing') return absent;
  if (absent) return null;
  const list = Array.isArray(v) ? v : [v as string];
  switch (c.op) {
    case 'eq':
      return list.includes(c.value as string);
    case 'neq':
      return !list.includes(c.value as string);
    case 'in':
      return list.some((x) => (c.value as string[]).includes(x));
    case 'not_in':
      return !list.some((x) => (c.value as string[]).includes(x));
    case 'contains':
      return list.includes(c.value as string);
  }
}

export interface RoutingResult {
  teamCode: string | null;
  ruleId: string | null;
  reasonCode: string;
  /** Rules that could not be decided because a fact was missing. */
  unknownRuleIds: string[];
}

/** Routing picks the matching rule with the lowest priority number. Unknown is never a match. */
export function evaluateRouting(def: RuleSetDefinition, facts: Facts): RoutingResult {
  const unknownRuleIds: string[] = [];
  for (const r of [...def.routing].sort((a, b) => a.priority - b.priority)) {
    const m = evaluateCondition(r.when, facts);
    if (m === true) return { teamCode: r.teamCode, ruleId: r.id, reasonCode: r.reasonCode, unknownRuleIds };
    if (m === null) unknownRuleIds.push(r.id);
  }
  return { teamCode: null, ruleId: null, reasonCode: 'NO_ROUTE', unknownRuleIds };
}

export interface Exclusion {
  ruleId: string;
  reasonCode: string;
}

/** Exclusion rules remove a candidate when they match, and also when they cannot be decided. */
export function evaluateExclusions(def: RuleSetDefinition, facts: Facts): Exclusion[] {
  const out: Exclusion[] = [];
  for (const r of def.exclusions) {
    const m = evaluateCondition(r.when, facts);
    if (m === true) out.push({ ruleId: r.id, reasonCode: r.reasonCode });
    else if (m === null) out.push({ ruleId: r.id, reasonCode: `UNKNOWN_FACT_${r.reasonCode}`.slice(0, 60) });
  }
  return out;
}

export const EMPTY_RULE_SET: RuleSetDefinition = { routing: [], exclusions: [], continuity: { enabled: true } };
