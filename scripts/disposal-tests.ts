// Asset disposals (Section 17.27-17.30) and manual journal entries.
// Run by `npm test`; CI gates the deploy on it.
import {
  GAIN_ON_DISPOSAL,
  LOSS_ON_DISPOSAL,
  DISPOSAL_RECEIVABLE,
  accDeprKey,
  balanceAt,
  buildBook,
  profitForPeriod,
  trialBalance,
} from '../src/logic/ledger';
import { financialYearFor, sofp } from '../src/logic/statements';
import { cashflowStatement } from '../src/logic/cashflow';
import { noteSchedules } from '../src/logic/notes';
import { dueDepreciation } from '../src/logic/depreciation';
import { round2 } from '../src/logic/compute';
import type { AllData, Asset, DepreciationCharge, Disposal, Journal, Settings, Tx } from '../src/types';

let failures = 0;
function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) console.log(`  ok  ${label}`);
  else {
    failures++;
    console.error(`FAIL  ${label}\n      expected ${e}\n      got      ${a}`);
  }
}
function ok(cond: boolean, label: string) {
  if (cond) console.log(`  ok  ${label}`);
  else {
    failures++;
    console.error(`FAIL  ${label}`);
  }
}

const settings: Settings = { entity_name: 'TEST (PTY) LTD', registration_number: null, fy_end_month: 2 };
const laptop: Asset = {
  id: 'laptop', name: 'Laptop', side: 'asset', category: 'other', notes: null, sort: 0, archived: false,
  bs_line: 'Property, plant and equipment', is_current: false, cf_class: 'investing',
  depreciate: true, depr_method: 'straight_line', useful_life_months: 36, residual_value: 0,
  depr_start: '2026-03-01', asset_class: 'Computer equipment',
};
const bank = {
  id: 'bank', name: 'Bank', kind: 'bank' as const, opening_balance: 0, sort: 0, archived: false,
  bs_line: 'Cash and cash equivalents', is_current: true, is_cash: true, cf_class: 'operating' as const,
};
const tx = (p: Partial<Tx> & Pick<Tx, 'tx_date' | 'kind' | 'amount' | 'account_id'>): Tx => ({
  id: `t-${p.tx_date}-${p.amount}`, category_id: null, transfer_account_id: null, payee: null, notes: null,
  created_at: '2026-01-01T00:00:00Z', ...p,
});

const fy = financialYearFor('2026-09-01', 2); // 2026-03-01 -> 2027-02-28

// Cost 36 000 over 36 months = 1 000/month. Six charges (Mar-Aug), so the
// carrying amount at 1 Sep 2026 is 30 000.
const charges: DepreciationCharge[] = ['03', '04', '05', '06', '07', '08'].map((m) => ({
  id: `d${m}`, asset_id: 'laptop', period_end: `2026-${m}-${m === '04' || m === '06' ? '30' : '31'}`,
  amount: 1000, method: 'straight_line', basis: null,
}));

const baseData: AllData = {
  accounts: [bank], categories: [], assets: [laptop], valuations: [],
  transactions: [tx({ tx_date: '2026-03-01', kind: 'expense', amount: 36000, account_id: 'bank', asset_id: 'laptop' })],
  recurring: [], importRules: [], equity: [], settings, notes: [],
  depreciation: charges, disposals: [], journals: [],
};

function withDisposal(proceeds: number, intoCash = true): AllData {
  const disposal: Disposal = {
    id: 'dsp1', asset_id: 'laptop', disposal_date: '2026-09-01', proceeds,
    proceeds_account_id: intoCash ? 'bank' : null, notes: 'Sold to a colleague',
  };
  return { ...baseData, disposals: [disposal] };
}

