import { useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useData } from '../data/DataContext';
import { parseAmount, todayStr } from '../lib/format';
import { Field, Modal, Seg } from './ui';
import type { Tx, TxKind } from '../types';

export function TxForm({ initial, onClose }: { initial?: Tx | null; onClose: () => void }) {
  const { categories, accounts, refresh } = useData();
  const live = accounts.filter((a) => !a.archived);
  const [kind, setKind] = useState<TxKind>(initial?.kind ?? 'expense');
  const [amount, setAmount] = useState(initial ? String(initial.amount) : '');
  const [date, setDate] = useState(initial?.tx_date ?? todayStr());
  const [categoryId, setCategoryId] = useState(initial?.category_id ?? '');
  const [accountId, setAccountId] = useState(initial?.account_id ?? live[0]?.id ?? '');
  const [toAccountId, setToAccountId] = useState(initial?.transfer_account_id ?? '');
  const [payee, setPayee] = useState(initial?.payee ?? '');
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cats = useMemo(
    () => categories.filter((c) => !c.archived && (kind === 'transfer' ? false : c.kind === kind)),
    [categories, kind],
  );

  async function save() {
    const amt = parseAmount(amount);
    if (amt == null || amt <= 0) return setError('Enter a positive amount.');
    if (!date) return setError('Pick a date.');
    if (!accountId) return setError('Pick an account.');
    if (kind === 'transfer') {
      if (!toAccountId) return setError('Pick the destination account.');
      if (toAccountId === accountId) return setError('Transfer accounts must differ.');
    }
    setBusy(true);
    setError(null);
    const row = {
      tx_date: date,
      kind,
      amount: amt,
      category_id: kind === 'transfer' ? null : categoryId || null,
      account_id: accountId,
      transfer_account_id: kind === 'transfer' ? toAccountId : null,
      payee: payee.trim() || null,
      notes: notes.trim() || null,
    };
    const q = initial
      ? supabase.from('fin_transactions').update(row).eq('id', initial.id)
      : supabase.from('fin_transactions').insert(row);
    const { error: err } = await q;
    setBusy(false);
    if (err) return setError(err.message);
    await refresh();
    onClose();
  }

  async function remove() {
    if (!initial) return;
    if (!window.confirm('Delete this transaction? This cannot be undone.')) return;
    setBusy(true);
    const { error: err } = await supabase.from('fin_transactions').delete().eq('id', initial.id);
    setBusy(false);
    if (err) return setError(err.message);
    await refresh();
    onClose();
  }

  return (
    <Modal title={initial ? 'Edit transaction' : 'Add transaction'} onClose={onClose}>
      <div className="field">
        <Seg
          options={[
            { value: 'expense', label: 'Expense' },
            { value: 'income', label: 'Income' },
            { value: 'transfer', label: 'Transfer' },
          ]}
          value={kind}
          onChange={(k) => {
            setKind(k);
            setCategoryId('');
          }}
        />
      </div>
      {error && <div className="error-banner">{error}</div>}
      <Field label="Amount (R)">
        <input
          inputMode="decimal"
          placeholder="0.00"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          autoFocus={!initial}
        />
      </Field>
      <Field label="Date">
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </Field>
      {kind !== 'transfer' && (
        <Field label="Category">
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">Uncategorised</option>
            {cats.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label={kind === 'transfer' ? 'From account' : 'Account'}>
        <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
          {live.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </Field>
      {kind === 'transfer' && (
        <Field label="To account">
          <select value={toAccountId} onChange={(e) => setToAccountId(e.target.value)}>
            <option value="">Choose…</option>
            {live
              .filter((a) => a.id !== accountId)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
          </select>
        </Field>
      )}
      {kind !== 'transfer' && (
        <Field label={kind === 'income' ? 'Source (optional)' : 'Payee (optional)'}>
          <input value={payee} onChange={(e) => setPayee(e.target.value)} placeholder={kind === 'income' ? 'e.g. Employer' : 'e.g. Woolworths'} />
        </Field>
      )}
      <Field label="Notes (optional)">
        <input value={notes} onChange={(e) => setNotes(e.target.value)} />
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
