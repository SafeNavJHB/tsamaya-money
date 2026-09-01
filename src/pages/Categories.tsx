import { useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useData } from '../data/DataContext';
import { Field, Modal, Seg } from '../components/ui';
import { fmtMoney, monthEnd, monthKey, monthStart, parseAmount, todayStr } from '../lib/format';
import { categoryTotals } from '../logic/compute';
import type { Category, CategoryKind } from '../types';

function CategoryForm({ initial, onClose }: { initial?: Category | null; onClose: () => void }) {
  const { refresh, transactions } = useData();
  const [name, setName] = useState(initial?.name ?? '');
  const [kind, setKind] = useState<CategoryKind>(initial?.kind ?? 'expense');
  const [budget, setBudget] = useState(initial?.monthly_budget != null ? String(initial.monthly_budget) : '');
  const [archived, setArchived] = useState(initial?.archived ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inUse = initial ? transactions.some((t) => t.category_id === initial.id) : false;

  async function save() {
    if (!name.trim()) return setError('Give it a name.');
    const b = budget.trim() ? parseAmount(budget) : null;
    if (budget.trim() && (b == null || b < 0)) return setError('Budget must be a positive amount (or blank).');
    setBusy(true);
    const row = { name: name.trim(), kind, monthly_budget: b, archived };
    const q = initial
      ? supabase.from('fin_categories').update(row).eq('id', initial.id)
      : supabase.from('fin_categories').insert(row);
    const { error: err } = await q;
    setBusy(false);
    if (err) return setError(err.message);
    await refresh();
    onClose();
  }

  async function remove() {
    if (!initial) return;
    if (!window.confirm(`Delete category "${initial.name}"?`)) return;
    setBusy(true);
    const { error: err } = await supabase.from('fin_categories').delete().eq('id', initial.id);
    setBusy(false);
    if (err) return setError('It has transactions against it, so it cannot be deleted — archive it instead.');
    await refresh();
    onClose();
  }

  return (
    <Modal title={initial ? 'Edit category' : 'New category'} onClose={onClose}>
      {error && <div className="error-banner">{error}</div>}
      <Field label="Name">
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus={!initial} />
      </Field>
      <div className="field">
        <span style={{ fontSize: 12.5, fontWeight: 650, color: 'var(--ink-2)' }}>Type</span>
        <Seg
          options={[
            { value: 'expense', label: 'Expense' },
            { value: 'income', label: 'Income' },
          ]}
          value={kind}
          onChange={setKind}
        />
      </div>
      {kind === 'expense' && (
        <Field label="Monthly budget (optional, R)">
          <input inputMode="decimal" placeholder="none" value={budget} onChange={(e) => setBudget(e.target.value)} />
        </Field>
      )}
      {initial && (
        <label className="row small" style={{ marginBottom: 12, cursor: 'pointer' }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={archived} onChange={(e) => setArchived(e.target.checked)} />
          Archived (hidden from pickers, history kept)
        </label>
      )}
      <div className="row">
        {initial && !inUse && (
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

export function Categories() {
  const { categories, transactions } = useData();
  const [editing, setEditing] = useState<Category | null>(null);
  const [adding, setAdding] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  const mk = monthKey(todayStr());
  const spendThisMonth = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of categoryTotals(transactions, categories, 'expense', monthStart(mk), monthEnd(mk)))
      if (r.category) map.set(r.category.id, r.total);
    for (const r of categoryTotals(transactions, categories, 'income', monthStart(mk), monthEnd(mk)))
      if (r.category) map.set(r.category.id, r.total);
    return map;
  }, [transactions, categories, mk]);

  const visible = categories.filter((c) => showArchived || !c.archived);
  const group = (kind: CategoryKind, title: string) => {
    const rows = visible.filter((c) => c.kind === kind);
    return (
      <div className="card">
        <div className="card-head">
          <h2>{title}</h2>
        </div>
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th className="num">This month</th>
                <th className="num">Budget</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} className="click" onClick={() => setEditing(c)}>
                  <td>
                    {c.name} {c.archived && <span className="pill">archived</span>}
                  </td>
                  <td className="num">{fmtMoney(spendThisMonth.get(c.id) ?? 0)}</td>
                  <td className="num muted">{c.monthly_budget != null ? fmtMoney(c.monthly_budget) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  return (
    <div className="stack">
      <div className="row">
        <h1>Categories</h1>
        <div className="spacer" />
        <button className="btn small" onClick={() => setShowArchived(!showArchived)}>
          {showArchived ? 'Hide archived' : 'Show archived'}
        </button>
        <button className="btn primary" onClick={() => setAdding(true)}>
          + New
        </button>
      </div>
      {group('expense', 'Expense categories')}
      {group('income', 'Income categories')}
      {adding && <CategoryForm onClose={() => setAdding(false)} />}
      {editing && <CategoryForm initial={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
