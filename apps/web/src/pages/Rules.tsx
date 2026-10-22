import {
  EMPTY_RULE_SET,
  OPERATORS,
  RADIOLOGIST_FACTS,
  STUDY_FACTS,
  TAT_INTERVALS,
  type Condition,
  type ExclusionRule,
  type RoutingRule,
  type RuleSetDefinition,
  type TatIntervalCode,
} from '@vf/shared';
import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { useCan, useMe } from '../App';
import { ErrorBox, State, When } from '../components/ui';
import { useResource } from '../hooks';

interface RuleSetRow {
  id: string;
  version: number;
  status: string;
  definition: RuleSetDefinition;
  note: string | null;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
  decided_by_name: string | null;
  decided_at: string | null;
  decision_note: string | null;
}

const OP_LABEL: Record<string, string> = {
  eq: 'is',
  neq: 'is not',
  in: 'is one of',
  not_in: 'is none of',
  contains: 'includes',
  exists: 'is present',
  missing: 'is missing',
};

/** Plain-English rendering of a condition tree. */
export function describe(c: Condition): string {
  if ('all' in c) return c.all.map(describe).join(' and ');
  if ('any' in c) return `(${c.any.map(describe).join(' or ')})`;
  if ('not' in c) return `not (${describe(c.not)})`;
  const v = Array.isArray(c.value) ? c.value.join(', ') : (c.value ?? '');
  return `${c.fact.replace(/^(study|radiologist)\./, '$1 ')} ${OP_LABEL[c.op]}${v ? ` ${v}` : ''}`;
}

/** Rule sets saved before turnaround and peer review existed get the defaults. */
const withDefaults = (d: Partial<RuleSetDefinition> | undefined): RuleSetDefinition => ({
  ...EMPTY_RULE_SET,
  ...(d ?? {}),
  continuity: { ...EMPTY_RULE_SET.continuity, ...(d?.continuity ?? {}) },
  ranking: { ...EMPTY_RULE_SET.ranking, ...(d?.ranking ?? {}) },
});
const PRIORITIES = ['STAT', 'URGENT', 'ROUTINE'] as const;

