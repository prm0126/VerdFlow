import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useCan, useMe } from '../App';
import { ErrorBox, Reason, State, When } from '../components/ui';
import { useResource } from '../hooks';

interface Task {
  id: string;
  study_id: string;
  accession: string;
  modality_code: string;
  service_text: string | null;
  service_code: string;
  hospital_code: string;
  status: string;
  skip_reason: string | null;
  outcome: string | null;
  comment: string | null;
  created_at: string;
  completed_at: string | null;
  reporter_name: string;
  reviewer_name: string | null;
  reviewer_user_id: string | null;
}

const OUTCOMES: Record<string, string> = { agree: 'Agree', minor_discrepancy: 'Minor discrepancy', major_discrepancy: 'Major discrepancy' };

function ReviewForm({ task, onDone }: { task: Task; onDone: () => void }) {
  const [outcome, setOutcome] = useState('agree');
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="row">
      <select value={outcome} onChange={(e) => setOutcome(e.target.value)} aria-label="Outcome">
        {Object.entries(OUTCOMES).map(([k, v]) => (
          <option key={k} value={k}>
            {v}
          </option>
        ))}
      </select>
      <input placeholder="Comment" value={comment} onChange={(e) => setComment(e.target.value)} />
      <button
        onClick={async () => {
          setError(null);
          try {
            await api(`/peer-review/${task.id}`, { method: 'POST', body: { outcome, comment: comment || undefined } });
            onDone();
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      >
        Record review
      </button>
      {error && <span className="error small">{error}</span>}
    </div>
  );
}

export function PeerReview() {
  const me = useMe();
  const can = useCan();
  const [tab, setTab] = useState<'mine' | 'all'>(can('review.perform') ? 'mine' : 'all');
  const { data, error, reload } = useResource<Task[]>(tab === 'mine' ? '/peer-review?mine=true&status=open' : '/peer-review');
  const { data: summary } = useResource<{ open: number; completed: number; skipped: number; major: number; finalized: number }>('/peer-review/summary');
  return (
    <>
      <h1>Peer review</h1>
      <p className="muted small">
        A share of final reports, set in the rule set, is chosen for review. The same study is always either in or out of the sample. A reviewer is
        never the original reporter and has a daily limit; when nobody can take a review it is recorded as skipped, with the reason.
      </p>
      {summary && (
        <div className="cards" style={{ marginBottom: '1rem' }}>
          <div className="card">
            <div className="label">Open reviews</div>
            <div className="value">{summary.open}</div>
          </div>
          <div className="card">
            <div className="label">Completed</div>
            <div className="value">{summary.completed}</div>
          </div>
          <div className={`card${summary.skipped ? ' alert' : ''}`}>
            <div className="label">Skipped (no reviewer or daily limit)</div>
            <div className="value">{summary.skipped}</div>
          </div>
          <div className={`card${summary.major ? ' alert' : ''}`}>
            <div className="label">Major discrepancies</div>
            <div className="value">{summary.major}</div>
          </div>
          <div className="card">
            <div className="label">Final reports</div>
            <div className="value">{summary.finalized}</div>
          </div>
        </div>
      )}
      <div className="tabs">
        {can('review.perform') && (
          <button className={tab === 'mine' ? 'active' : ''} onClick={() => setTab('mine')}>
            My reviews
          </button>
        )}
        <button className={tab === 'all' ? 'active' : ''} onClick={() => setTab('all')}>
          All reviews
        </button>
      </div>
      <ErrorBox error={error} />
      <table>
        <thead>
          <tr>
            <th>Study</th>
            <th>Reported by</th>
            <th>Reviewer</th>
            <th>Status</th>
            <th>Outcome</th>
          </tr>
        </thead>
        <tbody>
          {data?.map((t) => (
            <tr key={t.id}>
              <td>
                <Link to={`/studies/${t.study_id}`}>{t.accession}</Link>
                <div className="small muted">
                  {t.hospital_code} · {t.modality_code} · {t.service_text ?? t.service_code}
                </div>
              </td>
              <td>{t.reporter_name}</td>
              <td>{t.reviewer_name ?? '—'}</td>
              <td>
                <State value={t.status} /> <Reason code={t.skip_reason} />
                <div className="small muted">
                  <When value={t.completed_at ?? t.created_at} />
                </div>
              </td>
              <td>
                {t.status === 'open' && t.reviewer_user_id === me.id ? (
                  <ReviewForm task={t} onDone={reload} />
                ) : t.outcome ? (
                  <>
                    <span className={`badge ${t.outcome === 'agree' ? 'good' : t.outcome === 'major_discrepancy' ? 'bad' : 'warn'}`}>{OUTCOMES[t.outcome]}</span>
                    {t.comment && <div className="small">{t.comment}</div>}
                  </>
                ) : (
                  '—'
                )}
              </td>
            </tr>
          ))}
          {data?.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                {tab === 'mine' ? 'No reviews waiting for you.' : 'No reviews yet.'}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}
