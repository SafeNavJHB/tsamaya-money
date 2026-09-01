// Statement of cash flows (Section 7) and notes to the financial statements
// (Section 8), plus the full annual-financial-statement PDF pack.
import { useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useData } from '../data/DataContext';
import { Empty } from '../components/ui';
import { fmtDate, fmtMoney, todayStr } from '../lib/format';
import { buildBook, profitForPeriod } from '../logic/ledger';
import { financialYearFor, socie, sofp } from '../logic/statements';
import { cashflowStatement } from '../logic/cashflow';
import { noteSchedules } from '../logic/notes';
import { exportCsv } from '../export/csv';
import { exportXlsx } from '../export/xlsx';
import { exportPdf } from '../export/pdf';
import type { PdfTableSpec } from '../export/pdf';
import { stamp } from '../export/download';
import { incomeStatement } from '../logic/compute';

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

// ---------------------------------------------------------------- cash flows

export function CashflowStatementTab() {
  const data = useData();
  const { fy, offset, setOffset } = useYear();
  const book = useMemo(() => buildBook(data), [data]);
  const cf = useMemo(() => cashflowStatement(book, data, fy.from, fy.to), [book, data, fy]);

  const rows: (string | number | null)[][] = [
    ['CASH FLOWS FROM OPERATING ACTIVITIES', null],
    ...cf.operating.map((l) => [l.caption, l.amount]),
    ['Net cash from operating activities', cf.netOperating],
    ...(cf.investing.length
      ? ([['CASH FLOWS FROM INVESTING ACTIVITIES', null], ...cf.investing.map((l) => [l.caption, l.amount]), ['Net cash from investing activities', cf.netInvesting]] as (string | number | null)[][])
      : []),
    ...(cf.financing.length
      ? ([['CASH FLOWS FROM FINANCING ACTIVITIES', null], ...cf.financing.map((l) => [l.caption, l.amount]), ['Net cash from financing activities', cf.netFinancing]] as (string | number | null)[][])
      : []),
    ['Net movement in cash and cash equivalents', cf.netMovement],
    ['Cash and cash equivalents at the beginning of the year', cf.openingCash],
    ['Cash and cash equivalents at the end of the year', cf.closingCash],
  ];

  const section = (title: string, lines: { caption: string; amount: number }[], net: number, netLabel: string) =>
    lines.length === 0 ? null : (
      <>
        <tr className="section">
          <td colSpan={2}>{title}</td>
        </tr>
        {lines.map((l, i) => (
          <tr key={i}>
            <td className="cap">{l.caption}</td>
            <td className={`num ${l.amount < 0 ? 'neg' : ''}`}>{fmtMoney(l.amount)}</td>
          </tr>
        ))}
        <tr className="sub">
          <td>{netLabel}</td>
          <td className={`num ${net < 0 ? 'neg' : ''}`}>{fmtMoney(net)}</td>
        </tr>
      </>
    );

  return (
    <div className="card">
      <div className="card-head">
        <h2>Statement of cash flows</h2>
        <div className="spacer" />
        <YearNav label={`${fmtDate(fy.from)} – ${fmtDate(fy.to)}`} onPrev={() => setOffset(offset - 1)} onNext={() => setOffset(offset + 1)} />
      </div>
      <p className="small muted">
        {data.settings.entity_name} · indirect method · IFRS for SMEs, Section 7
      </p>
      <span className={`pill ${cf.reconciles ? 'badge-ok' : 'badge-bad'}`}>
        {cf.reconciles
          ? 'Reconciles to the movement in cash'
          : `DOES NOT RECONCILE by ${fmtMoney(cf.difference)} — check account classifications`}
      </span>

      <div className="tablewrap" style={{ marginTop: 12 }}>
        <table className="stmt">
          <tbody>
            {section('Cash flows from operating activities', cf.operating, cf.netOperating, 'Net cash from operating activities')}
            {section('Cash flows from investing activities', cf.investing, cf.netInvesting, 'Net cash from investing activities')}
            {section('Cash flows from financing activities', cf.financing, cf.netFinancing, 'Net cash from financing activities')}
            <tr className="sub">
              <td>Net movement in cash and cash equivalents</td>
              <td className={`num ${cf.netMovement < 0 ? 'neg' : ''}`}>{fmtMoney(cf.netMovement)}</td>
            </tr>
            <tr>
              <td className="cap">Cash and cash equivalents at the beginning of the year</td>
              <td className="num">{fmtMoney(cf.openingCash)}</td>
            </tr>
            <tr className="grand">
              <td>Cash and cash equivalents at the end of the year</td>
              <td className={`num ${cf.closingCash < 0 ? 'neg' : ''}`}>{fmtMoney(cf.closingCash)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {cf.components.length > 0 && (
        <p className="small muted" style={{ marginTop: 10 }}>
          Cash and cash equivalents comprise{' '}
          {cf.components.map((c, i) => (
            <span key={c.name}>
              {i > 0 ? ', ' : ''}
              {c.name} {fmtMoney(c.amount)}
            </span>
          ))}
          . Which accounts count as cash, and how every other balance is classified, is set per account on the
          Accounts page.
        </p>
      )}

      <div className="row wrap" style={{ marginTop: 12 }}>
        <span className="small muted">Export:</span>
        <button className="btn small" onClick={() => exportCsv(`cash-flow-statement-${stamp()}.csv`, ['Line', 'Amount'], rows)}>
          CSV
        </button>
        <button
          className="btn small"
          onClick={() => void exportXlsx(`cash-flow-statement-${stamp()}.xlsx`, [{ name: 'Cash flows', headers: ['Line', 'Amount'], rows, moneyCols: [1] }])}
        >
          Excel
        </button>
        <button
          className="btn small"
          onClick={() =>
            void exportPdf(`cash-flow-statement-${stamp()}.pdf`, 'Statement of cash flows', `${data.settings.entity_name} · ${fmtDate(fy.from)} to ${fmtDate(fy.to)}`, [
              { headers: ['', 'R'], rows, moneyCols: [1] },
            ])
          }
        >
          PDF
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- notes

function NoteEditor({ noteKey, title, body, onDone }: { noteKey: string; title: string; body: string; onDone: () => void }) {
  const { refresh } = useData();
  const [text, setText] = useState(body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    const { error: err } = await supabase.from('fin_notes').update({ body: text }).eq('note_key', noteKey);
    setBusy(false);
    if (err) return setError(err.message);
    await refresh();
    onDone();
  }

  return (
    <div>
      {error && <div className="error-banner">{error}</div>}
      <textarea rows={10} value={text} onChange={(e) => setText(e.target.value)} style={{ fontFamily: 'inherit' }} />
      <div className="row" style={{ marginTop: 8 }}>
        <span className="small muted">{title}</span>
        <div className="spacer" />
        <button className="btn small" onClick={onDone} disabled={busy}>
          Cancel
        </button>
        <button className="btn small primary" onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}

export function NotesTab() {
  const data = useData();
  const { fy, offset, setOffset } = useYear();
  const book = useMemo(() => buildBook(data), [data]);
  const scheds = useMemo(() => noteSchedules(book, data, fy.from, fy.to), [book, data, fy]);
  const [editing, setEditing] = useState<string | null>(null);

  const needsAttention = data.notes.filter((n) => !n.hidden && /\[.*?\]/.test(n.body));

  return (
    <div className="stack">
      <div className="card">
        <div className="card-head">
          <h2>Notes to the financial statements</h2>
          <div className="spacer" />
          <YearNav label={`${fmtDate(fy.from)} – ${fmtDate(fy.to)}`} onPrev={() => setOffset(offset - 1)} onNext={() => setOffset(offset + 1)} />
        </div>
        <p className="small muted">
          {data.settings.entity_name} · IFRS for SMEs, Section 8. The figures below are computed from the ledger, so a
          note cannot disagree with the statement it supports. The wording is yours to edit.
        </p>
        {needsAttention.length > 0 && (
          <div className="error-banner">
            {needsAttention.length === 1 ? 'One note' : `${needsAttention.length} notes`} still{' '}
            {needsAttention.length === 1 ? 'contains' : 'contain'} bracketed placeholders that must be resolved before
            these statements are issued: {needsAttention.map((n) => n.title).join(', ')}.
          </div>
        )}
      </div>

      {data.notes
        .filter((n) => !n.hidden)
        .map((n, i) => (
          <div className="card" key={n.id}>
            <div className="card-head">
              <h2>
                {i + 1}. {n.title}
              </h2>
              <div className="spacer" />
              {editing !== n.note_key && (
                <button className="btn small" onClick={() => setEditing(n.note_key)}>
                  Edit
                </button>
              )}
            </div>
            {editing === n.note_key ? (
              <NoteEditor noteKey={n.note_key} title={n.title} body={n.body} onDone={() => setEditing(null)} />
            ) : (
              n.body.split('\n\n').map((para, j) => (
                <p key={j} className={/\[.*?\]/.test(para) ? 'neg' : undefined} style={{ whiteSpace: 'pre-wrap' }}>
                  {para}
                </p>
              ))
            )}
          </div>
        ))}

      {scheds.length === 0 ? (
        <Empty>No supporting schedules yet — they appear as the balance sheet gains items.</Empty>
      ) : (
        scheds.map((s, i) => (
          <div className="card" key={s.key}>
            <div className="card-head">
              <h2>
                {data.notes.filter((n) => !n.hidden).length + i + 1}. {s.title}
              </h2>
            </div>
            <div className="tablewrap">
              <table className="stmt">
                <thead>
                  <tr>
                    <th></th>
                    <th className="num">{fy.to.slice(0, 4)}</th>
                    <th className="num">{Number(fy.to.slice(0, 4)) - 1}</th>
                  </tr>
                </thead>
                <tbody>
                  {s.rows.map((r, j) => (
                    <tr key={j} className={r.isTotal ? 'sub' : undefined}>
                      <td className={r.isTotal ? undefined : 'cap'}>{r.caption}</td>
                      <td className={`num ${r.current < 0 ? 'neg' : ''}`}>{fmtMoney(r.current)}</td>
                      <td className="num muted">{fmtMoney(r.prior)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {s.commentary?.filter(Boolean).map((c, j) => (
              <p key={j} className="small muted" style={{ marginTop: 8 }}>
                {c}
              </p>
            ))}
          </div>
        ))
      )}
    </div>
  );
}

// ---------------------------------------------------------------- full AFS pack

export function AfsPackButton() {
  const data = useData();
  const { settings } = data;
  const [busy, setBusy] = useState(false);

  async function build() {
    setBusy(true);
    const fy = financialYearFor(todayStr(), settings.fy_end_month);
    const book = buildBook(data);
    const bs = sofp(book, fy.to);
    const sc = socie(book, fy.from, fy.to);
    const cf = cashflowStatement(book, data, fy.from, fy.to);
    const is = incomeStatement(data.transactions, data.categories, fy.from, fy.to);
    const scheds = noteSchedules(book, data, fy.from, fy.to);
    const profit = profitForPeriod(book, fy.from, fy.to);

    const tables: PdfTableSpec[] = [
      {
        title: 'Statement of financial position',
        headers: ['', 'R'],
        rows: [
          ['ASSETS', ''],
          ...bs.nonCurrentAssets.map((l) => [l.caption, l.amount]),
          ...(bs.nonCurrentAssets.length ? [['Total non-current assets', bs.totalNonCurrentAssets]] : []),
          ...bs.currentAssets.map((l) => [l.caption, l.amount]),
          ['Total current assets', bs.totalCurrentAssets],
          ['Total assets', bs.totalAssets],
          ['EQUITY AND LIABILITIES', ''],
          ...bs.equity.map((l) => [l.caption, l.amount]),
          ['Total equity', bs.totalEquity],
          ...bs.nonCurrentLiabilities.map((l) => [l.caption, l.amount]),
          ...bs.currentLiabilities.map((l) => [l.caption, l.amount]),
          ['Total liabilities', bs.totalLiabilities],
          ['Total equity and liabilities', bs.totalEquity + bs.totalLiabilities],
        ] as (string | number)[][],
        moneyCols: [1],
        totalRow: true,
      },
      {
        title: 'Statement of comprehensive income',
        headers: ['', 'R'],
        rows: [
          ...is.income.map((r) => [r.category?.name ?? 'Uncategorised', r.total]),
          ['Total income', is.incomeTotal],
          ...is.expense.map((r) => [r.category?.name ?? 'Uncategorised', -r.total]),
          ['Total expenses', -is.expenseTotal],
          [profit < 0 ? 'Loss for the year' : 'Profit for the year', profit],
        ] as (string | number)[][],
        moneyCols: [1],
        totalRow: true,
      },
      {
        title: 'Statement of changes in equity',
        headers: ['', 'Share capital', 'Retained earnings', 'Total'],
        rows: sc.rows.map((r) => [r.caption, r.shareCapital, r.retainedEarnings, r.total]),
        moneyCols: [1, 2, 3],
        totalRow: true,
      },
      {
        title: 'Statement of cash flows',
        headers: ['', 'R'],
        rows: [
          ['Cash flows from operating activities', ''],
          ...cf.operating.map((l) => [l.caption, l.amount]),
          ['Net cash from operating activities', cf.netOperating],
          ...(cf.investing.length
            ? [['Cash flows from investing activities', ''], ...cf.investing.map((l) => [l.caption, l.amount]), ['Net cash from investing activities', cf.netInvesting]]
            : []),
          ...(cf.financing.length
            ? [['Cash flows from financing activities', ''], ...cf.financing.map((l) => [l.caption, l.amount]), ['Net cash from financing activities', cf.netFinancing]]
            : []),
          ['Net movement in cash', cf.netMovement],
          ['Cash at the beginning of the year', cf.openingCash],
          ['Cash at the end of the year', cf.closingCash],
        ] as (string | number)[][],
        moneyCols: [1],
        totalRow: true,
      },
    ];

    // Narrative notes, then the computed schedules.
    for (const [i, n] of data.notes.filter((x) => !x.hidden).entries()) {
      tables.push({
        title: `Note ${i + 1}. ${n.title}`,
        headers: [''],
        rows: n.body.split('\n\n').map((p) => [p]),
      });
    }
    const base = data.notes.filter((x) => !x.hidden).length;
    for (const [i, s] of scheds.entries()) {
      tables.push({
        title: `Note ${base + i + 1}. ${s.title}`,
        headers: ['', String(fy.to.slice(0, 4)), String(Number(fy.to.slice(0, 4)) - 1)],
        rows: [
          ...s.rows.map((r) => [r.caption, r.current, r.prior]),
          ...(s.commentary ?? []).filter(Boolean).map((c) => [c, '', '']),
        ] as (string | number)[][],
        moneyCols: [1, 2],
      });
    }

    await exportPdf(
      `annual-financial-statements-${fy.to}.pdf`,
      'Annual financial statements',
      `${settings.entity_name}${settings.registration_number ? ` · ${settings.registration_number}` : ''} · ${fy.label}`,
      tables,
    );
    setBusy(false);
  }

  return (
    <button className="btn small" onClick={build} disabled={busy}>
      {busy ? 'Building…' : 'Full AFS pack (PDF)'}
    </button>
  );
}
