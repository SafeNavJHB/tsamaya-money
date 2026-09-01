import { useMemo, useState } from 'react';
import { useData } from '../data/DataContext';
import { TAccountView } from '../components/TAccountView';
import { Empty, Seg } from '../components/ui';
import { fmtDate, fmtMoney, todayStr } from '../lib/format';
import { activeAccountKeys, buildBook, tAccount, trialBalance } from '../logic/ledger';
import { financialYearFor } from '../logic/statements';
import { exportCsv } from '../export/csv';
import { exportXlsx } from '../export/xlsx';
import { exportPdf } from '../export/pdf';
import { stamp } from '../export/download';

type View = 'taccounts' | 'trial' | 'journal';

export function Ledger() {
  const data = useData();
  const [view, setView] = useState<View>('taccounts');
  const [filter, setFilter] = useState('');
  const [yearOffset, setYearOffset] = useState(0);

  const book = useMemo(() => buildBook(data), [data]);
  const fy = useMemo(() => {
    const base = financialYearFor(todayStr(), data.settings.fy_end_month);
    if (yearOffset === 0) return base;
    const y = Number(base.to.slice(0, 4)) + yearOffset;
    return financialYearFor(`${y}-${base.to.slice(5)}`, data.settings.fy_end_month);
  }, [data.settings.fy_end_month, yearOffset]);

  const tb = useMemo(() => trialBalance(book, fy.from, fy.to), [book, fy]);
  const keys = useMemo(() => activeAccountKeys(book, fy.to), [book, fy]);
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return keys
      .map((k) => tAccount(book, k, fy.from, fy.to))
      .filter((t) => t.debits.length + t.credits.length + t.openingDebit + t.openingCredit > 0)
      .filter((t) => !q || t.name.toLowerCase().includes(q));
  }, [keys, book, fy, filter]);

  const journal = useMemo(
    () =>
      book.postings
        .filter((p) => p.date >= fy.from && p.date <= fy.to)
        .map((p) => ({ ...p, name: book.accounts.get(p.key)?.name ?? p.key })),
    [book, fy],
  );

  const tbRows = tb.rows.map((r) => [r.name, r.type, r.debit || null, r.credit || null]);
  const tbHeaders = ['Account', 'Type', 'Debit', 'Credit'];

  return (
    <div className="stack">
      <div className="row wrap">
        <h1>General ledger</h1>
        <div className="spacer" />
        <div className="row" style={{ gap: 4 }}>
          <button className="btn small" onClick={() => setYearOffset(yearOffset - 1)}>
            ‹
          </button>
          <strong className="small" style={{ minWidth: 140, textAlign: 'center' }}>
            {fmtDate(fy.from)} – {fmtDate(fy.to)}
          </strong>
          <button className="btn small" onClick={() => setYearOffset(yearOffset + 1)}>
            ›
          </button>
        </div>
      </div>

      <div className="row wrap">
        <Seg
          options={[
            { value: 'taccounts', label: 'T-accounts' },
            { value: 'trial', label: 'Trial balance' },
            { value: 'journal', label: 'Journal' },
          ]}
          value={view}
          onChange={setView}
        />
        <div className="spacer" />
        <span className={`pill ${tb.balanced ? 'badge-ok' : 'badge-bad'}`}>
          {tb.balanced
            ? `In balance · Dr = Cr = ${fmtMoney(tb.totalDebit)}`
            : `OUT OF BALANCE by ${fmtMoney(tb.totalDebit - tb.totalCredit)}`}
        </span>
      </div>

      {view === 'taccounts' && (
        <>
          <input placeholder="Filter accounts…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          {shown.length === 0 ? (
            <Empty>No ledger activity in this financial year.</Empty>
          ) : (
            <div>
              {shown.map((t) => (
                <TAccountView key={t.key} t={t} />
              ))}
            </div>
          )}
          <p className="small muted">
            Balance sheet accounts open with the balance brought down from earlier years; income and expense
            accounts start each financial year at nil. The closing balance is carried down on the short side, so
            both columns total the same figure.
          </p>
        </>
      )}

      {view === 'trial' && (
        <div className="card">
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Type</th>
                  <th className="num">Debit</th>
                  <th className="num">Credit</th>
                </tr>
              </thead>
              <tbody>
                {tb.rows.map((r) => (
                  <tr key={r.key}>
                    <td>{r.name}</td>
                    <td className="muted small">{r.type}</td>
                    <td className="num">{r.debit ? fmtMoney(r.debit) : ''}</td>
                    <td className="num">{r.credit ? fmtMoney(r.credit) : ''}</td>
                  </tr>
                ))}
                <tr className="total">
                  <td colSpan={2}>Totals</td>
                  <td className="num">{fmtMoney(tb.totalDebit)}</td>
                  <td className="num">{fmtMoney(tb.totalCredit)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div className="row wrap" style={{ marginTop: 12 }}>
            <span className="small muted">Export:</span>
            <button className="btn small" onClick={() => exportCsv(`trial-balance-${stamp()}.csv`, tbHeaders, tbRows)}>
              CSV
            </button>
            <button
              className="btn small"
              onClick={() =>
                void exportXlsx(`trial-balance-${stamp()}.xlsx`, [
                  { name: 'Trial balance', headers: tbHeaders, rows: tbRows, moneyCols: [2, 3] },
                ])
              }
            >
              Excel
            </button>
            <button
              className="btn small"
              onClick={() =>
                void exportPdf(`trial-balance-${stamp()}.pdf`, 'Trial balance', `${data.settings.entity_name} · ${fy.label}`, [
                  {
                    headers: tbHeaders,
                    rows: [...tbRows, ['Totals', '', tb.totalDebit, tb.totalCredit]],
                    moneyCols: [2, 3],
                    totalRow: true,
                  },
                ])
              }
            >
              PDF
            </button>
          </div>
        </div>
      )}

      {view === 'journal' && (
        <div className="card">
          <p className="small muted">
            Every posting made in the year, both sides of each entry, in date order.
          </p>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Account</th>
                  <th>Contra</th>
                  <th className="num">Debit</th>
                  <th className="num">Credit</th>
                </tr>
              </thead>
              <tbody>
                {journal.map((p, i) => (
                  <tr key={i}>
                    <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(p.date)}</td>
                    <td>
                      {p.name}
                      {p.detail && <span className="sub">{p.detail}</span>}
                    </td>
                    <td className="muted small">{p.contra}</td>
                    <td className="num">{p.debit ? fmtMoney(p.debit) : ''}</td>
                    <td className="num">{p.credit ? fmtMoney(p.credit) : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="row wrap" style={{ marginTop: 12 }}>
            <span className="small muted">Export:</span>
            <button
              className="btn small"
              onClick={() =>
                exportCsv(
                  `journal-${stamp()}.csv`,
                  ['Date', 'Account', 'Contra', 'Detail', 'Debit', 'Credit'],
                  journal.map((p) => [p.date, p.name, p.contra, p.detail, p.debit || null, p.credit || null]),
                )
              }
            >
              CSV
            </button>
            <button
              className="btn small"
              onClick={() =>
                void exportXlsx(`journal-${stamp()}.xlsx`, [
                  {
                    name: 'Journal',
                    headers: ['Date', 'Account', 'Contra', 'Detail', 'Debit', 'Credit'],
                    rows: journal.map((p) => [p.date, p.name, p.contra, p.detail, p.debit || null, p.credit || null]),
                    moneyCols: [4, 5],
                  },
                ])
              }
            >
              Excel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
