import { TAT_INTERVALS } from '@vf/shared';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useCan } from '../App';
import { ErrorBox, Reason, State, When } from '../components/ui';
import { useResource } from '../hooks';

interface Row {
  id: string;
  study_id: string;
  accession: string;
  priority: string;
  state: string;
  kind: 'manual_review' | 'tat_warning' | 'tat_breach';
  reason_code: string;
  detail: { dueAt?: string; targetMinutes?: number };
  raised_at: string;
  acknowledged_at: string | null;
  acknowledged_by_name: string | null;
  resolved_at: string | null;
  resolution: string | null;
}

const KIND: Record<Row['kind'], { label: string; tone: string }> = {
  tat_breach: { label: 'Overdue', tone: 'bad' },
  tat_warning: { label: 'At risk', tone: 'warn' },
  manual_review: { label: 'Needs a coordinator', tone: 'warn' },
};

export function Escalations() {
  const [all, setAll] = useState(false);
  const { data, error, reload } = useResource<Row[]>(`/escalations${all ? '?all=true' : ''}`, 15_000);
  const can = useCan();
  const [actionError, setActionError] = useState<string | null>(null);
  const ack = async (id: string) => {
    setActionError(null);
    try {
      await api(`/escalations/${id}/acknowledge`, { method: 'POST' });
      await reload();
    } catch (e) {
      setActionError((e as Error).message);
    }
  };
  return (
    <>
      <h1>Escalations</h1>
      <p className="muted small">
        Raised when a study needs a coordinator, or a turnaround target is at risk or overdue. They close by themselves when the study moves on
        or the step is done. Acknowledge one to show the team someone is dealing with it.
      </p>
      <label style={{ flexDirection: 'row', alignItems: 'center', gap: '0.4rem', marginBottom: '0.6rem' }}>
        <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
        Include closed escalations
      </label>
      <ErrorBox error={error ?? actionError} />
      <table>
        <thead>
          <tr>
            <th>Raised</th>
            <th>Study</th>
            <th>What</th>
            <th>Study state</th>
            <th>Handled</th>
          </tr>
        </thead>
        <tbody>
          {data?.map((e) => (
            <tr key={e.id}>
              <td>
                <When value={e.raised_at} />
              </td>
              <td>
                <Link to={`/studies/${e.study_id}`}>{e.accession}</Link> <span className="small muted">{e.priority}</span>
              </td>
              <td>
                <span className={`badge ${KIND[e.kind].tone}`}>{KIND[e.kind].label}</span>{' '}
                {e.kind === 'manual_review' ? (
                  <Reason code={e.reason_code} />
                ) : (
                  <span className="small">
                    {TAT_INTERVALS[e.reason_code as keyof typeof TAT_INTERVALS]?.label ?? e.reason_code}
                    {e.detail.dueAt && (
                      <>
                        {' '}
                        · due <When value={e.detail.dueAt} />
                      </>
                    )}
                  </span>
                )}
              </td>
              <td>
                <State value={e.state} />
              </td>
              <td>
                {e.resolved_at ? (
                  <span className="small muted">
                    Closed <When value={e.resolved_at} />: {e.resolution}
                  </span>
                ) : e.acknowledged_at ? (
                  <span className="small">
                    {e.acknowledged_by_name} on <When value={e.acknowledged_at} />
                  </span>
                ) : can('escalations.manage') ? (
                  <button className="secondary" onClick={() => ack(e.id)}>
                    Acknowledge
                  </button>
                ) : (
                  <span className="badge warn">Not yet acknowledged</span>
                )}
              </td>
            </tr>
          ))}
          {data?.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                No open escalations.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}
