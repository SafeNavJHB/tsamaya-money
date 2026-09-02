// Depreciation register assertions — IFRS for SMEs Section 17.
// Run by `npm test`; CI gates the deploy on it.
import { buildBook, balanceAt, accDeprKey, DEPRECIATION_EXPENSE, profitForPeriod } from '../src/logic/ledger';
import { financialYearFor, sofp } from '../src/logic/statements';
import { cashflowStatement } from '../src/logic/cashflow';
import { noteSchedules } from '../src/logic/notes';
import { canDepreciate, dueDepreciation, register } from '../src/logic/depreciation';
import { round2 } from '../src/logic/compute';
import type { AllData, Asset, DepreciationCharge, Settings, Tx } from '../src/types';

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
  depreciate: true, depr_method: 'straight_line', useful_life_months: 36, residual_value: 1000,
  depr_start: '2026-07-01', asset_class: 'Computer equipment',
};
const bank = {
  id: 'bank', name: 'Bank', kind: 'bank' as const, opening_balance: 0, sort: 0, archived: false,
  bs_line: 'Cash and cash equivalents', is_current: true, is_cash: true, cf_class: 'operating' as const,
};
let n = 0;
const tx = (p: Partial<Tx> & Pick<Tx, 'tx_date' | 'kind' | 'amount' | 'account_id'>): Tx => ({
  id: `t${++n}`, category_id: null, transfer_account_id: null, payee: null, notes: null,
  created_at: `2026-01-01T00:00:${String(n).padStart(2, '0')}Z`, ...p,
});

const base: AllData = {
  accounts: [bank], categories: [], assets: [laptop], valuations: [],
  transactions: [tx({ tx_date: '2026-07-01', kind: 'expense', amount: 37000, account_id: 'bank', asset_id: 'laptop' })],
  recurring: [], importRules: [], equity: [], settings, notes: [], depreciation: [], disposals: [], journals: [], bankConnections: [], bankFeed: [],
};
const costAt = (assetId: string, date: string) =>
  base.transactions.filter((t) => t.asset_id === assetId && t.tx_date <= date).reduce((s, t) => s + t.amount, 0);

// ---------------------------------------------------------------- configuration
console.log('configuration');
ok(canDepreciate(laptop), 'a fully configured asset can depreciate');
ok(!canDepreciate({ ...laptop, depreciate: false }), 'not flagged means no depreciation');
ok(!canDepreciate({ ...laptop, depr_start: null }), 'no start date means no depreciation');
ok(!canDepreciate({ ...laptop, useful_life_months: null }), 'straight line needs a useful life');
ok(!canDepreciate({ ...laptop, side: 'liability' }), 'a liability is never depreciated');
ok(!canDepreciate({ ...laptop, archived: true }), 'an archived asset stops depreciating');
ok(
  canDepreciate({ ...laptop, depr_method: 'reducing_balance', useful_life_months: null, depr_rate_pct: 33.3 }),
  'reducing balance needs a rate, not a life',
);

// ---------------------------------------------------------------- straight line
console.log('\nstraight line');
// (37 000 - 1 000) / 36 = 1 000.00 a month
const due = dueDepreciation(laptop, [], costAt, '2027-02-28');
eq(due.length, 8, 'eight monthly charges from July 2026 to February 2027');
eq(due[0].periodEnd, '2026-07-31', 'first charge is the month the asset came into use');
eq(due[0].amount, 1000, 'monthly charge is the depreciable amount over the useful life');
eq(round2(due.reduce((s, d) => s + d.amount, 0)), 8000, 'eight months of charges');
ok(due[0].basis.includes('36 months'), 'the basis records what was applied, for audit');

// no charge before the asset exists or before the start date
eq(dueDepreciation({ ...laptop, depr_start: '2026-09-01' }, [], costAt, '2026-10-31').length, 2,
  'depreciation starts when the asset is available for use, not when bought');
eq(dueDepreciation(laptop, [], () => 0, '2027-02-28').length, 0,
  'an asset with no capitalised cost depreciates nothing');

