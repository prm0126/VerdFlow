import { ASSIGNMENT_LABELS, TAT_INTERVALS } from '@vf/shared';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { useCan } from '../App';
import { ErrorBox, Reason, State, When } from '../components/ui';
import { useResource } from '../hooks';

interface Candidate {
  radiologistId: string;
  code: string;
  name: string;
  eligible: boolean;
  reasons: string[];
  loadRatio?: number;
  rank?: number;
}

interface Evaluation {
  id: string;
  rule_set_version: number | null;
  facts: Record<string, unknown>;
  routing: { routing: { teamCode: string | null; ruleId: string | null; reasonCode: string; unknownRuleIds: string[] } | null };
  candidates: Candidate[];
  continuity: { enabled?: boolean; scopeKey?: string; priorRadiologistId?: string | null; priorEligible?: boolean; priorReasons?: string[]; preserved?: boolean | null };
  outcome: string;
  reason_code: string;
  created_at: string;
  selected_name: string | null;
}

interface Outbound {
  id: string;
  kind: string;
  control_id: string;
  status: string;
  attempts: number;
  possibly_delivered: boolean;
  ack_code: string | null;
  ack_text: string | null;
  last_error: string | null;
  created_at: string;
  partner_code: string;
  attempts_detail: { attempt: number; started_at: string; outcome: string | null; http_status: number | null; ack_code: string | null; error: string | null }[];
}

interface Detail {
  id: string;
  accession: string;
  issuer: string;
  hospital_name: string;
  patient_name: string | null;
  patient_identifier: string;
  patient_authority: string;
  encounter_number: string | null;
  modality_code: string;
  service_code: string;
  service_text: string | null;
  priority: string;
  location: string | null;
  room: string | null;
  state: string;
  state_reason: string | null;
  created_at: string;
  events: { id: string; kind: string; detail: Record<string, unknown>; created_at: string }[];
  evaluations: Evaluation[];
  assignments: { id: string; version: number; status: string; team_code: string; radiologist_name: string; work_units: number; created_at: string; end_reason: string | null }[];
  outbound: Outbound[];
  intake: { id: string; control_id: string; message_type: string; status: string; reason_code: string | null; received_at: string }[];
  vetted_at: string | null;
  vetting_protocol: string | null;
  vetting_note: string | null;
  clocks: { interval_code: keyof typeof TAT_INTERVALS; rule_set_version: number; target_minutes: number; started_at: string; due_at: string; stopped_at: string | null; state: string }[];
  escalations: { id: string; kind: string; reason_code: string; raised_at: string; acknowledged_at: string | null; acknowledged_by_name: string | null; resolved_at: string | null; resolution: string | null }[];
  review: { id: string; status: string; skip_reason: string | null; outcome: string | null; comment: string | null; reviewer_name: string | null; completed_at: string | null } | null;
}

