import { createContext, useContext, useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { api, ApiError, type Me } from './api';
import { Availability } from './pages/Availability';
import { Dashboard } from './pages/Dashboard';
import { Errors } from './pages/Errors';
import { Login } from './pages/Login';
import { Masters } from './pages/Masters';
import { Rules } from './pages/Rules';
import { StudyDetail } from './pages/StudyDetail';
import { Studies } from './pages/Studies';
import { AuditLog } from './pages/AuditLog';
import { Rota } from './pages/Rota';
import { SetPassword } from './pages/SetPassword';
import { Users } from './pages/Users';

const MeContext = createContext<Me | null>(null);
export const useMe = () => useContext(MeContext)!;
export const useCan = () => {
  const me = useMe();
  return (p: string) => me.permissions.includes(p);
};

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const location = useLocation();
  const refresh = () =>
    api<Me>('/auth/me')
      .then(setMe)
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) setMe(null);
        else setMe(null);
      });
  useEffect(() => {
    refresh();
  }, []);

  const setPassword = location.pathname.match(/^\/set-password\/([^/]+)$/);
  if (setPassword) return <SetPassword token={setPassword[1]} />;
  if (me === undefined) return <p className="muted" style={{ padding: '2rem' }}>Loading…</p>;
  if (me === null) return <Login onSignedIn={refresh} />;

  const can = (p: string) => me.permissions.includes(p);
  const logout = async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    setMe(null);
  };

  return (
    <MeContext.Provider value={me}>
      <div className="layout">
        <nav className="sidebar" aria-label="Main">
          <div className="brand">
            VerdFlow<small>Teleradiology workflow</small>
          </div>
          <NavLink to="/" end>Dashboard</NavLink>
          <NavLink to="/studies">Worklist</NavLink>
          {can('errors.manage') && <NavLink to="/errors">Errors</NavLink>}
          <NavLink to="/availability">Availability</NavLink>
          <NavLink to="/rota">Rota</NavLink>
          <NavLink to="/rules">Rules</NavLink>
          <NavLink to="/masters">Masters</NavLink>
          {can('users.manage') && <NavLink to="/users">Users</NavLink>}
          {can('audit.view') && <NavLink to="/audit">Audit log</NavLink>}
          <div className="spacer" />
          <div className="who">
            {me.fullName}
            <br />
            <span className="small">{me.roles.join(', ')}</span>
          </div>
          <button className="secondary" onClick={logout}>
            Sign out
          </button>
        </nav>
        <main>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/studies" element={<Studies />} />
            <Route path="/studies/:id" element={<StudyDetail />} />
            <Route path="/errors" element={<Errors />} />
            <Route path="/availability" element={<Availability />} />
            <Route path="/rules" element={<Rules />} />
            <Route path="/masters" element={<Masters />} />
            <Route path="/rota" element={<Rota />} />
            <Route path="/users" element={<Users />} />
            <Route path="/audit" element={<AuditLog />} />
            <Route path="*" element={<Navigate to="/" />} />
          </Routes>
        </main>
      </div>
    </MeContext.Provider>
  );
}
