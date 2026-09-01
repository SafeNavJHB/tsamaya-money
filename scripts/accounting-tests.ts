// Accounting assertions for the double-entry engine and the IFRS for SMEs
// statements. Run by `npm test`; CI gates the deploy on it.
//
// The point of these is the identities, not the arithmetic: if debits ever stop
// equalling credits, or the balance sheet stops balancing, this fails loudly.
import { buildBook, tAccount, trialBalance, profitForPeriod, balanceAt, SHARE_CAPITAL } from '../src/logic/ledger';
import { financialYearFor, priorYear, socie, sofp } from '../src/logic/statements';
import { incomeStatement, monthlyCashflow, round2 } from '../src/logic/compute';
import { cashflowStatement, isCashAccount } from '../src/logic/cashflow';
import { noteSchedules } from '../src/logic/notes';
import type { Account, AllData, Asset, Category, EquityMovement, Settings, Tx } from '../src/types';

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

// ---------------------------------------------------------------- fixture
let n = 0;
const tx = (p: Partial<Tx> & Pick<Tx, 'tx_date' | 'kind' | 'amount' | 'account_id'>): Tx => ({
  id: `t${++n}`, category_id: null, transfer_account_id: null, payee: null, notes: null,
  created_at: `2026-01-01T00:00:${String(n).padStart(2, '0')}Z`, ...p,
});
const acct = (id: string, name: string, bs: string, current = true, opening = 0): Account => ({
  id, name, kind: 'bank', opening_balance: opening, sort: 0, archived: false, bs_line: bs, is_current: current,
});
// A director loan is not cash and is a financing flow — mirroring the live data,
// where it is kind='other' with is_cash=false.
const loanAcct = (id: string, name: string, bs: string): Account => ({
  id, name, kind: 'other', opening_balance: 0, sort: 1, archived: false, bs_line: bs, is_current: true,
  is_cash: false, cf_class: 'financing',
});
const cate = (id: string, name: string, kind: 'income' | 'expense'): Category => ({
  id, name, kind, monthly_budget: null, sort: 0, archived: false,
});
const asst = (id: string, name: string, side: 'asset' | 'liability', bs: string, current: boolean): Asset => ({
  id, name, side, category: 'other', notes: null, sort: 0, archived: false, bs_line: bs, is_current: current,
});
const settings: Settings = { entity_name: 'TEST (PTY) LTD', registration_number: null, fy_end_month: 2 };

// FY ending 28 Feb 2027 = 1 Mar 2026 -> 28 Feb 2027
const equity: EquityMovement[] = [
  { id: 'e1', mv_date: '2026-03-10', kind: 'share_issue', amount: 1000, contra_account_id: 'bank', shares_issued: 100, notes: 'Founder shares' },
  { id: 'e2', mv_date: '2026-12-01', kind: 'dividend', amount: 300, contra_account_id: 'bank', shares_issued: null, notes: null },
  { id: 'e3', mv_date: '2026-06-01', kind: 'prior_period_adjustment', amount: -150, contra_account_id: 'loan', shares_issued: null, notes: 'Understated FY2026 expense' },
];

const data: AllData = {
  accounts: [acct('bank', 'Bank', 'Cash and cash equivalents'), loanAcct('loan', 'Director loan', 'Loan from director')],
  categories: [cate('sales', 'Revenue', 'income'), cate('sub', 'Subscriptions', 'expense')],
  assets: [asst('laptop', 'Laptop', 'asset', 'Property, plant and equipment', false)],
  valuations: [{ id: 'v1', asset_id: 'laptop', val_date: '2027-02-28', value: 15000 }],
  transactions: [
    tx({ tx_date: '2026-04-01', kind: 'income', amount: 5000, category_id: 'sales', account_id: 'bank', payee: 'Customer' }),
    tx({ tx_date: '2026-05-01', kind: 'expense', amount: 1200, category_id: 'sub', account_id: 'bank', payee: 'Anthropic' }),
    tx({ tx_date: '2026-05-15', kind: 'expense', amount: 800, category_id: 'sub', account_id: 'loan', payee: 'Anthropic' }),
    // capitalised: debits the asset, never P&L
    tx({ tx_date: '2026-07-01', kind: 'expense', amount: 20000, account_id: 'bank', asset_id: 'laptop', payee: 'iStore' }),
    tx({ tx_date: '2026-08-01', kind: 'transfer', amount: 500, account_id: 'bank', transfer_account_id: 'loan' }),
    // falls in the NEXT financial year — must not touch FY2027
    tx({ tx_date: '2027-04-01', kind: 'income', amount: 9999, category_id: 'sales', account_id: 'bank' }),
  ],
  recurring: [], importRules: [], equity, settings, notes: [],
};

