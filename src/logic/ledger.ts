// The double-entry engine.
//
// Every statement in this app — trial balance, general ledger, T-accounts,
// statement of financial position, statement of changes in equity — is derived
// from the ONE posting list built here, so no two surfaces can disagree.
//
// Posting rules (each source row produces exactly one balanced pair):
//
//   expense   Dr expense category (or the asset, when capitalised)  Cr account
//   income    Dr account                                            Cr income category
//   transfer  Dr destination account                                Cr source account
//   share issue          Dr contra account (or share capital receivable)  Cr share capital
//   dividend             Dr dividends declared (equity)                   Cr contra account
//   prior-period adj.    Dr/Cr retained earnings                          Cr/Dr contra account
//
// The asset/valuation register is deliberately NOT posted: a valuation has no
// second leg. Assets reach the balance sheet at posted cost (IFRS for SMEs
// Section 17 cost model) by capitalising the purchase; valuations stay a
// memorandum figure shown alongside.
import type { AllData, Tx } from '../types';
import { round2 } from './compute';

export type AccountType = 'asset' | 'liability' | 'equity' | 'income' | 'expense';

/** Synthetic ledger accounts that have no row of their own. */
export const SHARE_CAPITAL = 'eq:share_capital';
export const RETAINED_EARNINGS = 'eq:retained_earnings';
export const DIVIDENDS = 'eq:dividends';
export const SHARE_RECEIVABLE = 'eq:share_capital_receivable';
export const DIVIDEND_PAYABLE = 'eq:dividend_payable';
export const DEPRECIATION_EXPENSE = 'sys:depreciation';
export const accDeprKey = (assetId: string) => `accdep:${assetId}`;

export interface LedgerAccountRef {
  key: string;
  name: string;
  type: AccountType;
  /** Presentation caption on the statement of financial position. */
  bsLine?: string;
  isCurrent?: boolean;
  /**
   * A contra account nets against this one before the balance sheet sides it.
   * Accumulated depreciation carries a credit balance but must reduce its
   * asset, not appear among liabilities.
   */
  netsInto?: string;
  /** Cash flow section this account's movement belongs to. */
  cfClass?: 'operating' | 'investing' | 'financing';
  /** Caption to use on the statement of cash flows, when the default is wrong. */
  cfCaption?: string;
}

export interface Posting {
  key: string; // ledger account this posting sits in
  date: string;
  debit: number; // >= 0
  credit: number; // >= 0
  /** The other side of the entry — what a T-account shows in its detail column. */
  contra: string;
  detail: string;
  sourceId: string;
}

export interface LedgerBook {
  accounts: Map<string, LedgerAccountRef>;
  postings: Posting[];
}

const accKey = (id: string) => `acc:${id}`;
const catKey = (id: string) => `cat:${id}`;
const astKey = (id: string) => `ast:${id}`;

function pair(
  out: Posting[],
  date: string,
  sourceId: string,
  detail: string,
  drKey: string,
  drName: string,
  crKey: string,
  crName: string,
  amount: number,
): void {
  const a = round2(amount);
  if (a === 0) return;
  out.push({ key: drKey, date, debit: a, credit: 0, contra: crName, detail, sourceId });
  out.push({ key: crKey, date, debit: 0, credit: a, contra: drName, detail, sourceId });
}

