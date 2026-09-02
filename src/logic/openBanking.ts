// Mapping Open Banking v3.1 (AISP) payloads onto this app's model.
//
// Nedbank's API Marketplace serves the UK Open Banking Read/Write shape — the
// `x-fapi-financial-id` header and the Data/Links/Meta envelope are straight
// from that spec — so this module is written against OB rather than anything
// Nedbank-specific, and the same code would serve another OB bank.
//
// Everything here is pure so it can be tested without credentials, which
// matters: production access is granted by Nedbank on approval, so the mapping
// has to be provably right BEFORE there is a live connection to try it on.
import { round2 } from './compute';

export interface ObAmount {
  Amount?: string | number;
  Currency?: string;
}

export interface ObTransaction {
  AccountId?: string;
  TransactionId?: string;
  TransactionReference?: string;
  Amount?: ObAmount;
  CreditDebitIndicator?: string;
  Status?: string;
  BookingDateTime?: string;
  ValueDateTime?: string;
  TransactionInformation?: string;
  Balance?: { Amount?: ObAmount; CreditDebitIndicator?: string; Type?: string };
  [k: string]: unknown;
}

export interface ObAccount {
  AccountId?: string;
  Currency?: string;
  AccountType?: string;
  AccountSubType?: string;
  Nickname?: string;
  Account?: { Identification?: string; Name?: string; SchemeName?: string }[];
  [k: string]: unknown;
}

export interface FeedRow {
  providerTxId: string;
  bookedOn: string; // YYYY-MM-DD
  amount: number; // always positive
  direction: 'credit' | 'debit';
  description: string;
  reference: string | null;
  balanceAfter: number | null;
  raw: ObTransaction;
}

/**
 * OB amounts arrive as strict decimal strings ("1932.07").
 *
 * Parsing is deliberately STRICT. An earlier version stripped spaces and
 * commas to be forgiving, which turned "1 932,07" into 193207 — a hundredfold
 * overstatement posted silently. Anything that is not a plain decimal is
 * rejected as null, and the caller reports it as skipped where a human can
 * see it, rather than guessing at a separator convention the spec does not
 * allow.
 */
export function obAmount(a: ObAmount | undefined): number | null {
  if (!a || a.Amount == null) return null;
  if (typeof a.Amount === 'number') return isFinite(a.Amount) ? round2(a.Amount) : null;
  const raw = String(a.Amount).trim();
  if (!/^[+-]?\d+(\.\d+)?$/.test(raw)) return null;
  const n = Number(raw);
  return isFinite(n) ? round2(n) : null;
}

/**
 * The booking date as the BANK stated it.
 *
 * Deliberately takes the leading date components rather than parsing through
 * Date: an ISO instant like 2026-08-08T23:00:00+02:00 would shift to the 8th
 * or 9th depending on the reader's timezone, and a statement line must not
 * move date because of where someone opened the app.
 */
export function obDate(s: string | undefined): string | null {
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const [, y, mo, d] = m;
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${y}-${mo}-${d}`;
}

/** Signed closing balance: OB states the sign separately from the magnitude. */
export function obBalance(t: ObTransaction): number | null {
  const v = obAmount(t.Balance?.Amount);
  if (v == null) return null;
  return t.Balance?.CreditDebitIndicator?.toLowerCase() === 'debit' ? -Math.abs(v) : Math.abs(v);
}

const isCredit = (ind: string | undefined) => (ind ?? '').toLowerCase().startsWith('credit');

/**
 * Pull the transaction array out of the envelope.
 * The OB schema names it `Transaction`; implementations vary and some emit
 * `Transactions`, so both are accepted rather than silently returning nothing.
 */
export function obTransactionList(payload: unknown): ObTransaction[] {
  const data = (payload as { Data?: Record<string, unknown> } | null)?.Data;
  if (!data) return [];
  const list = data.Transaction ?? data.Transactions;
  return Array.isArray(list) ? (list as ObTransaction[]) : [];
}

export function obAccountList(payload: unknown): ObAccount[] {
  const data = (payload as { Data?: Record<string, unknown> } | null)?.Data;
  if (!data) return [];
  const list = data.Account ?? data.Accounts;
  return Array.isArray(list) ? (list as ObAccount[]) : [];
}

export interface MapResult {
  rows: FeedRow[];
  /** Entries that could not be mapped, with the reason — never dropped silently. */
  skipped: { reason: string; transaction: ObTransaction }[];
}

/**
 * Map an OB transactions payload to feed rows.
 *
 * Only `Booked` entries are taken. A pending authorisation can change amount
 * or vanish entirely, and posting one would put a figure in the books that the
 * bank has not committed to.
 */
export function mapTransactions(payload: unknown): MapResult {
  const rows: FeedRow[] = [];
  const skipped: { reason: string; transaction: ObTransaction }[] = [];

  for (const t of obTransactionList(payload)) {
    const status = (t.Status ?? 'Booked').toLowerCase();
    if (status !== 'booked') {
      skipped.push({ reason: `status is ${t.Status}, not Booked`, transaction: t });
      continue;
    }
    const id = (t.TransactionId ?? '').trim();
    if (!id) {
      skipped.push({ reason: 'no TransactionId to deduplicate on', transaction: t });
      continue;
    }
    const bookedOn = obDate(t.BookingDateTime ?? t.ValueDateTime);
    if (!bookedOn) {
      skipped.push({ reason: 'no readable BookingDateTime', transaction: t });
      continue;
    }
    const amount = obAmount(t.Amount);
    if (amount == null || amount === 0) {
      skipped.push({ reason: 'no readable amount', transaction: t });
      continue;
    }
    const description = (t.TransactionInformation ?? t.TransactionReference ?? '').trim().replace(/\s+/g, ' ');
    rows.push({
      providerTxId: id,
      bookedOn,
      // OB carries the sign in CreditDebitIndicator, so a negative magnitude
      // would double-count the direction.
      amount: Math.abs(amount),
      direction: isCredit(t.CreditDebitIndicator) ? 'credit' : 'debit',
      description,
      reference: (t.TransactionReference ?? '').trim() || null,
      balanceAfter: obBalance(t),
      raw: t,
    });
  }
  return { rows, skipped };
}

/** A human label for an OB account, for the connection picker. */
export function accountLabel(a: ObAccount): string {
  const ident = a.Account?.[0]?.Identification ?? '';
  const name = a.Nickname ?? a.Account?.[0]?.Name ?? a.AccountSubType ?? 'Account';
  const masked = ident.length > 4 ? `••••${ident.slice(-4)}` : ident;
  return masked ? `${name} (${masked})` : name;
}

/** Feed direction to the app's transaction kind. */
export const directionToKind = (d: 'credit' | 'debit'): 'income' | 'expense' =>
  d === 'credit' ? 'income' : 'expense';