const book = buildBook(data);
const fy = financialYearFor('2026-09-01', 2);

console.log('financial year');
eq([fy.from, fy.to], ['2026-03-01', '2027-02-28'], 'February year-end spans Mar to Feb');
eq(financialYearFor('2027-02-28', 2).to, '2027-02-28', 'the last day belongs to that year');
eq(financialYearFor('2027-03-01', 2).to, '2028-02-29', 'the next day rolls into the next year (leap)');
eq(financialYearFor('2026-06-30', 12).from, '2026-01-01', 'December year-end is the calendar year');
eq(priorYear(fy, 2).to, '2026-02-28', 'prior year computed');

console.log('\ndouble entry');
const everyPairBalances = (() => {
  const bySource = new Map<string, { d: number; c: number }>();
  for (const p of book.postings) {
    const s = bySource.get(p.sourceId) ?? { d: 0, c: 0 };
    s.d += p.debit; s.c += p.credit;
    bySource.set(p.sourceId, s);
  }
  return [...bySource.values()].every((s) => Math.abs(s.d - s.c) < 0.005);
})();
ok(everyPairBalances, 'every source row posts equal debits and credits');
const tb = trialBalance(book, fy.from, fy.to);
ok(tb.balanced, `trial balance balances (Dr ${tb.totalDebit} = Cr ${tb.totalCredit})`);

console.log('\nprofit');
// FY2027 P&L: income 5000; expenses 1200 + 800 = 2000. The R20 000 laptop is
// capitalised and the 2027-04-01 sale is next year.
eq(profitForPeriod(book, fy.from, fy.to), 3000, 'profit excludes capitalised spend and later-year income');

console.log('\nstatement of financial position');
const bs = sofp(book, fy.to);
ok(bs.balanced, `SoFP balances (difference ${bs.difference})`);
// Bank: +1000 issue +5000 income -1200 sub -20000 laptop -500 transfer -300 dividend = -16000 -> overdraft
eq(balanceAt(book, 'acc:bank', fy.to), -16000, 'bank is overdrawn at year end');
eq(bs.currentLiabilities.find((l) => l.caption === 'Cash and cash equivalents')?.amount, 16000,
  'an overdrawn bank account presents in current liabilities, not as a negative asset');
eq(bs.nonCurrentAssets.find((l) => l.caption === 'Property, plant and equipment')?.amount, 20000,
  'capitalised laptop sits in non-current assets at cost, not at its R15 000 valuation');
// Director loan: -800 expense +500 transfer in -150 PPA contra = -450 credit -> liability
eq(bs.currentLiabilities.find((l) => l.caption === 'Loan from director')?.amount, 450, 'director loan presents as a current liability');
eq(bs.totalAssets, 20000, 'total assets');
eq(bs.totalLiabilities, 16450, 'total liabilities');
eq(bs.totalEquity, 3550, 'total equity');
eq(bs.equity.find((l) => l.caption === 'Share capital')?.amount, 1000, 'share capital presented separately');
eq(bs.equity.find((l) => l.caption === 'Retained earnings')?.amount, 2550, 'retained earnings = 3000 profit - 300 dividend - 150 PPA');
ok(Math.abs(bs.totalAssets - (bs.totalLiabilities + bs.totalEquity)) < 0.005, 'A = L + E');

console.log('\nstatement of changes in equity');
const sc = socie(book, fy.from, fy.to);
eq(sc.rows[0].caption, 'Balance at 2026-02-28', 'opens at the day before the year starts');
eq([sc.rows[0].shareCapital, sc.rows[0].retainedEarnings], [0, 0], 'opening equity is nil for a first year');
eq(sc.rows.map((r) => r.caption).slice(1, -1), [
  'Prior-period adjustment',
  'Total comprehensive income for the period',
  'Shares issued',
  'Dividends declared',
], 'movement rows in Section 6 order, nil rows suppressed');
eq(sc.rows.find((r) => r.caption === 'Dividends declared')?.retainedEarnings, -300, 'dividend reduces retained earnings');
eq(sc.rows.find((r) => r.caption === 'Prior-period adjustment')?.retainedEarnings, -150, 'PPA carried at its signed amount');
const closing = sc.rows[sc.rows.length - 1];
eq([closing.shareCapital, closing.retainedEarnings, closing.total], [1000, 2550, 3550], 'closing equity');
ok(Math.abs(sc.closingTotal - bs.totalEquity) < 0.005, 'SOCIE closing equity ties to the SoFP');

console.log('\naccount sides follow the balance, not the stored type');
eq(tAccount(book, 'acc:loan', fy.from, fy.to).type, 'liability',
  'a director loan in credit is labelled a liability, never "Asset"');
