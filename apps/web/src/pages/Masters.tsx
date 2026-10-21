import { useState } from 'react';
import { api, ApiError } from '../api';
import { useCan } from '../App';
import { ErrorBox } from '../components/ui';
import { useResource } from '../hooks';

type FieldType = 'text' | 'number' | 'bool' | 'list' | 'select';
interface Field {
  key: string;
  label: string;
  type: FieldType;
  options?: string[];
  createOnly?: boolean;
}

const KINDS: Record<string, { title: string; fields: Field[] }> = {
  hospitals: {
    title: 'Hospitals',
    fields: [
      { key: 'code', label: 'Code (as sent in MSH-4)', type: 'text', createOnly: true },
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'timezone', label: 'Time zone', type: 'text' },
      { key: 'outboundPartnerCode', label: 'Send assignments to (partner code)', type: 'text' },
      { key: 'active', label: 'Active', type: 'bool' },
    ],
  },
  rooms: {
    title: 'Rooms',
    fields: [
      { key: 'hospitalCode', label: 'Hospital', type: 'text', createOnly: true },
      { key: 'code', label: 'Code (as sent in PV1-3, second part)', type: 'text', createOnly: true },
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'modalities', label: 'Modalities allowed (blank for any)', type: 'list' },
      { key: 'status', label: 'Status', type: 'select', options: ['open', 'closed'] },
      { key: 'active', label: 'Active', type: 'bool' },
    ],
  },
  employees: {
    title: 'Employees',
    fields: [
      { key: 'code', label: 'Employee code', type: 'text', createOnly: true },
      { key: 'fullName', label: 'Name', type: 'text' },
      { key: 'email', label: 'Work email', type: 'text' },
      { key: 'jobTitle', label: 'Job title', type: 'text' },
      { key: 'active', label: 'Active', type: 'bool' },
    ],
  },
  radiologists: {
    title: 'Radiologists',
    fields: [
      { key: 'code', label: 'Code', type: 'text', createOnly: true },
      { key: 'fullName', label: 'Name', type: 'text' },
      { key: 'externalId', label: 'ID known to the destination', type: 'text' },
      { key: 'employeeCode', label: 'Employee code', type: 'text' },
      { key: 'grade', label: 'Grade', type: 'select', options: ['', 'CONSULTANT', 'REGISTRAR'] },
      { key: 'specialties', label: 'Specialties', type: 'list' },
      { key: 'modalities', label: 'Modality privileges', type: 'list' },
      { key: 'hospitals', label: 'Hospitals they may report for', type: 'list' },
      { key: 'teams', label: 'Teams', type: 'list' },
      { key: 'capacityUnits', label: 'Capacity (work units)', type: 'number' },
      { key: 'active', label: 'Active', type: 'bool' },
    ],
  },
  teams: {
    title: 'Teams',
    fields: [
      { key: 'code', label: 'Code', type: 'text', createOnly: true },
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'active', label: 'Active', type: 'bool' },
    ],
  },
  modalities: {
    title: 'Modalities',
    fields: [
      { key: 'code', label: 'Code (as sent in OBR-24)', type: 'text', createOnly: true },
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'workUnits', label: 'Work units per study', type: 'number' },
      { key: 'active', label: 'Active', type: 'bool' },
    ],
  },
  services: {
    title: 'Services',
    fields: [
      { key: 'code', label: 'Code (as sent in OBR-4)', type: 'text', createOnly: true },
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'modalityCode', label: 'Modality', type: 'text' },
      { key: 'workUnits', label: 'Work units (overrides modality)', type: 'number' },
      { key: 'requiresVetting', label: 'Needs vetting', type: 'bool' },
      { key: 'vettingProtocols', label: 'Vetting protocols', type: 'list' },
      { key: 'active', label: 'Active', type: 'bool' },
    ],
  },
  partners: {
    title: 'Integration partners',
    fields: [
      { key: 'code', label: 'Code', type: 'text', createOnly: true },
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'direction', label: 'Direction', type: 'select', options: ['inbound', 'outbound'], createOnly: true },
      { key: 'role', label: 'Sends (inbound)', type: 'select', options: ['source', 'reporting', 'presence'] },
      { key: 'allowedFacilities', label: 'Allowed sending facilities (inbound)', type: 'list' },
      { key: 'endpointUrl', label: 'Endpoint URL (outbound)', type: 'text' },
      { key: 'receivingApplication', label: 'Receiving application (MSH-5)', type: 'text' },
      { key: 'receivingFacility', label: 'Receiving facility (MSH-6)', type: 'text' },
      { key: 'timeoutMs', label: 'Timeout (ms)', type: 'number' },
      { key: 'active', label: 'Active', type: 'bool' },
    ],
  },
};

type Rec = Record<string, unknown>;

function cell(v: unknown) {
  if (Array.isArray(v)) return v.join(', ') || '—';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return v === null || v === undefined || v === '' ? '—' : String(v);
}