/** Builds the full chart of accounts and every posting, in date order. */
export function buildBook(data: AllData): LedgerBook {
  const accounts = new Map<string, LedgerAccountRef>();
  const add = (ref: LedgerAccountRef) => accounts.set(ref.key, ref);

  for (const a of data.accounts) {
    // An account's side follows its balance at the reporting date (an
    // overdrawn bank account is a liability), so `type` here is only a default;
    // the SoFP re-sides it by sign. See sofp().
    add({
      key: accKey(a.id),
      name: a.name,
      type: 'asset',
      bsLine: a.bs_line ?? undefined,
      isCurrent: a.is_current ?? true,
      cfClass: (a.cf_class as 'operating' | 'investing' | 'financing' | null) ?? 'operating',
    });
  }
  for (const c of data.categories) {
    add({ key: catKey(c.id), name: c.name, type: c.kind === 'income' ? 'income' : 'expense' });
  }
  for (const a of data.assets) {
    add({
      key: astKey(a.id),
      name: a.name,
      type: a.side === 'asset' ? 'asset' : 'liability',
      bsLine: a.bs_line ?? undefined,
      isCurrent: a.is_current ?? false,
      cfClass: (a.cf_class as 'operating' | 'investing' | 'financing' | null) ?? 'investing',
    });
    // Accumulated depreciation: a contra-asset that nets against its asset on
    // the balance sheet, and is added back as a non-cash item in operating
    // cash flows rather than appearing as an investing movement.
    add({
      key: accDeprKey(a.id),
      name: `Accumulated depreciation — ${a.name}`,
      type: 'asset',
      bsLine: a.bs_line ?? undefined,
      isCurrent: a.is_current ?? false,
      netsInto: astKey(a.id),
      cfClass: 'operating',
      cfCaption: 'Adjustment for depreciation',
    });
  }
  add({ key: SHARE_CAPITAL, name: 'Share capital', type: 'equity' });
  add({ key: RETAINED_EARNINGS, name: 'Retained earnings / (accumulated loss)', type: 'equity' });
  add({ key: DIVIDENDS, name: 'Dividends declared', type: 'equity' });
  add({ key: SHARE_RECEIVABLE, name: 'Share capital receivable', type: 'asset', bsLine: 'Share capital receivable', isCurrent: true, cfClass: 'financing' });
  add({ key: DIVIDEND_PAYABLE, name: 'Dividend payable', type: 'liability', bsLine: 'Dividend payable', isCurrent: true, cfClass: 'financing' });
  add({ key: DEPRECIATION_EXPENSE, name: 'Depreciation', type: 'expense' });

  const nameOf = (key: string) => accounts.get(key)?.name ?? '(unknown)';
  const postings: Posting[] = [];

  const txDetail = (t: Tx) =>
    t.payee?.trim() || t.notes?.trim() || t.import_ref?.trim() || '';

  for (const t of data.transactions) {
    const acc = accKey(t.account_id);
    if (t.kind === 'expense') {
      const dr = t.asset_id ? astKey(t.asset_id) : t.category_id ? catKey(t.category_id) : 'cat:uncategorised';
      if (!accounts.has(dr)) add({ key: dr, name: 'Uncategorised expenses', type: 'expense' });
      pair(postings, t.tx_date, t.id, txDetail(t), dr, nameOf(dr), acc, nameOf(acc), t.amount);
    } else if (t.kind === 'income') {
      const cr = t.category_id ? catKey(t.category_id) : 'cat:uncategorised_income';
      if (!accounts.has(cr)) add({ key: cr, name: 'Uncategorised income', type: 'income' });
      pair(postings, t.tx_date, t.id, txDetail(t), acc, nameOf(acc), cr, nameOf(cr), t.amount);
    } else if (t.transfer_account_id) {
      const to = accKey(t.transfer_account_id);
      pair(postings, t.tx_date, t.id, txDetail(t) || 'Transfer', to, nameOf(to), acc, nameOf(acc), t.amount);
    }
  }

  for (const m of data.equity) {
    const contra = m.contra_account_id ? accKey(m.contra_account_id) : null;
    const detail = m.notes?.trim() || '';
    if (m.kind === 'share_issue') {
      const dr = contra ?? SHARE_RECEIVABLE;
      pair(postings, m.mv_date, m.id, detail || 'Shares issued', dr, nameOf(dr), SHARE_CAPITAL, nameOf(SHARE_CAPITAL), m.amount);
    } else if (m.kind === 'dividend') {
      const cr = contra ?? DIVIDEND_PAYABLE;
      pair(postings, m.mv_date, m.id, detail || 'Dividend declared', DIVIDENDS, nameOf(DIVIDENDS), cr, nameOf(cr), m.amount);
    } else {
      // Signed: positive increases retained earnings (credit), negative reduces it.
      const other = contra ?? RETAINED_EARNINGS;
      if (m.amount > 0) pair(postings, m.mv_date, m.id, detail || 'Prior-period adjustment', other, nameOf(other), RETAINED_EARNINGS, nameOf(RETAINED_EARNINGS), m.amount);
      else pair(postings, m.mv_date, m.id, detail || 'Prior-period adjustment', RETAINED_EARNINGS, nameOf(RETAINED_EARNINGS), other, nameOf(other), -m.amount);
    }
  }

  // Depreciation: Dr depreciation expense / Cr accumulated depreciation.
  for (const d of data.depreciation) {
    const cr = accDeprKey(d.asset_id);
    if (!accounts.has(cr)) continue; // asset deleted; charge cascades away anyway
    pair(
      postings,
      d.period_end,
      d.id,
      d.basis ?? 'Depreciation',
      DEPRECIATION_EXPENSE,
      nameOf(DEPRECIATION_EXPENSE),
      cr,
      nameOf(cr),
      d.amount,
    );
  }

  postings.sort((a, b) => a.date.localeCompare(b.date) || a.sourceId.localeCompare(b.sourceId));
  return { accounts, postings };
}

