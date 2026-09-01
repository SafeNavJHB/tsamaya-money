import { useState } from 'react';
import { supabase } from '../lib/supabase';
import { useData } from '../data/DataContext';
import { Empty, Field, Modal, Seg } from '../components/ui';
import { fmtDate, fmtMoney, parseAmount, todayStr } from '../lib/format';
import { latestValuation } from '../logic/compute';
import type { Asset, AssetCategory, AssetSide } from '../types';

const ASSET_CATS: { value: AssetCategory; label: string; side: AssetSide }[] = [
  { value: 'vehicle', label: 'Vehicle', side: 'asset' },
  { value: 'property', label: 'Property', side: 'asset' },
  { value: 'investment', label: 'Investment', side: 'asset' },
  { value: 'retirement', label: 'Retirement fund', side: 'asset' },
  { value: 'other', label: 'Other', side: 'asset' },
  { value: 'loan', label: 'Loan', side: 'liability' },
  { value: 'credit', label: 'Credit / store account', side: 'liability' },
  { value: 'tax', label: 'Tax owed', side: 'liability' },
];

function AssetForm({ initial, onClose }: { initial?: Asset | null; onClose: () => void }) {
  const { refresh, valuations } = useData();
  const [name, setName] = useState(initial?.name ?? '');
  const [side, setSide] = useState<AssetSide>(initial?.side ?? 'asset');
  const [category, setCategory] = useState<AssetCategory>(initial?.category ?? 'other');
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [archived, setArchived] = useState(initial?.archived ?? false);
  const [valDate, setValDate] = useState(todayStr());
  const [valAmount, setValAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const history = initial
    ? valuations.filter((v) => v.asset_id === initial.id).slice().sort((a, b) => b.val_date.localeCompare(a.val_date))
    : [];

  async function save() {
    if (!name.trim()) return setError('Give it a name.');
    setBusy(true);
    const row = { name: name.trim(), side, category, notes: notes.trim() || null, archived };
    let err = null;
    let assetId = initial?.id;
    if (initial) {
      ({ error: err } = await supabase.from('fin_assets').update(row).eq('id', initial.id));
    } else {
      const res = await supabase.from('fin_assets').insert(row).select('id').single();
      err = res.error;
      assetId = (res.data as { id: string } | null)?.id;
    }
    if (!err && !initial && valAmount.trim() && assetId) {
      const v = parseAmount(valAmount);
      if (v != null && v >= 0) {
        ({ error: err } = await supabase.from('fin_valuations').insert({ asset_id: assetId, val_date: valDate, value: v }));
      }
    }
    setBusy(false);
    if (err) return setError(err.message);
    await refresh();
    onClose();
  }

  async function addValuation() {
    if (!initial) return;
    const v = parseAmount(valAmount);
    if (v == null || v < 0) return setError('Valuation must be a positive amount.');
    setBusy(true);
    const { error: err } = await supabase
      .from('fin_valuations')
      .upsert({ asset_id: initial.id, val_date: valDate, value: v }, { onConflict: 'asset_id,val_date' });
    setBusy(false);
    if (err) return setError(err.message);
    setValAmount('');
    await refresh();
  }

  async function deleteValuation(id: string) {
    setBusy(true);
    await supabase.from('fin_valuations').delete().eq('id', id);
    setBusy(false);
    await refresh();
  }

  async function remove() {
    if (!initial) return;
    if (!window.confirm(`Delete "${initial.name}" and its valuation history?`)) return;
    setBusy(true);
    const { error: err } = await supabase.from('fin_assets').delete().eq('id', initial.id);
    setBusy(false);
    if (err) return setError(err.message);
    await refresh();
    onClose();
  }

  return (
    <Modal title={initial ? `Edit ${initial.side}` : 'New asset / liability'} onClose={onClose}>
      {error && <div className="error-banner">{error}</div>}
      <div className="field">
        <Seg
          options={[
            { value: 'asset', label: 'Asset' },
            { value: 'liability', label: 'Liability' },
          ]}
          value={side}
          onChange={(s) => {
            setSide(s);
            const first = ASSET_CATS.find((c) => c.side === s);
            if (first) setCategory(first.value);
          }}
        />
      </div>
      <Field label="Name">
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus={!initial} placeholder={side === 'asset' ? 'e.g. MX-5' : 'e.g. Car finance'} />
      </Field>
      <Field label="Category">
        <select value={category} onChange={(e) => setCategory(e.target.value as AssetCategory)}>
          {ASSET_CATS.filter((c) => c.side === side).map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Notes (optional)">
        <input value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      {initial && (
        <label className="row small" style={{ marginBottom: 12, cursor: 'pointer' }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={archived} onChange={(e) => setArchived(e.target.checked)} />
          Archived (excluded from net worth)
        </label>
      )}

      <h3 style={{ margin: '10px 0 8px' }}>{initial ? 'Add / update valuation' : 'Current value (optional)'}</h3>
      <div className="row">
        <input type="date" value={valDate} onChange={(e) => setValDate(e.target.value)} style={{ width: 'auto' }} />
        <input
          inputMode="decimal"
          placeholder="R value"
          value={valAmount}
          onChange={(e) => setValAmount(e.target.value)}
        />
        {initial && (
          <button className="btn" onClick={addValuation} disabled={busy}>
            Add
          </button>
        )}
      </div>

      {initial && history.length > 0 && (
        <div className="tablewrap" style={{ marginTop: 10 }}>
          <table>
            <tbody>
              {history.map((v) => (
                <tr key={v.id}>
                  <td>{fmtDate(v.val_date)}</td>
                  <td className="num">{fmtMoney(v.value)}</td>
                  <td className="num">
                    <button className="btn small danger" onClick={() => void deleteValuation(v.id)} disabled={busy}>
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="row" style={{ marginTop: 14 }}>
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

export function Assets() {
  const { assets, valuations } = useData();
  const [editing, setEditing] = useState<Asset | null>(null);
  const [adding, setAdding] = useState(false);

  const section = (side: AssetSide, title: string) => {
    const rows = assets.filter((a) => a.side === side && !a.archived);
    return (
      <div className="card">
        <div className="card-head">
          <h2>{title}</h2>
        </div>
        {rows.length === 0 ? (
          <Empty>None yet.</Empty>
        ) : (
          <div className="tablewrap">
            <table>
              <tbody>
                {rows.map((a) => {
                  const v = latestValuation(valuations, a.id);
                  return (
                    <tr key={a.id} className="click" onClick={() => setEditing(a)}>
                      <td>
                        {a.name}
                        <span className="sub">
                          {ASSET_CATS.find((c) => c.value === a.category)?.label}
                          {v ? ` · valued ${fmtDate(v.val_date)}` : ' · no valuation yet'}
                        </span>
                      </td>
                      <td className="num">{v ? fmtMoney(v.value) : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="stack">
      <div className="row">
        <h1>Assets & liabilities</h1>
        <div className="spacer" />
        <button className="btn primary" onClick={() => setAdding(true)}>
          + New
        </button>
      </div>
      <p className="small muted">
        What the company owns (equipment, prepaid deposits, IP) and owes (loans, SARS, credit). Don't list the
        accounts from the Accounts page here — their balances already count toward net worth, and the director loan
        is one of them.
      </p>
      {section('asset', 'Assets')}
      {section('liability', 'Liabilities')}
      {adding && <AssetForm onClose={() => setAdding(false)} />}
      {editing && <AssetForm initial={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