function Form({ kind, initial, onDone }: { kind: string; initial: Rec | null; onDone: (msg?: string) => void }) {
  const spec = KINDS[kind];
  const [rec, setRec] = useState<Rec>(
    initial ?? { active: true, ...(kind === 'partners' ? { direction: 'inbound', role: 'source', timeoutMs: 10000 } : {}), ...(kind === 'rooms' ? { status: 'open' } : {}) },
  );
  const [err, setErr] = useState<{ message: string; issues: string[] } | null>(null);
  const save = async () => {
    setErr(null);
    const body: Rec = {};
    for (const f of spec.fields) {
      const v = rec[f.key];
      if (f.type === 'number') body[f.key] = v === '' || v === undefined || v === null ? undefined : Number(v);
      else if (f.type === 'list') body[f.key] = Array.isArray(v) ? v : String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      else if (f.type === 'bool') body[f.key] = !!v;
      else body[f.key] = v === '' ? null : v;
    }
    if (body.code === null || body.name === null) return setErr({ message: 'Code and name are required', issues: [] });
    try {
      const r = await api<{ code: string; apiKey?: string }>(`/masters/${kind}`, { method: 'PUT', body });
      onDone(r.apiKey ? `Partner key for ${r.code} (copy it now, it is not shown again): ${r.apiKey}` : `Saved ${r.code}.`);
    } catch (e) {
      setErr({ message: (e as Error).message, issues: e instanceof ApiError ? e.issues : [] });
    }
  };
  return (
    <div className="panel">
      <h3 style={{ marginTop: 0 }}>{initial ? `Edit ${String(initial.code)}` : `Add to ${spec.title.toLowerCase()}`}</h3>
      <div className="row">
        {spec.fields.map((f) => {
          const locked = !!initial && f.createOnly;
          const v = rec[f.key];
          if (f.type === 'bool')
            return (
              <label key={f.key} style={{ flexDirection: 'row', alignItems: 'center', gap: '0.4rem' }}>
                <input type="checkbox" checked={!!v} onChange={(e) => setRec({ ...rec, [f.key]: e.target.checked })} />
                {f.label}
              </label>
            );
          if (f.type === 'select')
            return (
              <label key={f.key}>
                {f.label}
                <select disabled={locked} value={String(v ?? '')} onChange={(e) => setRec({ ...rec, [f.key]: e.target.value })}>
                  {f.options!.map((o) => (
                    <option key={o} value={o}>
                      {o || '—'}
                    </option>
                  ))}
                </select>
              </label>
            );
          return (
            <label key={f.key}>
              {f.label}
              <input
                disabled={locked}
                type={f.type === 'number' ? 'number' : 'text'}
                value={Array.isArray(v) ? v.join(', ') : String(v ?? '')}
                placeholder={f.type === 'list' ? 'comma separated' : ''}
                onChange={(e) => setRec({ ...rec, [f.key]: f.type === 'list' ? e.target.value : e.target.value })}
              />
            </label>
          );
        })}
      </div>
      {err && <ErrorBox error={err.message} issues={err.issues} />}
      <div className="row" style={{ marginTop: '0.8rem' }}>
        <button onClick={save}>Save</button>
        <button className="secondary" onClick={() => onDone()}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export function Masters() {
  const [kind, setKind] = useState('hospitals');
  const { data, error, reload } = useResource<Rec[]>(`/masters/${kind}`);
  const can = useCan();
  const [editing, setEditing] = useState<Rec | null | 'new'>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const spec = KINDS[kind];
  const done = (msg?: string) => {
    setEditing(null);
    if (msg) setNotice(msg);
    reload();
  };
  const rotate = async (code: string) => {
    if (!window.confirm(`Issue a new key for ${code}? The current key stops working straight away.`)) return;
    try {
      const r = await api<{ apiKey: string }>(`/masters/partners/${code}/rotate-key`, { method: 'POST' });
      setNotice(`New key for ${code} (copy it now, it is not shown again): ${r.apiKey}`);
    } catch (e) {
      setNotice((e as Error).message);
    }
  };
  return (
    <>
      <h1>Masters</h1>
      <div className="tabs">
        {Object.entries(KINDS).map(([k, v]) => (
          <button key={k} className={k === kind ? 'active' : ''} onClick={() => (setKind(k), setEditing(null), setNotice(null))}>
            {v.title}
          </button>
        ))}
      </div>
      {notice && <div className="notice" style={{ wordBreak: 'break-all' }}>{notice}</div>}
      <ErrorBox error={error} />
      {editing && <Form key={editing === 'new' ? 'new' : String(editing.code)} kind={kind} initial={editing === 'new' ? null : editing} onDone={done} />}
      {can('masters.manage') && !editing && (
        <button style={{ marginBottom: '0.6rem' }} onClick={() => setEditing('new')}>
          Add
        </button>
      )}
      <table>
        <thead>
          <tr>
            {spec.fields.map((f) => (
              <th key={f.key}>{f.label}</th>
            ))}
            {can('masters.manage') && <th />}
          </tr>
        </thead>
        <tbody>
          {data?.map((r) => (
            <tr key={`${String(r.hospitalCode ?? '')}${String(r.code)}`}>
              {spec.fields.map((f) => (
                <td key={f.key}>{cell(r[f.key])}</td>
              ))}
              {can('masters.manage') && (
                <td>
                  <div className="row">
                    <button className="secondary" onClick={() => setEditing(r)}>
                      Edit
                    </button>
                    {kind === 'partners' && r.direction === 'inbound' && (
                      <button className="secondary" onClick={() => rotate(String(r.code))}>
                        New key
                      </button>
                    )}
                  </div>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
