import { useState } from 'react';
import { supabase } from '../lib/supabase';
import { useData } from '../data/DataContext';
import { Field } from '../components/ui';
import { fmtDate } from '../lib/format';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export function Settings() {
  const { settings, refresh } = useData();
  const [entityName, setEntityName] = useState(settings.entity_name);
  const [regNo, setRegNo] = useState(settings.registration_number ?? '');
  const [fyEnd, setFyEnd] = useState(settings.fy_end_month);
  const [lockedUntil, setLockedUntil] = useState(settings.locked_until ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    const { error: err } = await supabase
      .from('fin_settings')
      .update({
        entity_name: entityName.trim() || 'Company',
        registration_number: regNo.trim() || null,
        fy_end_month: fyEnd,
        locked_until: lockedUntil || null,
      })
      .eq('user_id', (await supabase.auth.getUser()).data.user?.id ?? '');
    setBusy(false);
    if (err) return setError(err.message);
    setSaved(true);
    await refresh();
  }

  return (
    <div className="stack">
      <h1>Settings</h1>

      {error && <div className="error-banner">{error}</div>}
      {saved && <div className="card small">Saved.</div>}

      <div className="card">
        <div className="card-head">
          <h2>Entity</h2>
        </div>
        <p className="small muted">
          These appear on the face of every statement and in the notes — IFRS for SMEs Section 3.23 requires the
          entity to be identified on each one.
        </p>
        <Field label="Registered name">
          <input value={entityName} onChange={(e) => setEntityName(e.target.value)} />
        </Field>
        <Field label="Registration number">
          <input value={regNo} onChange={(e) => setRegNo(e.target.value)} placeholder="e.g. 2023/123456/07" />
        </Field>
        <Field label="Financial year ends in">
          <select value={fyEnd} onChange={(e) => setFyEnd(Number(e.target.value))}>
            {MONTHS.map((m, i) => (
              <option key={m} value={i + 1}>
                {m}
              </option>
            ))}
          </select>
        </Field>
        <p className="small muted" style={{ marginTop: -6 }}>
          A February year end means the year runs 1 March to 28 February. Changing this re-cuts every statement, so
          set it to the year end actually adopted by the company.
        </p>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Close a period</h2>
        </div>
        <p className="small muted">
          Nothing can be posted, edited or deleted on or before this date — transactions, journals, capital
          transactions, depreciation and disposals alike. Set it once a year has been reported so the figures cannot
          move underneath statements you have already issued. This is enforced by the database, not just this screen.
        </p>
        <Field label="Locked up to and including">
          <input type="date" value={lockedUntil} onChange={(e) => setLockedUntil(e.target.value)} />
        </Field>
        {settings.locked_until ? (
          <p className="small">
            <strong>Currently locked</strong> up to {fmtDate(settings.locked_until)}. Clear the date to reopen.
          </p>
        ) : (
          <p className="small muted">No period is closed — everything is editable.</p>
        )}
      </div>

      <div className="row">
        <div className="spacer" />
        <button className="btn primary" onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Save settings'}
        </button>
      </div>
    </div>
  );
}