export function StudyDetail() {
  const { id } = useParams();
  const { data, error, reload } = useResource<Detail>(`/studies/${id}`, 10_000);
  const can = useCan();
  const [raw, setRaw] = useState<{ title: string; payload: string } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [explanation, setExplanation] = useState<{ text: string; engine: string } | null>(null);
  const [explaining, setExplaining] = useState(false);
  const explain = async () => {
    setExplaining(true);
    try {
      setExplanation(await api<{ text: string; engine: string }>(`/assistant/explain-study/${id}`, { method: 'POST' }));
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setExplaining(false);
    }
  };

  const showRaw = async (kind: 'intake' | 'outbound', mid: string, title: string) => {
    try {
      const r = await api<{ payload: string }>(`/messages/${kind}/${mid}/raw`);
      setRaw({ title, payload: r.payload.replace(/\r/g, '\n') });
    } catch (err) {
      setActionError((err as Error).message);
    }
  };
  const act = async (fn: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await fn();
      await reload();
    } catch (err) {
      setActionError((err as Error).message);
    }
  };

  if (error) return <ErrorBox error={error} />;
  if (!data) return <p className="muted">Loading…</p>;
  const latest = data.evaluations[data.evaluations.length - 1];

  return (
    <>
      <p>
        <Link to="/studies">← Worklist</Link>
      </p>
      <h1>
        Study {data.accession} <State value={data.state} /> {data.state_reason && <Reason code={data.state_reason} />}
      </h1>
      <ErrorBox error={actionError} />
      <div className="row" style={{ marginBottom: '0.6rem' }}>
        <button className="secondary" onClick={explain} disabled={explaining}>
          {explaining ? 'Explaining…' : 'Explain in plain English'}
        </button>
      </div>
      {explanation && (
        <div className="notice">
          <div style={{ whiteSpace: 'pre-wrap' }}>{explanation.text}</div>
          <div className="small muted">{explanation.engine === 'claude' ? 'Written by Claude from this study’s record (no patient details sent)' : 'Built-in summary'}</div>
        </div>
      )}
      <div className="grid2">
        <div className="panel">
          <h3 style={{ marginTop: 0 }}>What came in</h3>
          <div>
            {data.hospital_name} · {data.modality_code} · {data.service_text ?? data.service_code} · {data.priority}
          </div>
          <div className="small muted">
            Patient {data.patient_name ?? '—'} ({data.patient_identifier}, {data.patient_authority})
            {data.encounter_number && <> · encounter {data.encounter_number}</>}
            {data.location && <> · {data.location}</>}
            {data.room && <> / {data.room}</>}
          </div>
          <table style={{ marginTop: '0.6rem' }}>
            <tbody>
              {data.intake.map((m) => (
                <tr key={m.id}>
                  <td>
                    <When value={m.received_at} />
                  </td>
                  <td>
                    {m.message_type} <span className="muted small">{m.control_id}</span>
                  </td>
                  <td>
                    <State value={m.status} /> <Reason code={m.reason_code} />
                  </td>
                  <td>
                    {can('hl7.raw.view') && (
                      <button className="secondary" onClick={() => showRaw('intake', m.id, `Received ${m.control_id}`)}>
                        Raw HL7
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="panel">
          <h3 style={{ marginTop: 0 }}>Decision</h3>
          {latest ? (
            <>
              <div>
                {latest.outcome === 'assigned' ? <span className="badge good">Radiologist chosen</span> : <span className="badge warn">Sent to a coordinator</span>}{' '}
                <Reason code={latest.reason_code} />
              </div>
              <div className="small muted">
                Rule set version {latest.rule_set_version ?? '—'}
                {latest.routing.routing?.teamCode && (
                  <>
                    {' '}
                    · team {latest.routing.routing.teamCode} by rule <code>{latest.routing.routing.ruleId}</code>
                  </>
                )}
                {latest.selected_name && <> · selected {latest.selected_name}</>}
              </div>
              {latest.continuity.priorRadiologistId && (
                <div className="notice small">
                  {latest.continuity.preserved
                    ? 'Same-patient continuity kept: the previous radiologist was eligible.'
                    : `Previous radiologist could not take it: ${(latest.continuity.priorReasons ?? []).join(', ') || 'not eligible'}.`}
                </div>
              )}
              {(latest.routing.routing?.unknownRuleIds?.length ?? 0) > 0 && (
                <div className="small muted">Rules not decided for missing data: {latest.routing.routing!.unknownRuleIds.join(', ')}</div>
              )}
            </>
          ) : (
            <p className="muted">No decision yet.</p>
          )}
          {can('errors.manage') && (
            <div className="row" style={{ marginTop: '0.8rem' }}>
              {(data.state === 'manual_review' || data.state === 'ready') && (
                <button onClick={() => act(() => api(`/studies/${data.id}/reallocate`, { method: 'POST' }))}>Route again</button>
              )}
              {['reserved', 'awaiting_acceptance', 'assigned'].includes(data.state) && (
                <button
                  className="secondary"
                  onClick={() => {
                    const reason = window.prompt('Why are you taking this study back from the radiologist?');
                    if (reason) act(() => api(`/studies/${data.id}/reassign`, { method: 'POST', body: { reason } }));
                  }}
                >
                  Reassign
                </button>
              )}
              {!['cancelled', 'finalized', 'vetting_rejected'].includes(data.state) && (
                <button
                  className="danger"
                  onClick={() => {
                    const reason = window.prompt('Why are you cancelling this study?');
                    if (reason) act(() => api(`/studies/${data.id}/cancel`, { method: 'POST', body: { reason } }));
                  }}
                >
                  Cancel study
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {(data.vetted_at || data.clocks.length > 0 || data.escalations.length > 0 || data.review) && (
        <div className="grid2">
          <div className="panel">
            <h3 style={{ marginTop: 0 }}>Turnaround</h3>
            {data.vetted_at && (
              <p className="small">
                Vetted <When value={data.vetted_at} />
                {data.vetting_protocol && <> · protocol {data.vetting_protocol}</>}
                {data.vetting_note && <> · “{data.vetting_note}”</>}
              </p>
            )}
            {data.clocks.length > 0 ? (
              <table>
                <tbody>
                  {data.clocks.map((c) => (
                    <tr key={c.interval_code}>
                      <td>{TAT_INTERVALS[c.interval_code]?.label ?? c.interval_code}</td>
                      <td className="small">
                        {c.target_minutes} min target (rules v{c.rule_set_version})
                      </td>
                      <td>
                        <State value={c.state} />
                        <div className="small muted">
                          {c.stopped_at ? (
                            <>
                              done <When value={c.stopped_at} />
                            </>
                          ) : (
                            <>
                              due <When value={c.due_at} />
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="small muted">No turnaround targets apply.</p>
            )}
          </div>
          <div className="panel">
            <h3 style={{ marginTop: 0 }}>Escalations and peer review</h3>
            {data.escalations.map((e) => (
              <div key={e.id} className="small" style={{ marginBottom: '0.3rem' }}>
                <span className={`badge ${e.resolved_at ? 'grey' : e.kind === 'tat_breach' ? 'bad' : 'warn'}`}>
                  {e.kind === 'tat_breach' ? 'Overdue' : e.kind === 'tat_warning' ? 'At risk' : 'Needs a coordinator'}
                </span>{' '}
                <Reason code={e.reason_code} /> raised <When value={e.raised_at} />
                {e.acknowledged_by_name && <> · acknowledged by {e.acknowledged_by_name}</>}
                {e.resolved_at && <> · closed: {e.resolution}</>}
              </div>
            ))}
            {data.escalations.length === 0 && <p className="small muted">No escalations.</p>}
            {data.review && (
              <p className="small">
                Peer review: <State value={data.review.status} /> <Reason code={data.review.skip_reason} />
                {data.review.reviewer_name && <> · reviewer {data.review.reviewer_name}</>}
                {data.review.outcome && <> · {data.review.outcome.replace(/_/g, ' ')}</>}
                {data.review.comment && <> · “{data.review.comment}”</>}
              </p>
            )}
          </div>
        </div>
      )}

      {latest && latest.candidates.length > 0 && (
        <>
          <h2>Why this radiologist, and why not the others</h2>
          <table>
            <thead>
              <tr>
                <th>Rank</th>
                <th>Radiologist</th>
                <th>Eligible</th>
                <th>Load</th>
                <th>Reasons excluded</th>
              </tr>
            </thead>
            <tbody>
              {latest.candidates.map((c) => (
                <tr key={c.radiologistId}>
                  <td>{c.rank ?? '—'}</td>
                  <td>
                    {c.name} <span className="muted small">{c.code}</span>
                    {c.radiologistId === latest.continuity.priorRadiologistId && <span className="badge"> previous for this patient</span>}
                  </td>
                  <td>{c.eligible ? <span className="badge good">Yes</span> : <span className="badge bad">No</span>}</td>
                  <td>{c.loadRatio !== undefined ? `${Math.round(c.loadRatio * 100)}%` : '—'}</td>
                  <td>
                    {c.reasons.map((r) => (
                      <div key={r}>
                        <Reason code={r} />
                      </div>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h2>Assignments</h2>
      <table>
        <thead>
          <tr>
            <th>Version</th>
            <th>Radiologist</th>
            <th>Team</th>
            <th>Work units</th>
            <th>Status</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          {data.assignments.map((a) => (
            <tr key={a.id}>
              <td>{a.version}</td>
              <td>{a.radiologist_name}</td>
              <td>{a.team_code}</td>
              <td>{a.work_units}</td>
              <td>
                <span className={`badge ${a.status === 'accepted' || a.status === 'completed' || a.status === 'delivered' ? 'good' : a.status === 'declined' ? 'warn' : 'grey'}`}>
                  {ASSIGNMENT_LABELS[a.status] ?? a.status}
                </span>{' '}
                <Reason code={a.end_reason} />
              </td>
              <td>
                <When value={a.created_at} />
              </td>
            </tr>
          ))}
          {data.assignments.length === 0 && (
            <tr>
              <td colSpan={6} className="muted">
                None.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <h2>What was sent</h2>
      {data.outbound.map((o) => (
        <div className="panel" key={o.id}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div>
              <strong>{o.kind === 'assignment' ? 'Assignment' : 'Cancellation'}</strong> to {o.partner_code} · control ID {o.control_id} · <State value={o.status} />
              {o.ack_code && <> · ACK {o.ack_code}</>}
              {o.possibly_delivered && o.status !== 'accepted' && <span className="badge warn"> may have arrived</span>}
            </div>
            {can('hl7.raw.view') && (
              <button className="secondary" onClick={() => showRaw('outbound', o.id, `Sent ${o.control_id}`)}>
                Raw HL7
              </button>
            )}
          </div>
          {o.last_error && <div className="small muted">Last error: {o.last_error}</div>}
          {o.attempts_detail.length > 0 && (
            <table style={{ marginTop: '0.5rem' }}>
              <tbody>
                {o.attempts_detail.map((d) => (
                  <tr key={d.attempt}>
                    <td>Attempt {d.attempt}</td>
                    <td>
                      <When value={d.started_at} />
                    </td>
                    <td>{d.outcome ?? 'in progress'}</td>
                    <td>{d.http_status ? `HTTP ${d.http_status}` : ''}</td>
                    <td>{d.ack_code ?? ''}</td>
                    <td className="small">{d.error ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ))}
      {data.outbound.length === 0 && <p className="muted">Nothing sent.</p>}

      {raw && (
        <div className="panel">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <strong>{raw.title}</strong>
            <button className="secondary" onClick={() => setRaw(null)}>
              Close
            </button>
          </div>
          <p className="small muted">This view has been recorded in the audit log.</p>
          <pre className="hl7">{raw.payload}</pre>
        </div>
      )}

      <h2>History</h2>
      <table>
        <tbody>
          {data.events.map((e) => (
            <tr key={e.id}>
              <td style={{ width: 180 }}>
                <When value={e.created_at} />
              </td>
              <td>{e.kind.replace(/_/g, ' ')}</td>
              <td className="small muted condition">{JSON.stringify(e.detail)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
