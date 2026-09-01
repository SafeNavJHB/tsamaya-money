import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useData } from '../data/DataContext';
import { CashflowBars, HBars } from '../components/charts';
import { TxForm } from '../components/TxForm';
import { Empty } from '../components/ui';
import {
  categoryTotals,
  monthlyCashflow,
  netWorthAt,
} from '../logic/compute';
import { fmtDate, fmtMoney, lastNMonths, monthEnd, monthKey, monthLabel, monthStart, todayStr } from '../lib/format';
import type { Tx } from '../types';

export function Dashboard() {
  const data = useData();
  const { transactions, categories, categoryById, accountById } = data;
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Tx | null>(null);

  const today = todayStr();
  const mk = monthKey(today);
  const months = lastNMonths(6);

  const cashflow = useMemo(() => monthlyCashflow(transactions, months), [transactions, months]);
  const thisMonth = cashflow[cashflow.length - 1];
  const nw = useMemo(() => netWorthAt(data, today), [data, today]);
  const topSpend = useMemo(
    () =>
      categoryTotals(transactions, categories, 'expense', monthStart(mk), monthEnd(mk))
        .slice(0, 8)
        .map((r) => ({ label: r.category?.name ?? 'Uncategorised', value: r.total })),
    [transactions, categories, mk],
  );
  const recent = transactions.slice(0, 8);

  return (
    <div className="stack">
      <div className="row">
        <h1>{monthLabel(mk)}</h1>
        <div className="spacer" />
        <button className="btn primary" onClick={() => setAdding(true)}>
          + Add
        </button>
      </div>

      <div className="stats">
        <div className="stat">
          <div className="label">Income</div>
          <div className="value">{fmtMoney(thisMonth?.income ?? 0)}</div>
        </div>
        <div className="stat">
          <div className="label">Expenses</div>
          <div className="value">{fmtMoney(thisMonth?.expense ?? 0)}</div>
        </div>
        <div className="stat">
          <div className="label">Net this month</div>
          <div className={`value ${(thisMonth?.net ?? 0) >= 0 ? 'pos' : 'neg'}`}>{fmtMoney(thisMonth?.net ?? 0)}</div>
        </div>
        <div className="stat">
          <div className="label">Net worth</div>
          <div className="value">{fmtMoney(nw.netWorth)}</div>
          <div className="sub">
            <Link to="/reports?tab=networth">breakdown →</Link>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Cash flow — last 6 months</h2>
        </div>
        <CashflowBars data={cashflow} />
      </div>

      <div className="grid2">
        <div className="card">
          <div className="card-head">
            <h2>Top spending this month</h2>
            <div className="spacer" />
            <Link className="small" to="/reports">
              reports →
            </Link>
          </div>
          {topSpend.length ? <HBars rows={topSpend} /> : <Empty>No expenses logged this month yet.</Empty>}
        </div>

        <div className="card">
          <div className="card-head">
            <h2>Recent transactions</h2>
            <div className="spacer" />
            <Link className="small" to="/transactions">
              all →
            </Link>
          </div>
          {recent.length ? (
            <div className="tablewrap">
              <table>
                <tbody>
                  {recent.map((tx) => (
                    <tr key={tx.id} className="click" onClick={() => setEditing(tx)}>
                      <td>
                        {tx.kind === 'transfer'
                          ? `Transfer → ${accountById.get(tx.transfer_account_id ?? '')?.name ?? '?'}`
                          : tx.payee || (tx.category_id ? categoryById.get(tx.category_id)?.name : 'Uncategorised')}
                        <span className="sub">
                          {fmtDate(tx.tx_date)}
                          {tx.kind !== 'transfer' && tx.payee && tx.category_id
                            ? ` · ${categoryById.get(tx.category_id)?.name ?? ''}`
                            : ''}
                        </span>
                      </td>
                      <td className={`num ${tx.kind === 'income' ? 'pos' : ''}`}>
                        {tx.kind === 'income' ? '+' : tx.kind === 'expense' ? '−' : ''}
                        {fmtMoney(tx.amount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>Nothing logged yet — tap + Add to record your first transaction.</Empty>
          )}
        </div>
      </div>

      {adding && <TxForm onClose={() => setAdding(false)} />}
      {editing && <TxForm initial={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
