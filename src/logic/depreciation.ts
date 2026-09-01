// Fixed asset depreciation — IFRS for SMEs Section 17.
//
// Charges are computed here but POSTED and stored, never re-derived from the
// current settings. That is deliberate: a revised useful life or residual value
// is a change in accounting estimate applied PROSPECTIVELY (Section 10.15), so
// prior periods must keep the charge that was actually raised. Recomputing
// everything from today's settings would silently restate history.
import { round2 } from './compute';
import type { Asset, DepreciationCharge } from '../types';

export interface DuePeriod {
  periodEnd: string;
  amount: number;
  basis: string;
}

const dim = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const monthEndOf = (dateStr: string): string => {
  const y = Number(dateStr.slice(0, 4));
  const m = Number(dateStr.slice(5, 7));
  return `${y}-${String(m).padStart(2, '0')}-${String(dim(y, m)).padStart(2, '0')}`;
};
const nextMonthEnd = (periodEnd: string): string => {
  const y = Number(periodEnd.slice(0, 4));
  const m = Number(periodEnd.slice(5, 7));
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, '0')}-${String(dim(ny, nm)).padStart(2, '0')}`;
};

/** True when this asset is configured well enough to depreciate. */
export function canDepreciate(a: Asset): boolean {
  if (!a.depreciate || a.side !== 'asset' || a.archived) return false;
  if (!a.depr_start || !a.depr_method) return false;
  if (a.depr_method === 'straight_line') return !!a.useful_life_months && a.useful_life_months > 0;
  return !!a.depr_rate_pct && a.depr_rate_pct > 0;
}

/**
 * Every monthly charge owed for one asset up to `asOf` that has not already
 * been posted. `costAt` reads the capitalised cost from the ledger, so an
 * asset with no purchase posted against it depreciates nothing.
 *
 * Limitation, stated rather than hidden: each asset row is depreciated as a
 * single unit from its `depr_start`. A later addition to the same row is
 * therefore written off over the row's remaining life rather than its own —
 * record a separate asset row per addition when that matters.
 */
export function dueDepreciation(
  asset: Asset,
  existing: DepreciationCharge[],
  costAt: (assetId: string, date: string) => number,
  asOf: string,
  cap = 600,
): DuePeriod[] {
  if (!canDepreciate(asset)) return [];
  const residual = asset.residual_value ?? 0;
  const posted = existing.filter((c) => c.asset_id === asset.id);
  const postedPeriods = new Set(posted.map((c) => c.period_end));

  // Accumulated depreciation carried into the run, from what is already posted.
  let accumulated = round2(posted.reduce((s, c) => s + c.amount, 0));

  const out: DuePeriod[] = [];
  let periodEnd = monthEndOf(asset.depr_start!);
  let guard = 0;

  while (periodEnd <= asOf && guard++ < cap) {
    if (postedPeriods.has(periodEnd)) {
      periodEnd = nextMonthEnd(periodEnd);
      continue;
    }
    const cost = round2(costAt(asset.id, periodEnd));
    if (cost <= 0) {
      // Nothing capitalised yet at this date — no charge, and no catch-up
      // later for a period in which the asset did not exist.
      periodEnd = nextMonthEnd(periodEnd);
      continue;
    }

    let amount = 0;
    let basis = '';
    if (asset.depr_method === 'straight_line') {
      const depreciable = round2(cost - residual);
      const remaining = round2(depreciable - accumulated);
      if (remaining > 0) {
        const monthly = round2(depreciable / asset.useful_life_months!);
        amount = Math.min(monthly, remaining);
        basis = `Straight line over ${asset.useful_life_months} months on a depreciable amount of ${depreciable.toFixed(2)}`;
      }
    } else {
      const carrying = round2(cost - accumulated);
      const headroom = round2(carrying - residual);
      if (headroom > 0) {
        const monthly = round2((carrying * (asset.depr_rate_pct! / 100)) / 12);
        amount = Math.min(monthly, headroom);
        basis = `Reducing balance at ${asset.depr_rate_pct}% per year on a carrying amount of ${carrying.toFixed(2)}`;
      }
    }

    amount = round2(amount);
    if (amount > 0) {
      out.push({ periodEnd, amount, basis });
      accumulated = round2(accumulated + amount);
    }
    periodEnd = nextMonthEnd(periodEnd);
  }
  return out;
}

export interface RegisterRow {
  asset: Asset;
  cost: number;
  accumulated: number;
  carrying: number;
  chargeThisYear: number;
  /** Charges owed but not yet posted, at the reporting date. */
  outstanding: number;
  fullyDepreciated: boolean;
}

/** The register as at a date, for the Assets screen and the Section 17 note. */
export function register(
  assets: Asset[],
  charges: DepreciationCharge[],
  costAt: (assetId: string, date: string) => number,
  atDate: string,
  yearFrom: string,
): RegisterRow[] {
  return assets
    .filter((a) => a.side === 'asset' && !a.archived)
    .map((asset) => {
      const cost = round2(costAt(asset.id, atDate));
      const mine = charges.filter((c) => c.asset_id === asset.id && c.period_end <= atDate);
      const accumulated = round2(mine.reduce((s, c) => s + c.amount, 0));
      const chargeThisYear = round2(
        mine.filter((c) => c.period_end >= yearFrom).reduce((s, c) => s + c.amount, 0),
      );
      const outstanding = round2(
        dueDepreciation(asset, charges, costAt, atDate).reduce((s, d) => s + d.amount, 0),
      );
      const carrying = round2(cost - accumulated);
      return {
        asset,
        cost,
        accumulated,
        carrying,
        chargeThisYear,
        outstanding,
        fullyDepreciated:
          canDepreciate(asset) && cost > 0 && carrying <= round2(asset.residual_value ?? 0) + 0.004,
      };
    });
}

export const METHOD_LABEL: Record<string, string> = {
  straight_line: 'Straight line',
  reducing_balance: 'Reducing balance',
};
