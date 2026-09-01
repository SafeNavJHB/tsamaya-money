// Notes to the financial statements — IFRS for SMEs Section 8.
//
// Split deliberately in two:
//   - the FIGURES are computed here from the ledger, so a note can never
//     disagree with the face of the statement it supports;
//   - the WORDS are stored in fin_notes and edited by the preparer, because an
//     accounting policy and a going-concern conclusion are professional
//     judgements that must not be generated.
//
// Section 8.4 requires the notes to be cross-referenced from the face of the
// statements and presented in a systematic order; supporting notes follow the
// order the statements present the items (8.5(c)).
import { round2 } from './compute';
import { DIVIDENDS, SHARE_CAPITAL, balanceAt } from './ledger';
import type { LedgerBook } from './ledger';
import { isCashAccount } from './cashflow';
import type { AllData } from '../types';

export interface NoteScheduleRow {
  caption: string;
  current: number;
  prior: number;
  isTotal?: boolean;
}

export interface NoteSchedule {
  key: string;
  title: string;
  rows: NoteScheduleRow[];
  /** Extra explanatory sentences the figures themselves imply. */
  commentary?: string[];
}

const dayBefore = (d: string): string => {
  const t = new Date(Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)) - 1));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
};

/**
 * The computed note schedules for a financial year, in statement order.
 * Only notes with something to say are returned.
 */