eq(tAccount(book, 'acc:bank', fy.from, fy.to).type, 'liability', 'an overdrawn bank account is labelled a liability');
eq(tb.rows.find((r) => r.key === 'acc:loan')?.type, 'liability', 'trial balance types follow the balance too');
eq(tAccount(book, 'cat:sub', fy.from, fy.to).type, 'expense', 'an expense account keeps its fixed type');
eq(tAccount(book, SHARE_CAPITAL, fy.from, fy.to).type, 'equity', 'equity keeps its fixed type');

console.log('\nT-accounts');
const tBank = tAccount(book, 'acc:bank', fy.from, fy.to);
ok(Math.abs(tBank.totalDebit + tBank.closingDebit - (tBank.totalCredit + tBank.closingCredit)) < 0.005,
  'bank T-account: both sides total equally once the balance is carried down');
eq(tBank.closingDebit, 16000, 'overdrawn bank carries its balance down on the debit side');
eq(tBank.debits.map((d) => d.amount), [1000, 5000], 'bank debits: share issue and the sale');
eq(tBank.credits.map((d) => d.amount), [1200, 20000, 500, 300], 'bank credits in date order');
eq(tBank.debits[0].detail, 'Share capital', 'T-account detail names the contra account');

const tSub = tAccount(book, 'cat:sub', fy.from, fy.to);
eq(tSub.openingDebit + tSub.openingCredit, 0, 'a P&L account opens at nil each year');
eq(tSub.totalDebit, 2000, 'subscriptions total for the year');

const tCap = tAccount(book, SHARE_CAPITAL, fy.from, fy.to);
eq(tCap.closingDebit, 1000, 'share capital (a credit balance) carries down on the debit side');

// Second-year behaviour: balance sheet accounts carry forward, P&L accounts reset.
const fy2 = financialYearFor('2027-06-01', 2);
const tBank2 = tAccount(book, 'acc:bank', fy2.from, fy2.to);
eq(tBank2.openingCredit, 16000, 'next year opens with the balance brought down');
eq(tAccount(book, 'cat:sales', fy2.from, fy2.to).openingDebit, 0, 'income account does not carry forward');
eq(profitForPeriod(book, fy2.from, fy2.to), 9999, 'next year profit is only next year income');
const bs2 = sofp(book, fy2.to);
ok(bs2.balanced, 'SoFP balances in the second year too');
const sc2 = socie(book, fy2.from, fy2.to);
eq(sc2.rows[0].total, 3550, "second year's opening equity equals the first year's closing");
ok(Math.abs(sc2.closingTotal - bs2.totalEquity) < 0.005, 'second-year SOCIE ties to its SoFP');

console.log('\nthe two income-statement paths agree');
// Reports > Income statement uses categoryTotals; the ledger uses postings.
// They are computed independently, so this is a genuine cross-check — and it
// is the assertion that catches a capitalised purchase leaking into profit.
const is1 = incomeStatement(data.transactions, data.categories, fy.from, fy.to);
eq(is1.net, profitForPeriod(book, fy.from, fy.to), 'income statement net equals ledger profit');
eq(is1.expenseTotal, 2000, 'the capitalised R20 000 is not in expenses');
eq(is1.expense.find((r) => r.category === null), undefined, 'capitalised spend does not appear as uncategorised');
eq(
  monthlyCashflow(data.transactions, ['2026-07']).find((m) => m.month === '2026-07')?.expense,
  0,
  'the cash-flow chart also excludes capitalised spend, so the surfaces agree',
);

console.log('\nstatement of cash flows');
const cf = cashflowStatement(book, data, fy.from, fy.to);
ok(cf.reconciles, `cash flow reconciles to the movement in cash (difference ${cf.difference})`);
eq(cf.openingCash, 0, 'opening cash');
eq(cf.closingCash, -16000, 'closing cash equals the bank balance');
eq(cf.netMovement, -16000, 'net movement in cash');
eq(round2(cf.netOperating + cf.netInvesting + cf.netFinancing), cf.closingCash - cf.openingCash,
  'the three activity totals sum to the actual movement in cash');
eq(cf.investing.find((l) => l.caption.startsWith('Acquisition'))?.amount, -20000,
  'the capitalised laptop is an investing outflow, not an operating expense');
eq(cf.financing.find((l) => l.caption === 'Proceeds from issue of share capital')?.amount, 1000,
  'share issue is a financing inflow');
