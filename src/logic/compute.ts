// The accounting core. Every surface (dashboard, reports, ledgers, exports)
// computes through these pure functions so the numbers can never disagree
// between screens. Conventions:
//   - amounts are stored positive; tx.kind carries the sign
//   - transfers move money between accounts and are excluded from
//     income/expense reporting entirely
//   - dates are plain YYYY-MM-DD strings; ranges are inclusive on both ends
import type { Account, AllData, Asset, Category, Tx, Valuation } from '../types';

export const round2 = (n: number) => Math.round(n * 100) / 100;

/** Stable ledger order: by date, then by creation time. */
export function txSort(a: Tx, b: Tx): number {
  if (a.tx_date !== b.tx_date) return a.tx_date.localeCompare(b.tx_date);
  return a.created_at.localeCompare(b.created_at);
}

/** Signed effect of a transaction on one account's balance. */
export function txSignedForAccount(tx: Tx, accountId: string): number {
  if (tx.kind === 'income') return tx.account_id === accountId ? tx.amount : 0;
  if (tx.kind === 'expense') return tx.account_id === accountId ? -tx.amount : 0;
  // transfer: out of account_id, into transfer_account_id
  let d = 0;
  if (tx.account_id === accountId) d -= tx.amount;
  if (tx.transfer_account_id === accountId) d += tx.amount;
  return d;
}

/** Account balance including all transactions up to and including upToDate. */
export function accountBalance(account: Account, txns: Tx[], upToDate?: string): number {
  let bal = account.opening_balance;
  for (const tx of txns) {
    if (upToDate && tx.tx_date > upToDate) continue;
    bal += txSignedForAccount(tx, account.id);
  }
  return round2(bal);
}

// ---------------------------------------------------------------- cash flow

export interface CashflowMonth {
  month: string; // YYYY-MM
  income: number;
  expense: number;
  net: number;
}

/** Income vs expense per month (transfers excluded). */
export function monthlyCashflow(txns: Tx[], months: string[]): CashflowMonth[] {
  const by = new Map<string, { income: number; expense: number }>();
  for (const mk of months) by.set(mk, { income: 0, expense: 0 });
  for (const tx of txns) {
    const slot = by.get(tx.tx_date.slice(0, 7));
    if (!slot) continue;
    if (tx.kind === 'income') slot.income += tx.amount;
    else if (tx.kind === 'expense') slot.expense += tx.amount;
  }
  return months.map((mk) => {
    const s = by.get(mk)!;
    return { month: mk, income: round2(s.income), expense: round2(s.expense), net: round2(s.income - s.expense) };
  });
}

// ---------------------------------------------------------------- category totals

export interface CategoryTotal {
  category: Category | null; // null = uncategorised
  total: number;
  count: number;
}

/** Totals per category for one kind over an inclusive date range, sorted desc. */
export function categoryTotals(
  txns: Tx[],
  categories: Category[],
  kind: 'income' | 'expense',
  from: string,
  to: string,
): CategoryTotal[] {
  const catById = new Map(categories.map((c) => [c.id, c]));
  const acc = new Map<string, { total: number; count: number }>();
  for (const tx of txns) {
    if (tx.kind !== kind) continue;
    if (tx.tx_date < from || tx.tx_date > to) continue;
    const key = tx.category_id ?? '';
    const slot = acc.get(key) ?? { total: 0, count: 0 };
    slot.total += tx.amount;
    slot.count += 1;
    acc.set(key, slot);
  }
  const rows: CategoryTotal[] = [];
  for (const [key, slot] of acc) {
    rows.push({ category: key ? catById.get(key) ?? null : null, total: round2(slot.total), count: slot.count });
  }
  rows.sort((a, b) => b.total - a.total);
  return rows;
}

// ---------------------------------------------------------------- income statement

export interface IncomeStatement {
  from: string;
  to: string;
  income: CategoryTotal[];
  expense: CategoryTotal[];
  incomeTotal: number;
  expenseTotal: number;
  net: number;
}

export function incomeStatement(txns: Tx[], categories: Category[], from: string, to: string): IncomeStatement {
  const income = categoryTotals(txns, categories, 'income', from, to);
  const expense = categoryTotals(txns, categories, 'expense', from, to);
  const incomeTotal = round2(income.reduce((s, r) => s + r.total, 0));
  const expenseTotal = round2(expense.reduce((s, r) => s + r.total, 0));
  return { from, to, income, expense, incomeTotal, expenseTotal, net: round2(incomeTotal - expenseTotal) };
}

// ---------------------------------------------------------------- ledgers

export interface LedgerRow {
  tx: Tx;
  delta: number; // signed effect on this ledger
  balance: number; // running balance after this row
}

export interface AccountLedger {
  opening: number;
  rows: LedgerRow[];
  closing: number;
}

/**
 * Per-account ledger with running balance. `opening` is the balance carried
 * into `from` (opening_balance plus all activity before it).
 */
