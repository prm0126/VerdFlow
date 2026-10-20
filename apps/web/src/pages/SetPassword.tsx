import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';

export function SetPassword({ token }: { token: string }) {
  const [who, setWho] = useState<{ email: string; fullName: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState(false);

  useEffect(() => {
    api<{ email: string; fullName: string }>(`/auth/password-link/${encodeURIComponent(token)}`)
      .then(setWho)
      .catch((e) => setError((e as Error).message));
  }, [token]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) return setError('The two passwords do not match');
    setError(null);
    try {
      await api(`/auth/password-link/${encodeURIComponent(token)}`, { method: 'POST', body: { password } });
      setDone(true);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="login">
      <h1>Set your password</h1>
      {done ? (
        <>
          <p>Your password is set.</p>
          <a className="button" href="/">
            Sign in
          </a>
        </>
      ) : who ? (
        <form onSubmit={submit}>
          <p className="muted">
            {who.fullName} ({who.email})
          </p>
          <label>
            New password (at least 12 characters)
            <input type="password" autoComplete="new-password" minLength={12} value={password} onChange={(e) => setPassword(e.target.value)} required />
          </label>
          <label>
            Type it again
            <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
          </label>
          {error && <div className="error" role="alert">{error}</div>}
          <button>Set password</button>
        </form>
      ) : (
        error && <div className="error" role="alert">{error}</div>
      )}
    </div>
  );
}