export function noteSchedules(book: LedgerBook, data: AllData, from: string, to: string): NoteSchedule[] {
  const priorEnd = dayBefore(from);
  const priorStart = `${Number(from.slice(0, 4)) - 1}${from.slice(4)}`;
  const out: NoteSchedule[] = [];

  const at = (key: string, d: string) => balanceAt(book, key, d);

  // ---- Property, plant and equipment (Section 17.31 movement schedule) ----
  const ppe = data.assets.filter((a) => a.side === 'asset' && !a.archived);
  const ppeKeys = ppe.map((a) => `ast:${a.id}`);
  if (ppeKeys.some((k) => at(k, to) !== 0 || at(k, priorEnd) !== 0)) {
    const opening = round2(ppeKeys.reduce((s, k) => s + at(k, priorEnd), 0));
    const closing = round2(ppeKeys.reduce((s, k) => s + at(k, to), 0));
    const additions = round2(
      book.postings
        .filter((p) => ppeKeys.includes(p.key) && p.date >= from && p.date <= to)
        .reduce((s, p) => s + p.debit, 0),
    );
    const disposals = round2(
      book.postings
        .filter((p) => ppeKeys.includes(p.key) && p.date >= from && p.date <= to)
        .reduce((s, p) => s + p.credit, 0),
    );
    out.push({
      key: 'ppe',
      title: 'Property, plant and equipment',
      rows: [
        { caption: 'Carrying amount at the beginning of the year', current: opening, prior: 0 },
        { caption: 'Additions', current: additions, prior: 0 },
        ...(disposals ? [{ caption: 'Disposals', current: -disposals, prior: 0 }] : []),
        { caption: 'Carrying amount at the end of the year', current: closing, prior: opening, isTotal: true },
      ],
      commentary: [
        'Assets are carried at cost. No depreciation has been recognised because the app does not yet maintain a depreciation register — useful lives and residual values must be assessed and depreciation raised before the statements are issued.',
        ...ppe
          .filter((a) => data.valuations.some((v) => v.asset_id === a.id))
          .map((a) => {
            const v = data.valuations
              .filter((x) => x.asset_id === a.id && x.val_date <= to)
              .sort((x, y) => y.val_date.localeCompare(x.val_date))[0];
            return v
              ? `${a.name} was valued at R${v.value.toFixed(2)} on ${v.val_date}. This is a memorandum figure only and is not reflected above, which is stated at cost.`
              : '';
          })
          .filter(Boolean),
      ],
    });
  }

  // ---- Other balance-sheet accounts, grouped by presentation caption ----
  const byCaption = new Map<string, { keys: string[]; current: number; prior: number }>();
  for (const a of data.accounts) {
    if (isCashAccount(a)) continue;
    const key = `acc:${a.id}`;
    const cur = at(key, to);
    const pri = at(key, priorEnd);
    if (cur === 0 && pri === 0) continue;
    const cap = a.bs_line || a.name;
    const slot = byCaption.get(cap) ?? { keys: [], current: 0, prior: 0 };
    slot.keys.push(key);
    slot.current = round2(slot.current + cur);
    slot.prior = round2(slot.prior + pri);
    byCaption.set(cap, slot);
  }
  for (const [caption, v] of byCaption) {
    out.push({
      key: `bs:${caption}`,
      title: caption,
      rows: [{ caption, current: Math.abs(v.current), prior: Math.abs(v.prior), isTotal: true }],
      commentary:
        v.current < 0
          ? ['This balance is a liability of the company at the reporting date.']
          : ['This balance is an asset of the company at the reporting date.'],
    });
  }

  // ---- Share capital (Section 4.12(a)) ----
  const shareNow = round2(-at(SHARE_CAPITAL, to));
  const sharePrior = round2(-at(SHARE_CAPITAL, priorEnd));
  const sharesIssued = data.equity
    .filter((e) => e.kind === 'share_issue' && e.mv_date <= to)
    .reduce((s, e) => s + (e.shares_issued ?? 0), 0);
  out.push({
    key: 'share_capital',
    title: 'Share capital',
    rows: [{ caption: 'Issued share capital', current: shareNow, prior: sharePrior, isTotal: true }],
    commentary:
      shareNow === 0
        ? [
            'No share capital has been recorded. The subscription per the Memorandum of Incorporation (CoR15.1) must be captured before these statements are issued.',
          ]
        : [
            `${sharesIssued > 0 ? `${sharesIssued} ordinary shares have been issued and are ` : 'The issued shares are '}fully recorded at the subscription amount.`,
          ],
  });

  // ---- Cash and cash equivalents (Section 7.20) ----
  const cash = data.accounts.filter(isCashAccount);
  if (cash.length) {
    out.push({
      key: 'cash',
      title: 'Cash and cash equivalents',
      rows: [
        ...cash.map((a) => ({ caption: a.name, current: at(`acc:${a.id}`, to), prior: at(`acc:${a.id}`, priorEnd) })),
        {
          caption: 'Total',
          current: round2(cash.reduce((s, a) => s + at(`acc:${a.id}`, to), 0)),
          prior: round2(cash.reduce((s, a) => s + at(`acc:${a.id}`, priorEnd), 0)),
          isTotal: true,
        },
      ],
    });
  }

  // ---- Related party balances and transactions (Section 33) ----
  const rpAccounts = data.accounts.filter((a) => (a.cf_class ?? '') === 'financing' && !isCashAccount(a));
  if (rpAccounts.length) {
    const rows: NoteScheduleRow[] = rpAccounts.map((a) => ({
      caption: `${a.bs_line || a.name} — balance owing at year end`,
      current: Math.abs(at(`acc:${a.id}`, to)),
      prior: Math.abs(at(`acc:${a.id}`, priorEnd)),
    }));
    const funded = round2(
      rpAccounts.reduce(
        (s, a) =>
          s +
          book.postings
            .filter((p) => p.key === `acc:${a.id}` && p.date >= from && p.date <= to)
            .reduce((t, p) => t + p.credit - p.debit, 0),
        0,
      ),
    );
    // "Funded" rather than "expenses": the movement includes amounts settled on
    // the company's behalf that were not expenses, such as a prepaid deposit.
    rows.push({ caption: 'Amounts funded by the related party during the year', current: funded, prior: 0 });
    out.push({
      key: 'related_party_amounts',
      title: 'Related party balances',
      rows,
      commentary: [
        'Amounts owing to the director arise from company costs settled personally by the director. Terms of repayment are disclosed in the related party note.',
      ],
    });
  }

  // ---- Dividends ----
  const div = round2(at(DIVIDENDS, to) - at(DIVIDENDS, priorEnd));
  if (div !== 0) {
    out.push({
      key: 'dividends',
      title: 'Dividends',
      rows: [{ caption: 'Dividends declared during the year', current: div, prior: 0, isTotal: true }],
    });
  }

  void priorStart;
  return out;
}