// ---------------------------------------------------------------- gain
console.log('disposal at a gain');
// carrying 30 000, proceeds 34 000 -> gain 4 000
const gainData = withDisposal(34000);
const gBook = buildBook(gainData);
ok(trialBalance(gBook, fy.from, fy.to).balanced, 'the disposal entry balances');
eq(balanceAt(gBook, 'ast:laptop', fy.to), 0, 'cost is removed from the asset');
eq(balanceAt(gBook, accDeprKey('laptop'), fy.to), 0, 'accumulated depreciation is removed');
eq(balanceAt(gBook, GAIN_ON_DISPOSAL, fy.to), -4000, 'the gain is credited to income');
eq(balanceAt(gBook, LOSS_ON_DISPOSAL, fy.to), 0, 'no loss is raised on a gain');
eq(balanceAt(gBook, 'acc:bank', fy.to), round2(-36000 + 34000), 'proceeds reach the bank');
const gBs = sofp(gBook, fy.to);
ok(gBs.balanced, `SoFP balances after a disposal (difference ${gBs.difference})`);
eq(gBs.nonCurrentAssets.find((l) => l.caption === 'Property, plant and equipment'), undefined,
  'the disposed asset no longer appears on the balance sheet');
eq(profitForPeriod(gBook, fy.from, fy.to), round2(-6000 + 4000), 'profit is depreciation plus the gain');

// ---------------------------------------------------------------- loss
console.log('\ndisposal at a loss');
// carrying 30 000, proceeds 25 000 -> loss 5 000
const lBook = buildBook(withDisposal(25000));
ok(trialBalance(lBook, fy.from, fy.to).balanced, 'the loss entry balances');
eq(balanceAt(lBook, LOSS_ON_DISPOSAL, fy.to), 5000, 'the loss is debited to expenses');
eq(balanceAt(lBook, GAIN_ON_DISPOSAL, fy.to), 0, 'no gain is raised on a loss');
ok(sofp(lBook, fy.to).balanced, 'SoFP balances after a loss on disposal');

// scrapped for nothing: the whole carrying amount is the loss
const sBook = buildBook(withDisposal(0));
eq(balanceAt(sBook, LOSS_ON_DISPOSAL, fy.to), 30000, 'scrapping writes off the full carrying amount');
ok(sofp(sBook, fy.to).balanced, 'SoFP balances when an asset is scrapped');

// ---------------------------------------------------------------- proceeds not yet received
console.log('\nproceeds not received in cash');
const rBook = buildBook(withDisposal(34000, false));
eq(balanceAt(rBook, DISPOSAL_RECEIVABLE, fy.to), 34000, 'unreceived proceeds sit as a receivable');
eq(balanceAt(rBook, 'acc:bank', fy.to), -36000, 'no cash moved');
ok(sofp(rBook, fy.to).balanced, 'SoFP balances with a disposal receivable');
const rCf = cashflowStatement(rBook, withDisposal(34000, false), fy.from, fy.to);
ok(rCf.reconciles, `cash flow reconciles when proceeds are not received (difference ${rCf.difference})`);
eq(rCf.closingCash, -36000, 'closing cash excludes proceeds that never arrived');

// ---------------------------------------------------------------- cash flow presentation
console.log('\ncash flow presentation');
const gCf = cashflowStatement(gBook, gainData, fy.from, fy.to);
ok(gCf.reconciles, `cash flow reconciles across a disposal (difference ${gCf.difference})`);
eq(gCf.investing.find((l) => l.caption.startsWith('Proceeds on disposal'))?.amount, 34000,
  'investing shows the proceeds actually received, not the carrying amount');
eq(gCf.operating.find((l) => l.caption.startsWith('Gain on disposal'))?.amount, -4000,
  'the gain is reversed out of operating as a non-cash item');
eq(gCf.closingCash, -2000, 'closing cash is the purchase less the proceeds');
const lCf = cashflowStatement(lBook, withDisposal(25000), fy.from, fy.to);
ok(lCf.reconciles, 'cash flow reconciles on a loss');
eq(lCf.operating.find((l) => l.caption.startsWith('Loss on disposal'))?.amount, 5000,
  'a loss is added back in operating');

// ---------------------------------------------------------------- depreciation stops
console.log('\ndepreciation stops at disposal');
const costAt = (id: string, date: string) =>
  baseData.transactions.filter((t) => t.asset_id === id && t.tx_date <= date).reduce((s, t) => s + t.amount, 0);
eq(dueDepreciation(laptop, charges, costAt, '2027-02-28', '2026-09-01').length, 0,
  'no further charges are raised after the disposal date');
eq(dueDepreciation(laptop, charges, costAt, '2027-02-28', null).length, 6,
  'without a disposal the charges continue');
eq(dueDepreciation(laptop, charges.slice(0, 3), costAt, '2027-02-28', '2026-07-01').length, 1,
  'catch-up before a disposal stops at the disposal date');