// already-posted periods are skipped: the catch-up is idempotent
const posted: DepreciationCharge[] = due.slice(0, 3).map((d, i) => ({
  id: `d${i}`, asset_id: 'laptop', period_end: d.periodEnd, amount: d.amount, method: 'straight_line', basis: null,
}));
eq(dueDepreciation(laptop, posted, costAt, '2027-02-28').length, 5, 'already-posted periods are not charged again');
eq(dueDepreciation(laptop, posted, costAt, '2026-09-30').length, 0, 'running the same period twice charges nothing');

// the final charge is capped at the residual value
const full = dueDepreciation(laptop, [], costAt, '2031-12-31');
eq(full.length, 36, 'exactly the useful life in charges, then it stops');
eq(round2(full.reduce((s, d) => s + d.amount, 0)), 36000, 'total charges equal cost less residual');
ok(full.every((d) => d.amount > 0), 'no zero-value charges are produced');

// ---------------------------------------------------------------- reducing balance
console.log('\nreducing balance');
const rb: Asset = { ...laptop, depr_method: 'reducing_balance', useful_life_months: null, depr_rate_pct: 30, residual_value: 0 };
const rbDue = dueDepreciation(rb, [], costAt, '2026-09-30');
// month 1: 37 000 x 30% / 12 = 925.00; month 2 on the reduced carrying amount
eq(rbDue[0].amount, 925, 'first reducing-balance charge is on the full carrying amount');
ok(rbDue[1].amount < rbDue[0].amount, 'the charge falls as the carrying amount reduces');
eq(rbDue[1].amount, round2(((37000 - 925) * 0.3) / 12), 'each charge is on the opening carrying amount');
ok(rbDue.every((d) => d.amount > 0), 'reducing balance never charges zero');

// ---------------------------------------------------------------- ledger integration
console.log('\nledger, statements and cash flows');
const charges: DepreciationCharge[] = due.map((d, i) => ({
  id: `dep${i}`, asset_id: 'laptop', period_end: d.periodEnd, amount: d.amount, method: 'straight_line', basis: d.basis,
}));
const data: AllData = { ...base, depreciation: charges };
const book = buildBook(data);
const fy = financialYearFor('2026-09-01', 2);

eq(balanceAt(book, DEPRECIATION_EXPENSE, fy.to), 8000, 'depreciation is posted as an expense');
eq(balanceAt(book, accDeprKey('laptop'), fy.to), -8000, 'accumulated depreciation carries a credit balance');
eq(balanceAt(book, 'ast:laptop', fy.to), 37000, 'the asset stays at cost; depreciation never touches it');
eq(profitForPeriod(book, fy.from, fy.to), -8000, 'depreciation reduces profit');

const bs = sofp(book, fy.to);
ok(bs.balanced, `SoFP still balances with depreciation (difference ${bs.difference})`);
eq(bs.nonCurrentAssets.find((l) => l.caption === 'Property, plant and equipment')?.amount, 29000,
  'PPE presents at carrying amount, cost less accumulated depreciation');
ok(
  !bs.currentLiabilities.some((l) => l.caption === 'Property, plant and equipment') &&
    !bs.nonCurrentLiabilities.some((l) => l.caption === 'Property, plant and equipment'),
  'accumulated depreciation nets against the asset instead of appearing as a liability',
);

const cf = cashflowStatement(book, data, fy.from, fy.to);
ok(cf.reconciles, `cash flow still reconciles with depreciation (difference ${cf.difference})`);
eq(cf.operating.find((l) => l.caption === 'Adjustment for depreciation')?.amount, 8000,
  'depreciation is added back as a non-cash item in operating activities');
eq(cf.investing.find((l) => l.caption.startsWith('Acquisition'))?.amount, -37000,
  'the asset purchase remains an investing outflow at full cost');
eq(cf.closingCash, -37000, 'closing cash reflects only the cash actually spent');

