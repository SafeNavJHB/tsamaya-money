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
  const [bsLine, setBsLine] = useState(initial?.bs_line ?? '');
  const [isCurrent, setIsCurrent] = useState(initial?.is_current ?? false);
  const [assetClass, setAssetClass] = useState(initial?.asset_class ?? '');
  const [depreciate, setDepreciate] = useState(initial?.depreciate ?? false);
  const [deprMethod, setDeprMethod] = useState<'straight_line' | 'reducing_balance'>(
    initial?.depr_method ?? 'straight_line',
  );
  const [usefulLife, setUsefulLife] = useState(initial?.useful_life_months ? String(initial.useful_life_months) : '36');
  const [deprRate, setDeprRate] = useState(initial?.depr_rate_pct ? String(initial.depr_rate_pct) : '');
  const [residual, setResidual] = useState(initial?.residual_value ? String(initial.residual_value) : '0');
  const [deprStart, setDeprStart] = useState(initial?.depr_start ?? todayStr());
  const [valDate, setValDate] = useState(todayStr());
  const [valAmount, setValAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const history = initial
    ? valuations.filter((v) => v.asset_id === initial.id).slice().sort((a, b) => b.val_date.localeCompare(a.val_date))
    : [];

  async function save() {
    if (!name.trim()) return setError('Give it a name.');
    if (depreciate && side !== 'asset') return setError('Only assets are depreciated.');
    const res = parseAmount(residual || '0');
    if (res == null || res < 0) return setError('Residual value must be zero or more.');
    if (depreciate && deprMethod === 'straight_line' && (!Number(usefulLife) || Number(usefulLife) <= 0))
      return setError('Enter a useful life in months.');
    if (depreciate && deprMethod === 'reducing_balance' && (!Number(deprRate) || Number(deprRate) <= 0))
      return setError('Enter an annual depreciation rate.');
    setBusy(true);
    const row = {
      name: name.trim(),
      side,
      category,
      notes: notes.trim() || null,
      archived,
      bs_line: bsLine.trim() || null,
      is_current: isCurrent,
      asset_class: assetClass.trim() || null,
      depreciate: side === 'asset' ? depreciate : false,
      depr_method: depreciate ? deprMethod : null,
      useful_life_months: depreciate && deprMethod === 'straight_line' ? Number(usefulLife) : null,
      depr_rate_pct: depreciate && deprMethod === 'reducing_balance' ? Number(deprRate) : null,
      residual_value: res,
      depr_start: depreciate ? deprStart : null,
    };
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

      <h3 style={{ margin: '14px 0 8px' }}>Financial statement presentation</h3>
      <Field label="Balance sheet caption">
        <input value={bsLine} onChange={(e) => setBsLine(e.target.value)} placeholder="e.g. Property, plant and equipment" />
      </Field>
      <Field label="Classification">
        <select value={isCurrent ? 'current' : 'non'} onChange={(e) => setIsCurrent(e.target.value === 'current')}>
          <option value="non">Non-current</option>
          <option value="current">Current</option>
        </select>
      </Field>

      {side === 'asset' && (
        <>
          <h3 style={{ margin: '14px 0 8px' }}>Depreciation</h3>
          <label className="row small" style={{ marginBottom: 10, cursor: 'pointer' }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={depreciate} onChange={(e) => setDepreciate(e.target.checked)} />
            Depreciate this asset
          </label>
          {depreciate && (
            <>
              <Field label="Asset class">
                <input value={assetClass} onChange={(e) => setAssetClass(e.target.value)} placeholder="e.g. Computer equipment" />
              </Field>
              <Field label="Method">
                <select value={deprMethod} onChange={(e) => setDeprMethod(e.target.value as typeof deprMethod)}>
                  <option value="straight_line">Straight line</option>
                  <option value="reducing_balance">Reducing balance</option>
                </select>
              </Field>
              {deprMethod === 'straight_line' ? (
                <Field label="Useful life (months)">
                  <input inputMode="numeric" value={usefulLife} onChange={(e) => setUsefulLife(e.target.value)} />
                </Field>
              ) : (
                <Field label="Rate (% per year)">
                  <input inputMode="decimal" value={deprRate} onChange={(e) => setDeprRate(e.target.value)} placeholder="e.g. 33.3" />
                </Field>
              )}
              <Field label="Residual value (R)">
                <input inputMode="decimal" value={residual} onChange={(e) => setResidual(e.target.value)} />
              </Field>
              <Field label="Available for use from">
                <input type="date" value={deprStart} onChange={(e) => setDeprStart(e.target.value)} />
              </Field>
              <p className="small muted" style={{ marginTop: -6 }}>
                Depreciation starts when the asset is available for use, not necessarily when it was bought, and is
                charged monthly. Cost comes from expenses you tag to this asset, so record the purchase that way to
                capitalise it.
              </p>
            </>
          )}
        </>
      )}

      <h3 style={{ margin: '14px 0 8px' }}>{initial ? 'Add / update valuation' : 'Current value (optional)'}</h3>
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
