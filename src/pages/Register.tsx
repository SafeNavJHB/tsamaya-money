// The fixed asset / depreciation register (IFRS for SMEs Section 17).
import { useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useData } from '../data/DataContext';
import { Empty, Field, Modal } from '../components/ui';
import { fmtDate, fmtMoney, parseAmount, todayStr } from '../lib/format';
import { balanceAt, buildBook } from '../logic/ledger';
import { financialYearFor } from '../logic/statements';
import { METHOD_LABEL, canDepreciate, dueDepreciation, register } from '../logic/depreciation';
import { exportCsv } from '../export/csv';
import { exportXlsx } from '../export/xlsx';
import { exportPdf } from '../export/pdf';
import { stamp } from '../export/download';
import type { Asset, Disposal } from '../types';

function DisposalForm({
  asset, carrying, existing, onClose,
}: { asset: Asset; carrying: number; existing?: Disposal | null; onClose: () => void }) {
  const { accounts, refresh } = useData();
  const live = accounts.filter((a) => !a.archived);
  const [date, setDate] = useState(existing?.disposal_date ?? todayStr());
  const [proceeds, setProceeds] = useState(existing ? String(existing.proceeds) : '');
  const [account, setAccount] = useState(existing?.proceeds_account_id ?? live[0]?.id ?? '');
  const [received, setReceived] = useState(existing ? existing.proceeds_account_id !== null : true);
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const p = parseAmount(proceeds || '0') ?? 0;
  const result = Math.round((p - carrying) * 100) / 100;

  async function save() {
    if (p < 0) return setError('Proceeds cannot be negative.');
    if (received && !account) return setError('Choose where the proceeds went.');
    setBusy(true);
    setError(null);
    const row = {
      asset_id: asset.id,
      disposal_date: date,
      proceeds: p,
      proceeds_account_id: received ? account : null,
      notes: notes.trim() || null,
    };
    const q = existing
      ? supabase.from('fin_disposals').update(row).eq('id', existing.id)
      : supabase.from('fin_disposals').insert(row);
    const { error: err } = await q;
    setBusy(false);
    if (err) return setError(err.message);
    await refresh();
    onClose();
  }

  async function remove() {
    if (!existing || !window.confirm('Reverse this disposal? The asset comes back onto the books.')) return;
    setBusy(true);
    const { error: err } = await supabase.from('fin_disposals').delete().eq('id', existing.id);
    setBusy(false);
    if (err) return setError(err.message);
    await refresh();
    onClose();
  }

  return (
    <Modal title={`Dispose of ${asset.name}`} onClose={onClose}>
      {error && <div className="error-banner">{error}</div>}
      <p className="small muted">
        Carrying amount at disposal {fmtMoney(carrying)}. The cost and accumulated depreciation are removed and the
        difference against the proceeds goes to profit or loss. Depreciation stops from this date.
      </p>
      <Field label="Date of disposal">
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </Field>
      <Field label="Proceeds (R)">
        <input inputMode="decimal" value={proceeds} onChange={(e) => setProceeds(e.target.value)} placeholder="0.00 if scrapped" />
      </Field>
      <label className="row small" style={{ marginBottom: 10, cursor: 'pointer' }}>
        <input type="checkbox" style={{ width: 'auto' }} checked={received} onChange={(e) => setReceived(e.target.checked)} />
        Proceeds received
      </label>
      {received ? (
        <Field label="Received into">
          <select value={account} onChange={(e) => setAccount(e.target.value)}>
            {live.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </Field>
      ) : (
        <p className="small muted">Not received — the amount is carried as a receivable until it is.</p>
      )}
      <Field label="Notes (optional)">
        <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Sold to a colleague" />
      </Field>
      <p className="small">
        {p === 0 && carrying === 0
          ? 'No gain or loss.'
          : result >= 0
            ? `This will recognise a gain of ${fmtMoney(result)}.`
            : `This will recognise a loss of ${fmtMoney(-result)}.`}
      </p>
      <div className="row" style={{ marginTop: 10 }}>
        {existing && (
          <button className="btn danger" onClick={remove} disabled={busy}>
            Reverse
          </button>
        )}
        <div className="spacer" />
        <button className="btn" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button className="btn primary" onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Record disposal'}
        </button>
      </div>
    </Modal>
  );
}

export function DepreciationRegister() {
  const data = useData();
  const { refresh, settings } = data;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [upTo, setUpTo] = useState(todayStr());

  const book = useMemo(() => buildBook(data), [data]);
  const fy = useMemo(() => financialYearFor(upTo, settings.fy_end_month), [upTo, settings.fy_end_month]);
  const costAt = useMemo(
    () => (assetId: string, date: string) => balanceAt(book, `ast:${assetId}`, date),
    [book],
  );
  const disposedOn = useMemo(
    () => (assetId: string) => data.disposals.find((d) => d.asset_id === assetId)?.disposal_date ?? null,
    [data.disposals],
  );
  const rows = useMemo(
    () => register(data.assets, data.depreciation, costAt, upTo, fy.from, disposedOn),
    [data.assets, data.depreciation, costAt, upTo, fy.from, disposedOn],
  );
  const [disposing, setDisposing] = useState<{ asset: Asset; carrying: number } | null>(null);

  const owed = useMemo(
    () =>
      data.assets
        .filter(canDepreciate)
        .map((a) => ({ asset: a, due: dueDepreciation(a, data.depreciation, costAt, upTo, disposedOn(a.id)) }))
        .filter((d) => d.due.length > 0),
    [data.assets, data.depreciation, costAt, upTo, disposedOn],
  );
  const owedTotal = owed.reduce((s, o) => s + o.due.reduce((t, d) => t + d.amount, 0), 0);

  async function runDepreciation() {
    setBusy(true);
    setError(null);
    setNote(null);
    let posted = 0;
    let skipped = 0;
    for (const { asset, due } of owed) {
      const payload = due.map((d) => ({
        asset_id: asset.id,
        period_end: d.periodEnd,
        amount: d.amount,
        method: asset.depr_method!,
        basis: d.basis,
      }));
      const { error: err } = await supabase.from('fin_depreciation').insert(payload);
      if (err) {
        // 23505 = a period was already charged (another device, or a double
        // click). Not an error: the register is idempotent by design.
        if (err.code === '23505') skipped += payload.length;
        else {
          setBusy(false);
          await refresh();
          return setError(err.message);
        }
      } else {
        posted += payload.length;
      }
    }
    setBusy(false);
    setNote(
      `Posted ${posted} monthly charge${posted === 1 ? '' : 's'}` +
        (skipped ? `; ${skipped} were already on file` : '') +
        '.',
    );
    await refresh();
  }

  const totals = rows.reduce(
    (t, r) => ({
      cost: t.cost + r.cost,
      acc: t.acc + r.accumulated,
      carry: t.carry + r.carrying,
      year: t.year + r.chargeThisYear,
    }),
    { cost: 0, acc: 0, carry: 0, year: 0 },
  );

  const exportRows = rows.map((r) => [
    r.asset.name,
    r.asset.asset_class ?? '',
    canDepreciate(r.asset) ? METHOD_LABEL[r.asset.depr_method ?? ''] ?? '' : 'Not depreciated',
    r.asset.depr_method === 'reducing_balance' ? `${r.asset.depr_rate_pct}% pa` : r.asset.useful_life_months ? `${r.asset.useful_life_months} months` : '',
    r.asset.depr_start ?? '',
    r.cost,
    r.asset.residual_value ?? 0,
    r.chargeThisYear,
    r.accumulated,
    r.carrying,
  ]);
  const headers = ['Asset', 'Class', 'Method', 'Rate / life', 'Start', 'Cost', 'Residual', 'Charge this year', 'Accumulated', 'Carrying amount'];

  return (
    <div className="stack">
      <div className="row wrap">
        <h1>Depreciation register</h1>
        <div className="spacer" />
        <input type="date" style={{ width: 'auto' }} value={upTo} onChange={(e) => setUpTo(e.target.value)} />
      </div>
      <p className="small muted">
        {settings.entity_name} · as at {fmtDate(upTo)} · charges shown for the year from {fmtDate(fy.from)}. Depreciation
        is posted monthly, and once posted it stays put: revising a useful life or residual value changes future
        charges only, which is how a change in accounting estimate must be treated.
      </p>

      {error && <div className="error-banner">{error}</div>}
      {note && <div className="card small">{note}</div>}

      {owed.length > 0 && (
        <div className="card">
          <div className="card-head">
            <h2>Depreciation due</h2>
            <div className="spacer" />
            <span className="pill">{owed.reduce((s, o) => s + o.due.length, 0)} periods</span>
          </div>
          <div className="stack">
            {owed.map(({ asset, due }) => (
              <div className="duerow" key={asset.id}>
                <div className="row wrap">
                  <div style={{ flex: '1 1 220px' }}>
                    <strong>{asset.name}</strong>
                    <span className="sub">
                      {due.length} month{due.length === 1 ? '' : 's'} unposted, {fmtDate(due[0].periodEnd)} to{' '}
                      {fmtDate(due[due.length - 1].periodEnd)}
                    </span>
                  </div>
                  <strong className="num">{fmtMoney(due.reduce((s, d) => s + d.amount, 0))}</strong>
                </div>
              </div>
            ))}
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <span className="small muted">Total {fmtMoney(owedTotal)}</span>
            <div className="spacer" />
            <button className="btn primary" onClick={runDepreciation} disabled={busy}>
              {busy ? 'Posting…' : 'Post depreciation'}
            </button>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h2>Register</h2>
        </div>
        {rows.length === 0 ? (
          <Empty>
            No assets yet. Add one under Assets, then record its purchase as an expense tagged to that asset so it is
            capitalised rather than written off.
          </Empty>
        ) : (
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Asset</th>
                  <th>Method</th>
                  <th className="num">Cost</th>
                  <th className="num">Charge this year</th>
                  <th className="num">Accumulated</th>
                  <th className="num">Carrying amount</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.asset.id}>
                    <td>
                      {r.asset.name}
                      <span className="sub">
                        {r.asset.asset_class ? `${r.asset.asset_class} · ` : ''}
                        {canDepreciate(r.asset)
                          ? `from ${fmtDate(r.asset.depr_start!)}`
                          : 'depreciation not set up'}
                        {r.fullyDepreciated ? ' · fully depreciated' : ''}
                      </span>
                    </td>
                    <td className="small">
                      {canDepreciate(r.asset) ? (
                        <>
                          {METHOD_LABEL[r.asset.depr_method ?? '']}
                          <span className="sub">
                            {r.asset.depr_method === 'reducing_balance'
                              ? `${r.asset.depr_rate_pct}% per year`
                              : `${r.asset.useful_life_months} months`}
                          </span>
                        </>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="num">{fmtMoney(r.cost)}</td>
                    <td className="num">{fmtMoney(r.chargeThisYear)}</td>
                    <td className="num">{fmtMoney(r.accumulated)}</td>
                    <td className="num">{fmtMoney(r.carrying)}</td>
                    <td className="num">
                      {r.disposedOn ? (
                        <button
                          className="btn small"
                          onClick={() => setDisposing({ asset: r.asset, carrying: r.carrying })}
                        >
                          Disposed {fmtDate(r.disposedOn)}
                        </button>
                      ) : (
                        <button
                          className="btn small"
                          onClick={() => setDisposing({ asset: r.asset, carrying: r.carrying })}
                        >
                          Dispose
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                <tr className="total">
                  <td colSpan={2}>Totals</td>
                  <td className="num">{fmtMoney(totals.cost)}</td>
                  <td className="num">{fmtMoney(totals.year)}</td>
                  <td className="num">{fmtMoney(totals.acc)}</td>
                  <td className="num">{fmtMoney(totals.carry)}</td>
                  <td></td>
                </tr>
              </tbody>
            </table>
          </div>
        )}

        {rows.length > 0 && (
          <div className="row wrap" style={{ marginTop: 12 }}>
            <span className="small muted">Export:</span>
            <button className="btn small" onClick={() => exportCsv(`depreciation-register-${stamp()}.csv`, headers, exportRows)}>
              CSV
            </button>
            <button
              className="btn small"
              onClick={() =>
                void exportXlsx(`depreciation-register-${stamp()}.xlsx`, [
                  { name: 'Register', headers, rows: exportRows, moneyCols: [5, 6, 7, 8, 9] },
                ])
              }
            >
              Excel
            </button>
            <button
              className="btn small"
              onClick={() =>
                void exportPdf(
                  `depreciation-register-${stamp()}.pdf`,
                  'Depreciation register',
                  `${settings.entity_name} · as at ${fmtDate(upTo)}`,
                  [{ headers, rows: exportRows, moneyCols: [5, 6, 7, 8, 9] }],
                )
              }
            >
              PDF
            </button>
          </div>
        )}
      </div>

      {disposing && (
        <DisposalForm
          asset={disposing.asset}
          carrying={disposing.carrying}
          existing={data.disposals.find((d) => d.asset_id === disposing.asset.id) ?? null}
          onClose={() => setDisposing(null)}
        />
      )}

      {data.depreciation.length > 0 && (
        <div className="card">
          <div className="card-head">
            <h2>Posted charges</h2>
            <div className="spacer" />
            <span className="small muted">{data.depreciation.length} monthly entries</span>
          </div>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Period</th>
                  <th>Asset</th>
                  <th className="num">Charge</th>
                </tr>
              </thead>
              <tbody>
                {data.depreciation
                  .slice()
                  .sort((a, b) => b.period_end.localeCompare(a.period_end))
                  .slice(0, 24)
                  .map((d) => (
                    <tr key={d.id}>
                      <td>{fmtDate(d.period_end)}</td>
                      <td>{data.assets.find((a) => a.id === d.asset_id)?.name ?? '—'}</td>
                      <td className="num">{fmtMoney(d.amount)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

export function assetDepreciationSummary(a: Asset): string {
  if (!canDepreciate(a)) return 'No depreciation';
  return a.depr_method === 'reducing_balance'
    ? `Reducing balance ${a.depr_rate_pct}% pa`
    : `Straight line ${a.useful_life_months} months`;
}
