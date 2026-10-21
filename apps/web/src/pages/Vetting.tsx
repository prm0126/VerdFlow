import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { ErrorBox, State, When } from '../components/ui';
import { useResource } from '../hooks';

interface Row {
  id: string;
  accession: string;
  hospital_code: string;
  modality_code: string;
  service_code: string;
  service_name: string | null;
  priority: string;
  created_at: string;
  protocols: string[] | null;
  clock_state: string | null;
  due_at: string | null;
}

function VetRow({ r, onDone }: { r: Row; onDone: (msg: string) => void }) {
  const protocols = r.protocols ?? [];
  const [protocol, setProtocol] = useState(protocols[0] ?? '');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const decide = async (decision: 'approve' | 'reject') => {
    setError(null);
    try {
      const res = await api<{ outcome: string; allocation?: string }>(`/vetting/${r.id}`, {
        method: 'POST',
        body: decision === 'approve' ? { decision, protocol: protocol || undefined, note: note || undefined } : { decision, note },
      });
      onDone(
        res.outcome === 'approved'
          ? `${r.accession} approved${res.allocation === 'assigned' ? ' and routed to a radiologist' : '; it now needs a coordinator to route it'}.`
          : `${r.accession} not approved.`,
      );
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <tr>
      <td>
        <Link to={`/studies/${r.id}`}>{r.accession}</Link>
        <div className="small muted">{r.hospital_code}</div>
      </td>
      <td>
        {r.modality_code} · {r.service_name ?? r.service_code}
      </td>
      <td>{r.priority === 'STAT' ? <span className="badge bad">STAT</span> : r.priority === 'URGENT' ? <span className="badge warn">Urgent</span> : 'Routine'}</td>
      <td>
        <When value={r.created_at} />
        {r.clock_state && (
          <div>
            <State value={r.clock_state} /> <span className="small muted">due <When value={r.due_at} /></span>
          </div>
        )}
      </td>
      <td>
        <div className="row">
          {protocols.length > 0 && (
            <select value={protocol} onChange={(e) => setProtocol(e.target.value)} aria-label="Protocol">
              {protocols.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          )}
          <input placeholder="Note (needed to reject)" value={note} onChange={(e) => setNote(e.target.value)} />
          <button onClick={() => decide('approve')}>Approve</button>
          <button className="danger" onClick={() => decide('reject')}>
            Do not approve
          </button>
        </div>
        {error && <div className="error small">{error}</div>}
      </td>
    </tr>
  );
}

export function Vetting() {
  const { data, error, reload } = useResource<Row[]>('/vetting', 15_000);
  const [notice, setNotice] = useState<string | null>(null);
  return (
    <>
      <h1>Vetting</h1>
      <p className="muted small">
        Requests for services that need vetting wait here before routing. Approve with a protocol to send the study for reporting, or record why
        it should not go ahead. STAT requests are listed first.
      </p>
      <ErrorBox error={error} />
      {notice && <div className="notice">{notice}</div>}
      <table>
        <thead>
          <tr>
            <th>Accession</th>
            <th>Request</th>
            <th>Priority</th>
            <th>Received</th>
            <th>Decision</th>
          </tr>
        </thead>
        <tbody>
          {data?.map((r) => (
            <VetRow
              key={r.id}
              r={r}
              onDone={(msg) => {
                setNotice(msg);
                reload();
              }}
            />
          ))}
          {data?.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                Nothing waiting for vetting.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}
