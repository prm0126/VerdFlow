import { ROLES } from '@vf/shared';
import { useState } from 'react';
import { api } from '../api';
import { useMe } from '../App';
import { ErrorBox, When } from '../components/ui';
import { useResource } from '../hooks';

interface UserRow {
  id: string;
  email: string;
  full_name: string;
  status: string;
  last_login_at: string | null;
  locked: boolean;
  has_password: boolean;
  roles: string[];
}

const linkFor = (token: string) => `${window.location.origin}/set-password/${token}`;

function RolePicker({ value, onChange }: { value: string[]; onChange: (r: string[]) => void }) {
  return (
    <div className="row">
      {Object.entries(ROLES).map(([code, r]) => (
        <label key={code} style={{ flexDirection: 'row', alignItems: 'center', gap: '0.3rem' }}>
          <input type="checkbox" checked={value.includes(code)} onChange={(e) => onChange(e.target.checked ? [...value, code] : value.filter((x) => x !== code))} />
          {r.name}
        </label>
      ))}
    </div>
  );
}

export function Users() {
  const { data, error, reload } = useResource<UserRow[]>('/users');
  const me = useMe();
  const [form, setForm] = useState({ email: '', fullName: '', roles: ['viewer'] });
  const [editing, setEditing] = useState<{ id: string; roles: string[] } | null>(null);
  const [link, setLink] = useState<{ who: string; url: string } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const act = async (fn: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await fn();
      await reload();
    } catch (e) {
      setActionError((e as Error).message);
    }
  };

  return (
    <>
      <h1>Users</h1>
      <p className="muted small">
        New users get a single-use link to set their own password, valid for 72 hours. Pass it on securely. VerdFlow never emails or shows
        passwords. Changing someone’s roles or suspending them signs them out at once.
      </p>
      <ErrorBox error={error ?? actionError} />
      {link && (
        <div className="notice" style={{ wordBreak: 'break-all' }}>
          Set-password link for {link.who}: <code>{link.url}</code>{' '}
          <button className="secondary" onClick={() => navigator.clipboard?.writeText(link.url)}>
            Copy
          </button>
        </div>
      )}
      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Add a user</h3>
        <div className="row">
          <label>
            Name
            <input value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
          </label>
          <label>
            Email
            <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </label>
        </div>
        <div style={{ margin: '0.6rem 0' }}>
          <RolePicker value={form.roles} onChange={(roles) => setForm({ ...form, roles })} />
        </div>
        <button
          onClick={() =>
            act(async () => {
              const r = await api<{ token: string }>('/users', { method: 'POST', body: form });
              setLink({ who: form.email, url: linkFor(r.token) });
              setForm({ email: '', fullName: '', roles: ['viewer'] });
            })
          }
        >
          Add user
        </button>
      </div>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Email</th>
            <th>Roles</th>
            <th>Status</th>
            <th>Last sign-in</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data?.map((u) => (
            <tr key={u.id}>
              <td>{u.full_name}</td>
              <td>{u.email}</td>
              <td>
                {editing?.id === u.id ? (
                  <>
                    <RolePicker value={editing.roles} onChange={(roles) => setEditing({ id: u.id, roles })} />
                    <div className="row" style={{ marginTop: '0.4rem' }}>
                      <button onClick={() => act(async () => (await api(`/users/${u.id}`, { method: 'PUT', body: { roles: editing.roles } }), setEditing(null)))}>Save</button>
                      <button className="secondary" onClick={() => setEditing(null)}>
                        Cancel
                      </button>
                    </div>
                  </>
                ) : (
                  u.roles.map((r) => ROLES[r]?.name ?? r).join(', ')
                )}
              </td>
              <td>
                {u.status === 'active' ? <span className="badge good">Active</span> : <span className="badge grey">Suspended</span>}
                {u.locked && <span className="badge warn"> Locked</span>}
                {!u.has_password && <span className="badge warn"> No password yet</span>}
              </td>
              <td>
                <When value={u.last_login_at} />
              </td>
              <td>
                <div className="row">
                  {editing?.id !== u.id && (
                    <button className="secondary" onClick={() => setEditing({ id: u.id, roles: u.roles })}>
                      Roles
                    </button>
                  )}
                  {u.status === 'active' && (
                    <button
                      className="secondary"
                      onClick={() =>
                        act(async () => {
                          const r = await api<{ token: string }>(`/users/${u.id}/password-link`, { method: 'POST' });
                          setLink({ who: u.email, url: linkFor(r.token) });
                        })
                      }
                    >
                      New password link
                    </button>
                  )}
                  {u.id !== me.id &&
                    (u.status === 'active' ? (
                      <button className="danger" onClick={() => window.confirm(`Suspend ${u.full_name}? They will be signed out.`) && act(() => api(`/users/${u.id}`, { method: 'PUT', body: { status: 'suspended' } }))}>
                        Suspend
                      </button>
                    ) : (
                      <button className="secondary" onClick={() => act(() => api(`/users/${u.id}`, { method: 'PUT', body: { status: 'active' } }))}>
                        Reactivate
                      </button>
                    ))}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
