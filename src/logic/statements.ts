// IFRS for SMEs presentation.
//
//   Statement of financial position — Section 4 (current/non-current split,
//     4.4-4.7; minimum line items 4.2, aggregated where immaterial 4.3).
//   Statement of changes in equity — Section 6 (6.3: total comprehensive
//     income, prior-period adjustments, and for each equity component the
//     movements between opening and closing balances).
//
// Both are derived from the posting book, so the accounting equation holds by
// construction rather than by arithmetic done twice. `balanced` is asserted in
// the test suite and surfaced in the UI.
import { round2 } from './compute';
import {
  DIVIDENDS,
  RETAINED_EARNINGS,
  SHARE_CAPITAL,
  balanceAt,
  buildBook,
  profitForPeriod,
} from './ledger';
import type { LedgerBook } from './ledger';
import type { AllData } from '../types';

// ---------------------------------------------------------------- financial year

export interface FinancialYear {
  from: string;
  to: string;
  label: string;
}

const dim = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const iso = (y: number, m: number, d: number) =>
  `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/**
 * The financial year containing `onDate`, for a year ending in `fyEndMonth`.
 * A February year-end means 1 Mar 2026 to 28 Feb 2027.
 */
export function financialYearFor(onDate: string, fyEndMonth: number): FinancialYear {
  const y = Number(onDate.slice(0, 4));
  const m = Number(onDate.slice(5, 7));
  const d = Number(onDate.slice(8, 10));
  const endYear = m > fyEndMonth || (m === fyEndMonth && d > dim(y, fyEndMonth)) ? y + 1 : y;
  const to = iso(endYear, fyEndMonth, dim(endYear, fyEndMonth));
  const startMonth = (fyEndMonth % 12) + 1;
  const startYear = fyEndMonth === 12 ? endYear : endYear - 1;
  const from = iso(startYear, startMonth, 1);
  return { from, to, label: `Year ended ${to}` };
}

export function priorYear(fy: FinancialYear, fyEndMonth: number): FinancialYear {
  const prevEnd = Number(fy.to.slice(0, 4)) - 1;
  return financialYearFor(iso(prevEnd, fyEndMonth, dim(prevEnd, fyEndMonth)), fyEndMonth);
}

// ---------------------------------------------------------------- SoFP

export interface SofpLine {
  caption: string;
  amount: number;
  /** Ledger accounts aggregated into this caption, for drill-down. */
  keys: string[];
}

export interface Sofp {
  atDate: string;
  currentAssets: SofpLine[];
  nonCurrentAssets: SofpLine[];
  currentLiabilities: SofpLine[];
  nonCurrentLiabilities: SofpLine[];
  equity: SofpLine[];
  totalCurrentAssets: number;
  totalNonCurrentAssets: number;
  totalAssets: number;
  totalCurrentLiabilities: number;
  totalNonCurrentLiabilities: number;
  totalLiabilities: number;
  totalEquity: number;
  /** Assets − (liabilities + equity); zero when the books balance. */
  difference: number;
  balanced: boolean;
}

const DEFAULT_ASSET_LINE = 'Other assets';
const DEFAULT_LIABILITY_LINE = 'Other payables';

function push(into: SofpLine[], caption: string, amount: number, key: string): void {
  const hit = into.find((l) => l.caption === caption);
  if (hit) {
    hit.amount = round2(hit.amount + amount);
    hit.keys.push(key);
  } else {
    into.push({ caption, amount: round2(amount), keys: [key] });
  }
}

/**
 * Statement of financial position at a date.
 *
 * Accounts are sided by their actual balance, not their nature: a bank account
 * in overdraft presents within current liabilities, and a director loan
 * presents as a liability while it is in credit. This is the Section 4
 * treatment and it is why the statement stays true when a balance swings.
 */
export function sofp(book: LedgerBook, atDate: string, inceptionDate = '0000-01-01'): Sofp {
  const currentAssets: SofpLine[] = [];
  const nonCurrentAssets: SofpLine[] = [];
  const currentLiabilities: SofpLine[] = [];
  const nonCurrentLiabilities: SofpLine[] = [];

  for (const [key, ref] of book.accounts) {
    if (ref.type === 'income' || ref.type === 'expense' || ref.type === 'equity') continue;
    const net = balanceAt(book, key, atDate);
    if (net === 0) continue;
    const current = ref.isCurrent ?? true;
    if (net > 0) {
      push(current ? currentAssets : nonCurrentAssets, ref.bsLine || ref.name || DEFAULT_ASSET_LINE, net, key);
    } else {
      push(current ? currentLiabilities : nonCurrentLiabilities, ref.bsLine || ref.name || DEFAULT_LIABILITY_LINE, -net, key);
    }
  }

  // Equity: issued capital, plus accumulated profit or loss to date.
  const shareCapital = -balanceAt(book, SHARE_CAPITAL, atDate); // credit balance
  const retainedPosted = -balanceAt(book, RETAINED_EARNINGS, atDate); // prior-period adjustments
  const dividends = balanceAt(book, DIVIDENDS, atDate); // debit balance
  const accumulated = round2(profitForPeriod(book, inceptionDate, atDate) + retainedPosted - dividends);

  const equity: SofpLine[] = [];
  if (shareCapital !== 0) equity.push({ caption: 'Share capital', amount: shareCapital, keys: [SHARE_CAPITAL] });
  equity.push({
    caption: accumulated < 0 ? 'Accumulated loss' : 'Retained earnings',
    amount: accumulated,
    keys: [RETAINED_EARNINGS, DIVIDENDS],
  });

  const sum = (ls: SofpLine[]) => round2(ls.reduce((s, l) => s + l.amount, 0));
  const totalCurrentAssets = sum(currentAssets);
  const totalNonCurrentAssets = sum(nonCurrentAssets);
  const totalCurrentLiabilities = sum(currentLiabilities);
  const totalNonCurrentLiabilities = sum(nonCurrentLiabilities);
  const totalAssets = round2(totalCurrentAssets + totalNonCurrentAssets);
  const totalLiabilities = round2(totalCurrentLiabilities + totalNonCurrentLiabilities);
  const totalEquity = sum(equity);
  const difference = round2(totalAssets - totalLiabilities - totalEquity);

  const byCaption = (a: SofpLine, b: SofpLine) => a.caption.localeCompare(b.caption);
  currentAssets.sort(byCaption);
  nonCurrentAssets.sort(byCaption);
  currentLiabilities.sort(byCaption);
  nonCurrentLiabilities.sort(byCaption);

  return {
    atDate,
    currentAssets,
    nonCurrentAssets,
    currentLiabilities,
    nonCurrentLiabilities,
    equity,
    totalCurrentAssets,
    totalNonCurrentAssets,
    totalAssets,
    totalCurrentLiabilities,
    totalNonCurrentLiabilities,
    totalLiabilities,
    totalEquity,
    difference,
    balanced: Math.abs(difference) < 0.005,
  };
}

// ---------------------------------------------------------------- SOCIE

export interface SocieRow {
  caption: string;
  shareCapital: number;
  retainedEarnings: number;
  total: number;
  /** Rendered in bold as a subtotal (opening and closing balances). */
  isBalance?: boolean;
}

export interface Socie {
  from: string;
  to: string;
  rows: SocieRow[];
  closingTotal: number;
}

/**
 * Statement of changes in equity for a period.
 *
 * Opening balances are everything up to the day before `from`; the movement
 * rows are the period's profit, share issues, dividends and any prior-period
 * adjustment. Suppressed rows are those with no movement, per Section 3.16
 * (an entity need not present an immaterial or nil line).
 */
export function socie(book: LedgerBook, from: string, to: string, inceptionDate = '0000-01-01'): Socie {
  const dayBefore = (d: string) => {
    const t = new Date(Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)) - 1));
    return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
  };
  const priorEnd = dayBefore(from);

  const openShare = -balanceAt(book, SHARE_CAPITAL, priorEnd);
  const openRetained = round2(
    profitForPeriod(book, inceptionDate, priorEnd) - balanceAt(book, RETAINED_EARNINGS, priorEnd) - balanceAt(book, DIVIDENDS, priorEnd),
  );

  const profit = profitForPeriod(book, from, to);
  const issued = round2(-balanceAt(book, SHARE_CAPITAL, to, from));
  const dividends = round2(balanceAt(book, DIVIDENDS, to, from));
  const ppa = round2(-balanceAt(book, RETAINED_EARNINGS, to, from));

  const rows: SocieRow[] = [
    {
      caption: `Balance at ${priorEnd}`,
      shareCapital: openShare,
      retainedEarnings: openRetained,
      total: round2(openShare + openRetained),
      isBalance: true,
    },
  ];
  if (ppa !== 0)
    rows.push({ caption: 'Prior-period adjustment', shareCapital: 0, retainedEarnings: ppa, total: ppa });
  if (profit !== 0)
    rows.push({
      caption: profit < 0 ? 'Total comprehensive loss for the period' : 'Total comprehensive income for the period',
      shareCapital: 0,
      retainedEarnings: profit,
      total: profit,
    });
  if (issued !== 0)
    rows.push({ caption: 'Shares issued', shareCapital: issued, retainedEarnings: 0, total: issued });
  if (dividends !== 0)
    rows.push({ caption: 'Dividends declared', shareCapital: 0, retainedEarnings: -dividends, total: -dividends });

  const closeShare = round2(openShare + issued);
  const closeRetained = round2(openRetained + profit + ppa - dividends);
  rows.push({
    caption: `Balance at ${to}`,
    shareCapital: closeShare,
    retainedEarnings: closeRetained,
    total: round2(closeShare + closeRetained),
    isBalance: true,
  });

  return { from, to, rows, closingTotal: round2(closeShare + closeRetained) };
}

/** Convenience: build the book once and return both statements for a year. */
export function statementsFor(data: AllData, fy: FinancialYear) {
  const book = buildBook(data);
  return { book, sofp: sofp(book, fy.to), socie: socie(book, fy.from, fy.to) };
}
