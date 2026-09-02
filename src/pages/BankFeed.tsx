// Bank feed review — transactions pulled from Nedbank, staged for a human.
//
// The feed never writes to the ledger by itself. Rows arrive as `pending` and
// only become transactions when ticked here, the same discipline as the CSV
// importer: a bank feed posting straight into the books would mean the
// statements change without anyone deciding they should.
import { useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { SUPABASE_URL } from '../config';
import { useData } from '../data/DataContext';
import { Empty } from '../components/ui';
import { fmtDate, fmtMoney } from '../lib/format';
import { applyRules } from '../logic/importParse';
import type { ImportRow } from '../logic/importParse';
import { directionToKind } from '../logic/openBanking';
import type { BankFeedRow } from '../types';

export function BankFeed() {
  const data = useData();
  const { bankConnections, bankFeed, categories, accounts, importRules, refresh } = data;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const [linking, setLinking] = useState(false);

  // The link function bounces the browser back here with the outcome.
  const linkOutcome = useMemo(() => {
    const q = new URLSearchParams(window.location.hash.split('?')[1] ?? '');
    const linked = q.get('linked');
    return linked ? { ok: linked === 'ok', message: q.get('m') ?? '' } : null;
  }, []);

  async function connectBank() {
    setLinking(true);
    setError(null);
    try {
      const { data: session } = await supabase.auth.getSession();
      const token = session.session?.access_token;
      if (!token) throw new Error('Not signed in.');
      const res = await fetch(`${SUPABASE_URL}/functions/v1/nedbank-link`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.authorizeUrl) throw new Error(body.error ?? `Could not start the link (${res.status}).`);
      // Nedbank's own page handles the login; we never see those credentials.
      window.location.href = body.authorizeUrl as string;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setLinking(false);
    }
  }

  const pending = useMemo(
    () => bankFeed.filter((f) => f.status === 'pending').sort((a, b) => b.booked_on.localeCompare(a.booked_on)),
    [bankFeed],
  );

  // Reuse the importer's rule engine so a payee categorised once is
  // categorised the same way whether it arrived by CSV or by API.
  const suggestions = useMemo(() => {
    const asImportRows: ImportRow[] = pending.map((f, i) => ({
      index: i,
      date: f.booked_on,
      description: f.description ?? '',
      amount: f.amount,
      kind: directionToKind(f.direction),
      categoryId: null,
      payee: f.description ?? '',
      include: true,
      duplicate: false,
      matchedRule: null,
    }));
    const ruled = applyRules(asImportRows, importRules, categories);
    return new Map(pending.map((f, i) => [f.id, ruled[i]]));
  }, [pending, importRules, categories]);

  const categoryFor = (f: BankFeedRow) => chosen[f.id] ?? suggestions.get(f.id)?.categoryId ?? '';
  const isTicked = (f: BankFeedRow) => ticked[f.id] ?? true;
  const selected = pending.filter(isTicked);

  async function syncNow() {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const { data: session } = await supabase.auth.getSession();
      const token = session.session?.access_token;
      if (!token) throw new Error('Not signed in.');
      const res = await fetch(`${SUPABASE_URL}/functions/v1/nedbank-sync`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `Sync failed (${res.status}).`);
      const results = (body.results ?? []) as { connection: string; new?: number; error?: string }[];
      setNote(
        results
          .map((r) => (r.error ? `${r.connection}: ${r.error}` : `${r.connection}: ${r.new ?? 0} new`))
          .join(' · ') || 'Nothing new.',
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
    await refresh();
  }

  async function postSelected() {
    if (selected.length === 0) return setError('Nothing ticked.');
    const missingAccount = selected.filter((f) => !f.account_id);
    if (missingAccount.length) return setError('Some rows have no account mapped — set it on the connection first.');
    setBusy(true);
    setError(null);
    let posted = 0;
    for (const f of selected) {
      const { data: created, error: insErr } = await supabase
        .from('fin_transactions')
        .insert({
          tx_date: f.booked_on,
          kind: directionToKind(f.direction),
          amount: f.amount,
          category_id: categoryFor(f) || null,
          account_id: f.account_id,
          payee: (f.description ?? '').slice(0, 120) || null,
          import_ref: (f.description ?? '').slice(0, 300) || null,
        })
        .select('id')
        .single();
      if (insErr) {
        setBusy(false);
        await refresh();
        return setError(`Posted ${posted} before failing: ${insErr.message}`);
      }
      await supabase
        .from('fin_bank_feed')
        .update({ status: 'imported', transaction_id: (created as { id: string }).id })
        .eq('id', f.id);
      posted++;
    }
    setBusy(false);
    setNote(`Posted ${posted} transaction${posted === 1 ? '' : 's'} to the ledger.`);
    setTicked({});
    await refresh();
  }

  async function ignoreSelected() {
    setBusy(true);
    for (const f of selected) await supabase.from('fin_bank_feed').update({ status: 'ignored' }).eq('id', f.id);
    setBusy(false);
    setTicked({});
    await refresh();
  }

  async function mapAccount(connectionId: string, accountId: string) {
    await supabase.from('fin_bank_connections').update({ account_id: accountId || null }).eq('id', connectionId);
    await supabase.from('fin_bank_feed').update({ account_id: accountId || null })
      .eq('connection_id', connectionId).eq('status', 'pending');
    await refresh();
  }

  const expenseCats = categories.filter((c) => !c.archived && c.kind === 'expense');
  const incomeCats = categories.filter((c) => !c.archived && c.kind === 'income');

  return (
    <div className="stack">
      <div className="row wrap">
        <h1>Bank feed</h1>
        <div className="spacer" />
        <button className="btn" onClick={connectBank} disabled={linking}>
          {linking ? 'Starting…' : bankConnections.length ? 'Re-link bank' : 'Connect Nedbank'}
        </button>
        <button className="btn primary" onClick={syncNow} disabled={busy || bankConnections.length === 0}>
          {busy ? 'Syncing…' : 'Sync now'}
        </button>
      </div>

      {linkOutcome && (
        <div className={linkOutcome.ok ? 'card small' : 'error-banner'}>{linkOutcome.message}</div>
      )}
      {error && <div className="error-banner">{error}</div>}
      {note && <div className="card small">{note}</div>}

      {bankConnections.length === 0 ? (
        <div className="card">
          <div className="card-head">
            <h2>No bank connected yet</h2>
          </div>
          <p className="small muted">
            Tsamaya Money can pull transactions straight from Nedbank's API Marketplace, which serves the Open
            Banking v3.1 account-information shape. Connecting needs three things that only you can do:
          </p>
          <ol className="small muted">
            <li>
              Register on <code>apim.nedbank.co.za</code> and create an app to get a client ID and client secret.
            </li>
            <li>
              Ask Nedbank to move the app from sandbox to <strong>production</strong> against the business current
              account — that step is reviewed and approved by them, with a relationship manager.
            </li>
            <li>
              Authorise the consent in your own Nedbank login. Your banking credentials go to Nedbank and nowhere
              else — this app never sees them, and neither do I.
            </li>
          </ol>
          <p className="small muted">
            The credentials are then set as Supabase function secrets, never in this page: the site is static, so
            anything in the bundle is public. See <code>docs/NEDBANK.md</code> for the exact commands.
          </p>
          <p className="small muted">
            When registering the app, the <strong>redirect URI</strong> to enter is{' '}
            <code>{SUPABASE_URL}/functions/v1/nedbank-link/callback</code>. Once the secrets are set, press
            <strong> Connect Nedbank</strong> above and approve in your own Nedbank login: the whole consent flow
            runs itself from there.
          </p>
        </div>
      ) : (
        <div className="card">
          <div className="card-head">
            <h2>Connections</h2>
          </div>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Bank account</th>
                  <th>Posts to</th>
                  <th>Status</th>
                  <th>Last synced</th>
                </tr>
              </thead>
              <tbody>
                {bankConnections.map((c) => (
                  <tr key={c.id}>
                    <td>
                      {c.label}
                      {c.last_sync_error && <span className="sub neg">{c.last_sync_error}</span>}
                    </td>
                    <td>
                      <select
                        style={{ minWidth: 150 }}
                        value={c.account_id ?? ''}
                        onChange={(e) => void mapAccount(c.id, e.target.value)}
                      >
                        <option value="">Choose an account…</option>
                        {accounts.filter((a) => !a.archived).map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <span className={`pill ${c.status === 'active' ? 'badge-ok' : c.status === 'error' ? 'badge-bad' : ''}`}>
                        {c.status}
                      </span>
                    </td>
                    <td className="small muted">{c.last_synced_at ? fmtDate(c.last_synced_at.slice(0, 10)) : 'never'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h2>Awaiting review</h2>
          <div className="spacer" />
          <span className="small muted">{pending.length} pending</span>
        </div>
        {pending.length === 0 ? (
          <Empty>
            Nothing waiting. Transactions pulled from the bank land here for you to check before they reach the
            ledger — they are never posted automatically.
          </Empty>
        ) : (
          <>
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 30 }}></th>
                    <th>Date</th>
                    <th>Description</th>
                    <th>Category</th>
                    <th className="num">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {pending.map((f) => {
                    const s = suggestions.get(f.id);
                    return (
                      <tr key={f.id} style={isTicked(f) ? undefined : { opacity: 0.5 }}>
                        <td>
                          <input
                            type="checkbox"
                            style={{ width: 'auto' }}
                            checked={isTicked(f)}
                            onChange={(e) => setTicked({ ...ticked, [f.id]: e.target.checked })}
                          />
                        </td>
                        <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(f.booked_on)}</td>
                        <td>
                          {f.description || <em className="muted">(no description)</em>}
                          {s?.matchedRule && <span className="sub">rule: {s.matchedRule}</span>}
                        </td>
                        <td>
                          <select
                            style={{ minWidth: 130 }}
                            value={categoryFor(f)}
                            onChange={(e) => setChosen({ ...chosen, [f.id]: e.target.value })}
                          >
                            <option value="">Uncategorised</option>
                            {(f.direction === 'credit' ? incomeCats : expenseCats).map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className={`num ${f.direction === 'credit' ? 'pos' : ''}`}>
                          {f.direction === 'credit' ? '+' : '−'}
                          {fmtMoney(f.amount)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="row wrap" style={{ marginTop: 12 }}>
              <button className="btn small" onClick={() => setTicked(Object.fromEntries(pending.map((f) => [f.id, true])))}>
                Tick all
              </button>
              <button className="btn small" onClick={() => setTicked(Object.fromEntries(pending.map((f) => [f.id, false])))}>
                Untick all
              </button>
              <div className="spacer" />
              <button className="btn small" onClick={ignoreSelected} disabled={busy || selected.length === 0}>
                Ignore
              </button>
              <button className="btn primary" onClick={postSelected} disabled={busy || selected.length === 0}>
                {busy ? 'Posting…' : `Post ${selected.length} to the ledger`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
