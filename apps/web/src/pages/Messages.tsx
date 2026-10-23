import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api';
import { useCan } from '../App';
import { ErrorBox, Reason, State, When } from '../components/ui';
import { useResource } from '../hooks';

interface Received {
  id: string;
  received_at: string;
  partner_code: string;
  partner_role: string;
  control_id: string;
  message_type: string;
  status: string;
  reason_code: string | null;
  error: string | null;
  study_id: string | null;
  accession: string | null;
  archived: boolean;
  bytes: number;
}

interface Sent {
  id: string;
  created_at: string;
  partner_code: string;
  kind: string;
  control_id: string;
  status: string;
  attempts: number;
  possibly_delivered: boolean;
  ack_code: string | null;
  ack_text: string | null;
  last_error: string | null;
  study_id: string;
  accession: string;
  radiologist: string;
  attempts_detail: { attempt: number; started_at: string; outcome: string | null; http_status: number | null; ack_code: string | null; error: string | null }[];
}

/** Shows a message one segment per line; click a segment to see its numbered fields (PID-3, OBR-24…). */
function Hl7View({ text }: { text: string }) {
  const segments = text.split(/\r\n|\r|\n/).filter((l) => l.trim());
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div>
      <pre className="hl7" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
        {segments.map((seg, i) => (
          <div key={i} style={{ cursor: 'pointer', background: open === i ? '#1d3a37' : undefined }} onClick={() => setOpen(open === i ? null : i)}>
            <span style={{ color: '#5eead4', fontWeight: 700 }}>{seg.slice(0, 3)}</span>
            {seg.slice(3)}
          </div>
        ))}
      </pre>
      {open !== null && <Fields segment={segments[open]} />}
      <p className="small muted">Click a segment to see its fields.</p>
    </div>
  );
}

function Fields({ segment }: { segment: string }) {
  const name = segment.slice(0, 3);
  const parts = segment.split('|');
  // In MSH the field separator itself is MSH-1, so the numbering is shifted by one.
  const fields = name === 'MSH' ? [['1', '|'], ...parts.slice(1).map((v, i) => [String(i + 2), v])] : parts.slice(1).map((v, i) => [String(i + 1), v]);
  return (
    <table>
      <thead>
        <tr>
          <th style={{ width: 90 }}>Field</th>
          <th>Value</th>
        </tr>
      </thead>
      <tbody>
        {fields
          .filter(([, v]) => v !== '')
          .map(([n, v]) => (
            <tr key={n}>
              <td>
                <code>
                  {name}-{n}
                </code>
              </td>
              <td className="condition">{v}</td>
            </tr>
          ))}
      </tbody>
    </table>
  );
}

function RawPanel({ kind, id, title, onClose }: { kind: 'intake' | 'outbound'; id: string; title: string; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setText(null);
    api<{ payload: string }>(`/messages/${kind}/${id}/raw`)
      .then((r) => setText(r.payload))
      .catch((e) => setError((e as Error).message));
  }, [kind, id]);
  return (
    <div className="panel" style={{ background: '#fff' }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <strong>{title}</strong>
        <div className="row">
          {text && (
            <button className="secondary" onClick={() => navigator.clipboard?.writeText(text.replace(/\r/g, '\n'))}>
              Copy
            </button>
          )}
          <button className="secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
      <p className="small muted">Opening a message is recorded in the audit log.</p>
      <ErrorBox error={error} />
      {text === null && !error && <p className="muted">Loading…</p>}
      {text && <Hl7View text={text} />}
    </div>
  );
}

