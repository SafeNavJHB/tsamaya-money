// Hand-rolled SVG charts following the dataviz method: thin marks with
// rounded data-ends, hairline grid, recessive axes, hover tooltips, legends
// for multi-series, text in ink tokens (never series colors).
import { useState } from 'react';
import type { CashflowMonth } from '../logic/compute';
import { fmtMoney, fmtMoneyCompact, monthLabel, monthLabelShort } from '../lib/format';

interface Tip {
  xPct: number;
  yPct: number;
  lines: string[];
}

function TipBox({ tip }: { tip: Tip | null }) {
  if (!tip) return null;
  return (
    <div className="tip" style={{ left: `${tip.xPct}%`, top: `${tip.yPct}%` }}>
      {tip.lines.map((l, i) => (
        <div key={i}>{l}</div>
      ))}
    </div>
  );
}

function topRound(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.max(0, Math.min(r, w / 2, h));
  return `M${x},${y + h} L${x},${y + rr} Q${x},${y} ${x + rr},${y} L${x + w - rr},${y} Q${x + w},${y} ${x + w},${y + rr} L${x + w},${y + h} Z`;
}

function niceMax(v: number): number {
  if (v <= 0) return 100;
  const mag = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * mag) return m * mag;
  return 10 * mag;
}

/** Grouped income-vs-expense bars per month, with legend and hover tooltip. */
export function CashflowBars({ data }: { data: CashflowMonth[] }) {
  const [tip, setTip] = useState<Tip | null>(null);
  const W = 660;
  const H = 230;
  const padL = 46;
  const padR = 8;
  const padT = 12;
  const padB = 26;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const max = niceMax(Math.max(1, ...data.map((d) => Math.max(d.income, d.expense))));
  const slot = plotW / Math.max(1, data.length);
  const barW = Math.min(18, (slot - 8) / 2);
  const y = (v: number) => padT + plotH - (v / max) * plotH;
  const ticks = [0, max / 2, max];

  return (
    <div className="chart">
      <div className="legend" style={{ marginBottom: 8 }}>
        <span>
          <span className="sw" style={{ background: 'var(--income)' }} />
          Income
        </span>
        <span>
          <span className="sw" style={{ background: 'var(--expense)' }} />
          Expenses
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} onMouseLeave={() => setTip(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke="var(--grid)" strokeWidth={1} />
            <text x={padL - 6} y={y(t) + 4} textAnchor="end" fontSize={10} fill="var(--muted)">
              {fmtMoneyCompact(t)}
            </text>
          </g>
        ))}
        {data.map((d, i) => {
          const cx = padL + slot * i + slot / 2;
          const skip = data.length > 8 && i % 2 === 1;
          return (
            <g key={d.month}>
              <path d={topRound(cx - barW - 1, y(d.income), barW, plotH + padT - y(d.income), 4)} fill="var(--income)" />
              <path d={topRound(cx + 1, y(d.expense), barW, plotH + padT - y(d.expense), 4)} fill="var(--expense)" />
              {!skip && (
                <text x={cx} y={H - 8} textAnchor="middle" fontSize={10} fill="var(--muted)">
                  {monthLabelShort(d.month)}
                </text>
              )}
              <rect
                x={padL + slot * i}
                y={padT}
                width={slot}
                height={plotH}
                fill="transparent"
                onMouseEnter={() =>
                  setTip({
                    xPct: (cx / W) * 100,
                    yPct: (Math.min(y(d.income), y(d.expense)) / H) * 100,
                    lines: [
                      monthLabel(d.month),
                      `In ${fmtMoney(d.income)}`,
                      `Out ${fmtMoney(d.expense)}`,
                      `Net ${fmtMoney(d.net)}`,
                    ],
                  })
                }
              />
            </g>
          );
        })}
        <line x1={padL} x2={W - padR} y1={padT + plotH} y2={padT + plotH} stroke="var(--grid)" strokeWidth={1.5} />
      </svg>
      <TipBox tip={tip} />
    </div>
  );
}

