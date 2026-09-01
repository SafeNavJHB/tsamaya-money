// The two IFRS for SMEs primary statements, plus the capital-transaction
// entry that feeds the SOCIE. Rendered inside the Reports page tabs.
import { useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useData } from '../data/DataContext';
import { Field, Modal, Seg } from '../components/ui';
import { fmtDate, fmtMoney, parseAmount, todayStr } from '../lib/format';
import { buildBook } from '../logic/ledger';
import { financialYearFor, socie, sofp } from '../logic/statements';
import type { Sofp } from '../logic/statements';
import { exportCsv } from '../export/csv';
import { exportXlsx } from '../export/xlsx';
import { exportPdf } from '../export/pdf';
import { stamp } from '../export/download';
import type { EquityKind, EquityMovement } from '../types';

/** Year picker shared by both statements. */
function useYear() {
  const { settings } = useData();
  const [offset, setOffset] = useState(0);
  const fy = useMemo(() => {
    const base = financialYearFor(todayStr(), settings.fy_end_month);
    if (offset === 0) return base;
    const y = Number(base.to.slice(0, 4)) + offset;
    return financialYearFor(`${y}-${base.to.slice(5)}`, settings.fy_end_month);
  }, [settings.fy_end_month, offset]);
  return { fy, offset, setOffset };
}