// ---------------------------------------------------------------- the note
console.log('\nSection 17.31 reconciliation');
const ppe = noteSchedules(book, data, fy.from, fy.to).find((s) => s.key === 'ppe');
ok(!!ppe, 'a PPE note is produced');
const row = (c: string) => ppe?.rows.find((r) => r.caption === c)?.current;
eq(row('Cost at the beginning of the year'), 0, 'opening cost');
eq(row('Additions'), 37000, 'additions at cost');
eq(row('Cost at the end of the year'), 37000, 'closing cost');
eq(row('Accumulated depreciation at the beginning of the year'), 0, 'opening accumulated depreciation');
eq(row('Depreciation charge for the year'), -8000, 'the charge for the year');
eq(row('Accumulated depreciation at the end of the year'), -8000, 'closing accumulated depreciation');
eq(row('Carrying amount at the end of the year'), 29000, 'carrying amount ties to the balance sheet');
ok(
  (ppe?.commentary ?? []).some(
    (c) => c.includes('straight line method over 36 months') && c.includes('residual value of R1000.00'),
  ),
  'the note discloses the method, useful life and residual value applied (Section 17.31(a))',
);
ok(
  (ppe?.commentary ?? []).some((c) => c.includes('Computer equipment')),
  'the note names the asset class',
);
// An asset with no depreciation set up must be called out, not silently ignored.
const bare: Asset = { ...laptop, depreciate: false };
const bareNote = noteSchedules(buildBook({ ...data, assets: [bare] }), { ...data, assets: [bare] }, fy.from, fy.to)
  .find((s) => s.key === 'ppe');
ok(
  (bareNote?.commentary ?? []).some((c) => c.includes('No depreciation has been raised')),
  'an asset with no depreciation configured is flagged in the note',
);

// ---------------------------------------------------------------- register view
console.log('\nregister');
const reg = register([laptop], charges, costAt, fy.to, fy.from);
eq(reg[0].cost, 37000, 'register shows cost');
eq(reg[0].accumulated, 8000, 'register shows accumulated depreciation');
eq(reg[0].carrying, 29000, 'register shows carrying amount');
eq(reg[0].chargeThisYear, 8000, 'register shows the charge for the year');
eq(reg[0].outstanding, 0, 'nothing outstanding once every period is posted');
eq(register([laptop], [], costAt, fy.to, fy.from)[0].outstanding, 8000, 'unposted charges are surfaced as outstanding');
ok(!reg[0].fullyDepreciated, 'not yet fully depreciated');
const done = register([laptop], full.map((d, i) => ({
  id: `f${i}`, asset_id: 'laptop', period_end: d.periodEnd, amount: d.amount, method: 'straight_line', basis: null,
})), costAt, '2031-12-31', '2031-01-01');
ok(done[0].fullyDepreciated, 'flagged once the carrying amount reaches the residual value');
eq(done[0].carrying, 1000, 'carrying amount stops at the residual value, never below');

// ---------------------------------------------------------------- regression
console.log('\nregression: synthetic accounts must not be skipped');
// Before the cash flow was driven off the ledger chart, an unsettled share
// issue (which debits a synthetic receivable) was missed and the statement
// silently failed to reconcile.
const unsettled: AllData = {
  ...base,
  transactions: [],
  equity: [
    { id: 'u1', mv_date: '2026-04-01', kind: 'share_issue', amount: 1000, contra_account_id: null, shares_issued: 100, notes: null },
    { id: 'u2', mv_date: '2026-05-01', kind: 'dividend', amount: 200, contra_account_id: null, shares_issued: null, notes: null },
  ],
};
const uBook = buildBook(unsettled);
const uCf = cashflowStatement(uBook, unsettled, fy.from, fy.to);
ok(uCf.reconciles, `unsettled capital transactions reconcile (difference ${uCf.difference})`);
eq(uCf.netMovement, 0, 'no cash moved, so the net movement is nil');

if (failures) {
  console.error(`\n${failures} depreciation test(s) FAILED`);
  process.exit(1);
}
console.log('\nAll depreciation tests passed.');
