import { useState } from 'react';
import type { FormEvent } from 'react';
import { signIn } from '../auth/useSession';
import { APP_NAME } from '../config';

export function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const err = await signIn(email.trim(), password);
    setBusy(false);
    if (err) setError(err);
  }

  return (
    <div className="center-screen">
      <form className="card auth-card" onSubmit={submit}>
        <div className="wordmark" style={{ fontSize: 22, marginBottom: 4 }}>
          <span className="r">R</span> {APP_NAME}
        </div>
        <p className="muted small" style={{ marginBottom: 16 }}>
          Private — sign in to continue.
        </p>
        {error && <div className="error-banner">{error}</div>}
        <label className="field">
          <span>Email</span>
          <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        <button className="btn primary" style={{ width: '100%', marginTop: 4 }} disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
