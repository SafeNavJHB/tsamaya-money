// Assertion harness for the accounting core — run with `npm test` (tsx).
// These are the numbers a report is built from; CI runs this before deploy.
import {
  accountBalance,
  accountLedger,
  budgetRows,
  categoryLedger,
  categoryTotals,
  incomeStatement,
  latestValuation,
  monthlyCashflow,
  netWorthAt,
} from '../src/logic/compute';
import { addMonths, daysInMonth, fmtMoney, lastNMonths, parseAmount } from '../src/lib/format';
import { rowsToCsv } from '../src/export/csv';
import { advanceDate, dueDates } from '../src/logic/recurring';
import {
  applyRules,
  buildImportRows,
  detectColumns,
  detectDateFormat,
  markDuplicates,
  parseDateFlexible,
  parseMoneyLoose,
  parseStatement,
  suggestMatchText,
} from '../src/logic/importParse';
import type { Account, AllData, Asset, Category, ImportRule, RecurringRule, Tx, Valuation } from '../src/types';

let failures = 0;
function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ok  ${label}`);
  } else {
    failures++;
    console.error(`FAIL  ${label}\n      expected ${e}\n      got      ${a}`);
  }
}

// ---- fixtures ----
let txSeq = 0;
function tx(partial: Partial<Tx> & Pick<Tx, 'tx_date' | 'kind' | 'amount' | 'account_id'>): Tx {
  txSeq++;
  return {
    id: `tx${txSeq}`,
    category_id: null,
    transfer_account_id: null,
    payee: null,
    notes: null,
    created_at: `2026-01-01T00:00:${String(txSeq).padStart(2, '0')}Z`,
    ...partial,
  };
}
const acc = (id: string, opening = 0): Account => ({
  id, name: id, kind: 'bank', opening_balance: opening, sort: 0, archived: false,
});
const cat = (id: string, kind: 'income' | 'expense', budget: number | null = null): Category => ({
  id, name: id, kind, monthly_budget: budget, sort: 0, archived: false,
});
const asset = (id: string, side: 'asset' | 'liability'): Asset => ({
  id, name: id, side, category: 'other', notes: null, sort: 0, archived: false,
});
const val = (id: string, asset_id: string, val_date: string, value: number): Valuation => ({ id, asset_id, val_date, value });

// ---- format helpers ----
console.log('format');
eq(fmtMoney(1234567.5), 'R 1 234 567.50', 'fmtMoney groups with spaces');
eq(fmtMoney(-0.001), 'R 0.00', 'fmtMoney -0 collapses to zero');
eq(parseAmount('1 234,56'), 1234.56, 'parseAmount comma decimal');
eq(parseAmount('1,234.56'), 1234.56, 'parseAmount US grouping');
eq(parseAmount('R 500'), 500, 'parseAmount strips R');
eq(parseAmount('abc'), null, 'parseAmount rejects junk');
eq(addMonths('2026-01', -1), '2025-12', 'addMonths across year boundary');
eq(addMonths('2026-11', 3), '2027-02', 'addMonths forward across year');
eq(daysInMonth('2024-02'), 29, 'daysInMonth leap Feb');
eq(lastNMonths(3, '2026-01'), ['2025-11', '2025-12', '2026-01'], 'lastNMonths spans year');

// ---- balances & transfers ----
console.log('balances');
const A = acc('A', 1000);
const B = acc('B', 0);
const salary = cat('salary', 'income');
const food = cat('food', 'expense', 3000);
const fuel = cat('fuel', 'expense');
const txns: Tx[] = [
  tx({ tx_date: '2026-08-25', kind: 'income', amount: 20000, account_id: 'A', category_id: 'salary' }),
  tx({ tx_date: '2026-08-26', kind: 'expense', amount: 1500, account_id: 'A', category_id: 'food' }),
  tx({ tx_date: '2026-08-27', kind: 'transfer', amount: 5000, account_id: 'A', transfer_account_id: 'B' }),
  tx({ tx_date: '2026-09-01', kind: 'expense', amount: 800, account_id: 'B', category_id: 'fuel' }),
  tx({ tx_date: '2026-09-02', kind: 'expense', amount: 3200, account_id: 'A', category_id: 'food' }),
  tx({ tx_date: '2026-09-03', kind: 'income', amount: 250, account_id: 'B' }), // uncategorised income
];
eq(accountBalance(A, txns), 1000 + 20000 - 1500 - 5000 - 3200, 'account A balance');
eq(accountBalance(B, txns), 5000 - 800 + 250, 'account B balance (transfer in)');
eq(accountBalance(A, txns, '2026-08-31'), 1000 + 20000 - 1500 - 5000, 'balance as at date');

// ---- cashflow excludes transfers ----
console.log('cashflow');
const flow = monthlyCashflow(txns, ['2026-08', '2026-09']);
eq(flow[0], { month: '2026-08', income: 20000, expense: 1500, net: 18500 }, 'August flow (transfer excluded)');
eq(flow[1], { month: '2026-09', income: 250, expense: 4000, net: -3750 }, 'September flow');

// ---- income statement ----
console.log('income statement');
const st = incomeStatement(txns, [salary, food, fuel], '2026-08-01', '2026-09-30');
eq(st.incomeTotal, 20250, 'income total');
eq(st.expenseTotal, 5500, 'expense total');
eq(st.net, 14750, 'net');
eq(st.income.find((r) => r.category === null)?.total, 250, 'uncategorised income surfaces');
const catTot = categoryTotals(txns, [salary, food, fuel], 'expense', '2026-08-01', '2026-09-30');
eq(catTot[0], { category: food, total: 4700, count: 2 }, 'top expense category');

// ---- ledgers ----
console.log('ledgers');
const ledA = accountLedger(A, txns, '2026-09-01', '2026-09-30');
eq(ledA.opening, 14500, 'ledger opening carries pre-period activity');
eq(ledA.rows.length, 1, 'ledger row count in period');
eq(ledA.closing, 11300, 'ledger closing');
const ledFull = accountLedger(B, txns);
eq(ledFull.rows.map((r) => r.balance), [5000, 4200, 4450], 'running balance sequence');
const ledFood = categoryLedger(food, txns);
eq(ledFood.total, 4700, 'category ledger total');
eq(ledFood.rows.map((r) => r.balance), [1500, 4700], 'category running total');

// ---- net worth ----
console.log('net worth');
const car = asset('car', 'asset');
const loan = asset('loan', 'liability');
const data: AllData = {
  categories: [salary, food, fuel],
  accounts: [A, B],
  transactions: txns,
  assets: [car, loan],
  valuations: [
    val('v1', 'car', '2026-07-01', 250000),
    val('v2', 'car', '2026-09-01', 240000),
    val('v3', 'loan', '2026-08-15', 180000),
  ],
  recurring: [],
  importRules: [],
};
eq(latestValuation(data.valuations, 'car', '2026-08-31')?.value, 250000, 'valuation as-of picks earlier');
const nw = netWorthAt(data, '2026-09-30');
eq(nw.accountsTotal, 11300 + 4450, 'accounts total');
eq(nw.assetsTotal, 240000, 'assets use latest valuation');
eq(nw.liabilitiesTotal, 180000, 'liabilities total');
eq(nw.netWorth, 11300 + 4450 + 240000 - 180000, 'net worth = accounts + assets - liabilities');

// ---- budgets ----
console.log('budgets');
const bud = budgetRows([salary, food, fuel], txns, '2026-09');
eq(bud.length, 1, 'only expense categories with budgets');
eq(bud[0].actual, 3200, 'budget actual for month');
eq(bud[0].remaining, -200, 'over budget is negative remaining');

// ---- csv ----
console.log('csv');
eq(
  rowsToCsv(['a', 'b'], [['plain', 'has "quotes", and comma'], [12.5, null]]),
  'a,b\r\nplain,"has ""quotes"", and comma"\r\n12.5,\r\n',
  'csv escaping',
);

// ---- recurring date maths ----
console.log('recurring');
eq(advanceDate('2026-01-31', 'monthly', 31), '2026-02-28', 'monthly clamps to Feb');
eq(advanceDate('2026-02-28', 'monthly', 31), '2026-03-31', 'monthly re-anchors after Feb (no drift)');
eq(advanceDate('2024-01-31', 'monthly', 31), '2024-02-29', 'monthly clamps to leap Feb');
eq(advanceDate('2026-12-15', 'monthly', 15), '2027-01-15', 'monthly crosses year end');
eq(advanceDate('2026-03-05', 'weekly', 5), '2026-03-12', 'weekly');
eq(advanceDate('2026-03-05', 'fortnightly', 5), '2026-03-19', 'fortnightly');
eq(advanceDate('2026-11-30', 'quarterly', 31), '2027-02-28', 'quarterly clamps and crosses year');
eq(advanceDate('2024-02-29', 'annually', 29), '2025-02-28', 'annual leap-day clamps');

const rule = (over: Partial<RecurringRule> = {}): RecurringRule => ({
  id: 'r1', name: 'Claude', kind: 'expense', amount: 1932.07, category_id: 'c1', account_id: 'A',
  transfer_account_id: null, payee: 'Anthropic', notes: null, frequency: 'monthly', anchor_day: 8,
  start_date: '2026-06-08', end_date: null, next_date: '2026-06-08', auto_post: false, archived: false, ...over,
});
eq(dueDates(rule(), '2026-09-01'), ['2026-06-08', '2026-07-08', '2026-08-08'], 'catch-up lists every missed occurrence');
eq(dueDates(rule({ next_date: '2026-09-08' }), '2026-09-01'), [], 'nothing due before next_date');
eq(dueDates(rule({ archived: true }), '2026-09-01'), [], 'paused series is never due');
eq(dueDates(rule({ end_date: '2026-07-31' }), '2026-09-01'), ['2026-06-08', '2026-07-08'], 'end_date stops the series');
eq(dueDates(rule({ next_date: '2020-01-08' }), '2026-09-01').length, 36, 'runaway series is capped');

// ---- money parsing (bank formats) ----
console.log('import: money');
eq(parseMoneyLoose('1 234,56'), 1234.56, 'SA space thousands, comma decimal');
eq(parseMoneyLoose('1,234.56'), 1234.56, 'US grouping');
eq(parseMoneyLoose('1.234,56'), 1234.56, 'EU grouping');
eq(parseMoneyLoose('R 1 932.07'), 1932.07, 'R prefix');
eq(parseMoneyLoose('120.00-'), -120, 'trailing minus (SA exports)');
eq(parseMoneyLoose('(120.00)'), -120, 'parentheses negative');
eq(parseMoneyLoose('-377.47'), -377.47, 'leading minus');
eq(parseMoneyLoose('1234'), 1234, 'bare integer');
eq(parseMoneyLoose('1,234'), 1234, 'comma as thousands, not decimal');
eq(parseMoneyLoose(''), null, 'blank is null');
eq(parseMoneyLoose('n/a'), null, 'text is null');
eq(parseMoneyLoose('33.99'), 33.99, 'cross-border fee row');

// ---- date parsing ----
console.log('import: dates');
eq(parseDateFlexible('2026-03-01'), '2026-03-01', 'ISO');
eq(parseDateFlexible('01/03/2026'), '2026-03-01', 'ambiguous defaults day-first (SA)');
eq(parseDateFlexible('01/03/2026', 'mdy'), '2026-01-03', 'explicit month-first');
eq(parseDateFlexible('25/12/2026'), '2026-12-25', 'unambiguous day-first');
eq(parseDateFlexible('12/25/2026'), '2026-12-25', 'auto-detects month-first when day > 12');
eq(parseDateFlexible('15 Jun 2026'), '2026-06-15', 'day month-name year');
eq(parseDateFlexible('Jun 15, 2026'), '2026-06-15', 'month-name day year');
eq(parseDateFlexible('20260301'), '2026-03-01', 'compact 8 digits');
eq(parseDateFlexible('08/08/26'), '2026-08-08', 'two-digit year');
eq(parseDateFlexible('31/02/2026'), null, '31 February is rejected');
eq(parseDateFlexible('rubbish'), null, 'junk is null');
eq(detectDateFormat(['01/03/2026', '25/12/2026']), 'dmy', 'detects day-first from the column');
eq(detectDateFormat(['12/25/2026', '01/03/2026']), 'mdy', 'detects month-first from the column');

// ---- statement parsing end to end (real Standard Bank shapes) ----
console.log('import: statement');
const statement = [
  'Statement for account 1234567890',
  '',
  'Date,Description,Amount,Balance',
  '2026-06-07,"ANTHROPIC* CLAUDE SUB ANTHROPIC.COM US",-1959.70,12000.00',
  '2026-06-10,"APPLE.COM/BILL ITUNES.COM IE",-1699.99,10300.01',
  '2026-06-10,"INTERNATIONAL TRANSACTION FEE",-33.99,10266.02',
  '2026-06-15,"DOMAINS CO ZA JOHANNESBURG ZA",-99.00,10167.02',
  '2026-06-25,"SALARY, JUNE",32000.00,42167.02',
  ',,,',
].join('\n');
const table = parseStatement(statement);
eq(table.headers, ['Date', 'Description', 'Amount', 'Balance'], 'header row found past the preamble');
eq(table.rows.length, 5, 'data rows counted, blank row dropped');
const mapping = detectColumns(table);
eq([mapping.date, mapping.description, mapping.amount], [0, 1, 2], 'columns detected, balance not mistaken for amount');
const built = buildImportRows(table, mapping, { dateFormat: 'auto', flipSigns: false });
eq(built.rows.length, 5, 'all rows built');
eq(built.rows[0], {
  index: 0, date: '2026-06-07', description: 'ANTHROPIC* CLAUDE SUB ANTHROPIC.COM US', amount: 1959.7,
  kind: 'expense', categoryId: null, payee: 'ANTHROPIC* CLAUDE SUB ANTHROPIC.COM US', include: true,
  duplicate: false, matchedRule: null,
}, 'negative becomes a positive expense');
eq(built.rows[4].kind, 'income', 'positive becomes income');
eq(built.rows[4].amount, 32000, 'quoted field with an embedded comma parsed');
eq(
  buildImportRows(table, mapping, { dateFormat: 'auto', flipSigns: true }).rows[0].kind,
  'income',
  'flipSigns inverts direction',
);

// separate debit/credit columns
const dc = parseStatement(
  ['Date;Narrative;Debit;Credit', '15/06/2026;DOMAINS CO ZA;99,00;', '25/06/2026;SALARY;;32 000,00'].join('\n'),
);
eq(dc.delimiter, ';', 'semicolon delimiter detected');
const dcMap = detectColumns(dc);
eq([dcMap.amount, dcMap.debit, dcMap.credit], [-1, 2, 3], 'debit/credit columns detected');
const dcRows = buildImportRows(dc, dcMap, { dateFormat: 'auto', flipSigns: false }).rows;
eq([dcRows[0].kind, dcRows[0].amount], ['expense', 99], 'debit column becomes expense');
eq([dcRows[1].kind, dcRows[1].amount], ['income', 32000], 'credit column becomes income');

// rows with no readable date/amount are skipped, not silently mangled
const junk = parseStatement(['Date,Description,Amount', 'not-a-date,X,5.00', '2026-06-01,Y,'].join('\n'));
eq(buildImportRows(junk, { date: 0, description: 1, amount: 2, debit: -1, credit: -1 }, { dateFormat: 'auto', flipSigns: false }).skipped, 2, 'unreadable rows counted as skipped');

// ---- rules ----
console.log('import: rules');
const rules: ImportRule[] = [
  { id: '1', match_text: 'ANTHROPIC', category_id: 'c-sub', payee: 'Anthropic' },
  { id: '2', match_text: 'ANTHROPIC* CLAUDE', category_id: 'c-ai', payee: 'Claude' },
  { id: '3', match_text: 'DOMAINS CO ZA', category_id: 'c-archived', payee: null },
];
const cats2: Category[] = [cat('c-sub', 'expense'), cat('c-ai', 'expense'), { ...cat('c-archived', 'expense'), archived: true }];
const ruled = applyRules(built.rows, rules, cats2);
eq([ruled[0].categoryId, ruled[0].payee], ['c-ai', 'Claude'], 'longest matching rule wins');
eq(ruled[3].categoryId, null, 'rule pointing at an archived category does not apply it');
eq(ruled[2].categoryId, null, 'unmatched row keeps no category');
eq(suggestMatchText('ANTHROPIC* CLAUDE SUB ANTHROPIC.COM US'), 'ANTHROPIC', 'match suggestion strips punctuation');
eq(suggestMatchText('GOOGLE PLAY 650-2530000 US'), 'GOOGLE', 'match suggestion drops numbers and country codes');
eq(suggestMatchText('POS CARD 1234'), 'POS CARD 1234', 'all-noise description falls back to the whole string');

// ---- duplicates ----
console.log('import: duplicates');
const existing: Tx[] = [
  tx({ tx_date: '2026-06-07', kind: 'expense', amount: 1959.7, account_id: 'A' }),
  tx({ tx_date: '2026-06-15', kind: 'expense', amount: 99, account_id: 'B' }),
];
const marked = markDuplicates(built.rows, existing, 'A');
eq([marked[0].duplicate, marked[0].include], [true, false], 'existing row flagged and unticked');
eq(marked[3].duplicate, false, 'same amount on a different account is not a duplicate');
const twice = markDuplicates(
  [built.rows[0], { ...built.rows[0], index: 9 }],
  existing,
  'A',
);
eq([twice[0].duplicate, twice[1].duplicate], [true, false], 'one flag per existing row, so a genuine repeat still imports');

if (failures) {
  console.error(`\n${failures} test(s) FAILED`);
  process.exit(1);
}
console.log('\nAll logic tests passed.');
