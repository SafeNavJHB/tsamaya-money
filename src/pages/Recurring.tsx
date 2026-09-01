import { useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useData } from '../data/DataContext';
import { Empty, Field, Modal, Seg } from '../components/ui';
import { fmtDate, fmtMoney, parseAmount, todayStr } from '../lib/format';
import { FREQUENCY_LABEL, advanceDate, dueDates, isFinished } from '../logic/recurring';
import type { Frequency, RecurringRule, TxKind } from '../types';

// ---------------------------------------------------------------- posting

export interface PostOutcome {
  posted: number;
  skippedExisting: number;
  error: string | null;
}

/**
 * Posts every occurrence owed by one series, oldest first, advancing
 * next_date as it goes. A 23505 means that occurrence is already on file
 * (double-click, or another device beat us) — it is counted, not an error.
 */
export async function postDue(rule: RecurringRule, dates: string[]): Promise<PostOutcome> {
  let posted = 0;
  let skippedExisting = 0;
  let cursor = rule.next_date;
  for (const d of dates) {
    const { error } = await supabase.from('fin_transactions').insert({
      tx_date: d,
      kind: rule.kind,
      amount: rule.amount,
      category_id: rule.kind === 'transfer' ? null : rule.category_id,
      account_id: rule.account_id,
      transfer_account_id: rule.kind === 'transfer' ? rule.transfer_account_id : null,
      payee: rule.payee,
      notes: rule.notes,
      recurring_id: rule.id,
    });
    if (error) {
      if (error.code === '23505') skippedExisting++;
      else {
        // Persist progress made so far before reporting the failure.
        if (cursor !== rule.next_date) await supabase.from('fin_recurring').update({ next_date: cursor }).eq('id', rule.id);
        return { posted, skippedExisting, error: error.message };
      }
    } else {
      posted++;
    }
    cursor = advanceDate(d, rule.frequency, rule.anchor_day);
  }
  const { error: upErr } = await supabase.from('fin_recurring').update({ next_date: cursor }).eq('id', rule.id);
  return { posted, skippedExisting, error: upErr ? upErr.message : null };
}

// ---------------------------------------------------------------- form

