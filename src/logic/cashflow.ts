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
  accDeprKey,
  balanceAt,
  disposalSourceId,
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
  // The cost and accumulated-depreciation legs of a disposal are removed from
  // the generic walk and presented explicitly below, because their raw
  // movement is the carrying amount, not the cash that actually changed hands.
  const disposalsInPeriod = data.disposals.filter((d) => d.disposal_date >= from && d.disposal_date <= to);
  const excluded = new Set(disposalsInPeriod.map((d) => disposalSourceId(d.id)));
  const assetLegKeys = new Set(disposalsInPeriod.flatMap((d) => [`ast:${d.asset_id}`, accDeprKey(d.asset_id)]));
  const deltaOf = (key: string): number => {
    if (!assetLegKeys.has(key)) return round2(balanceAt(book, key, to) - balanceAt(book, key, priorEnd));
    return round2(
      book.postings
        .filter((p) => p.key === key && p.date >= from && p.date <= to && !excluded.has(p.sourceId))
        .reduce((s2, p) => s2 + p.debit - p.credit, 0) +
        balanceAt(book, key, priorEnd) -
        balanceAt(book, key, priorEnd),
    );
  };

  for (const [key, ref] of book.accounts) {
    if (ref.type === 'income' || ref.type === 'expense' || ref.type === 'equity') continue;
    if (cashSet.has(key)) continue;
    const delta = deltaOf(key);
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

  // 4. Disposals. The gain or loss sits in profit but moved no cash, so it is
  //    reversed out of operating; the proceeds are the investing inflow.
  //    Together these equal the carrying amount removed from the walk above,
  //    which is why the statement still reconciles.
  for (const d of disposalsInPeriod) {
    const name = book.accounts.get(`ast:${d.asset_id}`)?.name ?? 'asset';
    const legs = book.postings.filter((p) => p.sourceId === disposalSourceId(d.id));
    const cost = round2(legs.filter((p) => p.key === `ast:${d.asset_id}`).reduce((s2, p) => s2 + p.credit - p.debit, 0));
    const accDep = round2(legs.filter((p) => p.key === accDeprKey(d.asset_id)).reduce((s2, p) => s2 + p.debit - p.credit, 0));
    const carrying = round2(cost - accDep);
    const result = round2(d.proceeds - carrying);
    if (result !== 0) {
      operating.push({
        caption: result > 0 ? `Gain on disposal of ${name.toLowerCase()}` : `Loss on disposal of ${name.toLowerCase()}`,
        amount: -result,
      });
    }
    if (d.proceeds !== 0) {
      investing.push({ caption: `Proceeds on disposal of ${name.toLowerCase()}`, amount: round2(d.proceeds) });
    }
  }

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
