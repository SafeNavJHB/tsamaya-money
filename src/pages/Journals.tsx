// Manual journal entries — the escape hatch that makes accruals, provisions,
// prepayment releases, reclassifications, corrections and opening balances
// possible without a bespoke table for each.
import { useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useData } from '../data/DataContext';
import { Empty, Field, Modal } from '../components/ui';
import { fmtDate, fmtMoney, parseAmount, todayStr } from '../lib/format';
import { buildBook } from '../logic/ledger';
import { round2 } from '../logic/compute';
import type { Journal } from '../types';

interface DraftLine {
  accountKey: string;
  debit: string;
  credit: string;
  note: string;
}

const emptyLine = (): DraftLine => ({ accountKey: '', debit: '', credit: '', note: '' });

function JournalForm({ initial, onClose }: { initial?: Journal | null; onClose: () => void }) {
  const data = useData();
  const { refresh } = data;
  const book = useMemo(() => buildBook(data), [data]);

  // Only accounts a human should post to: everything in the chart, ordered by
  // type, with the synthetic ones included because reclassifying to them is
  // exactly what a journal is for.
  const options = useMemo(() => {
    const order: Record<string, number> = { asset: 0, liability: 1, equity: 2, income: 3, expense: 4 };
    return [...book.accounts.values()]
      .filter((a) => !a.name.startsWith('Unrecognised'))
      .sort((a, b) => (order[a.type] ?? 9) - (order[b.type] ?? 9) || a.name.localeCompare(b.name));
  }, [book]);

  const [entryDate, setEntryDate] = useState(initial?.entry_date ?? todayStr());
  const [reference, setReference] = useState(initial?.reference ?? '');
  const [narration, setNarration] = useState(initial?.narration ?? '');
  const [lines, setLines] = useState<DraftLine[]>(
    initial
      ? initial.lines.map((l) => ({
          accountKey: l.account_key,
          debit: l.debit ? String(l.debit) : '',
          credit: l.credit ? String(l.credit) : '',
          note: l.line_note ?? '',
        }))
      : [emptyLine(), emptyLine()],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsed = lines.map((l) => ({
    accountKey: l.accountKey,
    debit: round2(parseAmount(l.debit) ?? 0),
    credit: round2(parseAmount(l.credit) ?? 0),
    note: l.note.trim() || null,
  }));
  const totalDr = round2(parsed.reduce((s, l) => s + l.debit, 0));
  const totalCr = round2(parsed.reduce((s, l) => s + l.credit, 0));
  const balanced = Math.abs(totalDr - totalCr) < 0.005 && totalDr > 0;

  const setLine = (i: number, patch: Partial<DraftLine>) =>
    setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  async function save() {
    if (!narration.trim()) return setError('Describe what this entry is for.');
    const usable = parsed.filter((l) => l.accountKey && (l.debit > 0 || l.credit > 0));
    if (usable.length < 2) return setError('A journal needs at least two lines.');
    if (usable.some((l) => l.debit > 0 && l.credit > 0))
      return setError('Each line is either a debit or a credit, not both.');
    if (!balanced) return setError(`Debits (${fmtMoney(totalDr)}) must equal credits (${fmtMoney(totalCr)}).`);

    setBusy(true);
    setError(null);
    let journalId = initial?.id;
    if (initial) {
      const { error: hErr } = await supabase
        .from('fin_journals')
        .update({ entry_date: entryDate, reference: reference.trim() || null, narration: narration.trim() })
        .eq('id', initial.id);
      if (hErr) {
        setBusy(false);
        return setError(hErr.message);
      }
      // Replace the lines wholesale; the deferred balance trigger checks the
      // final state at commit, so an intermediate unbalanced moment is fine.
      await supabase.from('fin_journal_lines').delete().eq('journal_id', initial.id);
    } else {
      const { data: created, error: hErr } = await supabase
        .from('fin_journals')
        .insert({ entry_date: entryDate, reference: reference.trim() || null, narration: narration.trim() })
        .select('id')
        .single();
      if (hErr || !created) {
        setBusy(false);
        return setError(hErr?.message ?? 'Could not create the entry.');
      }
      journalId = (created as { id: string }).id;
    }

    const { error: lErr } = await supabase.from('fin_journal_lines').insert(
      usable.map((l) => ({
        journal_id: journalId,
        account_key: l.accountKey,
        debit: l.debit,
        credit: l.credit,
        line_note: l.note,
      })),
    );
    setBusy(false);
    if (lErr) return setError(lErr.message);
    await refresh();
    onClose();
  }

  async function remove() {
    if (!initial || !window.confirm('Delete this journal entry?')) return;
    setBusy(true);
    const { error: err } = await supabase.from('fin_journals').delete().eq('id', initial.id);
    setBusy(false);
    if (err) return setError(err.message);
    await refresh();
    onClose();
  }

  return (
    <Modal title={initial ? 'Edit journal entry' : 'New journal entry'} onClose={onClose}>
      {error && <div className="error-banner">{error}</div>}
      <Field label="Date">
        <input type="date" value={entryDate} onChange={(e) => setEntryDate(e.target.value)} />
      </Field>
      <Field label="Reference (optional)">
        <input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="e.g. JNL-001" />
      </Field>
      <Field label="Narration">
        <input
          value={narration}
          onChange={(e) => setNarration(e.target.value)}
          placeholder="e.g. Accrue audit fee for the year"
        />
      </Field>

      <h3 style={{ margin: '14px 0 8px' }}>Lines</h3>
      {lines.map((l, i) => (
        <div key={i} className="jline">
          <select value={l.accountKey} onChange={(e) => setLine(i, { accountKey: e.target.value })}>
            <option value="">Choose an account…</option>
            {options.map((o) => (
              <option key={o.key} value={o.key}>
                {o.name} ({o.type})
              </option>
            ))}
          </select>
          <div className="row" style={{ gap: 6, marginTop: 6 }}>
            <input
              inputMode="decimal"
              placeholder="Debit"
              value={l.debit}
              onChange={(e) => setLine(i, { debit: e.target.value, credit: e.target.value ? '' : l.credit })}
            />
            <input
              inputMode="decimal"
              placeholder="Credit"
              value={l.credit}
              onChange={(e) => setLine(i, { credit: e.target.value, debit: e.target.value ? '' : l.debit })}
            />
            {lines.length > 2 && (
              <button className="btn small danger" onClick={() => setLines((ls) => ls.filter((_, x) => x !== i))}>
                ✕
              </button>
            )}
          </div>
        </div>
      ))}
      <button className="btn small" onClick={() => setLines((ls) => [...ls, emptyLine()])}>
        + Add line
      </button>

      <div className="row" style={{ marginTop: 12 }}>
        <span className={`pill ${balanced ? 'badge-ok' : 'badge-bad'}`}>
          {balanced ? `Balanced — ${fmtMoney(totalDr)}` : `Dr ${fmtMoney(totalDr)} · Cr ${fmtMoney(totalCr)}`}
        </span>
      </div>

      <div className="row" style={{ marginTop: 12 }}>
        {initial && (
          <button className="btn danger" onClick={remove} disabled={busy}>
            Delete
          </button>
        )}
        <div className="spacer" />
        <button className="btn" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button className="btn primary" onClick={save} disabled={busy || !balanced}>
          {busy ? 'Saving…' : 'Post entry'}
        </button>
      </div>
    </Modal>
  );
}

export function Journals() {
  const data = useData();
  const book = useMemo(() => buildBook(data), [data]);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Journal | null>(null);

  const nameOf = (key: string) => book.accounts.get(key)?.name ?? key;

  return (
    <div className="stack">
      <div className="row">
        <h1>Journal entries</h1>
        <div className="spacer" />
        <button className="btn primary" onClick={() => setAdding(true)}>
          + New entry
        </button>
      </div>
      <p className="small muted">
        Any balanced debit and credit against any account in the chart. This is how you raise accruals and
        provisions, release a prepayment, reclassify a balance, correct a misposting, or bring in opening balances
        from another system. Every entry flows straight into the trial balance, the ledger and the statements.
      </p>

      {data.journals.length === 0 ? (
        <Empty>No journal entries yet.</Empty>
      ) : (
        data.journals
          .slice()
          .sort((a, b) => b.entry_date.localeCompare(a.entry_date))
          .map((j) => {
            const dr = round2(j.lines.reduce((s, l) => s + l.debit, 0));
            return (
              <div className="card" key={j.id}>
                <div className="card-head">
                  <h2>{j.narration}</h2>
                  <div className="spacer" />
                  <span className="small muted">
                    {j.reference ? `${j.reference} · ` : ''}
                    {fmtDate(j.entry_date)}
                  </span>
                  <button className="btn small" onClick={() => setEditing(j)}>
                    Edit
                  </button>
                </div>
                <div className="tablewrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Account</th>
                        <th className="num">Debit</th>
                        <th className="num">Credit</th>
                      </tr>
                    </thead>
                    <tbody>
                      {j.lines.map((l) => (
                        <tr key={l.id}>
                          <td>
                            {nameOf(l.account_key)}
                            {l.line_note && <span className="sub">{l.line_note}</span>}
                          </td>
                          <td className="num">{l.debit ? fmtMoney(l.debit) : ''}</td>
                          <td className="num">{l.credit ? fmtMoney(l.credit) : ''}</td>
                        </tr>
                      ))}
                      <tr className="total">
                        <td></td>
                        <td className="num">{fmtMoney(dr)}</td>
                        <td className="num">{fmtMoney(dr)}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })
      )}

      {adding && <JournalForm onClose={() => setAdding(false)} />}
      {editing && <JournalForm initial={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
