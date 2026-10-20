import { STUDY_STATES } from '@vf/shared';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ErrorBox, Reason, State, When } from '../components/ui';
import { useResource } from '../hooks';

interface StudyRow {
  id: string;
  accession: string;
  hospital_code: string;
  modality_code: string;
  service_code: string;
  service_text: string | null;
  priority: string;
  state: string;
  state_reason: string | null;
  created_at: string;
  patient_name: string | null;
  radiologist_name: string | null;
  team_code: string | null;
}

export function Studies() {
  const [params, setParams] = useSearchParams();
  const state = params.get('state') ?? '';
  const q = params.get('q') ?? '';
  const query = new URLSearchParams({ ...(state ? { state } : {}), ...(q ? { q } : {}) }).toString();
  const { data, error } = useResource<StudyRow[]>(`/studies${query ? `?${query}` : ''}`, 10_000);
  const navigate = useNavigate();
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next);
  };
  return (
    <>
      <h1>Worklist</h1>
      <div className="row" style={{ marginBottom: '0.8rem' }}>
        <label>
          State
          <select value={state} onChange={(e) => set('state', e.target.value)}>
            <option value="">All</option>
            {STUDY_STATES.map((s) => (
              <option key={s} value={s}>
                {s.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        </label>
        <label>
          Accession
          <input value={q} onChange={(e) => set('q', e.target.value)} placeholder="Search" />
        </label>
      </div>
      <ErrorBox error={error} />
      <table>
        <thead>
          <tr>
            <th>Received</th>
            <th>Accession</th>
            <th>Patient</th>
            <th>Hospital</th>
            <th>Study</th>
            <th>Priority</th>
            <th>Team / radiologist</th>
            <th>State</th>
          </tr>
        </thead>
        <tbody>
          {data?.map((s) => (
            <tr key={s.id} className="clickable" onClick={() => navigate(`/studies/${s.id}`)}>
              <td>
                <When value={s.created_at} />
              </td>
              <td>{s.accession}</td>
              <td>{s.patient_name ?? '—'}</td>
              <td>{s.hospital_code}</td>
              <td>
                {s.modality_code} · {s.service_text ?? s.service_code}
              </td>
              <td>{s.priority === 'STAT' ? <span className="badge bad">STAT</span> : s.priority === 'URGENT' ? <span className="badge warn">Urgent</span> : 'Routine'}</td>
              <td>
                {s.team_code ?? '—'}
                {s.radiologist_name && <div className="small muted">{s.radiologist_name}</div>}
              </td>
              <td>
                <State value={s.state} />
                {s.state_reason && (
                  <div>
                    <Reason code={s.state_reason} />
                  </div>
                )}
              </td>
            </tr>
          ))}
          {data?.length === 0 && (
            <tr>
              <td colSpan={8} className="muted">
                No studies match.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}