function ReceivedTab({ onOpen }: { onOpen: (r: { kind: 'intake'; id: string; title: string }) => void }) {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const query = new URLSearchParams({ ...(q ? { q } : {}), ...(status ? { status } : {}) }).toString();
  const { data, error } = useResource<Received[]>(`/hl7/received${query ? `?${query}` : ''}`, 10_000);
  return (
    <>
      <div className="row" style={{ marginBottom: '0.6rem' }}>
        <label>
          Control ID or accession
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" />
        </label>
        <label>
          State
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            <option value="received">Waiting to process</option>
            <option value="processed">Processed</option>
            <option value="ignored">Ignored</option>
            <option value="quarantined">Quarantined</option>
          </select>
        </label>
      </div>
      <ErrorBox error={error} />
      <table>
        <thead>
          <tr>
            <th>Received</th>
            <th>From</th>
            <th>Message</th>
            <th>Study</th>
            <th>Result</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data?.map((m) => (
            <tr key={m.id}>
              <td>
                <When value={m.received_at} />
              </td>
              <td>
                {m.partner_code}
                <div className="small muted">{m.partner_role}</div>
              </td>
              <td>
                {m.message_type}
                <div className="small muted">{m.control_id}</div>
              </td>
              <td>{m.study_id ? <Link to={`/studies/${m.study_id}`}>{m.accession}</Link> : '—'}</td>
              <td>
                <State value={m.status} /> <Reason code={m.reason_code} />
                {m.error && <div className="small muted">{m.error}</div>}
              </td>
              <td>
                <button className="secondary" onClick={() => onOpen({ kind: 'intake', id: m.id, title: `Received ${m.message_type} ${m.control_id}` })}>
                  {m.archived ? 'Where is it?' : 'View'}
                </button>
              </td>
            </tr>
          ))}
          {data?.length === 0 && (
            <tr>
              <td colSpan={6} className="muted">
                No messages.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}

function SentTab({ onOpen }: { onOpen: (r: { kind: 'outbound'; id: string; title: string }) => void }) {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const query = new URLSearchParams({ ...(q ? { q } : {}), ...(status ? { status } : {}) }).toString();
  const { data, error } = useResource<Sent[]>(`/hl7/sent${query ? `?${query}` : ''}`, 10_000);
  return (
    <>
      <div className="row" style={{ marginBottom: '0.6rem' }}>
        <label>
          Control ID or accession
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" />
        </label>
        <label>
          State
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            <option value="pending">Waiting to send</option>
            <option value="accepted">Destination accepted</option>
            <option value="unknown">Delivery uncertain</option>
            <option value="retry">Will retry</option>
            <option value="rejected">Destination rejected</option>
            <option value="failed">Failed after retries</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </label>
      </div>
      <ErrorBox error={error} />
      <table>
        <thead>
          <tr>
            <th>Created</th>
            <th>To</th>
            <th>Message</th>
            <th>Study / radiologist</th>
            <th>Delivery</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data?.map((o) => (
            <tr key={o.id}>
              <td>
                <When value={o.created_at} />
              </td>
              <td>{o.partner_code}</td>
              <td>
                {o.kind === 'assignment' ? 'Assignment' : 'Cancellation'}
                <div className="small muted">{o.control_id}</div>
              </td>
              <td>
                <Link to={`/studies/${o.study_id}`}>{o.accession}</Link>
                <div className="small muted">{o.radiologist}</div>
              </td>
              <td>
                <State value={o.status} />
                {o.ack_code && <span className="small"> ACK {o.ack_code}</span>}
                {o.possibly_delivered && o.status !== 'accepted' && o.status !== 'rejected' && <div className="badge warn">may have arrived</div>}
                <div className="small muted">
                  {o.attempts} attempt{o.attempts === 1 ? '' : 's'}
                  {o.attempts_detail.length > 0 && `, last: ${o.attempts_detail[o.attempts_detail.length - 1].outcome ?? 'in progress'}`}
                  {o.ack_text && ` · ${o.ack_text}`}
                  {o.last_error && ` · ${o.last_error}`}
                </div>
              </td>
              <td>
                <button className="secondary" onClick={() => onOpen({ kind: 'outbound', id: o.id, title: `Sent ${o.kind} ${o.control_id}` })}>
                  View
                </button>
              </td>
            </tr>
          ))}
          {data?.length === 0 && (
            <tr>
              <td colSpan={6} className="muted">
                Nothing sent yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}

const TEMPLATES: { kind: string; label: string; needsAccession: boolean }[] = [
  { kind: 'new_order', label: 'New order (ORM NW)', needsAccession: false },
  { kind: 'cancel', label: 'Cancel an order (ORM CA)', needsAccession: true },
  { kind: 'accept', label: 'Radiologist accepts (ORC OK)', needsAccession: true },
  { kind: 'decline', label: 'Radiologist declines (ORC UA)', needsAccession: true },
  { kind: 'preliminary', label: 'Preliminary report (ORU P)', needsAccession: true },
  { kind: 'final', label: 'Final report (ORU F)', needsAccession: true },
];

function SendTab() {
  const { data: partners } = useResource<{ code: string; name: string; direction: string; role: string; allowedFacilities: string[]; active: boolean }[]>('/hl7/partners');
  const inbound = (partners ?? []).filter((p) => p.direction === 'inbound' && p.role !== 'presence' && p.active);
  const [partner, setPartner] = useState('');
  const [payload, setPayload] = useState('');
  const [template, setTemplate] = useState('new_order');
  const [accession, setAccession] = useState('');
  const [result, setResult] = useState<{ outcome: string; httpStatus: number; ack: string; intakeMessageId?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const needs = TEMPLATES.find((t) => t.kind === template)?.needsAccession;

  const load = async () => {
    setError(null);
    setResult(null);
    try {
      const t = await api<{ partner: string | null; payload: string }>(`/hl7/templates/${template}${needs ? `?accession=${encodeURIComponent(accession)}` : ''}`);
      setPayload(t.payload);
      if (t.partner) setPartner(t.partner);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const send = async () => {
    setError(null);
    setResult(null);
    setBusy(true);
    try {
      setResult(await api('/hl7/send', { method: 'POST', body: { partner: partner || inbound[0]?.code, payload } }));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid2">
      <div className="panel" style={{ background: '#fff' }}>
        <h3 style={{ marginTop: 0 }}>Send an HL7 message</h3>
        <p className="small muted">
          The message goes through exactly the same checks as one from Mirth: the partner's allowed facilities, duplicate detection, then
          processing by the worker. Use a test hospital and test data only. The send is audit-logged.
        </p>
        <div className="row" style={{ marginBottom: '0.6rem' }}>
          <label>
            Start from
            <select value={template} onChange={(e) => setTemplate(e.target.value)}>
              {TEMPLATES.map((t) => (
                <option key={t.kind} value={t.kind}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          {needs && (
            <label>
              Accession
              <input value={accession} onChange={(e) => setAccession(e.target.value)} placeholder="e.g. MSK1" />
            </label>
          )}
          <button className="secondary" onClick={load} disabled={needs && !accession.trim()}>
            Fill in
          </button>
        </div>
        <label>
          As partner
          <select value={partner || inbound[0]?.code || ''} onChange={(e) => setPartner(e.target.value)}>
            {inbound.map((p) => (
              <option key={p.code} value={p.code}>
                {p.code} — {p.name} ({p.role}; facilities {p.allowedFacilities.join(', ') || 'none'})
              </option>
            ))}
          </select>
        </label>
        <label style={{ marginTop: '0.6rem' }}>
          Message (one segment per line)
          <textarea rows={14} value={payload} onChange={(e) => setPayload(e.target.value)} spellCheck={false} placeholder="MSH|^~\&|..." />
        </label>
        <div className="row" style={{ marginTop: '0.6rem' }}>
          <button onClick={send} disabled={busy || !payload.trim()}>
            {busy ? 'Sending…' : 'Send'}
          </button>
        </div>
      </div>
      <div>
        <ErrorBox error={error} />
        {result && (
          <div className="panel" style={{ background: '#fff' }}>
            <h3 style={{ marginTop: 0 }}>
              {result.outcome === 'accepted'
                ? 'Accepted'
                : result.outcome === 'duplicate'
                  ? 'Already received (duplicate control ID)'
                  : result.outcome === 'collision'
                    ? 'Control ID reused with different content: held for investigation'
                    : 'Refused at the intake boundary'}{' '}
              <span className="small muted">HTTP {result.httpStatus}</span>
            </h3>
            <p className="small">
              {result.outcome === 'accepted'
                ? 'The worker will process it within a few seconds. Find it on the Received tab.'
                : 'This is the acknowledgment a partner would get back:'}
            </p>
            <strong className="small">Acknowledgment returned</strong>
            <Hl7View text={result.ack} />
          </div>
        )}
        {payload.trim() && (
          <div className="panel" style={{ background: '#fff' }}>
            <strong>Preview</strong>
            <Hl7View text={payload} />
          </div>
        )}
      </div>
    </div>
  );
}

export function Messages() {
  const can = useCan();
  const [tab, setTab] = useState<'received' | 'sent' | 'send'>('received');
  const [raw, setRaw] = useState<{ kind: 'intake' | 'outbound'; id: string; title: string } | null>(null);
  return (
    <>
      <h1>HL7 messages</h1>
      <div className="tabs">
        <button className={tab === 'received' ? 'active' : ''} onClick={() => (setTab('received'), setRaw(null))}>
          Received
        </button>
        <button className={tab === 'sent' ? 'active' : ''} onClick={() => (setTab('sent'), setRaw(null))}>
          Sent to third party
        </button>
        {can('hl7.send') && (
          <button className={tab === 'send' ? 'active' : ''} onClick={() => (setTab('send'), setRaw(null))}>
            Send a message
          </button>
        )}
      </div>
      {raw && <RawPanel {...raw} onClose={() => setRaw(null)} />}
      {tab === 'received' && <ReceivedTab onOpen={setRaw} />}
      {tab === 'sent' && <SentTab onOpen={setRaw} />}
      {tab === 'send' && <SendTab />}
    </>
  );
}
