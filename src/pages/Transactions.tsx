import { useMemo, useState } from 'react';
import { useData } from '../data/DataContext';
import { TxForm } from '../components/TxForm';
import { Empty, Seg } from '../components/ui';
import { exportCsv } from '../export/csv';
import { exportXlsx } from '../export/xlsx';
import { exportPdf } from '../export/pdf';
import { stamp } from '../export/download';
import { addMonths, fmtDate, fmtMoney, monthKey, monthLabel, todayStr } from '../lib/format';
import { round2, txSort } from '../logic/compute';
import type { Tx } from '../types';

type KindFilter = 'all' | 'expense' | 'income' | 'transfer';

export function Transactions() {
  const { transactions, categories, categoryById, accountById } = useData();
  const [mk, setMk] = useState(monthKey(todayStr()));
  const [kind, setKind] = useState<KindFilter>('all');
  const [catId, setCatId] = useState('');
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Tx | null>(null);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return transactions
      .filter((t) => t.tx_date.slice(0, 7) === mk)
      .filter((t) => kind === 'all' || t.kind === kind)
      .filter((t) => !catId || t.category_id === catId)
      .filter((t) => {
        if (!q) return true;
        const cat = t.category_id ? categoryById.get(t.category_id)?.name ?? '' : '';
        return `${t.payee ?? ''} ${t.notes ?? ''} ${cat}`.toLowerCase().includes(q);
      })
      .sort((a, b) => txSort(b, a)); // newest first
  }, [transactions, mk, kind, catId, search, categoryById]);

  const totals = useMemo(() => {
    let income = 0;
    let expense = 0;
    for (const t of rows) {
      if (t.kind === 'income') income += t.amount;
      else if (t.kind === 'expense') expense += t.amount;
    }
    return { income: round2(income), expense: round2(expense) };
  }, [rows]);

  const exportRows = () =>
    rows.map((t) => [
      t.tx_date,
      t.kind,
      t.kind === 'transfer' ? '' : t.category_id ? categoryById.get(t.category_id)?.name ?? '' : 'Uncategorised',
      accountById.get(t.account_id)?.name ?? '',
      t.kind === 'transfer' ? accountById.get(t.transfer_account_id ?? '')?.name ?? '' : '',
      t.payee ?? '',
      t.notes ?? '',
      t.kind === 'expense' ? -t.amount : t.amount,
    ]);
  const headers = ['Date', 'Kind', 'Category', 'Account', 'To account', 'Payee', 'Notes', 'Amount'];
  const label = `transactions-${mk}`;

  return (
    <div className="stack">
      <div className="row">
        <h1>Transactions</h1>
        <div className="spacer" />
        <button className="btn primary" onClick={() => setAdding(true)}>
          + Add
        </button>
      </div>

      <div className="card">
        <div className="row wrap" style={{ marginBottom: 10 }}>
          <div className="row" style={{ gap: 4 }}>
            <button className="btn small" onClick={() => setMk(addMonths(mk, -1))} aria-label="Previous month">
              ‹
            </button>
            <strong style={{ minWidth: 86, textAlign: 'center' }}>{monthLabel(mk)}</strong>
            <button className="btn small" onClick={() => setMk(addMonths(mk, 1))} aria-label="Next month">
              ›
            </button>
          </div>
          <Seg
            options={[
              { value: 'all', label: 'All' },
              { value: 'expense', label: 'Out' },
              { value: 'income', label: 'In' },
              { value: 'transfer', label: 'Transfers' },
            ]}
            value={kind}
            onChange={setKind}
          />
          <select style={{ width: 'auto' }} value={catId} onChange={(e) => setCatId(e.target.value)}>
            <option value="">All categories</option>
            {categories
              .filter((c) => !c.archived)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </select>
          <input
            style={{ width: 160, flex: '1 1 120px' }}
            placeholder="Search payee/notes…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {rows.length ? (
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Detail</th>
                  <th>Account</th>
                  <th className="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id} className="click" onClick={() => setEditing(t)}>
                    <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(t.tx_date)}</td>
                    <td>
                      {t.kind === 'transfer'
                        ? `Transfer → ${accountById.get(t.transfer_account_id ?? '')?.name ?? '?'}`
                        : t.payee || (t.category_id ? categoryById.get(t.category_id)?.name : 'Uncategorised')}
                      {t.kind !== 'transfer' && (
                        <span className="sub">
                          {t.category_id ? categoryById.get(t.category_id)?.name : 'Uncategorised'}
                          {t.notes ? ` · ${t.notes}` : ''}
                        </span>
                      )}
                    </td>
                    <td>{accountById.get(t.account_id)?.name ?? ''}</td>
                    <td className={`num ${t.kind === 'income' ? 'pos' : ''}`}>
                      {t.kind === 'income' ? '+' : t.kind === 'expense' ? '−' : ''}
                      {fmtMoney(t.amount)}
                    </td>
                  </tr>
                ))}
                <tr className="total">
                  <td colSpan={3}>
                    {rows.length} transaction{rows.length === 1 ? '' : 's'} · in {fmtMoney(totals.income)} · out{' '}
                    {fmtMoney(totals.expense)}
                  </td>
                  <td className={`num ${totals.income - totals.expense >= 0 ? 'pos' : 'neg'}`}>
                    {fmtMoney(totals.income - totals.expense)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No transactions match.</Empty>
        )}

        <div className="row wrap" style={{ marginTop: 12 }}>
          <span className="small muted">Export this view:</span>
          <button className="btn small" onClick={() => exportCsv(`${label}-${stamp()}.csv`, headers, exportRows())}>
            CSV
          </button>
          <button
            className="btn small"
            onClick={() =>
              void exportXlsx(`${label}-${stamp()}.xlsx`, [
                { name: monthLabel(mk), headers, rows: exportRows(), moneyCols: [7] },
              ])
            }
          >
            Excel
          </button>
          <button
            className="btn small"
            onClick={() =>
              void exportPdf(`${label}-${stamp()}.pdf`, 'Transactions', monthLabel(mk), [
                { headers, rows: exportRows(), moneyCols: [7] },
              ])
            }
          >
            PDF
          </button>
        </div>
      </div>

      {adding && <TxForm onClose={() => setAdding(false)} />}
      {editing && <TxForm initial={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