export function accountLedger(account: Account, txns: Tx[], from?: string, to?: string): AccountLedger {
  const mine = txns.filter((t) => txSignedForAccount(t, account.id) !== 0).sort(txSort);
  let opening = account.opening_balance;
  const rows: LedgerRow[] = [];
  let bal = 0;
  for (const tx of mine) {
    const d = txSignedForAccount(tx, account.id);
    if (from && tx.tx_date < from) {
      opening += d;
      continue;
    }
    if (to && tx.tx_date > to) continue;
    rows.push({ tx, delta: round2(d), balance: 0 }); // balance filled below
  }
  opening = round2(opening);
  bal = opening;
  for (const r of rows) {
    bal = round2(bal + r.delta);
    r.balance = bal;
  }
  return { opening, rows, closing: rows.length ? rows[rows.length - 1].balance : opening };
}

export interface CategoryLedger {
  rows: LedgerRow[];
  total: number;
}

/** Per-category ledger: cumulative amount recorded against the category. */
export function categoryLedger(category: Category, txns: Tx[], from?: string, to?: string): CategoryLedger {
  const mine = txns
    .filter((t) => t.category_id === category.id)
    .filter((t) => (!from || t.tx_date >= from) && (!to || t.tx_date <= to))
    .sort(txSort);
  const rows: LedgerRow[] = [];
  let run = 0;
  for (const tx of mine) {
    run = round2(run + tx.amount);
    rows.push({ tx, delta: tx.amount, balance: run });
  }
  return { rows, total: run };
}

// ---------------------------------------------------------------- net worth

/** Latest valuation for an asset on or before upTo (or latest overall). */
export function latestValuation(valuations: Valuation[], assetId: string, upTo?: string): Valuation | null {
  let best: Valuation | null = null;
  for (const v of valuations) {
    if (v.asset_id !== assetId) continue;
    if (upTo && v.val_date > upTo) continue;
    if (!best || v.val_date > best.val_date) best = v;
  }
  return best;
}

export interface NetWorthBreakdown {
  atDate: string;
  accounts: { account: Account; balance: number }[];
  assets: { asset: Asset; value: number; asOf: string | null }[];
  liabilities: { asset: Asset; value: number; asOf: string | null }[];
  accountsTotal: number;
  assetsTotal: number;
  liabilitiesTotal: number;
  netWorth: number;
}

/**
 * Net worth = transaction-account balances + valued assets - liabilities.
 * Bank/card/cash accounts come from the ledger, so they must NOT be listed
 * again on the assets register (the Assets page says so).
 */
export function netWorthAt(data: AllData, atDate: string): NetWorthBreakdown {
  const accounts = data.accounts
    .filter((a) => !a.archived)
    .map((account) => ({ account, balance: accountBalance(account, data.transactions, atDate) }));
  const value = (a: Asset) => {
    const v = latestValuation(data.valuations, a.id, atDate);
    return { asset: a, value: v ? v.value : 0, asOf: v ? v.val_date : null };
  };
  const live = data.assets.filter((a) => !a.archived);
  const assets = live.filter((a) => a.side === 'asset').map(value);
  const liabilities = live.filter((a) => a.side === 'liability').map(value);
  const accountsTotal = round2(accounts.reduce((s, r) => s + r.balance, 0));
  const assetsTotal = round2(assets.reduce((s, r) => s + r.value, 0));
  const liabilitiesTotal = round2(liabilities.reduce((s, r) => s + r.value, 0));
  return {
    atDate,
    accounts,
    assets,
    liabilities,
    accountsTotal,
    assetsTotal,
    liabilitiesTotal,
    netWorth: round2(accountsTotal + assetsTotal - liabilitiesTotal),
  };
}

export function netWorthSeries(data: AllData, months: string[]): { month: string; value: number }[] {
  return months.map((mk) => {
    const y = Number(mk.slice(0, 4));
    const m = Number(mk.slice(5, 7));
    const end = `${mk}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
    return { month: mk, value: netWorthAt(data, end).netWorth };
  });
}

// ---------------------------------------------------------------- budgets

export interface BudgetRow {
  category: Category;
  budget: number;
  actual: number;
  remaining: number; // positive = still available, negative = over
}

export function budgetRows(categories: Category[], txns: Tx[], mk: string): BudgetRow[] {
  const start = `${mk}-01`;
  const y = Number(mk.slice(0, 4));
  const m = Number(mk.slice(5, 7));
  const end = `${mk}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
  const rows: BudgetRow[] = [];
  for (const c of categories) {
    if (c.kind !== 'expense' || c.archived || c.monthly_budget == null) continue;
    let actual = 0;
    for (const tx of txns) {
      if (tx.kind !== 'expense' || tx.category_id !== c.id) continue;
      if (tx.tx_date < start || tx.tx_date > end) continue;
      actual += tx.amount;
    }
    actual = round2(actual);
    rows.push({ category: c, budget: c.monthly_budget, actual, remaining: round2(c.monthly_budget - actual) });
  }
  rows.sort((a, b) => a.category.sort - b.category.sort || a.category.name.localeCompare(b.category.name));
  return rows;
}