// ---------------------------------------------------------------- the note
console.log('\nSection 17.31 note');
const ppe = noteSchedules(gBook, gainData, fy.from, fy.to).find((s) => s.key === 'ppe');
const row = (c: string) => ppe?.rows.find((r) => r.caption === c)?.current;
eq(row('Additions'), 36000, 'additions at cost');
eq(row('Disposals'), -36000, 'the disposal removes cost');
eq(row('Cost at the end of the year'), 0, 'closing cost is nil');
eq(row('Depreciation charge for the year'), -6000, 'the charge excludes the disposal release');
eq(row('Accumulated depreciation on disposals'), 6000, 'accumulated depreciation released on disposal');
eq(row('Accumulated depreciation at the end of the year'), 0, 'closing accumulated depreciation is nil');
eq(row('Carrying amount at the end of the year'), 0, 'nothing is carried forward');
ok((ppe?.commentary ?? []).some((c) => c.includes('disposed of during the year')), 'the note mentions the disposal');

// ---------------------------------------------------------------- journals
console.log('\nmanual journal entries');
const accrual: Journal = {
  id: 'j1', entry_date: '2027-02-28', reference: 'JNL-001', narration: 'Accrue audit fee',
  lines: [
    { id: 'l1', journal_id: 'j1', account_key: 'cat:fees', debit: 5000, credit: 0, line_note: null },
    { id: 'l2', journal_id: 'j1', account_key: 'acc:bank', debit: 0, credit: 5000, line_note: null },
  ],
};
const jData: AllData = {
  ...baseData,
  categories: [{ id: 'fees', name: 'Professional fees', kind: 'expense', monthly_budget: null, sort: 0, archived: false }],
  journals: [accrual],
};
const jBook = buildBook(jData);
ok(trialBalance(jBook, fy.from, fy.to).balanced, 'a journal keeps the trial balance in balance');
eq(balanceAt(jBook, 'cat:fees', fy.to), 5000, 'the debit lands on the expense');
eq(balanceAt(jBook, 'acc:bank', fy.to), -41000, 'the credit lands on the bank');
eq(profitForPeriod(jBook, fy.from, fy.to), -11000, 'the journal flows through profit');
ok(sofp(jBook, fy.to).balanced, 'SoFP balances with a journal posted');
const jCf = cashflowStatement(jBook, jData, fy.from, fy.to);
ok(jCf.reconciles, 'cash flow reconciles with a journal posted');

// a multi-line journal
const split: Journal = {
  id: 'j2', entry_date: '2027-02-28', reference: null, narration: 'Split allocation',
  lines: [
    { id: 'm1', journal_id: 'j2', account_key: 'cat:fees', debit: 300, credit: 0, line_note: null },
    { id: 'm2', journal_id: 'j2', account_key: 'ast:laptop', debit: 700, credit: 0, line_note: null },
    { id: 'm3', journal_id: 'j2', account_key: 'acc:bank', debit: 0, credit: 1000, line_note: null },
  ],
};
const mBook = buildBook({ ...jData, journals: [accrual, split] });
ok(trialBalance(mBook, fy.from, fy.to).balanced, 'a three-line journal balances');
eq(balanceAt(mBook, 'ast:laptop', fy.to), 36700, 'a journal can debit an asset directly');

// an unrecognised account must surface, never be silently dropped
const orphan: Journal = {
  id: 'j3', entry_date: '2027-02-28', reference: null, narration: 'Bad key',
  lines: [
    { id: 'o1', journal_id: 'j3', account_key: 'cat:does-not-exist', debit: 100, credit: 0, line_note: null },
    { id: 'o2', journal_id: 'j3', account_key: 'acc:bank', debit: 0, credit: 100, line_note: null },
  ],
};
const oBook = buildBook({ ...jData, journals: [orphan] });
ok(trialBalance(oBook, fy.from, fy.to).balanced, 'an unknown account key still leaves the books balanced');
ok(
  oBook.accounts.get('cat:does-not-exist')?.name.includes('Unrecognised') ?? false,
  'the unknown account is surfaced by name rather than dropped',
);

if (failures) {
  console.error(`\n${failures} disposal/journal test(s) FAILED`);
  process.exit(1);
}
console.log('\nAll disposal and journal tests passed.');