eq(cf.financing.find((l) => l.caption === 'Dividends declared')?.amount, -300, 'dividend is a financing outflow');
eq(cf.operating[0].amount, 3000, 'operating opens with the profit for the period');
eq(cf.components.map((c) => c.name), ['Bank'], 'cash components disclosed (Section 7.20)');
// the director loan is classed financing in this fixture only if set; default
// is operating, so assert the default lands somewhere and still reconciles
ok(
  [...cf.operating, ...cf.investing, ...cf.financing].every((l) => Number.isFinite(l.amount)),
  'every cash flow line carries a finite amount',
);

// A second year must reconcile too, opening at the prior closing cash.
const cf2 = cashflowStatement(book, data, fy2.from, fy2.to);
ok(cf2.reconciles, 'second-year cash flow reconciles');
eq(cf2.openingCash, -16000, 'second year opens at the prior closing cash');
eq(cf2.closingCash, -6001, 'second year closing cash');

// Classification must not change the total, only where it appears.
const reclassified = {
  ...data,
  accounts: data.accounts.map((a) => (a.id === 'loan' ? { ...a, cf_class: 'investing' as const } : a)),
};
const cf3 = cashflowStatement(buildBook(reclassified), reclassified, fy.from, fy.to);
ok(cf3.reconciles, 'reclassifying an account keeps the statement reconciled');
eq(cf3.netMovement, cf.netMovement, 'reclassification moves a line between sections, it does not change the total');
ok(
  cf.financing.some((l) => l.caption.toLowerCase().includes('loan from director')),
  'the director loan movement appears under financing',
);
ok(
  cf3.investing.some((l) => l.caption.toLowerCase().includes('loan from director')),
  'reclassifying it to investing moves the line to investing',
);
// The cash inference itself: an account with no explicit flag follows its kind.
eq(isCashAccount({ ...acct('x', 'Savings', 'Cash'), kind: 'savings' }), true, 'a savings account defaults to cash');
eq(isCashAccount({ ...acct('x', 'Other', 'Other'), kind: 'other' }), false, "kind 'other' does not default to cash");
eq(isCashAccount({ ...acct('x', 'Bank', 'Cash'), is_cash: false }), false, 'an explicit flag overrides the kind');

console.log('\nnotes');
const scheds = noteSchedules(book, data, fy.from, fy.to);
const ppeNote = scheds.find((s) => s.key === 'ppe');
ok(!!ppeNote, 'a PPE note is produced when there are capitalised assets');
eq(ppeNote?.rows.find((r) => r.caption === 'Additions')?.current, 20000, 'PPE additions equal the capitalised cost');
eq(ppeNote?.rows.find((r) => r.isTotal)?.current, 20000, 'PPE closing carrying amount ties to the balance sheet');
ok(
  (ppeNote?.commentary ?? []).some((c) => c.includes('memorandum')),
  'the note states the R15 000 valuation is memorandum only, not the carrying amount',
);
ok((ppeNote?.commentary ?? []).some((c) => c.includes('depreciation')), 'the note flags that no depreciation is raised');
const shareNote = scheds.find((s) => s.key === 'share_capital');
eq(shareNote?.rows[0].current, 1000, 'share capital note ties to the SoFP');
const cashNote = scheds.find((s) => s.key === 'cash');
eq(cashNote?.rows.find((r) => r.isTotal)?.current, -16000, 'cash note ties to the cash flow statement closing cash');

console.log('\nedge cases');
const emptyBook = buildBook({ ...data, transactions: [], equity: [], assets: [], valuations: [] });
const emptyBs = sofp(emptyBook, fy.to);
ok(emptyBs.balanced, 'an empty entity still balances');
eq(emptyBs.totalEquity, 0, 'empty entity has nil equity');
eq(socie(emptyBook, fy.from, fy.to).rows.length, 2, 'empty SOCIE is just opening and closing');

// Unsettled capital transactions (no contra account) must still balance.
const unsettled = buildBook({
  ...data,
  transactions: [],
  equity: [
    { id: 'u1', mv_date: '2026-03-01', kind: 'share_issue', amount: 100, contra_account_id: null, shares_issued: 100, notes: null },
    { id: 'u2', mv_date: '2026-04-01', kind: 'dividend', amount: 50, contra_account_id: null, shares_issued: null, notes: null },
  ],
});
const uBs = sofp(unsettled, fy.to);
ok(uBs.balanced, 'unpaid share issue and undeclared-cash dividend still balance');
eq(uBs.currentAssets.find((l) => l.caption === 'Share capital receivable')?.amount, 100,
  'unpaid share capital shows as a receivable');
eq(uBs.currentLiabilities.find((l) => l.caption === 'Dividend payable')?.amount, 50,
  'unpaid dividend shows as a payable');

if (failures) {
  console.error(`\n${failures} accounting test(s) FAILED`);
  process.exit(1);
}
console.log('\nAll accounting tests passed.');