function YearNav({ label, onPrev, onNext }: { label: string; onPrev: () => void; onNext: () => void }) {
  return (
    <div className="row" style={{ gap: 4 }}>
      <button className="btn small" onClick={onPrev}>
        ‹
      </button>
      <strong className="small" style={{ minWidth: 150, textAlign: 'center' }}>
        {label}
      </strong>
      <button className="btn small" onClick={onNext}>
        ›
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- SoFP

export function BalanceSheetTab() {
  const data = useData();
  const { fy, offset, setOffset } = useYear();
  const book = useMemo(() => buildBook(data), [data]);
  const bs = useMemo(() => sofp(book, fy.to), [book, fy]);
  const prior = useMemo(() => {
    const y = Number(fy.to.slice(0, 4)) - 1;
    return sofp(book, financialYearFor(`${y}-${fy.to.slice(5)}`, data.settings.fy_end_month).to);
  }, [book, fy, data.settings.fy_end_month]);

  // Register items carried at a valuation but never posted: shown as a note,
  // because a valuation has no second leg and must not enter the statement.
  const unposted = data.assets.filter(
    (a) => !a.archived && !data.transactions.some((t) => t.asset_id === a.id) && data.valuations.some((v) => v.asset_id === a.id),
  );

  const rows: (string | number | null)[][] = [
    ['ASSETS', null],
    ...bs.nonCurrentAssets.map((l) => [l.caption, l.amount]),
    ['Total non-current assets', bs.totalNonCurrentAssets],
    ...bs.currentAssets.map((l) => [l.caption, l.amount]),
    ['Total current assets', bs.totalCurrentAssets],
    ['TOTAL ASSETS', bs.totalAssets],
    ['EQUITY AND LIABILITIES', null],
    ...bs.equity.map((l) => [l.caption, l.amount]),
    ['Total equity', bs.totalEquity],
    ...bs.nonCurrentLiabilities.map((l) => [l.caption, l.amount]),
    ...bs.currentLiabilities.map((l) => [l.caption, l.amount]),
    ['Total liabilities', bs.totalLiabilities],
    ['TOTAL EQUITY AND LIABILITIES', bs.totalEquity + bs.totalLiabilities],
  ];
  const sub = `${data.settings.entity_name} · as at ${fmtDate(bs.atDate)}`;

  return (
    <div className="stack">
      <div className="card">
        <div className="card-head">
          <h2>Statement of financial position</h2>
          <div className="spacer" />
          <YearNav label={`as at ${fmtDate(fy.to)}`} onPrev={() => setOffset(offset - 1)} onNext={() => setOffset(offset + 1)} />
        </div>
        <p className="small muted">
          {data.settings.entity_name} · presented in South African rand · IFRS for SMEs, Section 4
        </p>
        <span className={`pill ${bs.balanced ? 'badge-ok' : 'badge-bad'}`}>
          {bs.balanced ? 'Balanced — assets = equity + liabilities' : `OUT OF BALANCE by ${fmtMoney(bs.difference)}`}
        </span>

        <div className="tablewrap" style={{ marginTop: 12 }}>
          <table className="stmt">
            <thead>
              <tr>
                <th></th>
                <th className="num">{fy.to.slice(0, 4)}</th>
                <th className="num">{Number(fy.to.slice(0, 4)) - 1}</th>
              </tr>
            </thead>
            <tbody>
              <tr className="section">
                <td colSpan={3}>ASSETS</td>
              </tr>
              {bs.nonCurrentAssets.length > 0 && (
                <>
                  {bs.nonCurrentAssets.map((l) => (
                    <tr key={l.caption}>
                      <td className="cap">{l.caption}</td>
                      <td className="num">{fmtMoney(l.amount)}</td>
                      <td className="num muted">{fmtMoney(prior.nonCurrentAssets.find((p) => p.caption === l.caption)?.amount ?? 0)}</td>
                    </tr>
                  ))}
                  <tr className="sub">
                    <td>Total non-current assets</td>
                    <td className="num">{fmtMoney(bs.totalNonCurrentAssets)}</td>
                    <td className="num muted">{fmtMoney(prior.totalNonCurrentAssets)}</td>
                  </tr>
                </>
              )}
              {bs.currentAssets.map((l) => (
                <tr key={l.caption}>
                  <td className="cap">{l.caption}</td>
                  <td className="num">{fmtMoney(l.amount)}</td>
                  <td className="num muted">{fmtMoney(prior.currentAssets.find((p) => p.caption === l.caption)?.amount ?? 0)}</td>
                </tr>
              ))}
              <tr className="sub">
                <td>Total current assets</td>
                <td className="num">{fmtMoney(bs.totalCurrentAssets)}</td>
                <td className="num muted">{fmtMoney(prior.totalCurrentAssets)}</td>
              </tr>
              <tr className="grand">
                <td>Total assets</td>
                <td className="num">{fmtMoney(bs.totalAssets)}</td>
                <td className="num muted">{fmtMoney(prior.totalAssets)}</td>
              </tr>

              <tr className="section">
                <td colSpan={3}>EQUITY AND LIABILITIES</td>
              </tr>
              {bs.equity.map((l) => (
                <tr key={l.caption}>
                  <td className="cap">{l.caption}</td>
                  <td className={`num ${l.amount < 0 ? 'neg' : ''}`}>{fmtMoney(l.amount)}</td>
                  <td className="num muted">{fmtMoney(prior.equity.find((p) => p.caption === l.caption)?.amount ?? 0)}</td>
                </tr>
              ))}
              <tr className="sub">
                <td>Total equity</td>
                <td className={`num ${bs.totalEquity < 0 ? 'neg' : ''}`}>{fmtMoney(bs.totalEquity)}</td>
                <td className="num muted">{fmtMoney(prior.totalEquity)}</td>
              </tr>
              {bs.nonCurrentLiabilities.length > 0 && (
                <>
                  {bs.nonCurrentLiabilities.map((l) => (
                    <tr key={l.caption}>
                      <td className="cap">{l.caption}</td>
                      <td className="num">{fmtMoney(l.amount)}</td>
                      <td className="num muted">{fmtMoney(prior.nonCurrentLiabilities.find((p) => p.caption === l.caption)?.amount ?? 0)}</td>
                    </tr>
                  ))}
                  <tr className="sub">
                    <td>Total non-current liabilities</td>
                    <td className="num">{fmtMoney(bs.totalNonCurrentLiabilities)}</td>
                    <td className="num muted">{fmtMoney(prior.totalNonCurrentLiabilities)}</td>
                  </tr>
                </>
              )}
              {bs.currentLiabilities.map((l) => (
                <tr key={l.caption}>
                  <td className="cap">{l.caption}</td>
                  <td className="num">{fmtMoney(l.amount)}</td>
                  <td className="num muted">{fmtMoney(prior.currentLiabilities.find((p) => p.caption === l.caption)?.amount ?? 0)}</td>
                </tr>
              ))}
              <tr className="sub">
                <td>Total current liabilities</td>
                <td className="num">{fmtMoney(bs.totalCurrentLiabilities)}</td>
                <td className="num muted">{fmtMoney(prior.totalCurrentLiabilities)}</td>
              </tr>
              <tr className="grand">
                <td>Total equity and liabilities</td>
                <td className="num">{fmtMoney(bs.totalEquity + bs.totalLiabilities)}</td>
                <td className="num muted">{fmtMoney(prior.totalEquity + prior.totalLiabilities)}</td>
              </tr>
            </tbody>
          </table>
        </div>

        {unposted.length > 0 && (
          <p className="small muted" style={{ marginTop: 12 }}>
            <strong>Note.</strong> {unposted.map((a) => a.name).join(', ')}{' '}
            {unposted.length === 1 ? 'is' : 'are'} carried in the asset register at a valuation but{' '}
            {unposted.length === 1 ? 'has' : 'have'} no purchase posted, so {unposted.length === 1 ? 'it is' : 'they are'}{' '}
            excluded from this statement. Record the purchase against the asset to bring it on at cost.
          </p>
        )}

        <div className="row wrap" style={{ marginTop: 12 }}>
          <span className="small muted">Export:</span>
          <button className="btn small" onClick={() => exportCsv(`balance-sheet-${stamp()}.csv`, ['Line', 'Amount'], rows)}>
            CSV
          </button>
          <button
            className="btn small"
            onClick={() =>
              void exportXlsx(`balance-sheet-${stamp()}.xlsx`, [
                { name: 'Balance sheet', headers: ['Line', 'Amount'], rows, moneyCols: [1] },
              ])
            }
          >
            Excel
          </button>
          <button
            className="btn small"
            onClick={() =>
              void exportPdf(`balance-sheet-${stamp()}.pdf`, 'Statement of financial position', sub, [
                { headers: ['', 'R'], rows, moneyCols: [1] },
              ])
            }
          >
            PDF
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- equity form

const KIND_LABEL: Record<EquityKind, string> = {
  share_issue: 'Shares issued',
  dividend: 'Dividend declared',
  prior_period_adjustment: 'Prior-period adjustment',
};

function EquityForm({ initial, onClose }: { initial?: EquityMovement | null; onClose: () => void }) {
  const { accounts, refresh } = useData();
  const live = accounts.filter((a) => !a.archived);
  const [kind, setKind] = useState<EquityKind>(initial?.kind ?? 'share_issue');
  const [mvDate, setMvDate] = useState(initial?.mv_date ?? todayStr());
  const [amount, setAmount] = useState(initial ? String(Math.abs(initial.amount)) : '');
  const [negative, setNegative] = useState(initial ? initial.amount < 0 : true);
  const [contra, setContra] = useState(initial?.contra_account_id ?? '');
  const [shares, setShares] = useState(initial?.shares_issued ? String(initial.shares_issued) : '');
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const raw = parseAmount(amount);
    if (raw == null || raw <= 0) return setError('Enter a positive amount.');
    const signed = kind === 'prior_period_adjustment' && negative ? -raw : raw;
    setBusy(true);
    setError(null);
    const row = {
      mv_date: mvDate,
      kind,
      amount: signed,
      contra_account_id: contra || null,
      shares_issued: kind === 'share_issue' && shares.trim() ? Number(shares) : null,
      notes: notes.trim() || null,
    };
    const q = initial
      ? supabase.from('fin_equity').update(row).eq('id', initial.id)
      : supabase.from('fin_equity').insert(row);
    const { error: err } = await q;
    setBusy(false);
    if (err) return setError(err.message);
    await refresh();
    onClose();
  }

  async function remove() {
    if (!initial || !window.confirm('Delete this capital transaction?')) return;
    setBusy(true);
    const { error: err } = await supabase.from('fin_equity').delete().eq('id', initial.id);
    setBusy(false);
    if (err) return setError(err.message);
    await refresh();
    onClose();
  }

  return (
    <Modal title={initial ? 'Edit capital transaction' : 'Capital transaction'} onClose={onClose}>
      {error && <div className="error-banner">{error}</div>}
      <Field label="Type">
        <select value={kind} onChange={(e) => setKind(e.target.value as EquityKind)}>
          {(Object.keys(KIND_LABEL) as EquityKind[]).map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Date">
        <input type="date" value={mvDate} onChange={(e) => setMvDate(e.target.value)} />
      </Field>
      <Field label="Amount (R)">
        <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
      </Field>
      {kind === 'prior_period_adjustment' && (
        <div className="field">
          <Seg
            options={[
              { value: 'dec', label: 'Reduces equity' },
              { value: 'inc', label: 'Increases equity' },
            ]}
            value={negative ? 'dec' : 'inc'}
            onChange={(v) => setNegative(v === 'dec')}
          />
        </div>
      )}
      {kind === 'share_issue' && (
        <Field label="Number of shares (optional)">
          <input inputMode="numeric" value={shares} onChange={(e) => setShares(e.target.value)} />
        </Field>
      )}
      <Field label={kind === 'dividend' ? 'Paid from' : 'Received into'}>
        <select value={contra} onChange={(e) => setContra(e.target.value)}>
          <option value="">
            {kind === 'share_issue' ? 'Not yet paid (receivable)' : kind === 'dividend' ? 'Not yet paid (payable)' : 'Against retained earnings only'}
          </option>
          {live.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Notes (optional)">
        <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Founder subscription per CoR15.1" />
      </Field>
      <div className="row" style={{ marginTop: 6 }}>
        {initial && (
          <button className="btn danger" onClick={remove} disabled={busy}>
            Delete
          </button>
        )}
        <div className="spacer" />
        <button className="btn" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button className="btn primary" onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- SOCIE

export function EquityTab() {
  const data = useData();
  const { fy, offset, setOffset } = useYear();
  const book = useMemo(() => buildBook(data), [data]);
  const sc = useMemo(() => socie(book, fy.from, fy.to), [book, fy]);
  const bs = useMemo(() => sofp(book, fy.to), [book, fy]);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<EquityMovement | null>(null);

  const rows = sc.rows.map((r) => [r.caption, r.shareCapital, r.retainedEarnings, r.total]);
  const headers = ['', 'Share capital', 'Retained earnings', 'Total'];
  const sub = `${data.settings.entity_name} · ${fmtDate(sc.from)} to ${fmtDate(sc.to)}`;
  const ties = Math.abs(sc.closingTotal - bs.totalEquity) < 0.005;

  return (
    <div className="stack">
      <div className="card">
        <div className="card-head">
          <h2>Statement of changes in equity</h2>
          <div className="spacer" />
          <YearNav
            label={`${fmtDate(fy.from)} – ${fmtDate(fy.to)}`}
            onPrev={() => setOffset(offset - 1)}
            onNext={() => setOffset(offset + 1)}
          />
        </div>
        <p className="small muted">
          {data.settings.entity_name} · presented in South African rand · IFRS for SMEs, Section 6
        </p>
        <span className={`pill ${ties ? 'badge-ok' : 'badge-bad'}`}>
          {ties ? 'Ties to the balance sheet' : `Does not tie to the balance sheet (${fmtMoney(sc.closingTotal - bs.totalEquity)})`}
        </span>

        <div className="tablewrap" style={{ marginTop: 12 }}>
          <table className="stmt">
            <thead>
              <tr>
                <th></th>
                <th className="num">Share capital</th>
                <th className="num">Retained earnings</th>
                <th className="num">Total</th>
              </tr>
            </thead>
            <tbody>
              {sc.rows.map((r, i) => (
                <tr key={i} className={r.isBalance ? 'sub' : undefined}>
                  <td>{r.caption.replace(/^Balance at (\d{4}-\d{2}-\d{2})$/, (_, d) => `Balance at ${fmtDate(d)}`)}</td>
                  <td className="num">{r.shareCapital === 0 ? '—' : fmtMoney(r.shareCapital)}</td>
                  <td className={`num ${r.retainedEarnings < 0 ? 'neg' : ''}`}>
                    {r.retainedEarnings === 0 ? '—' : fmtMoney(r.retainedEarnings)}
                  </td>
                  <td className={`num ${r.total < 0 ? 'neg' : ''}`}>{fmtMoney(r.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="row wrap" style={{ marginTop: 12 }}>
          <span className="small muted">Export:</span>
          <button className="btn small" onClick={() => exportCsv(`socie-${stamp()}.csv`, headers, rows)}>
            CSV
          </button>
          <button
            className="btn small"
            onClick={() => void exportXlsx(`socie-${stamp()}.xlsx`, [{ name: 'SOCIE', headers, rows, moneyCols: [1, 2, 3] }])}
          >
            Excel
          </button>
          <button
            className="btn small"
            onClick={() => void exportPdf(`socie-${stamp()}.pdf`, 'Statement of changes in equity', sub, [{ headers, rows, moneyCols: [1, 2, 3] }])}
          >
            PDF
          </button>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Capital transactions</h2>
          <div className="spacer" />
          <button className="btn small primary" onClick={() => setAdding(true)}>
            + Add
          </button>
        </div>
        <p className="small muted">
          Share issues, dividends and prior-period adjustments. These never touch profit or loss — they post
          straight to equity, which is what keeps the SOCIE and the income statement independent.
        </p>
        {data.equity.length === 0 ? (
          <p className="small muted">
            None recorded. Share capital is still nil: read the actual subscription off the MOI or CoR15.1 and add it
            here rather than estimating.
          </p>
        ) : (
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Type</th>
                  <th className="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {data.equity.map((m) => (
                  <tr key={m.id} className="click" onClick={() => setEditing(m)}>
                    <td>{fmtDate(m.mv_date)}</td>
                    <td>
                      {KIND_LABEL[m.kind]}
                      {m.notes && <span className="sub">{m.notes}</span>}
                    </td>
                    <td className={`num ${m.amount < 0 ? 'neg' : ''}`}>{fmtMoney(m.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {adding && <EquityForm onClose={() => setAdding(false)} />}
      {editing && <EquityForm initial={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

export type { Sofp };
