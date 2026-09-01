// The fixed asset / depreciation register (IFRS for SMEs Section 17).
import { useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useData } from '../data/DataContext';
import { Empty } from '../components/ui';
import { fmtDate, fmtMoney, todayStr } from '../lib/format';
import { balanceAt, buildBook } from '../logic/ledger';
import { financialYearFor } from '../logic/statements';
import { METHOD_LABEL, canDepreciate, dueDepreciation, register } from '../logic/depreciation';
import { exportCsv } from '../export/csv';
import { exportXlsx } from '../export/xlsx';
import { exportPdf } from '../export/pdf';
import { stamp } from '../export/download';
import type { Asset } from '../types';

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
  const rows = useMemo(
    () => register(data.assets, data.depreciation, costAt, upTo, fy.from),
    [data.assets, data.depreciation, costAt, upTo, fy.from],
  );

  const owed = useMemo(
    () =>
      data.assets
        .filter(canDepreciate)
        .map((a) => ({ asset: a, due: dueDepreciation(a, data.depreciation, costAt, upTo) }))
        .filter((d) => d.due.length > 0),
    [data.assets, data.depreciation, costAt, upTo],
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
                  </tr>
                ))}
                <tr className="total">
                  <td colSpan={2}>Totals</td>
                  <td className="num">{fmtMoney(totals.cost)}</td>
                  <td className="num">{fmtMoney(totals.year)}</td>
                  <td className="num">{fmtMoney(totals.acc)}</td>
                  <td className="num">{fmtMoney(totals.carry)}</td>
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