// ---------------------------------------------------------------- trial balance

export interface TrialBalanceRow {
  key: string;
  name: string;
  type: AccountType;
  debit: number; // net, one side only
  credit: number;
}

export interface TrialBalance {
  rows: TrialBalanceRow[];
  totalDebit: number;
  totalCredit: number;
  balanced: boolean;
}

/**
 * Net balance per ledger account up to `to`. P&L accounts are restricted to
 * [from, to] so the trial balance can be run for a financial year; balance
 * sheet accounts always run from inception, which is what makes them balances.
 */
export function trialBalance(book: LedgerBook, from: string, to: string): TrialBalance {
  const acc = new Map<string, { debit: number; credit: number }>();
  for (const p of book.postings) {
    if (p.date > to) continue;
    const ref = book.accounts.get(p.key);
    const isPL = ref?.type === 'income' || ref?.type === 'expense' || p.key === DIVIDENDS;
    if (isPL && p.date < from) continue;
    const slot = acc.get(p.key) ?? { debit: 0, credit: 0 };
    slot.debit += p.debit;
    slot.credit += p.credit;
    acc.set(p.key, slot);
  }
  const rows: TrialBalanceRow[] = [];
  let totalDebit = 0;
  let totalCredit = 0;
  for (const [key, sums] of acc) {
    const ref = book.accounts.get(key);
    const net = round2(sums.debit - sums.credit);
    if (net === 0) continue;
    const row: TrialBalanceRow = {
      key,
      name: ref?.name ?? key,
      type: effectiveType(book, key, to),
      debit: net > 0 ? net : 0,
      credit: net < 0 ? -net : 0,
    };
    totalDebit += row.debit;
    totalCredit += row.credit;
    rows.push(row);
  }
  const order: Record<AccountType, number> = { asset: 0, liability: 1, equity: 2, income: 3, expense: 4 };
  rows.sort((a, b) => order[a.type] - order[b.type] || a.name.localeCompare(b.name));
  totalDebit = round2(totalDebit);
  totalCredit = round2(totalCredit);
  return { rows, totalDebit, totalCredit, balanced: Math.abs(totalDebit - totalCredit) < 0.005 };
}

// ---------------------------------------------------------------- T-accounts

export interface TAccountEntry {
  date: string;
  detail: string;
  amount: number;
}

export interface TAccount {
  key: string;
  name: string;
  type: AccountType;
  /** Balance brought down at `from` (0 for P&L accounts, which start fresh). */
  openingDebit: number;
  openingCredit: number;
  debits: TAccountEntry[];
  credits: TAccountEntry[];
  totalDebit: number;
  totalCredit: number;
  /** Balance carried down — sits on the side that makes both columns total equal. */
  closingDebit: number;
  closingCredit: number;
}

