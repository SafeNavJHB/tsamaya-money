import { useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useData } from '../data/DataContext';
import { Field, Modal } from '../components/ui';
import { fmtMoney, parseAmount } from '../lib/format';
import { accountBalance } from '../logic/compute';
import type { Account, AccountKind } from '../types';

const KINDS: { value: AccountKind; label: string }[] = [
  { value: 'bank', label: 'Bank account' },
  { value: 'card', label: 'Credit card' },
  { value: 'cash', label: 'Cash' },
  { value: 'savings', label: 'Savings' },
  { value: 'investment', label: 'Investment' },
  { value: 'other', label: 'Other' },
];

function AccountForm({ initial, onClose }: { initial?: Account | null; onClose: () => void }) {
  const { refresh, transactions } = useData();
  const [name, setName] = useState(initial?.name ?? '');
  const [kind, setKind] = useState<AccountKind>(initial?.kind ?? 'bank');
  const [opening, setOpening] = useState(initial ? String(initial.opening_balance) : '0');
  const [archived, setArchived] = useState(initial?.archived ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inUse = initial
    ? transactions.some((t) => t.account_id === initial.id || t.transfer_account_id === initial.id)
    : false;

  async function save() {
    if (!name.trim()) return setError('Give it a name.');
    const ob = parseAmount(opening || '0');
    if (ob == null) return setError('Opening balance must be a number (negative allowed for cards).');
    setBusy(true);
    const row = { name: name.trim(), kind, opening_balance: ob, archived };
    const q = initial
      ? supabase.from('fin_accounts').update(row).eq('id', initial.id)
      : supabase.from('fin_accounts').insert(row);
    const { error: err } = await q;
    setBusy(false);
    if (err) return setError(err.message);
    await refresh();
    onClose();
  }

  async function remove() {
    if (!initial) return;
    if (!window.confirm(`Delete account "${initial.name}"?`)) return;
    setBusy(true);
    const { error: err } = await supabase.from('fin_accounts').delete().eq('id', initial.id);
    setBusy(false);
    if (err) return setError('It has transactions, so it cannot be deleted — archive it instead.');
    await refresh();
    onClose();
  }

  return (
    <Modal title={initial ? 'Edit account' : 'New account'} onClose={onClose}>
      {error && <div className="error-banner">{error}</div>}
      <Field label="Name">
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus={!initial} placeholder="e.g. FNB Cheque" />
      </Field>
      <Field label="Type">
        <select value={kind} onChange={(e) => setKind(e.target.value as AccountKind)}>
          {KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Opening balance (R)">
        <input inputMode="decimal" value={opening} onChange={(e) => setOpening(e.target.value)} />
      </Field>
      {initial && (
        <label className="row small" style={{ marginBottom: 12, cursor: 'pointer' }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={archived} onChange={(e) => setArchived(e.target.checked)} />
          Archived (hidden from pickers and net worth)
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

export function Accounts() {
  const { accounts, transactions } = useData();
  const [editing, setEditing] = useState<Account | null>(null);
  const [adding, setAdding] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  const visible = accounts.filter((a) => showArchived || !a.archived);
  const total = visible.filter((a) => !a.archived).reduce((s, a) => s + accountBalance(a, transactions), 0);

  return (
    <div className="stack">
      <div className="row">
        <h1>Accounts</h1>
        <div className="spacer" />
        <button className="btn small" onClick={() => setShowArchived(!showArchived)}>
          {showArchived ? 'Hide archived' : 'Show archived'}
        </button>
        <button className="btn primary" onClick={() => setAdding(true)}>
          + New
        </button>
      </div>
      <div className="card">
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Account</th>
                <th></th>
                <th className="num">Balance</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((a) => (
                <tr key={a.id} className="click" onClick={() => setEditing(a)}>
                  <td>
                    {a.name} {a.archived && <span className="pill">archived</span>}
                    <span className="sub">{KINDS.find((k) => k.value === a.kind)?.label}</span>
                  </td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <Link className="small" to={`/reports?tab=ledger&account=${a.id}`}>
                      ledger →
                    </Link>
                  </td>
                  <td className="num">{fmtMoney(accountBalance(a, transactions))}</td>
                </tr>
              ))}
              <tr className="total">
                <td colSpan={2}>Total (active accounts)</td>
                <td className="num">{fmtMoney(total)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      {adding && <AccountForm onClose={() => setAdding(false)} />}
      {editing && <AccountForm initial={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
