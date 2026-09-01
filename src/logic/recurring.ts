// Recurring-series date maths. Pure, string-in/string-out on YYYY-MM-DD so
// nothing here can drift with the browser timezone.
import type { Frequency, RecurringRule } from '../types';

const dim = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

function parts(dateStr: string): [number, number, number] {
  return [Number(dateStr.slice(0, 4)), Number(dateStr.slice(5, 7)), Number(dateStr.slice(8, 10))];
}

const iso = (y: number, m: number, d: number) =>
  `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

export function addDays(dateStr: string, n: number): string {
  const [y, m, d] = parts(dateStr);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/**
 * Add whole months, clamping the day to the target month's length but keeping
 * the series anchored: a 31st series goes 31 Jan → 28 Feb → 31 Mar, never
 * collapsing to the 28th permanently.
 */
export function addMonthsClamped(dateStr: string, months: number, anchorDay: number): string {
  const [y, m] = parts(dateStr);
  const total = (y * 12 + (m - 1)) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return iso(ny, nm, Math.min(anchorDay, dim(ny, nm)));
}

/** The occurrence following `dateStr` for this frequency. */
export function advanceDate(dateStr: string, frequency: Frequency, anchorDay: number): string {
  switch (frequency) {
    case 'weekly':
      return addDays(dateStr, 7);
    case 'fortnightly':
      return addDays(dateStr, 14);
    case 'monthly':
      return addMonthsClamped(dateStr, 1, anchorDay);
    case 'quarterly':
      return addMonthsClamped(dateStr, 3, anchorDay);
    case 'annually':
      return addMonthsClamped(dateStr, 12, anchorDay);
  }
}

/**
 * Every occurrence that is owed on or before `today` — so a series missed for
 * three months surfaces as three separate postings to confirm, not one.
 * Capped so a corrupt next_date can never spin.
 */
export function dueDates(rule: RecurringRule, today: string, cap = 36): string[] {
  if (rule.archived) return [];
  const out: string[] = [];
  let d = rule.next_date;
  while (d <= today && out.length < cap) {
    if (rule.end_date && d > rule.end_date) break;
    out.push(d);
    d = advanceDate(d, rule.frequency, rule.anchor_day);
  }
  return out;
}

/** True once the series has run past its end date. */
export function isFinished(rule: RecurringRule): boolean {
  return !!rule.end_date && rule.next_date > rule.end_date;
}

export const FREQUENCY_LABEL: Record<Frequency, string> = {
  weekly: 'Weekly',
  fortnightly: 'Every 2 weeks',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  annually: 'Yearly',
};
