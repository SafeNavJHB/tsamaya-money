import { useMemo, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useData } from '../data/DataContext';
import { Empty, Field } from '../components/ui';
import { fmtDate, fmtMoney } from '../lib/format';
import {
  applyRules,
  buildImportRows,
  detectColumns,
  detectDateFormat,
  markDuplicates,
  parseStatement,
  suggestMatchText,
} from '../logic/importParse';
import type { ColumnMapping, DateFormat, ImportRow, ParsedTable } from '../logic/importParse';

const CHUNK = 200;

export function Import() {
  const { accounts, categories, transactions, importRules, refresh } = useData();
  const live = accounts.filter((a) => !a.archived);
  const fileRef = useRef<HTMLInputElement>(null);

  const [fileName, setFileName] = useState('');
  const [table, setTable] = useState<ParsedTable | null>(null);
  const [map, setMap] = useState<ColumnMapping | null>(null);
  const [dateFormat, setDateFormat] = useState<DateFormat>('auto');
  const [flipSigns, setFlipSigns] = useState(false);
  const [accountId, setAccountId] = useState(live[0]?.id ?? '');
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [skipped, setSkipped] = useState(0);
  const [remember, setRemember] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const expenseCats = categories.filter((c) => !c.archived && c.kind === 'expense');
  const incomeCats = categories.filter((c) => !c.archived && c.kind === 'income');

  function rebuild(t: ParsedTable, m: ColumnMapping, fmt: DateFormat, flip: boolean, acc: string) {
    const built = buildImportRows(t, m, { dateFormat: fmt, flipSigns: flip });
    const withRules = applyRules(built.rows, importRules, categories);
    setRows(markDuplicates(withRules, transactions, acc));
    setSkipped(built.skipped);
    // `remember` is keyed by preview-row index, and remapping columns can
    // renumber the rows — so drop it rather than attach a rule to the wrong row.
    setRemember({});
  }

  async function onFile(file: File) {
    setError(null);
    setDone(null);
    setRemember({});
    const text = await file.text();
    const t = parseStatement(text);
    if (t.rows.length === 0) {
      setTable(null);
      setRows([]);
      return setError("That file has no data rows we could read. Export the statement as CSV and try again.");
    }
    const m = detectColumns(t);
    if (m.date < 0 || (m.amount < 0 && m.debit < 0 && m.credit < 0)) {
      setTable(t);
      setMap(m);
      setRows([]);
      return setError('We could not tell which columns hold the date and the amount — pick them below.');
    }
    const fmt = detectDateFormat(t.rows.map((r) => r[m.date] ?? ''));
    setFileName(file.name);
    setTable(t);
    setMap(m);
    setDateFormat(fmt);
    rebuild(t, m, fmt, false, accountId);
  }

  function updateMapping(patch: Partial<ColumnMapping>) {
    if (!table || !map) return;
    const next = { ...map, ...patch };
    setMap(next);
    setError(null);
    if (next.date >= 0 && (next.amount >= 0 || next.debit >= 0 || next.credit >= 0))
      rebuild(table, next, dateFormat, flipSigns, accountId);
  }

  const setRow = (i: number, patch: Partial<ImportRow>) =>
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  const included = rows.filter((r) => r.include);
  const totals = useMemo(() => {
    let inc = 0;
    let exp = 0;
    for (const r of included) {
      if (r.kind === 'income') inc += r.amount;
      else exp += r.amount;
    }
    return { inc, exp };
  }, [included]);

  async function runImport() {
    if (!accountId) return setError('Pick the account this statement belongs to.');
    if (included.length === 0) return setError('Nothing ticked to import.');
    setBusy(true);
    setError(null);

    // New rules first, so a failed import doesn't lose the categorisation work.
    const newRules = Object.entries(remember)
      .map(([idx, text]) => {
        const row = rows[Number(idx)];
        return row && row.include && text.trim().length >= 2
          ? { match_text: text.trim(), category_id: row.categoryId, payee: row.payee.slice(0, 80) || null }
          : null;
      })
      .filter(Boolean) as { match_text: string; category_id: string | null; payee: string | null }[];
    const uniqueRules = [...new Map(newRules.map((r) => [r.match_text.toLowerCase(), r])).values()];
    if (uniqueRules.length) {
      const { error: rErr } = await supabase
        .from('fin_import_rules')
        .upsert(uniqueRules, { onConflict: 'user_id,match_text' });
      if (rErr) {
        setBusy(false);
        return setError(`Could not save the rules: ${rErr.message}`);
      }
    }

    const payload = included.map((r) => ({
      tx_date: r.date,
      kind: r.kind,
      amount: r.amount,
      category_id: r.categoryId,
      account_id: accountId,
      payee: r.payee.slice(0, 120) || null,
      import_ref: r.description.slice(0, 300) || null,
    }));
    let inserted = 0;
    for (let i = 0; i < payload.length; i += CHUNK) {
      const { error: iErr } = await supabase.from('fin_transactions').insert(payload.slice(i, i + CHUNK));
      if (iErr) {
        setBusy(false);
        await refresh();
        return setError(`Imported ${inserted} before failing: ${iErr.message}`);
      }
      inserted += Math.min(CHUNK, payload.length - i);
    }
    setBusy(false);
    setRows([]);
    setTable(null);
    setMap(null);
    setRemember({});
    if (fileRef.current) fileRef.current.value = '';
    setDone(
      `Imported ${inserted} transaction${inserted === 1 ? '' : 's'}` +
        (uniqueRules.length ? ` and saved ${uniqueRules.length} categorisation rule${uniqueRules.length === 1 ? '' : 's'}` : '') +
        '.',
    );
    await refresh();
  }

  async function deleteRule(id: string) {
    await supabase.from('fin_import_rules').delete().eq('id', id);
    await refresh();
  }

  const colOptions = (t: ParsedTable) =>
    t.headers.map((h, i) => (
      <option key={i} value={i}>
        {h.trim() ? `${i + 1}. ${h.trim()}` : `${i + 1}. (unnamed)`}
      </option>
    ));

  return (
    <div className="stack">
      <h1>Import bank statement</h1>
      <p className="small muted">
        Export your statement as CSV from internet banking, then drop it here. Nothing is saved until you press Import,
        and rows that look like they're already on file come in unticked.
      </p>

      {error && <div className="error-banner">{error}</div>}
      {done && <div className="card small">{done}</div>}

      <div className="card">
        <div className="row wrap">
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.txt,text/csv,text/plain"
            style={{ width: 'auto', flex: '1 1 220px' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onFile(f);
            }}
          />
          <select
            style={{ width: 'auto' }}
            value={accountId}
            onChange={(e) => {
              setAccountId(e.target.value);
              if (table && map) rebuild(table, map, dateFormat, flipSigns, e.target.value);
            }}
          >
            {live.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
        {fileName && (
          <p className="small muted" style={{ marginTop: 8, marginBottom: 0 }}>
            {fileName} · {table?.rows.length ?? 0} rows read
            {skipped > 0 && `, ${skipped} skipped (no readable date or amount)`}
          </p>
        )}
      </div>

      {table && map && (
        <div className="card">
          <div className="card-head">
            <h2>Columns</h2>
          </div>
          <div className="grid2">
            <Field label="Date column">
              <select value={map.date} onChange={(e) => updateMapping({ date: Number(e.target.value) })}>
                <option value={-1}>— none —</option>
                {colOptions(table)}
              </select>
            </Field>
            <Field label="Description column">
              <select value={map.description} onChange={(e) => updateMapping({ description: Number(e.target.value) })}>
                <option value={-1}>— none —</option>
                {colOptions(table)}
              </select>
            </Field>
            <Field label="Amount column (one signed column)">
              <select
                value={map.amount}
                onChange={(e) => updateMapping({ amount: Number(e.target.value), debit: -1, credit: -1 })}
              >
                <option value={-1}>— use debit/credit —</option>
                {colOptions(table)}
              </select>
            </Field>
            <Field label="Date format">
              <select value={dateFormat} onChange={(e) => {
                const f = e.target.value as DateFormat;
                setDateFormat(f);
                if (table && map) rebuild(table, map, f, flipSigns, accountId);
              }}>
                <option value="auto">Detect automatically</option>
                <option value="dmy">Day first (25/12/2026)</option>
                <option value="mdy">Month first (12/25/2026)</option>
                <option value="ymd">Year first (2026-12-25)</option>
              </select>
            </Field>
            {map.amount < 0 && (
              <>
                <Field label="Money out (debit) column">
                  <select value={map.debit} onChange={(e) => updateMapping({ debit: Number(e.target.value) })}>
                    <option value={-1}>— none —</option>
                    {colOptions(table)}
                  </select>
                </Field>
                <Field label="Money in (credit) column">
                  <select value={map.credit} onChange={(e) => updateMapping({ credit: Number(e.target.value) })}>
                    <option value={-1}>— none —</option>
                    {colOptions(table)}
                  </select>
                </Field>
              </>
            )}
          </div>
          <label className="row small" style={{ cursor: 'pointer' }}>
            <input
              type="checkbox"
              style={{ width: 'auto' }}
              checked={flipSigns}
              onChange={(e) => {
                setFlipSigns(e.target.checked);
                if (table && map) rebuild(table, map, dateFormat, e.target.checked, accountId);
              }}
            />
            Flip in/out (tick if money spent is showing up as income)
          </label>
        </div>
      )}

      {rows.length > 0 && (
        <div className="card">
          <div className="card-head">
            <h2>Preview</h2>
            <div className="spacer" />
            <span className="small muted">
              {included.length} of {rows.length} ticked · in {fmtMoney(totals.inc)} · out {fmtMoney(totals.exp)}
            </span>
          </div>
          <div className="row wrap" style={{ marginBottom: 8 }}>
            <button className="btn small" onClick={() => setRows((rs) => rs.map((r) => ({ ...r, include: true })))}>
              Tick all
            </button>
            <button className="btn small" onClick={() => setRows((rs) => rs.map((r) => ({ ...r, include: false })))}>
              Untick all
            </button>
            <button
              className="btn small"
              onClick={() => setRows((rs) => rs.map((r) => ({ ...r, include: !r.duplicate })))}
            >
              Untick duplicates only
            </button>
          </div>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 30 }}></th>
                  <th>Date</th>
                  <th>Description</th>
                  <th>Category</th>
                  <th className="num">Amount</th>
                  <th>Remember</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} style={r.include ? undefined : { opacity: 0.5 }}>
                    <td>
                      <input
                        type="checkbox"
                        style={{ width: 'auto' }}
                        checked={r.include}
                        onChange={(e) => setRow(i, { include: e.target.checked })}
                      />
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(r.date)}</td>
                    <td>
                      {r.description || <em className="muted">(no description)</em>}
                      {r.duplicate && <span className="pill">already on file</span>}
                      {r.matchedRule && <span className="sub">rule: {r.matchedRule}</span>}
                    </td>
                    <td>
                      <select
                        style={{ minWidth: 130 }}
                        value={r.categoryId ?? ''}
                        onChange={(e) => setRow(i, { categoryId: e.target.value || null })}
                      >
                        <option value="">Uncategorised</option>
                        {(r.kind === 'income' ? incomeCats : expenseCats).map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className={`num ${r.kind === 'income' ? 'pos' : ''}`}>
                      {r.kind === 'income' ? '+' : '−'}
                      {fmtMoney(r.amount)}
                    </td>
                    <td>
                      {r.categoryId && !r.matchedRule ? (
                        remember[i] != null ? (
                          <input
                            style={{ minWidth: 110 }}
                            value={remember[i]}
                            onChange={(e) => setRemember({ ...remember, [i]: e.target.value })}
                          />
                        ) : (
                          <button
                            className="btn small"
                            onClick={() => setRemember({ ...remember, [i]: suggestMatchText(r.description) })}
                          >
                            Remember
                          </button>
                        )
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <div className="spacer" />
            <button className="btn primary" onClick={runImport} disabled={busy || included.length === 0}>
              {busy ? 'Importing…' : `Import ${included.length} transaction${included.length === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h2>Saved rules</h2>
        </div>
        <p className="small muted">
          When a statement description contains this text, the category is filled in automatically. The longest
          matching rule wins.
        </p>
        {importRules.length === 0 ? (
          <Empty>No rules yet — press "Remember" beside a row while importing.</Empty>
        ) : (
          <div className="tablewrap">
            <table>
              <tbody>
                {importRules.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <code>{r.match_text}</code>
                    </td>
                    <td>{r.category_id ? categories.find((c) => c.id === r.category_id)?.name ?? '—' : '—'}</td>
                    <td className="num">
                      <button className="btn small danger" onClick={() => void deleteRule(r.id)}>
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