/** Horizontal magnitude bars, single hue, direct-labeled (no tooltip needed). */
export function HBars({ rows }: { rows: { label: string; value: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  const rowH = 30;
  const W = 660;
  const labelW = 150;
  const valueW = 78;
  const H = rows.length * rowH;
  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`}>
        {rows.map((r, i) => {
          const barMax = W - labelW - valueW - 12;
          const w = Math.max(2, (r.value / max) * barMax);
          const cy = i * rowH + rowH / 2;
          return (
            <g key={r.label}>
              <text x={labelW - 8} y={cy + 4} textAnchor="end" fontSize={12} fill="var(--ink-2)">
                {r.label.length > 20 ? r.label.slice(0, 19) + '…' : r.label}
              </text>
              <rect x={labelW} y={cy - 7} width={w} height={14} rx={4} fill="var(--accent)" />
              <text x={labelW + w + 8} y={cy + 4} fontSize={12} fontWeight={600} fill="var(--ink)">
                {fmtMoneyCompact(r.value)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** Single-series line with crosshair hover — used for net worth over time. */
export function TrendLine({ points }: { points: { month: string; value: number }[] }) {
  const [tip, setTip] = useState<Tip | null>(null);
  const [hoverI, setHoverI] = useState<number | null>(null);
  const W = 660;
  const H = 200;
  const padL = 52;
  const padR = 12;
  const padT = 12;
  const padB = 24;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const vals = points.map((p) => p.value);
  let lo = Math.min(0, ...vals);
  let hi = Math.max(0, ...vals);
  if (hi === lo) hi = lo + 100;
  const span = hi - lo;
  lo -= span * 0.06;
  hi += span * 0.06;
  const x = (i: number) => padL + (points.length === 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const y = (v: number) => padT + plotH - ((v - lo) / (hi - lo)) * plotH;
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const zeroVisible = lo < 0 && hi > 0;

  return (
    <div className="chart">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        onMouseLeave={() => {
          setTip(null);
          setHoverI(null);
        }}
      >
        {[hi - span * 0.06, (hi + lo) / 2, lo + span * 0.06].map((t, i) => (
          <g key={i}>
            <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke="var(--grid)" strokeWidth={1} />
            <text x={padL - 6} y={y(t) + 4} textAnchor="end" fontSize={10} fill="var(--muted)">
              {fmtMoneyCompact(t)}
            </text>
          </g>
        ))}
        {zeroVisible && <line x1={padL} x2={W - padR} y1={y(0)} y2={y(0)} stroke="var(--muted)" strokeWidth={1} strokeDasharray="3 3" />}
        {hoverI != null && <line x1={x(hoverI)} x2={x(hoverI)} y1={padT} y2={padT + plotH} stroke="var(--muted)" strokeWidth={1} />}
        <path d={path} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {points.map((p, i) => (
          <circle
            key={p.month}
            cx={x(i)}
            cy={y(p.value)}
            r={hoverI === i ? 4.5 : i === points.length - 1 ? 3.5 : 0}
            fill="var(--accent)"
            stroke="var(--surface)"
            strokeWidth={2}
          />
        ))}
        {points.map((p, i) => (
          <rect
            key={p.month}
            x={x(i) - plotW / Math.max(1, points.length - 1) / 2}
            y={padT}
            width={plotW / Math.max(1, points.length - 1)}
            height={plotH}
            fill="transparent"
            onMouseEnter={() => {
              setHoverI(i);
              setTip({
                xPct: (x(i) / W) * 100,
                yPct: (y(p.value) / H) * 100,
                lines: [monthLabel(p.month), fmtMoney(p.value)],
              });
            }}
          />
        ))}
        {points.map((p, i) =>
          i % Math.ceil(points.length / 6) === 0 ? (
            <text key={p.month} x={x(i)} y={H - 6} textAnchor="middle" fontSize={10} fill="var(--muted)">
              {monthLabelShort(p.month)}
            </text>
          ) : null,
        )}
      </svg>
      <TipBox tip={tip} />
    </div>
  );
}