/** One T-account for the period, in the classic two-sided presentation. */
export function tAccount(book: LedgerBook, key: string, from: string, to: string): TAccount {
  const ref = book.accounts.get(key);
  const nominal = ref?.type ?? 'asset';
  const type = effectiveType(book, key, to);
  const isPL = nominal === 'income' || nominal === 'expense' || key === DIVIDENDS;

  let openingNet = 0;
  const debits: TAccountEntry[] = [];
  const credits: TAccountEntry[] = [];

  for (const p of book.postings) {
    if (p.key !== key) continue;
    if (p.date > to) continue;
    if (p.date < from) {
      if (!isPL) openingNet += p.debit - p.credit; // balance brought down
      continue;
    }
    if (p.debit > 0) debits.push({ date: p.date, detail: p.contra || p.detail, amount: p.debit });
    else credits.push({ date: p.date, detail: p.contra || p.detail, amount: p.credit });
  }

  openingNet = round2(openingNet);
  const openingDebit = openingNet > 0 ? openingNet : 0;
  const openingCredit = openingNet < 0 ? -openingNet : 0;

  const totalDebit = round2(openingDebit + debits.reduce((s, e) => s + e.amount, 0));
  const totalCredit = round2(openingCredit + credits.reduce((s, e) => s + e.amount, 0));
  const net = round2(totalDebit - totalCredit);

  return {
    key,
    name: ref?.name ?? key,
    type,
    openingDebit,
    openingCredit,
    debits,
    credits,
    totalDebit,
    totalCredit,
    // The carried-down balance goes on the SHORT side so the two columns agree.
    closingDebit: net < 0 ? -net : 0,
    closingCredit: net > 0 ? net : 0,
  };
}

/** Every ledger account that has activity or an opening balance in the period. */
export function activeAccountKeys(book: LedgerBook, to: string): string[] {
  const seen = new Set<string>();
  for (const p of book.postings) if (p.date <= to) seen.add(p.key);
  const order: Record<AccountType, number> = { asset: 0, liability: 1, equity: 2, income: 3, expense: 4 };
  return [...seen].sort((a, b) => {
    const ra = book.accounts.get(a);
    const rb = book.accounts.get(b);
    return order[ra?.type ?? 'asset'] - order[rb?.type ?? 'asset'] || (ra?.name ?? '').localeCompare(rb?.name ?? '');
  });
}

/**
 * The side an account actually sits on at a date. Bank and loan accounts are
 * stored with a nominal type, but a credit balance IS a liability — a director
 * loan in credit must not be captioned "Asset" anywhere the user can see it.
 * Income, expense and equity accounts keep their fixed type.
 */
export function effectiveType(book: LedgerBook, key: string, atDate: string): AccountType {
  const ref = book.accounts.get(key);
  if (!ref) return 'asset';
  if (ref.type === 'income' || ref.type === 'expense' || ref.type === 'equity') return ref.type;
  return balanceAt(book, key, atDate) < 0 ? 'liability' : 'asset';
}

/** Net balance of one ledger account at a date (debit positive). */
export function balanceAt(book: LedgerBook, key: string, to: string, from?: string): number {
  let net = 0;
  for (const p of book.postings) {
    if (p.key !== key || p.date > to) continue;
    if (from && p.date < from) continue;
    net += p.debit - p.credit;
  }
  return round2(net);
}

/** Profit or loss for a period: income less expenses (positive = profit). */
export function profitForPeriod(book: LedgerBook, from: string, to: string): number {
  let income = 0;
  let expense = 0;
  for (const p of book.postings) {
    if (p.date < from || p.date > to) continue;
    const t = book.accounts.get(p.key)?.type;
    if (t === 'income') income += p.credit - p.debit;
    else if (t === 'expense') expense += p.debit - p.credit;
  }
  return round2(income - expense);
}