function RecurringForm({ initial, onClose }: { initial?: RecurringRule | null; onClose: () => void }) {
  const { categories, accounts, refresh } = useData();
  const live = accounts.filter((a) => !a.archived);
  const [name, setName] = useState(initial?.name ?? '');
  const [kind, setKind] = useState<TxKind>(initial?.kind ?? 'expense');
  const [amount, setAmount] = useState(initial ? String(initial.amount) : '');
  const [frequency, setFrequency] = useState<Frequency>(initial?.frequency ?? 'monthly');
  const [startDate, setStartDate] = useState(initial?.start_date ?? todayStr());
  const [nextDate, setNextDate] = useState(initial?.next_date ?? todayStr());
  const [endDate, setEndDate] = useState(initial?.end_date ?? '');
  const [categoryId, setCategoryId] = useState(initial?.category_id ?? '');
  const [accountId, setAccountId] = useState(initial?.account_id ?? live[0]?.id ?? '');
  const [toAccountId, setToAccountId] = useState(initial?.transfer_account_id ?? '');
  const [payee, setPayee] = useState(initial?.payee ?? '');
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [autoPost, setAutoPost] = useState(initial?.auto_post ?? false);
  const [archived, setArchived] = useState(initial?.archived ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cats = categories.filter((c) => !c.archived && kind !== 'transfer' && c.kind === kind);

  async function save() {
    if (!name.trim()) return setError('Give it a name.');
    const amt = parseAmount(amount);
    if (amt == null || amt <= 0) return setError('Enter a positive amount.');
    if (!accountId) return setError('Pick an account.');
    if (kind === 'transfer') {
      if (!toAccountId) return setError('Pick the destination account.');
      if (toAccountId === accountId) return setError('Transfer accounts must differ.');
    }
    if (endDate && endDate < startDate) return setError('The end date is before the start date.');
    setBusy(true);
    setError(null);
    const row = {
      name: name.trim(),
      kind,
      amount: amt,
      category_id: kind === 'transfer' ? null : categoryId || null,
      account_id: accountId,
      transfer_account_id: kind === 'transfer' ? toAccountId : null,
      payee: payee.trim() || null,
      notes: notes.trim() || null,
      frequency,
      anchor_day: Number(startDate.slice(8, 10)) || 1,
      start_date: startDate,
      end_date: endDate || null,
      next_date: initial ? nextDate : startDate,
      auto_post: autoPost,
      archived,
    };
    const q = initial
      ? supabase.from('fin_recurring').update(row).eq('id', initial.id)
      : supabase.from('fin_recurring').insert(row);
    const { error: err } = await q;
    setBusy(false);
    if (err) return setError(err.message);
    await refresh();
    onClose();
  }

  async function remove() {
    if (!initial) return;
    if (!window.confirm(`Delete "${initial.name}"? Transactions already posted from it are kept.`)) return;
    setBusy(true);
    const { error: err } = await supabase.from('fin_recurring').delete().eq('id', initial.id);
    setBusy(false);
    if (err) return setError(err.message);
    await refresh();
    onClose();
  }

  return (
    <Modal title={initial ? 'Edit recurring' : 'New recurring'} onClose={onClose}>
      {error && <div className="error-banner">{error}</div>}
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
      <Field label="Name">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Claude subscription" autoFocus={!initial} />
      </Field>
      <Field label="Amount (R)">
        <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
      </Field>
      <p className="small muted" style={{ marginTop: -6 }}>
        If the real amount varies month to month, post it and then edit that one transaction — the series keeps this
        figure as its default.
      </p>
      <Field label="How often">
        <select value={frequency} onChange={(e) => setFrequency(e.target.value as Frequency)}>
          {(Object.keys(FREQUENCY_LABEL) as Frequency[]).map((f) => (
            <option key={f} value={f}>
              {FREQUENCY_LABEL[f]}
            </option>
          ))}
        </select>
      </Field>
      <Field label={initial ? 'First date (sets the day of month)' : 'Starts on'}>
        <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
      </Field>
      {initial && (
        <Field label="Next due">
          <input type="date" value={nextDate} onChange={(e) => setNextDate(e.target.value)} />
        </Field>
      )}
      <Field label="Ends on (optional)">
        <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
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
        <Field label="Payee (optional)">
          <input value={payee} onChange={(e) => setPayee(e.target.value)} />
        </Field>
      )}
      <Field label="Notes (optional)">
        <input value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      <label className="row small" style={{ marginBottom: 8, cursor: 'pointer' }}>
        <input type="checkbox" style={{ width: 'auto' }} checked={autoPost} onChange={(e) => setAutoPost(e.target.checked)} />
        Post automatically when due
      </label>
      <p className="small muted" style={{ marginTop: -4 }}>
        Automatic posting happens the next time you open this app — there is no server running in the background.
      </p>
      {initial && (
        <label className="row small" style={{ margin: '10px 0', cursor: 'pointer' }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={archived} onChange={(e) => setArchived(e.target.checked)} />
          Paused (stops posting, keeps history)
        </label>
      )}
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

// ---------------------------------------------------------------- page

export function Recurring() {
  const { recurring, categoryById, accountById, refresh } = useData();
  const [editing, setEditing] = useState<RecurringRule | null>(null);
  const [adding, setAdding] = useState(false);
  const [showPaused, setShowPaused] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const today = todayStr();

  const due = useMemo(
    () => recurring.map((r) => ({ rule: r, dates: dueDates(r, today) })).filter((d) => d.dates.length > 0),
    [recurring, today],
  );

  async function post(rule: RecurringRule, dates: string[]) {
    setBusyId(rule.id);
    setError(null);
    setNote(null);
    const out = await postDue(rule, dates);
    setBusyId(null);
    if (out.error) setError(out.error);
    else
      setNote(
        `Posted ${out.posted} transaction${out.posted === 1 ? '' : 's'} for ${rule.name}` +
          (out.skippedExisting ? ` (${out.skippedExisting} were already on file)` : ''),
      );
    await refresh();
  }

  async function skipOne(rule: RecurringRule, date: string) {
    setBusyId(rule.id);
    const { error: err } = await supabase
      .from('fin_recurring')
      .update({ next_date: advanceDate(date, rule.frequency, rule.anchor_day) })
      .eq('id', rule.id);
    setBusyId(null);
    if (err) setError(err.message);
    await refresh();
  }

  const detail = (r: RecurringRule) =>
    r.kind === 'transfer'
      ? `${accountById.get(r.account_id)?.name ?? '?'} → ${accountById.get(r.transfer_account_id ?? '')?.name ?? '?'}`
      : `${r.category_id ? categoryById.get(r.category_id)?.name ?? 'Uncategorised' : 'Uncategorised'} · ${
          accountById.get(r.account_id)?.name ?? ''
        }`;

  const visible = recurring.filter((r) => showPaused || !r.archived);

  return (
    <div className="stack">
      <div className="row">
        <h1>Recurring</h1>
        <div className="spacer" />
        <button className="btn small" onClick={() => setShowPaused(!showPaused)}>
          {showPaused ? 'Hide paused' : 'Show paused'}
        </button>
        <button className="btn primary" onClick={() => setAdding(true)}>
          + New
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {note && <div className="card small">{note}</div>}

      {due.length > 0 && (
        <div className="card">
          <div className="card-head">
            <h2>Due now</h2>
            <div className="spacer" />
            <span className="pill">{due.reduce((s, d) => s + d.dates.length, 0)}</span>
          </div>
          <div className="stack">
            {due.map(({ rule, dates }) => (
              <div key={rule.id} className="duerow">
                <div className="row wrap">
                  <div style={{ flex: '1 1 200px' }}>
                    <strong>{rule.name}</strong>
                    <span className="sub">
                      {dates.length > 1
                        ? `${dates.length} occurrences owed, ${fmtDate(dates[0])} to ${fmtDate(dates[dates.length - 1])}`
                        : `Due ${fmtDate(dates[0])}`}{' '}
                      · {detail(rule)}
                    </span>
                  </div>
                  <strong className="num">{fmtMoney(rule.amount * dates.length)}</strong>
                  <button className="btn small" onClick={() => void skipOne(rule, dates[0])} disabled={busyId === rule.id}>
                    Skip one
                  </button>
                  <button
                    className="btn small primary"
                    onClick={() => void post(rule, dates)}
                    disabled={busyId === rule.id}
                  >
                    {busyId === rule.id ? 'Posting…' : dates.length > 1 ? `Post all ${dates.length}` : 'Post'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h2>All series</h2>
        </div>
        {visible.length === 0 ? (
          <Empty>
            Nothing recurring yet. Add subscriptions, annual renewals or a regular transfer and they'll queue up here
            each period.
          </Empty>
        ) : (
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>How often</th>
                  <th>Next</th>
                  <th className="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => (
                  <tr key={r.id} className="click" onClick={() => setEditing(r)}>
                    <td>
                      {r.name} {r.archived && <span className="pill">paused</span>}
                      {r.auto_post && !r.archived && <span className="pill">auto</span>}
                      <span className="sub">{detail(r)}</span>
                    </td>
                    <td>{FREQUENCY_LABEL[r.frequency]}</td>
                    <td>{r.archived ? '—' : isFinished(r) ? 'finished' : fmtDate(r.next_date)}</td>
                    <td className={`num ${r.kind === 'income' ? 'pos' : ''}`}>
                      {r.kind === 'income' ? '+' : r.kind === 'expense' ? '−' : ''}
                      {fmtMoney(r.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {adding && <RecurringForm onClose={() => setAdding(false)} />}
      {editing && <RecurringForm initial={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
