import { AVAILABILITY_STATES } from '@vf/shared';
import { useState } from 'react';
import { api } from '../api';
import { useCan } from '../App';
import { ErrorBox, State, When } from '../components/ui';
import { useResource } from '../hooks';

interface Row {
  radiologist_id: string;
  code: string;
  full_name: string;
  status: string;
  heartbeat_at: string | null;
  present: boolean;
  capacity_units: number;
  active_units: number;
  active_assignments: number;
  teams: string[];
  on_shift: boolean;
  absence: string | null;
  shift_ends_at: string | null;
  blockers: string[];
}

export function Availability() {
  const { data, error, reload } = useResource<Row[]>('/availability', 10_000);
  const can = useCan();
  const [actionError, setActionError] = useState<string | null>(null);
  const update = async (id: string, body: { status: string; capacityUnits?: number }) => {
    setActionError(null);
    try {
      await api(`/availability/${id}`, { method: 'PUT', body });
      await reload();
    } catch (err) {
      setActionError((err as Error).message);
    }
  };
  const breakAction = async (id: string, action: 'start' | 'end') => {
    setActionError(null);
    try {
      await api(`/rota/radiologists/${id}/break`, { method: 'POST', body: { action } });
      await reload();
    } catch (err) {
      setActionError((err as Error).message);
    }
  };
  return (
    <>
      <h1>Radiologist availability</h1>
      <p className="muted small">
        A radiologist receives new work only when they are on a shift, not on leave or a break, ready, present (a recent heartbeat from the
        reporting workstation) and have capacity. None of these withdraws work they already hold.
      </p>
      <ErrorBox error={error ?? actionError} />
      <table>
        <thead>
          <tr>
            <th>Radiologist</th>
            <th>Teams</th>
            <th>Can take new work</th>
            <th>Status</th>
            <th>Presence</th>
            <th>Load (work units)</th>
            <th>Active studies</th>
          </tr>
        </thead>
        <tbody>
          {data?.map((r) => (
            <tr key={r.radiologist_id}>
              <td>
                {r.full_name} <span className="small muted">{r.code}</span>
              </td>
              <td>{r.teams.join(', ') || '—'}</td>
              <td>
                {r.blockers.length === 0 ? (
                  r.active_units >= r.capacity_units ? <span className="badge warn">At capacity</span> : <span className="badge good">Yes</span>
                ) : (
                  r.blockers.map((b) => (
                    <div key={b}>
                      <span className="badge grey">{b}</span>
                    </div>
                  ))
                )}
                {r.shift_ends_at && (
                  <div className="small muted">
                    Shift ends {new Date(r.shift_ends_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                  </div>
                )}
                {can('availability.manage') && (
                  <div style={{ marginTop: '0.3rem' }}>
                    {r.absence === 'break' ? (
                      <button className="secondary" onClick={() => breakAction(r.radiologist_id, 'end')}>
                        End break
                      </button>
                    ) : (
                      !r.absence && (
                        <button className="secondary" onClick={() => breakAction(r.radiologist_id, 'start')}>
                          Start break
                        </button>
                      )
                    )}
                  </div>
                )}
              </td>
              <td>
                {can('availability.manage') ? (
                  <select value={r.status} onChange={(e) => update(r.radiologist_id, { status: e.target.value })} aria-label={`Status for ${r.full_name}`}>
                    {AVAILABILITY_STATES.map((s) => (
                      <option key={s} value={s}>
                        {s.replace(/_/g, ' ')}
                      </option>
                    ))}
                  </select>
                ) : (
                  <State value={r.status} />
                )}
              </td>
              <td>
                {r.present ? <span className="badge good">Present</span> : <span className="badge grey">No recent heartbeat</span>}
                <div className="small muted">
                  <When value={r.heartbeat_at} />
                </div>
              </td>
              <td>
                {r.active_units} of{' '}
                {can('availability.manage') ? (
                  <input
                    type="number"
                    min={0}
                    max={1000}
                    step={0.5}
                    key={r.capacity_units}
                    defaultValue={r.capacity_units}
                    style={{ width: 70 }}
                    aria-label={`Capacity for ${r.full_name}`}
                    onBlur={(e) => {
                      const v = Number(e.target.value);
                      if (v !== r.capacity_units) update(r.radiologist_id, { status: r.status, capacityUnits: v });
                    }}
                  />
                ) : (
                  r.capacity_units
                )}
              </td>
              <td>{r.active_assignments}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
