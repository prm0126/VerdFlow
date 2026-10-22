import { useMemo, useState } from 'react';
import { api } from '../api';
import { useCan } from '../App';
import { ErrorBox } from '../components/ui';
import { useResource } from '../hooks';

interface RotaData {
  radiologists: { id: string; code: string; full_name: string; on_shift_now: boolean; absent_now: string | null }[];
  shifts: { id: string; radiologist_id: string; starts_at: string; ends_at: string; kind: string; note: string | null }[];
  absences: { id: string; radiologist_id: string; kind: string; starts_at: string; ends_at: string | null }[];
}

const DAY = 86400_000;
const ABSENCE_LABEL: Record<string, string> = { leave: 'Leave', break: 'Break', training: 'Training', other: 'Absent' };

function startOfWeek(d: Date) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = (x.getDay() + 6) % 7; // Monday first
  return new Date(x.getTime() - day * DAY);
}
const time = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const localInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

export function Rota() {
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const weekEnd = new Date(weekStart.getTime() + 7 * DAY);
  const { data, error, reload } = useResource<RotaData>(`/rota?from=${weekStart.toISOString()}&to=${weekEnd.toISOString()}`);
  const can = useCan();
  const [actionError, setActionError] = useState<string | null>(null);
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => new Date(weekStart.getTime() + i * DAY)), [weekStart]);

  const firstId = data?.radiologists[0]?.id ?? '';
  const [shift, setShift] = useState({ radiologistId: '', start: localInput(new Date(new Date().setHours(8, 0, 0, 0))), end: localInput(new Date(new Date().setHours(20, 0, 0, 0))), kind: 'reporting' });
  const [absence, setAbsence] = useState({ radiologistId: '', kind: 'leave', start: localInput(new Date(new Date().setHours(0, 0, 0, 0))), end: localInput(new Date(new Date().setHours(23, 59, 0, 0))) });

  const act = async (fn: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await fn();
      await reload();
    } catch (e) {
      setActionError((e as Error).message);
    }
  };

  // An open-ended absence is shown up to today only.
  const inDay = (startIso: string, endIso: string | null, day: Date) => {
    const s = new Date(startIso).getTime();
    const e = endIso ? new Date(endIso).getTime() : Date.now();
    return s < day.getTime() + DAY && e > day.getTime();
  };
  /** "08:00–20:00" within a day; "from 20:00 →" and "→ until 08:00" when a shift crosses midnight. */
  const span = (startIso: string, endIso: string, day: Date) => {
    const s = new Date(startIso).getTime();
    const e = new Date(endIso).getTime();
    const startsToday = s >= day.getTime();
    const endsToday = e <= day.getTime() + DAY;
    if (startsToday && endsToday) return `${time(startIso)}–${time(endIso)}`;
    if (startsToday) return `from ${time(startIso)} →`;
    if (endsToday) return `→ until ${time(endIso)}`;
    return 'all day';
  };

  return (
    <>
      <h1>Rota</h1>
      <p className="muted small">
        Only radiologists on a shift, and not on leave or a break, receive new work. Times are shown in your browser’s time zone. Removing a
        shift or starting leave does not withdraw work a radiologist already holds.
      </p>
      <ErrorBox error={error ?? actionError} />
      <div className="row" style={{ marginBottom: '0.8rem' }}>
        <button className="secondary" onClick={() => setWeekStart(new Date(weekStart.getTime() - 7 * DAY))}>
          ← Previous week
        </button>
        <button className="secondary" onClick={() => setWeekStart(startOfWeek(new Date()))}>
          This week
        </button>
        <button className="secondary" onClick={() => setWeekStart(new Date(weekStart.getTime() + 7 * DAY))}>
          Next week →
        </button>
        <strong>
          Week of {weekStart.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}
        </strong>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th>Radiologist</th>
              {days.map((d) => (
                <th key={d.toISOString()}>{d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data?.radiologists.map((r) => (
              <tr key={r.id}>
                <td>
                  {r.full_name}
                  <div className="small">
                    {r.absent_now ? (
                      <span className="badge warn">{ABSENCE_LABEL[r.absent_now]} now</span>
                    ) : r.on_shift_now ? (
                      <span className="badge good">On shift now</span>
                    ) : (
                      <span className="badge grey">Off shift</span>
                    )}
                  </div>
                </td>
                {days.map((d) => (
                  <td key={d.toISOString()} style={{ minWidth: 120 }}>
                    {data.shifts
                      .filter((s) => s.radiologist_id === r.id && inDay(s.starts_at, s.ends_at, d))
                      .map((s) => (
                        <div key={s.id} className="badge" style={{ display: 'flex', justifyContent: 'space-between', gap: 4, marginBottom: 3 }}>
                          <span>
                            {span(s.starts_at, s.ends_at, d)}
                            {s.kind === 'on_call' ? ' on call' : ''}
                          </span>
                          {can('availability.manage') && (
                            <button
                              aria-label="Remove shift"
                              title="Remove shift"
                              style={{ padding: '0 0.3rem', fontSize: '0.75rem' }}
                              className="secondary"
                              onClick={() => window.confirm('Remove this shift?') && act(() => api(`/rota/shifts/${s.id}/delete`, { method: 'POST' }))}
                            >
                              ×
                            </button>
                          )}
                        </div>
                      ))}
                    {data.absences
                      .filter((a) => a.radiologist_id === r.id && inDay(a.starts_at, a.ends_at, d))
                      .map((a) => (
                        <div key={a.id} className="badge warn" style={{ display: 'flex', justifyContent: 'space-between', gap: 4, marginBottom: 3 }}>
                          <span>
                            {ABSENCE_LABEL[a.kind]} {a.ends_at ? '' : '(open)'}
                          </span>
                          {can('availability.manage') && (!a.ends_at || new Date(a.ends_at) > new Date()) && (
                            <button
                              aria-label="End absence"
                              title="End now"
                              style={{ padding: '0 0.3rem', fontSize: '0.75rem' }}
                              className="secondary"
                              onClick={() => act(() => api(`/rota/absences/${a.id}/end`, { method: 'POST' }))}
                            >
                              End
                            </button>
                          )}
                        </div>
                      ))}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {can('availability.manage') && data && (
        <div className="grid2">
          <div className="panel">
            <h3 style={{ marginTop: 0 }}>Add a shift</h3>
            <div className="row">
              <label>
                Radiologist
                <select value={shift.radiologistId || firstId} onChange={(e) => setShift({ ...shift, radiologistId: e.target.value })}>
                  {data.radiologists.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.full_name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Starts
                <input type="datetime-local" value={shift.start} onChange={(e) => setShift({ ...shift, start: e.target.value })} />
              </label>
              <label>
                Ends
                <input type="datetime-local" value={shift.end} onChange={(e) => setShift({ ...shift, end: e.target.value })} />
              </label>
              <label>
                Type
                <select value={shift.kind} onChange={(e) => setShift({ ...shift, kind: e.target.value })}>
                  <option value="reporting">Reporting</option>
                  <option value="on_call">On call</option>
                </select>
              </label>
              <button
                onClick={() =>
                  act(() =>
                    api('/rota/shifts', {
                      method: 'POST',
                      body: { radiologistId: shift.radiologistId || firstId, startsAt: new Date(shift.start).toISOString(), endsAt: new Date(shift.end).toISOString(), kind: shift.kind },
                    }),
                  )
                }
              >
                Add shift
              </button>
            </div>
          </div>
          <div className="panel">
            <h3 style={{ marginTop: 0 }}>Add leave, a planned break or other absence</h3>
            <div className="row">
              <label>
                Radiologist
                <select value={absence.radiologistId || firstId} onChange={(e) => setAbsence({ ...absence, radiologistId: e.target.value })}>
                  {data.radiologists.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.full_name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Type
                <select value={absence.kind} onChange={(e) => setAbsence({ ...absence, kind: e.target.value })}>
                  <option value="leave">Leave</option>
                  <option value="break">Break (planned, e.g. lunch)</option>
                  <option value="training">Training</option>
                  <option value="other">Other</option>
                </select>
              </label>
              <label>
                From
                <input type="datetime-local" value={absence.start} onChange={(e) => setAbsence({ ...absence, start: e.target.value })} />
              </label>
              <label>
                To
                <input type="datetime-local" value={absence.end} onChange={(e) => setAbsence({ ...absence, end: e.target.value })} />
              </label>
              <button
                onClick={() =>
                  act(() =>
                    api('/rota/absences', {
                      method: 'POST',
                      body: { radiologistId: absence.radiologistId || firstId, kind: absence.kind, startsAt: new Date(absence.start).toISOString(), endsAt: new Date(absence.end).toISOString() },
                    }),
                  )
                }
              >
                Add
              </button>
            </div>
            <p className="small muted">No new work is given during any of these. Breaks can also be started and ended on the spot from the Availability page.</p>
          </div>
        </div>
      )}
    </>
  );
}
