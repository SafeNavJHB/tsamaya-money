// Money and date formatting. Display style follows SA banking apps:
// "R 12 345.67" — space thousands, dot decimals. Exports write raw numbers
// (never formatted strings) so spreadsheets parse them natively.

export function fmtMoney(n: number): string {
  const neg = n < -0.004; // treat -0.00 as zero
  const [int, dec] = Math.abs(n).toFixed(2).split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${neg ? '-' : ''}R ${grouped}.${dec}`;
}

/** Like fmtMoney but with an explicit + for positive values (deltas). */
export function fmtMoneySigned(n: number): string {
  return n > 0.004 ? `+${fmtMoney(n)}` : fmtMoney(n);
}

/** Compact form for chart labels: R 12.3k / R 1.2m. */
export function fmtMoneyCompact(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1_000_000) return `${sign}R ${(abs / 1_000_000).toFixed(1)}m`;
  if (abs >= 10_000) return `${sign}R ${(abs / 1000).toFixed(0)}k`;
  if (abs >= 1_000) return `${sign}R ${(abs / 1000).toFixed(1)}k`;
  return `${sign}R ${abs.toFixed(0)}`;
}

/** Parse a typed amount: accepts "1 234,56", "1234.56", "R 500", "1,234.56". */
export function parseAmount(raw: string): number | null {
  let s = raw.replace(/[Rr\s  ]/g, '');
  if (!s) return null;
  if (/,\d{1,2}$/.test(s) && !/\.\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  const n = Number(s);
  if (!isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

// ---- date helpers (all on plain YYYY-MM-DD strings) ----

export function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export const monthKey = (dateStr: string) => dateStr.slice(0, 7);

export function daysInMonth(mk: string): number {
  const y = Number(mk.slice(0, 4));
  const m = Number(mk.slice(5, 7));
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export const monthStart = (mk: string) => `${mk}-01`;
export const monthEnd = (mk: string) => `${mk}-${String(daysInMonth(mk)).padStart(2, '0')}`;

export function addMonths(mk: string, delta: number): string {
  const y = Number(mk.slice(0, 4));
  const m = Number(mk.slice(5, 7)) - 1 + delta;
  const yy = y + Math.floor(m / 12);
  const mm = ((m % 12) + 12) % 12;
  return `${yy}-${String(mm + 1).padStart(2, '0')}`;
}

/** The last n month keys ending at `end` (inclusive), ascending. */
export function lastNMonths(n: number, end = monthKey(todayStr())): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(addMonths(end, -i));
  return out;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function monthLabel(mk: string): string {
  return `${MONTHS[Number(mk.slice(5, 7)) - 1]} ${mk.slice(0, 4)}`;
}

export function monthLabelShort(mk: string): string {
  return MONTHS[Number(mk.slice(5, 7)) - 1];
}

export function fmtDate(dateStr: string): string {
  return `${Number(dateStr.slice(8, 10))} ${MONTHS[Number(dateStr.slice(5, 7)) - 1]} ${dateStr.slice(0, 4)}`;
}
