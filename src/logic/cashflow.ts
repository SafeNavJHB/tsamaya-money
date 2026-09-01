// Statement of cash flows — IFRS for SMEs Section 7, indirect method (7.7).
//
// The reconciliation is not computed twice and compared; it falls out of double
// entry. Over any period, summing (debits − credits) across every ledger
// account gives zero, so:
//
//   Δcash + Δ(other balance-sheet accounts) + Δ(equity accounts) + P&L = 0
//   ⇒  Δcash = profit − Δ(other balance-sheet) − Δ(equity)
//
// Each term on the right is then presented under operating, investing or
// financing according to the account's cf_class. `reconciles` asserts the
// derived movement equals the actual change in cash balances — if it ever goes
// false, a classification has gone missing rather than the maths being wrong.
import { round2 } from './compute';
import {
  DIVIDENDS,
  RETAINED_EARNINGS,
  SHARE_CAPITAL,
  balanceAt,
  profitForPeriod,
} from './ledger';
import type { LedgerBook } from './ledger';
import type { Account, AllData, Asset } from '../types';

export type CfClass = 'operating' | 'investing' | 'financing';

/** Cash and cash equivalents: explicit when set, else inferred from the kind. */
export function isCashAccount(a: Account): boolean {
  if (a.is_cash != null) return a.is_cash;
  return a.kind === 'bank' || a.kind === 'cash' || a.kind === 'savings';
}

export function accountCfClass(a: Account): CfClass {
  return (a.cf_class as CfClass | null | undefined) ?? 'operating';
}

export function assetCfClass(a: Asset): CfClass {
  return (a.cf_class as CfClass | null | undefined) ?? 'investing';
}

export interface CashflowLine {
  caption: string;
  amount: number; // signed: positive is an inflow
}

export interface CashflowStatement {
  from: string;
  to: string;
  operating: CashflowLine[];
  investing: CashflowLine[];
  financing: CashflowLine[];
  netOperating: number;
  netInvesting: number;
  netFinancing: number;
  netMovement: number;
  openingCash: number;
  closingCash: number;
  /** Derived movement vs the actual movement in cash balances. */
  reconciles: boolean;
  difference: number;
  /** Cash accounts and their closing balances (Section 7.20). */
  components: { name: string; amount: number }[];
}

const dayBefore = (d: string): string => {
  const t = new Date(Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)) - 1));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
};

const movementCaption = (name: string, delta: number, assetLike: boolean): string => {
  // A rise in an asset consumes cash; a rise in a liability provides it.
  const rising = assetLike ? delta > 0 : delta < 0;
  return `${rising ? 'Increase' : 'Decrease'} in ${name.charAt(0).toLowerCase()}${name.slice(1)}`;
};

export function cashflowStatement(
  book: LedgerBook,
  data: AllData,
  from: string,
  to: string,
): CashflowStatement {
  const priorEnd = dayBefore(from);
  const cashKeys = data.accounts.filter(isCashAccount).map((a) => `acc:${a.id}`);
  const cashSet = new Set(cashKeys);

  const openingCash = round2(cashKeys.reduce((s, k) => s + balanceAt(book, k, priorEnd), 0));
  const closingCash = round2(cashKeys.reduce((s, k) => s + balanceAt(book, k, to), 0));

  const operating: CashflowLine[] = [];
  const investing: CashflowLine[] = [];
  const financing: CashflowLine[] = [];

  // 1. Operating starts at the period's profit or loss.
  const profit = profitForPeriod(book, from, to);
  operating.push({ caption: profit < 0 ? 'Loss for the period' : 'Profit for the period', amount: profit });

  const bucket = (c: CfClass) => (c === 'operating' ? operating : c === 'investing' ? investing : financing);

  // 2. Every non-cash balance-sheet ledger account — enumerated from the BOOK,
  //    not from the raw data, so synthetic accounts (accumulated depreciation,
  //    share capital receivable, dividend payable) are never silently missed.
  //    A missed account would break the reconciliation, which is why this is
  //    driven off the same chart the statements use.
  for (const [key, ref] of book.accounts) {
    if (ref.type === 'income' || ref.type === 'expense' || ref.type === 'equity') continue;
    if (cashSet.has(key)) continue;
    const delta = round2(balanceAt(book, key, to) - balanceAt(book, key, priorEnd));
    if (delta === 0) continue;
    const cls = ref.cfClass ?? 'operating';
    const name = ref.bsLine ?? ref.name;
    let caption: string;
    if (ref.cfCaption) {
      caption = ref.cfCaption;
    } else if (cls === 'investing') {
      caption = delta > 0 ? `Acquisition of ${name.toLowerCase()}` : `Proceeds on disposal of ${name.toLowerCase()}`;
    } else if (cls === 'financing') {
      caption = `${delta < 0 ? 'Increase' : 'Decrease'} in ${name.toLowerCase()}`;
    } else {
      caption = movementCaption(name, delta, balanceAt(book, key, to) >= 0);
    }
    const line = bucket(cls);
    const existing = line.find((l) => l.caption === caption);
    if (existing) existing.amount = round2(existing.amount - delta);
    else line.push({ caption, amount: -delta });
  }

  // 3. Equity accounts. Share capital and dividends are financing; a
  //    prior-period adjustment is a non-cash movement whose cash effect (if
  //    any) already sits in whatever account it was posted against.
  const shareDelta = round2(balanceAt(book, SHARE_CAPITAL, to) - balanceAt(book, SHARE_CAPITAL, priorEnd));
  if (shareDelta !== 0) financing.push({ caption: 'Proceeds from issue of share capital', amount: -shareDelta });

  const divDelta = round2(balanceAt(book, DIVIDENDS, to) - balanceAt(book, DIVIDENDS, priorEnd));
  if (divDelta !== 0) financing.push({ caption: 'Dividends declared', amount: -divDelta });

  const reDelta = round2(balanceAt(book, RETAINED_EARNINGS, to) - balanceAt(book, RETAINED_EARNINGS, priorEnd));
  if (reDelta !== 0) operating.push({ caption: 'Prior-period adjustment (non-cash)', amount: -reDelta });

  const sum = (ls: CashflowLine[]) => round2(ls.reduce((s, l) => s + l.amount, 0));
  const netOperating = sum(operating);
  const netInvesting = sum(investing);
  const netFinancing = sum(financing);
  const netMovement = round2(netOperating + netInvesting + netFinancing);
  const difference = round2(netMovement - (closingCash - openingCash));

  return {
    from,
    to,
    operating,
    investing,
    financing,
    netOperating,
    netInvesting,
    netFinancing,
    netMovement,
    openingCash,
    closingCash,
    reconciles: Math.abs(difference) < 0.005,
    difference,
    components: data.accounts
      .filter(isCashAccount)
      .map((a) => ({ name: a.name, amount: balanceAt(book, `acc:${a.id}`, to) }))
      .filter((c) => c.amount !== 0 || data.accounts.filter(isCashAccount).length === 1),
  };
}

/** Unused but kept explicit: inception is the earliest posting date. */
export function inceptionOf(book: LedgerBook): string {
  return book.postings.length ? book.postings[0].date : '0000-01-01';
}
