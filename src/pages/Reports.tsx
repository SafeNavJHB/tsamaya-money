import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useData } from '../data/DataContext';
import { CashflowBars, TrendLine } from '../components/charts';
import { Empty, Seg } from '../components/ui';
import { exportCsv } from '../export/csv';
import { exportXlsx } from '../export/xlsx';
import type { SheetSpec } from '../export/xlsx';
import { exportPdf } from '../export/pdf';
import type { PdfTableSpec } from '../export/pdf';
import { stamp } from '../export/download';
import {
  accountLedger,
  budgetRows,
  categoryLedger,
  incomeStatement,
  monthlyCashflow,
  netWorthAt,
  netWorthSeries,
} from '../logic/compute';
import {
  addMonths,
  fmtDate,
  fmtMoney,
  lastNMonths,
  monthEnd,
  monthKey,
  monthLabel,
  monthStart,
  todayStr,
} from '../lib/format';

type Tab = 'statement' | 'cashflow' | 'networth' | 'budgets' | 'ledger';

interface ExportSet {
  filename: string;
  title: string;
  subtitle: string;
  csvHeaders: string[];
  csvRows: (string | number | null)[][];
  sheets?: SheetSpec[];
  pdfTables: PdfTableSpec[];
}

function ExportButtons({ set }: { set: ExportSet }) {
  return (
    <div className="row wrap" style={{ marginTop: 12 }}>
      <span className="small muted">Export:</span>
      <button className="btn small" onClick={() => exportCsv(`${set.filename}-${stamp()}.csv`, set.csvHeaders, set.csvRows)}>
        CSV
      </button>
      <button
        className="btn small"
        onClick={() =>
          void exportXlsx(
            `${set.filename}-${stamp()}.xlsx`,
            set.sheets ?? [{ name: set.title.slice(0, 31), headers: set.csvHeaders, rows: set.csvRows, moneyCols: [set.csvHeaders.length - 1] }],
          )
        }
      >
        Excel
      </button>
      <button
        className="btn small"
        onClick={() => void exportPdf(`${set.filename}-${stamp()}.pdf`, set.title, set.subtitle, set.pdfTables)}
      >
        PDF
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- periods

type Preset = 'thisMonth' | 'lastMonth' | 'thisYear' | 'last12' | 'all' | 'custom';

function presetRange(p: Preset, customFrom: string, customTo: string): { from: string; to: string; label: string } {
  const today = todayStr();
  const mk = monthKey(today);
  switch (p) {
    case 'thisMonth':
      return { from: monthStart(mk), to: monthEnd(mk), label: monthLabel(mk) };
    case 'lastMonth': {
      const lm = addMonths(mk, -1);
      return { from: monthStart(lm), to: monthEnd(lm), label: monthLabel(lm) };
    }
    case 'thisYear':
      return { from: `${mk.slice(0, 4)}-01-01`, to: today, label: `${mk.slice(0, 4)} year to date` };
    case 'last12':
      return { from: monthStart(addMonths(mk, -11)), to: today, label: 'Last 12 months' };
    case 'all':
      return { from: '0000-01-01', to: '9999-12-31', label: 'All time' };
    case 'custom':
      return { from: customFrom || '0000-01-01', to: customTo || '9999-12-31', label: `${customFrom || '…'} to ${customTo || '…'}` };
  }
}

// ---------------------------------------------------------------- page

export function Reports() {
  const data = useData();
  const { transactions, categories, accounts, assets, valuations, categoryById, accountById } = data;
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'statement';
  const setTab = (t: Tab) => setParams({ tab: t }, { replace: true });

  return (
    <div className="stack">
      <div className="row wrap">
        <h1>Reports</h1>
        <div className="spacer" />
        <button
          className="btn small"
          onClick={() =>
            void exportXlsx(`money-backup-${stamp()}.xlsx`, [
              {
                name: 'Transactions',
                headers: ['Date', 'Kind', 'Category', 'Account', 'To account', 'Payee', 'Notes', 'Amount'],
                rows: transactions.map((t) => [
                  t.tx_date,
                  t.kind,
                  t.category_id ? categoryById.get(t.category_id)?.name ?? '' : '',
                  accountById.get(t.account_id)?.name ?? '',
                  t.transfer_account_id ? accountById.get(t.transfer_account_id)?.name ?? '' : '',
                  t.payee,
                  t.notes,
                  t.kind === 'expense' ? -t.amount : t.amount,
                ]),
                moneyCols: [7],
              },
              {
                name: 'Categories',
                headers: ['Name', 'Kind', 'Monthly budget', 'Archived'],
                rows: categories.map((c) => [c.name, c.kind, c.monthly_budget, c.archived ? 'yes' : '']),
                moneyCols: [2],
              },
              {
                name: 'Accounts',
                headers: ['Name', 'Kind', 'Opening balance', 'Archived'],
                rows: accounts.map((a) => [a.name, a.kind, a.opening_balance, a.archived ? 'yes' : '']),
                moneyCols: [2],
              },
              {
                name: 'Assets',
                headers: ['Name', 'Side', 'Category', 'Notes', 'Archived'],
                rows: assets.map((a) => [a.name, a.side, a.category, a.notes, a.archived ? 'yes' : '']),
              },
              {
                name: 'Valuations',
                headers: ['Asset', 'Date', 'Value'],
                rows: valuations.map((v) => [assets.find((a) => a.id === v.asset_id)?.name ?? '', v.val_date, v.value]),
                moneyCols: [2],
              },
            ])
          }
        >
          Full backup (Excel)
        </button>
      </div>

      <div className="tablewrap">
        <Seg
          options={[
            { value: 'statement', label: 'Income statement' },
            { value: 'cashflow', label: 'Cash flow' },
            { value: 'networth', label: 'Net worth' },
            { value: 'budgets', label: 'Budgets' },
            { value: 'ledger', label: 'Ledger' },
          ]}
          value={tab}
          onChange={setTab}
        />
      </div>

      {tab === 'statement' && <StatementTab />}
      {tab === 'cashflow' && <CashflowTab />}
      {tab === 'networth' && <NetWorthTab />}
      {tab === 'budgets' && <BudgetsTab />}
      {tab === 'ledger' && <LedgerTab />}
    </div>
  );
}

// ---------------------------------------------------------------- statement

function PeriodPicker({
  preset,
  setPreset,
  customFrom,
  setCustomFrom,
  customTo,
  setCustomTo,
}: {
  preset: Preset;
  setPreset: (p: Preset) => void;
  customFrom: string;
  setCustomFrom: (s: string) => void;
  customTo: string;
  setCustomTo: (s: string) => void;
}) {
  return (
    <div className="row wrap" style={{ marginBottom: 12 }}>
      <select style={{ width: 'auto' }} value={preset} onChange={(e) => setPreset(e.target.value as Preset)}>
        <option value="thisMonth">This month</option>
        <option value="lastMonth">Last month</option>
        <option value="thisYear">This year</option>
        <option value="last12">Last 12 months</option>
        <option value="all">All time</option>
        <option value="custom">Custom…</option>
      </select>
      {preset === 'custom' && (
        <>
          <input type="date" style={{ width: 'auto' }} value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} />
          <span className="muted">to</span>
          <input type="date" style={{ width: 'auto' }} value={customTo} onChange={(e) => setCustomTo(e.target.value)} />
        </>
      )}
    </div>
  );
}

function StatementTab() {
  const { transactions, categories } = useData();
  const [preset, setPreset] = useState<Preset>('thisMonth');
  const [customFrom, setCustomFrom] = useState(monthStart(monthKey(todayStr())));
  const [customTo, setCustomTo] = useState(todayStr());
  const range = presetRange(preset, customFrom, customTo);
  const st = useMemo(
    () => incomeStatement(transactions, categories, range.from, range.to),
    [transactions, categories, range.from, range.to],
  );

  const name = (r: { category: { name: string } | null }) => r.category?.name ?? 'Uncategorised';
  const csvRows: (string | number)[][] = [
    ...st.income.map((r) => ['Income', name(r), r.total]),
    ['Income', 'TOTAL INCOME', st.incomeTotal],
    ...st.expense.map((r) => ['Expense', name(r), r.total]),
    ['Expense', 'TOTAL EXPENSES', st.expenseTotal],
    ['', 'NET', st.net],
  ];

  const set: ExportSet = {
    filename: 'income-statement',
    title: 'Income statement',
    subtitle: range.label,
    csvHeaders: ['Section', 'Category', 'Amount'],
    csvRows,
    pdfTables: [
      {
        title: 'Income',
        headers: ['Category', 'Amount'],
        rows: [...st.income.map((r) => [name(r), r.total]), ['Total income', st.incomeTotal]],
        moneyCols: [1],
        totalRow: true,
      },
      {
        title: 'Expenses',
        headers: ['Category', 'Amount'],
        rows: [...st.expense.map((r) => [name(r), r.total]), ['Total expenses', st.expenseTotal]],
        moneyCols: [1],
        totalRow: true,
      },
      { headers: ['', 'Amount'], rows: [['Net surplus / (deficit)', st.net]], moneyCols: [1], totalRow: true },
    ],
  };

  return (
    <div className="card">
      <PeriodPicker {...{ preset, setPreset, customFrom, setCustomFrom, customTo, setCustomTo }} />
      {st.income.length + st.expense.length === 0 ? (
        <Empty>No transactions in this period.</Empty>
      ) : (
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Category</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td colSpan={2}>
                  <h3>Income</h3>
                </td>
              </tr>
              {st.income.map((r, i) => (
                <tr key={i}>
                  <td>{name(r)}</td>
                  <td className="num">{fmtMoney(r.total)}</td>
                </tr>
              ))}
              <tr className="total">
                <td>Total income</td>
                <td className="num">{fmtMoney(st.incomeTotal)}</td>
              </tr>
              <tr>
                <td colSpan={2}>
                  <h3 style={{ marginTop: 8 }}>Expenses</h3>
                </td>
              </tr>
              {st.expense.map((r, i) => (
                <tr key={i}>
                  <td>{name(r)}</td>
                  <td className="num">{fmtMoney(r.total)}</td>
                </tr>
              ))}
              <tr className="total">
                <td>Total expenses</td>
                <td className="num">{fmtMoney(st.expenseTotal)}</td>
              </tr>
              <tr className="total">
                <td>Net surplus / (deficit)</td>
                <td className={`num ${st.net >= 0 ? 'pos' : 'neg'}`}>{fmtMoney(st.net)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
      <ExportButtons set={set} />
    </div>
  );
}

// ---------------------------------------------------------------- cash flow

function CashflowTab() {
  const { transactions } = useData();
  const months = lastNMonths(12);
  const flow = useMemo(() => monthlyCashflow(transactions, months), [transactions, months]);
  const rows = flow.map((f) => [monthLabel(f.month), f.income, f.expense, f.net]);
  const set: ExportSet = {
    filename: 'cash-flow',
    title: 'Cash flow',
    subtitle: 'Last 12 months',
    csvHeaders: ['Month', 'Income', 'Expenses', 'Net'],
    csvRows: rows,
    sheets: [{ name: 'Cash flow', headers: ['Month', 'Income', 'Expenses', 'Net'], rows, moneyCols: [1, 2, 3] }],
    pdfTables: [{ headers: ['Month', 'Income', 'Expenses', 'Net'], rows, moneyCols: [1, 2, 3] }],
  };
  return (
    <div className="card">
      <CashflowBars data={flow} />
      <div className="tablewrap" style={{ marginTop: 12 }}>
        <table>
          <thead>
            <tr>
              <th>Month</th>
              <th className="num">Income</th>
              <th className="num">Expenses</th>
              <th className="num">Net</th>
            </tr>
          </thead>
          <tbody>
            {flow.map((f) => (
              <tr key={f.month}>
                <td>{monthLabel(f.month)}</td>
                <td className="num">{fmtMoney(f.income)}</td>
                <td className="num">{fmtMoney(f.expense)}</td>
                <td className={`num ${f.net >= 0 ? 'pos' : 'neg'}`}>{fmtMoney(f.net)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ExportButtons set={set} />
    </div>
  );
}

// ---------------------------------------------------------------- net worth

function NetWorthTab() {
  const data = useData();
  const today = todayStr();
  const nw = useMemo(() => netWorthAt(data, today), [data, today]);
  const series = useMemo(() => netWorthSeries(data, lastNMonths(12)), [data]);

  const csvRows: (string | number)[][] = [
    ...nw.accounts.map((r) => ['Account', r.account.name, r.balance]),
    ...nw.assets.map((r) => ['Asset', r.asset.name, r.value]),
    ...nw.liabilities.map((r) => ['Liability', r.asset.name, -r.value]),
    ['', 'NET WORTH', nw.netWorth],
  ];
  const set: ExportSet = {
    filename: 'net-worth',
    title: 'Net worth statement',
    subtitle: `As at ${fmtDate(today)}`,
    csvHeaders: ['Type', 'Item', 'Value'],
    csvRows,
    pdfTables: [
      {
        title: 'Accounts',
        headers: ['Account', 'Balance'],
        rows: [...nw.accounts.map((r) => [r.account.name, r.balance]), ['Total', nw.accountsTotal]],
        moneyCols: [1],
        totalRow: true,
      },
      {
        title: 'Assets',
        headers: ['Asset', 'Value'],
        rows: [...nw.assets.map((r) => [r.asset.name, r.value]), ['Total', nw.assetsTotal]],
        moneyCols: [1],
        totalRow: true,
      },
      {
        title: 'Liabilities',
        headers: ['Liability', 'Value'],
        rows: [...nw.liabilities.map((r) => [r.asset.name, r.value]), ['Total', nw.liabilitiesTotal]],
        moneyCols: [1],
        totalRow: true,
      },
      { headers: ['', 'Amount'], rows: [['Net worth', nw.netWorth]], moneyCols: [1], totalRow: true },
    ],
  };

  const section = (title: string, rows: { name: string; value: number; sub?: string }[], total: number) => (
    <>
      <tr>
        <td colSpan={2}>
          <h3 style={{ marginTop: 8 }}>{title}</h3>
        </td>
      </tr>
      {rows.map((r, i) => (
        <tr key={i}>
          <td>
            {r.name}
            {r.sub && <span className="sub">{r.sub}</span>}
          </td>
          <td className="num">{fmtMoney(r.value)}</td>
        </tr>
      ))}
      <tr className="total">
        <td>Total {title.toLowerCase()}</td>
        <td className="num">{fmtMoney(total)}</td>
      </tr>
    </>
  );

  return (
    <div className="stack">
      <div className="card">
        <div className="card-head">
          <h2>Net worth — last 12 months</h2>
          <div className="spacer" />
          <strong>{fmtMoney(nw.netWorth)}</strong>
        </div>
        <TrendLine points={series} />
      </div>
      <div className="card">
        <div className="tablewrap">
          <table>
            <tbody>
              {section(
                'Accounts',
                nw.accounts.map((r) => ({ name: r.account.name, value: r.balance })),
                nw.accountsTotal,
              )}
              {section(
                'Assets',
                nw.assets.map((r) => ({ name: r.asset.name, value: r.value, sub: r.asOf ? `valued ${fmtDate(r.asOf)}` : 'no valuation yet' })),
                nw.assetsTotal,
              )}
              {section(
                'Liabilities',
                nw.liabilities.map((r) => ({ name: r.asset.name, value: r.value, sub: r.asOf ? `valued ${fmtDate(r.asOf)}` : 'no valuation yet' })),
                nw.liabilitiesTotal,
              )}
              <tr className="total">
                <td>Net worth</td>
                <td className={`num ${nw.netWorth >= 0 ? 'pos' : 'neg'}`}>{fmtMoney(nw.netWorth)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <ExportButtons set={set} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- budgets

function BudgetsTab() {
  const { categories, transactions } = useData();
  const [mk, setMk] = useState(monthKey(todayStr()));
  const rows = useMemo(() => budgetRows(categories, transactions, mk), [categories, transactions, mk]);

  const csvRows = rows.map((r) => [r.category.name, r.budget, r.actual, r.remaining]);
  const set: ExportSet = {
    filename: `budget-${mk}`,
    title: 'Budget vs actual',
    subtitle: monthLabel(mk),
    csvHeaders: ['Category', 'Budget', 'Actual', 'Remaining'],
    csvRows,
    sheets: [{ name: 'Budget', headers: ['Category', 'Budget', 'Actual', 'Remaining'], rows: csvRows, moneyCols: [1, 2, 3] }],
    pdfTables: [{ headers: ['Category', 'Budget', 'Actual', 'Remaining'], rows: csvRows, moneyCols: [1, 2, 3] }],
  };

  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 12, gap: 4 }}>
        <button className="btn small" onClick={() => setMk(addMonths(mk, -1))}>
          ‹
        </button>
        <strong style={{ minWidth: 86, textAlign: 'center' }}>{monthLabel(mk)}</strong>
        <button className="btn small" onClick={() => setMk(addMonths(mk, 1))}>
          ›
        </button>
      </div>
      {rows.length === 0 ? (
        <Empty>
          No budgets set yet — open <strong>Categories</strong> and give any expense category a monthly budget.
        </Empty>
      ) : (
        <div className="stack">
          {rows.map((r) => {
            const pct = r.budget > 0 ? Math.min(100, (r.actual / r.budget) * 100) : 100;
            const over = r.remaining < 0;
            return (
              <div key={r.category.id}>
                <div className="row" style={{ marginBottom: 4 }}>
                  <span style={{ fontWeight: 650 }}>{r.category.name}</span>
                  <div className="spacer" />
                  <span className="small">
                    {fmtMoney(r.actual)} of {fmtMoney(r.budget)}
                    {over && (
                      <strong className="neg"> · over by {fmtMoney(-r.remaining)}</strong>
                    )}
                  </span>
                </div>
                <div className="budgetbar">
                  <div className={over ? 'over' : ''} style={{ width: `${pct}%` }} />
                </div>
              </div>
            );
          })}
          <ExportButtons set={set} />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- ledger

function LedgerTab() {
  const { accounts, categories, transactions, accountById, categoryById } = useData();
  const [params] = useSearchParams();
  const [target, setTarget] = useState(params.get('account') ? `a:${params.get('account')}` : '');
  const year = todayStr().slice(0, 4);
  const [from, setFrom] = useState(`${year}-01-01`);
  const [to, setTo] = useState(todayStr());

  const account = target.startsWith('a:') ? accountById.get(target.slice(2)) : undefined;
  const category = target.startsWith('c:') ? categoryById.get(target.slice(2)) : undefined;

  const led = useMemo(() => {
    if (account) return accountLedger(account, transactions, from, to);
    return null;
  }, [account, transactions, from, to]);
  const catLed = useMemo(() => {
    if (category) return categoryLedger(category, transactions, from, to);
    return null;
  }, [category, transactions, from, to]);

  const detail = (tx: { payee: string | null; notes: string | null; kind: string; category_id: string | null; transfer_account_id: string | null }) => {
    if (tx.kind === 'transfer') return `Transfer → ${accountById.get(tx.transfer_account_id ?? '')?.name ?? '?'}`;
    return tx.payee || (tx.category_id ? categoryById.get(tx.category_id)?.name ?? '' : 'Uncategorised');
  };

  const title = account ? `Ledger — ${account.name}` : category ? `Ledger — ${category.name}` : 'Ledger';
  const rows: (string | number)[][] = [];
  if (led) {
    rows.push([from, 'Opening balance', '', led.opening]);
    for (const r of led.rows) rows.push([r.tx.tx_date, detail(r.tx), r.delta, r.balance]);
    rows.push([to, 'Closing balance', '', led.closing]);
  } else if (catLed) {
    for (const r of catLed.rows) rows.push([r.tx.tx_date, detail(r.tx), r.delta, r.balance]);
    rows.push([to, 'Total', '', catLed.total]);
  }
  const set: ExportSet = {
    filename: 'ledger',
    title,
    subtitle: `${from} to ${to}`,
    csvHeaders: ['Date', 'Detail', 'Movement', 'Balance'],
    csvRows: rows,
    sheets: [{ name: 'Ledger', headers: ['Date', 'Detail', 'Movement', 'Balance'], rows, moneyCols: [2, 3] }],
    pdfTables: [{ headers: ['Date', 'Detail', 'Movement', 'Balance'], rows, moneyCols: [2, 3] }],
  };

  return (
    <div className="card">
      <div className="row wrap" style={{ marginBottom: 12 }}>
        <select style={{ width: 'auto' }} value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">Choose account or category…</option>
          <optgroup label="Accounts">
            {accounts.map((a) => (
              <option key={a.id} value={`a:${a.id}`}>
                {a.name}
              </option>
            ))}
          </optgroup>
          <optgroup label="Categories">
            {categories
              .filter((c) => !c.archived)
              .map((c) => (
                <option key={c.id} value={`c:${c.id}`}>
                  {c.name}
                </option>
              ))}
          </optgroup>
        </select>
        <input type="date" style={{ width: 'auto' }} value={from} onChange={(e) => setFrom(e.target.value)} />
        <span className="muted">to</span>
        <input type="date" style={{ width: 'auto' }} value={to} onChange={(e) => setTo(e.target.value)} />
      </div>

      {!account && !category ? (
        <Empty>Pick an account or category to see its ledger with running balances.</Empty>
      ) : (
        <>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Detail</th>
                  <th className="num">Movement</th>
                  <th className="num">Balance</th>
                </tr>
              </thead>
              <tbody>
                {led && (
                  <tr>
                    <td>{fmtDate(from)}</td>
                    <td>
                      <em>Opening balance</em>
                    </td>
                    <td className="num"></td>
                    <td className="num">{fmtMoney(led.opening)}</td>
                  </tr>
                )}
                {(led?.rows ?? catLed?.rows ?? []).map((r) => (
                  <tr key={r.tx.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(r.tx.tx_date)}</td>
                    <td>{detail(r.tx)}</td>
                    <td className={`num ${r.delta >= 0 ? 'pos' : ''}`}>{fmtMoney(r.delta)}</td>
                    <td className="num">{fmtMoney(r.balance)}</td>
                  </tr>
                ))}
                <tr className="total">
                  <td colSpan={3}>{led ? 'Closing balance' : 'Total'}</td>
                  <td className="num">{fmtMoney(led ? led.closing : catLed?.total ?? 0)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <ExportButtons set={set} />
        </>
      )}
    </div>
  );
}
