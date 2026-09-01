// Bank statement CSV parsing. Written against real Standard Bank exports:
// descriptions like "ANTHROPIC* CLAUDE SUB ANTHROPIC.COM US", cross-border
// fees on their own line, SA number formatting, and either a single signed
// amount column or separate debit/credit columns.
//
// Everything here is pure and covered by scripts/logic-tests.ts.
import type { Category, ImportRule, Tx } from '../types';

// ---------------------------------------------------------------- delimited parsing

export interface ParsedTable {
  headers: string[];
  rows: string[][];
  delimiter: string;
}

/** RFC4180-style split: honours quotes, embedded delimiters and newlines. */
export function splitDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const src = text.replace(/^﻿/, ''); // strip BOM
  while (i < src.length) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      quoted = true;
      i++;
      continue;
    }
    if (c === delimiter) {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (c === '\r') {
      i++;
      continue;
    }
    if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
      continue;
    }
    field += c;
    i++;
  }
  row.push(field);
  rows.push(row);
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

/** Picks the delimiter that yields the most consistent column count. */
export function detectDelimiter(text: string): string {
  const sample = text.split(/\r?\n/).slice(0, 20).join('\n');
  let best = ',';
  let bestScore = -1;
  for (const d of [',', ';', '\t', '|']) {
    const rows = splitDelimited(sample, d);
    if (rows.length === 0) continue;
    const counts = rows.map((r) => r.length);
    const mode = counts.sort((a, b) => a - b)[Math.floor(counts.length / 2)];
    if (mode < 2) continue;
    const consistent = counts.filter((c) => c === mode).length;
    const score = mode * 10 + consistent;
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

/**
 * Finds the header row. Bank exports often carry a few preamble lines
 * ("Statement for account …") before the real header, so the first row with
 * the modal column count and at least one recognisable column name wins.
 */
export function parseStatement(text: string): ParsedTable {
  const delimiter = detectDelimiter(text);
  const all = splitDelimited(text, delimiter);
  if (all.length === 0) return { headers: [], rows: [], delimiter };
  const counts = all.map((r) => r.length);
  const modal = counts.slice().sort((a, b) => a - b)[Math.floor(counts.length / 2)];
  let headerIdx = all.findIndex(
    (r) => r.length === modal && r.some((c) => /date|amount|description|debit|credit|narrative|detail/i.test(c)),
  );
  if (headerIdx < 0) headerIdx = all.findIndex((r) => r.length === modal);
  if (headerIdx < 0) headerIdx = 0;
  const headers = all[headerIdx].map((h) => h.trim());
  const rows = all.slice(headerIdx + 1).filter((r) => r.length >= Math.min(2, modal));
  return { headers, rows, delimiter };
}

// ---------------------------------------------------------------- value parsing

export type DateFormat = 'auto' | 'dmy' | 'mdy' | 'ymd';

const MONTHS3 = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const clampYear = (y: number) => (y < 100 ? (y >= 70 ? 1900 + y : 2000 + y) : y);

function build(y: number, m: number, d: number): string | null {
  if (!y || !m || !d || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const yy = clampYear(y);
  if (d > new Date(Date.UTC(yy, m, 0)).getUTCDate()) return null;
  return `${String(yy).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Parses the date shapes SA bank exports actually use. */
export function parseDateFlexible(raw: string, fmt: DateFormat = 'auto'): string | null {
  const s = (raw ?? '').trim();
  if (!s) return null;

  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/); // 2026-03-01
  if (m) return build(Number(m[1]), Number(m[2]), Number(m[3]));

  m = s.match(/^(\d{8})$/); // 20260301
  if (m) return build(Number(s.slice(0, 4)), Number(s.slice(4, 6)), Number(s.slice(6, 8)));

  m = s.match(/^(\d{1,2})[\s-]([A-Za-z]{3,})[\s-](\d{2,4})$/); // 01 Mar 2026
  if (m) {
    const mi = MONTHS3.indexOf(m[2].slice(0, 3).toLowerCase());
    if (mi >= 0) return build(Number(m[3]), mi + 1, Number(m[1]));
  }

  m = s.match(/^([A-Za-z]{3,})[\s-](\d{1,2}),?[\s-](\d{2,4})$/); // Mar 1, 2026
  if (m) {
    const mi = MONTHS3.indexOf(m[1].slice(0, 3).toLowerCase());
    if (mi >= 0) return build(Number(m[3]), mi + 1, Number(m[2]));
  }

  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/); // 01/03/2026 — ambiguous
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const y = Number(m[3]);
    if (fmt === 'mdy') return build(y, a, b);
    if (fmt === 'dmy') return build(y, b, a);
    // auto: the unambiguous reading wins, else day-first (SA convention)
    if (a > 12 && b <= 12) return build(y, b, a);
    if (b > 12 && a <= 12) return build(y, a, b);
    return build(y, b, a);
  }
  return null;
}

/**
 * Scans a column of dates and reports whether it is unambiguously day-first
 * or month-first, so the UI can preselect the right format and say why.
 */
export function detectDateFormat(samples: string[]): DateFormat {
  let dmy = 0;
  let mdy = 0;
  for (const s of samples) {
    const m = (s ?? '').trim().match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
    if (!m) continue;
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a > 12 && b <= 12) dmy++;
    else if (b > 12 && a <= 12) mdy++;
  }
  if (dmy && !mdy) return 'dmy';
  if (mdy && !dmy) return 'mdy';
  return 'auto';
}

/**
 * Money as banks write it: "1 234,56", "1,234.56", "R 500.00", "(120.00)",
 * "120.00-" (trailing minus is common in SA exports), "" → null.
 */
export function parseMoneyLoose(raw: string): number | null {
  let s = (raw ?? '').replace(/[\s  ]/g, '').replace(/^[A-Za-z]{0,3}\$?R?/i, '');
  s = s.replace(/[Rr](?=[\d(.,-])/, '');
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1);
  }
  if (/-$/.test(s)) {
    neg = true;
    s = s.slice(0, -1);
  }
  if (/^-/.test(s)) {
    neg = true;
    s = s.slice(1);
  }
  if (/^\+/.test(s)) s = s.slice(1);
  s = s.replace(/[^\d.,]/g, '');
  if (!s || !/\d/.test(s)) return null;

  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    // whichever separator comes last is the decimal point
    if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (lastComma >= 0) {
    // a lone comma is decimal only when it sits 1-2 digits from the end
    s = s.length - lastComma - 1 <= 2 ? s.replace(',', '.') : s.replace(/,/g, '');
  } else if (lastDot >= 0) {
    if (s.length - lastDot - 1 > 2) s = s.replace(/\./g, '');
  }
  const n = Number(s);
  if (!isFinite(n)) return null;
  return Math.round((neg ? -n : n) * 100) / 100;
}

// ---------------------------------------------------------------- column mapping

export interface ColumnMapping {
  date: number;
  description: number;
  amount: number; // single signed column; -1 when using debit/credit
  debit: number;
  credit: number;
}

const findCol = (headers: string[], re: RegExp, skip: number[] = []) =>
  headers.findIndex((h, i) => !skip.includes(i) && re.test(h));

/** Best-guess column mapping from the header names, then from the values. */
export function detectColumns(table: ParsedTable): ColumnMapping {
  const h = table.headers;
  let date = findCol(h, /^(transaction\s*)?date|posting.?date|value.?date/i);
  let description = findCol(h, /descr|narrat|detail|payee|reference|memo|particular/i);
  const debit = findCol(h, /debit|money\s*out|withdraw|payment.?out/i);
  const credit = findCol(h, /credit|money\s*in|deposit|payment.?in/i);
  let amount = debit >= 0 && credit >= 0 ? -1 : findCol(h, /amount|value/i, [findCol(h, /balance/i)]);

  // Fall back to sniffing the values when headers are unhelpful.
  const sample = table.rows.slice(0, 25);
  const colCount = Math.max(h.length, ...sample.map((r) => r.length), 0);
  if (date < 0) {
    for (let c = 0; c < colCount; c++) {
      const hits = sample.filter((r) => parseDateFlexible(r[c] ?? '')).length;
      if (hits >= Math.max(1, Math.floor(sample.length * 0.6))) {
        date = c;
        break;
      }
    }
  }
  if (amount < 0 && debit < 0 && credit < 0) {
    let bestCol = -1;
    let bestHits = 0;
    for (let c = 0; c < colCount; c++) {
      if (c === date) continue;
      if (/balance/i.test(h[c] ?? '')) continue;
      const hits = sample.filter((r) => parseMoneyLoose(r[c] ?? '') != null).length;
      if (hits > bestHits) {
        bestHits = hits;
        bestCol = c;
      }
    }
    if (bestHits >= Math.max(1, Math.floor(sample.length * 0.6))) amount = bestCol;
  }
  if (description < 0) {
    let bestCol = -1;
    let bestLen = 0;
    for (let c = 0; c < colCount; c++) {
      if (c === date || c === amount || c === debit || c === credit) continue;
      const avg = sample.reduce((s, r) => s + (r[c] ?? '').trim().length, 0) / Math.max(1, sample.length);
      if (avg > bestLen) {
        bestLen = avg;
        bestCol = c;
      }
    }
    if (bestLen > 3) description = bestCol;
  }
  return { date, description, amount, debit, credit };
}

// ---------------------------------------------------------------- rows

export interface ImportRow {
  index: number;
  date: string;
  description: string;
  amount: number; // always positive
  kind: 'income' | 'expense';
  categoryId: string | null;
  payee: string;
  include: boolean;
  duplicate: boolean;
  matchedRule: string | null;
}

export interface BuildOptions {
  dateFormat: DateFormat;
  /** Some exports write debits as positive in a single column. */
  flipSigns: boolean;
}

export interface BuildResult {
  rows: ImportRow[];
  skipped: number;
}

export function buildImportRows(table: ParsedTable, map: ColumnMapping, opts: BuildOptions): BuildResult {
  const rows: ImportRow[] = [];
  let skipped = 0;
  table.rows.forEach((raw, i) => {
    const date = parseDateFlexible(raw[map.date] ?? '', opts.dateFormat);
    let signed: number | null = null;
    if (map.amount >= 0) {
      signed = parseMoneyLoose(raw[map.amount] ?? '');
    } else {
      const d = map.debit >= 0 ? parseMoneyLoose(raw[map.debit] ?? '') : null;
      const c = map.credit >= 0 ? parseMoneyLoose(raw[map.credit] ?? '') : null;
      if (d != null && Math.abs(d) > 0) signed = -Math.abs(d);
      else if (c != null && Math.abs(c) > 0) signed = Math.abs(c);
    }
    if (!date || signed == null || signed === 0) {
      skipped++;
      return;
    }
    if (opts.flipSigns) signed = -signed;
    const description = (raw[map.description] ?? '').trim().replace(/\s+/g, ' ');
    rows.push({
      index: i,
      date,
      description,
      amount: Math.abs(signed),
      kind: signed < 0 ? 'expense' : 'income',
      categoryId: null,
      payee: description,
      include: true,
      duplicate: false,
      matchedRule: null,
    });
  });
  return { rows, skipped };
}

// ---------------------------------------------------------------- rules & duplicates

/** Longest match_text wins, so a specific rule beats a general one. */
export function applyRules(rows: ImportRow[], rules: ImportRule[], categories: Category[]): ImportRow[] {
  const live = new Set(categories.filter((c) => !c.archived).map((c) => c.id));
  const sorted = rules.slice().sort((a, b) => b.match_text.length - a.match_text.length);
  return rows.map((r) => {
    const hay = r.description.toLowerCase();
    const hit = sorted.find((rule) => hay.includes(rule.match_text.trim().toLowerCase()));
    if (!hit) return r;
    return {
      ...r,
      categoryId: hit.category_id && live.has(hit.category_id) ? hit.category_id : r.categoryId,
      payee: hit.payee?.trim() ? hit.payee.trim() : r.payee,
      matchedRule: hit.match_text,
    };
  });
}

/**
 * Flags rows that look like a transaction already on file for this account
 * (same date, same amount, same direction) — the overlapping-statement case.
 * Flagged rows are unticked but still shown, because two identical purchases
 * on one day are a real thing.
 */
export function markDuplicates(rows: ImportRow[], existing: Tx[], accountId: string): ImportRow[] {
  const seen = new Map<string, number>();
  for (const t of existing) {
    if (t.account_id !== accountId) continue;
    if (t.kind === 'transfer') continue;
    const key = `${t.tx_date}|${t.kind}|${t.amount.toFixed(2)}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return rows.map((r) => {
    const key = `${r.date}|${r.kind}|${r.amount.toFixed(2)}`;
    const left = seen.get(key) ?? 0;
    if (left <= 0) return r;
    seen.set(key, left - 1); // one flag per existing row, not per match
    return { ...r, duplicate: true, include: false };
  });
}

const NOISE = /^(pos|card|purchase|payment|debit|credit|order|ref|www|the|and|for|from|za|us|ie|gb)$/i;

/** A sensible starting match text for a "remember this" rule. */
export function suggestMatchText(description: string): string {
  const tokens = description
    .split(/\s+/)
    .map((t) => t.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9./]+$/g, ''))
    .filter((t) => t.length >= 3 && /[A-Za-z]/.test(t) && !NOISE.test(t));
  if (tokens.length === 0) return description.slice(0, 20).trim();
  if (tokens[0].length >= 5) return tokens[0];
  return tokens.slice(0, 2).join(' ');
}
