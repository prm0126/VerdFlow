import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { ErrorBox, Reason, State, When } from '../components/ui';
import { useResource } from '../hooks';

interface ErrorsData {
  quarantined: { id: string; partner_code: string; control_id: string; message_type: string; reason_code: string; error: string | null; received_at: string }[];
  collisions: { id: string; control_id: string; partner_code: string; received_at: string }[];
  outbound: {
    id: string;
    study_id: string;
    accession: string;
    kind: string;
    control_id: string;
    status: string;
    attempts: number;
    possibly_delivered: boolean;
    ack_code: string | null;
    ack_text: string | null;
    last_error: string | null;
    partner_code: string;
  }[];
}

export function Errors() {
  const { data, error, reload } = useResource<ErrorsData>('/errors', 15_000);
  const [actionError, setActionError] = useState<string | null>(null);
  const act = async (path: string) => {
    setActionError(null);
    try {
      await api(path, { method: 'POST' });
      await reload();
    } catch (err) {
      setActionError((err as Error).message);
    }
  };
  return (
    <>
      <h1>Errors and reconciliation</h1>
      <ErrorBox error={error ?? actionError} />
      {data && (
        <>
          <h2>Delivery problems ({data.outbound.length})</h2>
          <p className="small muted">
            “May have arrived” means the destination might hold this assignment. Retrying sends the same message with the same control ID, so the
            receiver can recognise a repeat. Check with the receiving team before cancelling.
          </p>
          <table>
            <thead>
              <tr>
                <th>Study</th>
                <th>Message</th>
                <th>State</th>
                <th>Attempts</th>
                <th>Detail</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.outbound.map((o) => (
                <tr key={o.id}>
                  <td>
                    <Link to={`/studies/${o.study_id}`}>{o.accession}</Link>
                  </td>
                  <td>
                    {o.kind} to {o.partner_code}
                    <div className="small muted">{o.control_id}</div>
                  </td>
                  <td>
                    <State value={o.status} />
                    {o.possibly_delivered && o.status !== 'rejected' && <div className="badge warn">may have arrived</div>}
                  </td>
                  <td>{o.attempts}</td>
                  <td className="small">{o.ack_code ? `ACK ${o.ack_code}: ${o.ack_text ?? ''}` : o.last_error}</td>
                  <td>
                    {(o.status === 'failed' || o.status === 'unknown') && <button onClick={() => act(`/errors/outbound/${o.id}/retry`)}>Retry</button>}
                    {o.status === 'rejected' && <Link to={`/studies/${o.study_id}`}>Route again from the study</Link>}
                  </td>
                </tr>
              ))}
              {data.outbound.length === 0 && (
                <tr>
                  <td colSpan={6} className="muted">
                    None.
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          <h2>Quarantined messages ({data.quarantined.length})</h2>
          <p className="small muted">Fix the cause (for example add a missing modality or hospital in Masters), then put the message back in the queue.</p>
          <table>
            <thead>
              <tr>
                <th>Received</th>
                <th>From</th>
                <th>Message</th>
                <th>Reason</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.quarantined.map((q) => (
                <tr key={q.id}>
                  <td>
                    <When value={q.received_at} />
                  </td>
                  <td>{q.partner_code}</td>
                  <td>
                    {q.message_type} <span className="small muted">{q.control_id}</span>
                  </td>
                  <td>
                    <Reason code={q.reason_code} />
                    <div className="small muted">{q.error}</div>
                  </td>
                  <td>
                    <button className="secondary" onClick={() => act(`/errors/intake/${q.id}/requeue`)}>
                      Process again
                    </button>
                  </td>
                </tr>
              ))}
              {data.quarantined.length === 0 && (
                <tr>
                  <td colSpan={5} className="muted">
                    None.
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          <h2>Control ID reused with different content ({data.collisions.length})</h2>
          <p className="small muted">The second message was kept but not processed. Ask the sending team which version is correct.</p>
          <table>
            <thead>
              <tr>
                <th>Received</th>
                <th>From</th>
                <th>Control ID</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.collisions.map((c) => (
                <tr key={c.id}>
                  <td>
                    <When value={c.received_at} />
                  </td>
                  <td>{c.partner_code}</td>
                  <td>{c.control_id}</td>
                  <td>
                    <button className="secondary" onClick={() => act(`/errors/collisions/${c.id}/resolve`)}>
                      Mark investigated
                    </button>
                  </td>
                </tr>
              ))}
              {data.collisions.length === 0 && (
                <tr>
                  <td colSpan={4} className="muted">
                    None.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}