function TatEditor({ def, onChange }: { def: RuleSetDefinition; onChange: (d: RuleSetDefinition) => void }) {
  const minutes = (priority: string, code: TatIntervalCode) =>
    def.tat.profiles.find((p) => p.priority === priority)?.intervals.find((i) => i.code === code)?.minutes;
  const set = (priority: (typeof PRIORITIES)[number], code: TatIntervalCode, value: string) => {
    const n = value === '' ? null : Math.max(1, Math.round(Number(value)));
    const profiles = PRIORITIES.map((p) => {
      const existing = def.tat.profiles.find((x) => x.priority === p) ?? { priority: p, intervals: [] };
      if (p !== priority) return existing;
      const others = existing.intervals.filter((i) => i.code !== code);
      return { priority: p, intervals: n ? [...others, { code, minutes: n }] : others };
    }).filter((p) => p.intervals.length > 0);
    onChange({ ...def, tat: { ...def.tat, profiles } });
  };
  return (
    <>
      <h3>Turnaround targets (minutes; leave blank for none)</h3>
      <table>
        <thead>
          <tr>
            <th>Interval</th>
            {PRIORITIES.map((p) => (
              <th key={p}>{p}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {(Object.keys(TAT_INTERVALS) as TatIntervalCode[]).map((code) => (
            <tr key={code}>
              <td>{TAT_INTERVALS[code].label}</td>
              {PRIORITIES.map((p) => (
                <td key={p}>
                  <input type="number" min={1} style={{ width: 90 }} value={minutes(p, code) ?? ''} onChange={(e) => set(p, code, e.target.value)} aria-label={`${p} ${code}`} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <label style={{ marginTop: '0.5rem', maxWidth: 260 }}>
        Warn when this share of the target has passed (%)
        <input type="number" min={10} max={99} value={def.tat.warnAtPercent} onChange={(e) => onChange({ ...def, tat: { ...def.tat, warnAtPercent: Number(e.target.value) } })} />
      </label>
      <h3>Peer review</h3>
      <div className="row">
        <label style={{ flexDirection: 'row', alignItems: 'center', gap: '0.4rem' }}>
          <input type="checkbox" checked={def.peerReview.enabled} onChange={(e) => onChange({ ...def, peerReview: { ...def.peerReview, enabled: e.target.checked } })} />
          Review a share of final reports
        </label>
        <label>
          Share (%)
          <input type="number" min={0} max={100} value={def.peerReview.percent} onChange={(e) => onChange({ ...def, peerReview: { ...def.peerReview, percent: Number(e.target.value) } })} style={{ width: 90 }} />
        </label>
        <label>
          Reviews per reviewer per day
          <input type="number" min={1} max={200} value={def.peerReview.dailyCapPerReviewer} onChange={(e) => onChange({ ...def, peerReview: { ...def.peerReview, dailyCapPerReviewer: Number(e.target.value) } })} style={{ width: 90 }} />
        </label>
      </div>
    </>
  );
}

type Leaf = Extract<Condition, { fact: string }>;
/** The basic editor handles a list of conditions joined by "and". Anything deeper is edited as JSON. */
function asLeaves(c: Condition): Leaf[] | null {
  if ('fact' in c) return [c];
  if ('all' in c && c.all.every((x) => 'fact' in x)) return c.all as Leaf[];
  return null;
}
const fromLeaves = (l: Leaf[]): Condition => (l.length === 1 ? l[0] : { all: l });

function ConditionEditor({ value, facts, onChange }: { value: Condition; facts: readonly string[]; onChange: (c: Condition) => void }) {
  const leaves = asLeaves(value);
  if (!leaves) return <div className="small muted">Nested condition: {describe(value)}. Edit it in the JSON view.</div>;
  const set = (i: number, patch: Partial<Leaf>) => {
    const next = leaves.map((l, j) => (j === i ? ({ ...l, ...patch } as Leaf) : l));
    onChange(fromLeaves(next));
  };
  return (
    <div>
      {leaves.map((l, i) => {
        const list = l.op === 'in' || l.op === 'not_in';
        const none = l.op === 'exists' || l.op === 'missing';
        return (
          <div className="row" key={i} style={{ marginBottom: '0.3rem' }}>
            <span className="small muted" style={{ width: 28 }}>{i === 0 ? 'If' : 'and'}</span>
            <select value={l.fact} onChange={(e) => set(i, { fact: e.target.value as Leaf['fact'] })}>
              {facts.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
            <select
              value={l.op}
              onChange={(e) => {
                const op = e.target.value as Leaf['op'];
                const value = op === 'exists' || op === 'missing' ? undefined : op === 'in' || op === 'not_in' ? (Array.isArray(l.value) ? l.value : l.value ? [l.value] : []) : Array.isArray(l.value) ? (l.value[0] ?? '') : (l.value ?? '');
                set(i, { op, value });
              }}
            >
              {OPERATORS.map((o) => (
                <option key={o} value={o}>
                  {OP_LABEL[o]}
                </option>
              ))}
            </select>
            {!none && (
              <input
                value={Array.isArray(l.value) ? l.value.join(', ') : (l.value ?? '')}
                placeholder={list ? 'CT, MR' : 'value'}
                onChange={(e) => set(i, { value: list ? e.target.value.split(',').map((s) => s.trim()).filter(Boolean) : e.target.value })}
              />
            )}
            {leaves.length > 1 && (
              <button className="secondary" type="button" onClick={() => onChange(fromLeaves(leaves.filter((_, j) => j !== i)))}>
                Remove
              </button>
            )}
          </div>
        );
      })}
      <button className="secondary" type="button" onClick={() => onChange(fromLeaves([...leaves, { fact: facts[0] as Leaf['fact'], op: 'eq', value: '' }]))}>
        Add condition
      </button>
    </div>
  );
}

function Editor({ draft, onSaved }: { draft: RuleSetRow | null; onSaved: (r: RuleSetRow) => void }) {
  const base = withDefaults(draft?.definition);
  const [def, setDef] = useState<RuleSetDefinition>(base);
  const [json, setJson] = useState(JSON.stringify(base, null, 2));
  const [mode, setMode] = useState<'basic' | 'json'>('basic');
  const [note, setNote] = useState(draft?.note ?? '');
  const [err, setErr] = useState<{ message: string; issues: string[] } | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  useEffect(() => {
    setDef(base);
    setJson(JSON.stringify(base, null, 2));
    setNote(draft?.note ?? '');
  }, [draft?.id]);

  const current = (): RuleSetDefinition | null => {
    if (mode === 'basic') return def;
    try {
      return JSON.parse(json);
    } catch {
      setErr({ message: 'The JSON is not valid', issues: [] });
      return null;
    }
  };
  const switchMode = (m: 'basic' | 'json') => {
    if (m === 'json') setJson(JSON.stringify(def, null, 2));
    else {
      try {
        setDef(withDefaults(JSON.parse(json)));
      } catch {
        setErr({ message: 'Fix the JSON before switching to the basic view', issues: [] });
        return;
      }
    }
    setMode(m);
  };
  const run = async (fn: (d: RuleSetDefinition) => Promise<unknown>, msg: string) => {
    setErr(null);
    setOk(null);
    const d = current();
    if (!d) return;
    try {
      await fn(d);
      setOk(msg);
    } catch (e) {
      setErr({ message: (e as Error).message, issues: e instanceof ApiError ? e.issues : [] });
    }
  };
  const [ask, setAsk] = useState('');
  const [drafting, setDrafting] = useState(false);
  const draftFromDescription = async () => {
    setErr(null);
    setOk(null);
    setDrafting(true);
    try {
      const r = await api<{ definition: RuleSetDefinition; summary: string }>('/assistant/draft-rules', { method: 'POST', body: { instruction: ask } });
      const d = withDefaults(r.definition);
      setDef(d);
      setJson(JSON.stringify(d, null, 2));
      setOk(`Proposed by Claude: ${r.summary} Check every rule below, then save the draft. Nothing is saved or published until you do.`);
    } catch (e) {
      setErr({ message: (e as Error).message, issues: e instanceof ApiError ? e.issues : [] });
    } finally {
      setDrafting(false);
    }
  };
  const setRouting = (i: number, r: RoutingRule) => setDef({ ...def, routing: def.routing.map((x, j) => (j === i ? r : x)) });
  const setExclusion = (i: number, r: ExclusionRule) => setDef({ ...def, exclusions: def.exclusions.map((x, j) => (j === i ? r : x)) });

  return (
    <div className="panel">
      <div className="notice">
        <label>
          Describe a change and Claude will propose the rules, for you to check
          <div className="row">
            <input style={{ flex: 1 }} value={ask} maxLength={2000} onChange={(e) => setAsk(e.target.value)} placeholder="For example: send all ultrasound from City Hospital to the general team" />
            <button className="secondary" onClick={draftFromDescription} disabled={drafting || !ask.trim()}>
              {drafting ? 'Drafting…' : 'Propose'}
            </button>
          </div>
        </label>
      </div>
      <div className="tabs">
        <button className={mode === 'basic' ? 'active' : ''} onClick={() => switchMode('basic')}>
          Basic
        </button>
        <button className={mode === 'json' ? 'active' : ''} onClick={() => switchMode('json')}>
          Advanced (JSON)
        </button>
      </div>
      {mode === 'json' ? (
        <textarea rows={24} value={json} onChange={(e) => setJson(e.target.value)} aria-label="Rule set JSON" />
      ) : (
        <>
          <h3>Choosing the radiologist</h3>
          <label style={{ flexDirection: 'row', alignItems: 'center', gap: '0.5rem' }}>
            <input type="checkbox" checked={def.continuity.enabled} onChange={(e) => setDef({ ...def, continuity: { ...def.continuity, enabled: e.target.checked } })} />
            Prefer the same radiologist for the same patient (only when they are eligible: on shift, not on a break, under capacity)
          </label>
          <div className="row" style={{ margin: '0.5rem 0' }}>
            <label>
              "Same patient" means
              <select value={def.continuity.matchOn} onChange={(e) => setDef({ ...def, continuity: { ...def.continuity, matchOn: e.target.value as 'encounter' | 'team' } })}>
                <option value="encounter">the same encounter</option>
                <option value="team">the same patient and specialty (team)</option>
              </select>
            </label>
            <label>
              Then give the study to
              <select value={def.ranking.prefer} onChange={(e) => setDef({ ...def, ranking: { prefer: e.target.value as 'least_loaded' | 'earliest_clock_in' } })}>
                <option value="least_loaded">the least loaded radiologist</option>
                <option value="earliest_clock_in">whoever clocked in first this shift</option>
              </select>
            </label>
          </div>
          <h3>Routing to a team (lowest priority number wins)</h3>
          {def.routing.map((r, i) => (
            <div className="panel" key={i} style={{ background: '#fff' }}>
              <div className="row">
                <label>
                  Name
                  <input value={r.name} onChange={(e) => setRouting(i, { ...r, name: e.target.value })} />
                </label>
                <label>
                  ID
                  <input value={r.id} onChange={(e) => setRouting(i, { ...r, id: e.target.value })} style={{ width: 130 }} />
                </label>
                <label>
                  Priority
                  <input type="number" value={r.priority} onChange={(e) => setRouting(i, { ...r, priority: Number(e.target.value) })} style={{ width: 90 }} />
                </label>
                <label>
                  Team code
                  <input value={r.teamCode} onChange={(e) => setRouting(i, { ...r, teamCode: e.target.value.toUpperCase() })} style={{ width: 110 }} />
                </label>
                <label>
                  Reason code
                  <input value={r.reasonCode} onChange={(e) => setRouting(i, { ...r, reasonCode: e.target.value.toUpperCase() })} style={{ width: 160 }} />
                </label>
                <button className="danger" type="button" onClick={() => setDef({ ...def, routing: def.routing.filter((_, j) => j !== i) })}>
                  Delete
                </button>
              </div>
              <ConditionEditor value={r.when} facts={STUDY_FACTS} onChange={(when) => setRouting(i, { ...r, when })} />
            </div>
          ))}
          <button
            className="secondary"
            onClick={() =>
              setDef({
                ...def,
                routing: [
                  ...def.routing,
                  { id: `rule-${def.routing.length + 1}`, name: 'New routing rule', priority: (Math.max(0, ...def.routing.map((r) => r.priority)) || 0) + 10, when: { fact: 'study.modality', op: 'eq', value: 'CT' }, teamCode: 'GENERAL', reasonCode: 'NEW_RULE' },
                ],
              })
            }
          >
            Add routing rule
          </button>
          <h3>Exclusions (a radiologist is excluded when the conditions match, or cannot be checked)</h3>
          {def.exclusions.map((r, i) => (
            <div className="panel" key={i} style={{ background: '#fff' }}>
              <div className="row">
                <label>
                  Name
                  <input value={r.name} onChange={(e) => setExclusion(i, { ...r, name: e.target.value })} />
                </label>
                <label>
                  ID
                  <input value={r.id} onChange={(e) => setExclusion(i, { ...r, id: e.target.value })} style={{ width: 150 }} />
                </label>
                <label>
                  Reason code
                  <input value={r.reasonCode} onChange={(e) => setExclusion(i, { ...r, reasonCode: e.target.value.toUpperCase() })} style={{ width: 200 }} />
                </label>
                <button className="danger" type="button" onClick={() => setDef({ ...def, exclusions: def.exclusions.filter((_, j) => j !== i) })}>
                  Delete
                </button>
              </div>
              <ConditionEditor value={r.when} facts={[...STUDY_FACTS, ...RADIOLOGIST_FACTS]} onChange={(when) => setExclusion(i, { ...r, when })} />
            </div>
          ))}
          <button
            className="secondary"
            onClick={() =>
              setDef({
                ...def,
                exclusions: [...def.exclusions, { id: `exclusion-${def.exclusions.length + 1}`, name: 'New exclusion', when: { fact: 'radiologist.grade', op: 'eq', value: 'REGISTRAR' }, reasonCode: 'NEW_EXCLUSION' }],
              })
            }
          >
            Add exclusion
          </button>
          <TatEditor def={def} onChange={setDef} />
        </>
      )}
      <label style={{ marginTop: '0.8rem' }}>
        Change note for the approver
        <input value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      {err && <ErrorBox error={err.message} issues={err.issues} />}
      {ok && <div className="notice">{ok}</div>}
      <div className="row" style={{ marginTop: '0.8rem' }}>
        <button className="secondary" onClick={() => run((d) => api('/rules/validate', { method: 'POST', body: { definition: d } }), 'The rule set is valid.')}>
          Check
        </button>
        <button
          onClick={() =>
            run(async (d) => {
              const saved = draft
                ? await api<RuleSetRow>(`/rules/${draft.id}`, { method: 'PUT', body: { definition: d, note } })
                : await api<RuleSetRow>('/rules', { method: 'POST', body: { definition: d, note } });
              onSaved(saved);
            }, 'Draft saved.')
          }
        >
          Save draft
        </button>
      </div>
    </div>
  );
}

export function Rules() {
  const { data, error, reload } = useResource<RuleSetRow[]>('/rules');
  const can = useCan();
  const me = useMe();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<RuleSetRow | null | 'new'>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const selected = data?.find((r) => r.id === selectedId) ?? data?.find((r) => r.status === 'published') ?? null;

  const act = async (fn: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await fn();
      await reload();
    } catch (e) {
      setActionError((e as Error).message);
    }
  };
  const newDraftFrom = async (r: RuleSetRow) =>
    act(async () => {
      const d = await api<RuleSetRow>('/rules', { method: 'POST', body: { definition: r.definition, note: `Based on version ${r.version}` } });
      setSelectedId(d.id);
      setEditing(d);
    });

  return (
    <>
      <h1>Rules</h1>
      <p className="muted small">
        A rule set is written as a draft, checked, submitted, and published by a different person. Each decision records the version it used, so
        past decisions stay explainable after rules change.
      </p>
      <ErrorBox error={error ?? actionError} />
      <div className="grid2" style={{ gridTemplateColumns: '320px 1fr' }}>
        <div>
          <table>
            <thead>
              <tr>
                <th>Version</th>
                <th>Status</th>
                <th>Author</th>
              </tr>
            </thead>
            <tbody>
              {data?.map((r) => (
                <tr key={r.id} className="clickable" onClick={() => (setSelectedId(r.id), setEditing(null))} style={selected?.id === r.id ? { background: 'var(--teal-50)' } : undefined}>
                  <td>v{r.version}</td>
                  <td>
                    <State value={r.status} />
                  </td>
                  <td className="small">{r.created_by_name ?? 'seed'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {can('rules.author') && (
            <button style={{ marginTop: '0.6rem' }} onClick={() => (selected ? newDraftFrom(selected) : setEditing('new'))}>
              {selected ? `New draft from v${selected.version}` : 'New draft'}
            </button>
          )}
        </div>
        <div>
          {editing ? (
            <Editor
              draft={editing === 'new' ? null : editing}
              onSaved={(r) => {
                setSelectedId(r.id);
                setEditing(r);
                reload();
              }}
            />
          ) : selected ? (
            <div className="panel">
              <h2 style={{ marginTop: 0 }}>
                Version {selected.version} <State value={selected.status} />
              </h2>
              <div className="small muted">
                Written by {selected.created_by_name ?? 'seed'} on <When value={selected.created_at} />
                {selected.decided_by_name && (
                  <>
                    {' '}
                    · decided by {selected.decided_by_name} on <When value={selected.decided_at} />
                  </>
                )}
                {selected.note && <> · “{selected.note}”</>}
              </div>
              <p>
                Same-patient continuity:{' '}
                {withDefaults(selected.definition).continuity.enabled
                  ? withDefaults(selected.definition).continuity.matchOn === 'team'
                    ? 'on, same patient and specialty'
                    : 'on, same encounter'
                  : 'off'}{' '}
                · Then: {withDefaults(selected.definition).ranking.prefer === 'earliest_clock_in' ? 'whoever clocked in first' : 'least loaded'} · Peer review:{' '}
                {withDefaults(selected.definition).peerReview.enabled
                  ? `${withDefaults(selected.definition).peerReview.percent}% of final reports, up to ${withDefaults(selected.definition).peerReview.dailyCapPerReviewer} a day per reviewer`
                  : 'off'}
              </p>
              {withDefaults(selected.definition).tat.profiles.length > 0 && (
                <>
                  <h3>Turnaround targets</h3>
                  <table>
                    <tbody>
                      {withDefaults(selected.definition).tat.profiles.map((p) => (
                        <tr key={p.priority}>
                          <td style={{ width: 90 }}>{p.priority}</td>
                          <td className="small">{p.intervals.map((i) => `${TAT_INTERVALS[i.code].label}: ${i.minutes} min`).join(' · ')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
              <h3>Routing</h3>
              <table>
                <tbody>
                  {[...selected.definition.routing]
                    .sort((a, b) => a.priority - b.priority)
                    .map((r) => (
                      <tr key={r.id}>
                        <td style={{ width: 60 }}>{r.priority}</td>
                        <td>
                          <strong>{r.name}</strong>
                          <div className="small condition">
                            If {describe(r.when)} → team {r.teamCode}
                          </div>
                        </td>
                        <td>
                          <code className="small">{r.reasonCode}</code>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
              <h3>Exclusions</h3>
              <table>
                <tbody>
                  {selected.definition.exclusions.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <strong>{r.name}</strong>
                        <div className="small condition">Exclude when {describe(r.when)}</div>
                      </td>
                      <td>
                        <code className="small">{r.reasonCode}</code>
                      </td>
                    </tr>
                  ))}
                  {selected.definition.exclusions.length === 0 && (
                    <tr>
                      <td className="muted">None.</td>
                    </tr>
                  )}
                </tbody>
              </table>
              <div className="row" style={{ marginTop: '0.8rem' }}>
                {selected.status === 'draft' && can('rules.author') && (
                  <>
                    <button className="secondary" onClick={() => setEditing(selected)}>
                      Edit draft
                    </button>
                    <button onClick={() => act(() => api(`/rules/${selected.id}/submit`, { method: 'POST' }))}>Submit for approval</button>
                  </>
                )}
                {selected.status === 'submitted' && can('rules.approve') && selected.created_by !== me.id && (
                  <>
                    <button onClick={() => act(() => api(`/rules/${selected.id}/decision`, { method: 'POST', body: { approve: true, note: window.prompt('Approval note (optional)') ?? undefined } }))}>
                      Approve and publish
                    </button>
                    <button className="danger" onClick={() => act(() => api(`/rules/${selected.id}/decision`, { method: 'POST', body: { approve: false, note: window.prompt('Why are you rejecting it?') ?? undefined } }))}>
                      Reject
                    </button>
                  </>
                )}
                {selected.status === 'submitted' && selected.created_by === me.id && <span className="small muted">Waiting for another person to approve.</span>}
              </div>
            </div>
          ) : (
            <p className="muted">No rule sets yet.</p>
          )}
        </div>
      </div>
    </>
  );
}
