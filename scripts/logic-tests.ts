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
import type { Account, AllData, Asset, Category, Tx, Valuation } from '../src/types';

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

if (failures) {
  console.error(`\n${failures} test(s) FAILED`);
  process.exit(1);
}
console.log('\nAll logic tests passed.');
