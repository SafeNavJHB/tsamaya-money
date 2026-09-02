// Open Banking (Nedbank API Marketplace) mapping assertions.
// These exist so the mapping is provably right BEFORE there is a live
// connection: production access is granted on approval, so there is no
// opportunity to "just try it" first.
import {
  accountLabel,
  directionToKind,
  mapTransactions,
  obAmount,
  obBalance,
  obDate,
  obAccountList,
  obTransactionList,
} from '../src/logic/openBanking';

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

// A payload in the exact shape Nedbank's documentation shows.
const payload = {
  Data: {
    Transaction: [
      {
        AccountId: 'NB-1', TransactionId: 'OB-1', TransactionReference: 'CLAUDE',
        Amount: { Amount: '1932.07', Currency: 'ZAR' },
        CreditDebitIndicator: 'Debit', Status: 'Booked',
        BookingDateTime: '2026-08-08T00:00:00+02:00',
        TransactionInformation: 'ANTHROPIC* CLAUDE SUB ANTHROPIC.COM US',
        Balance: { Amount: { Amount: '15000.00', Currency: 'ZAR' }, CreditDebitIndicator: 'Credit', Type: 'InterimBooked' },
      },
      {
        AccountId: 'NB-1', TransactionId: 'OB-2', TransactionReference: 'SALARY',
        Amount: { Amount: '32000.00', Currency: 'ZAR' },
        CreditDebitIndicator: 'Credit', Status: 'Booked',
        BookingDateTime: '2026-08-25T00:00:00+02:00',
        TransactionInformation: 'SALARY AUGUST',
        Balance: { Amount: { Amount: '47000.00', Currency: 'ZAR' }, CreditDebitIndicator: 'Credit' },
      },
      // pending — must never reach the books
      {
        AccountId: 'NB-1', TransactionId: 'OB-3', Amount: { Amount: '500.00', Currency: 'ZAR' },
        CreditDebitIndicator: 'Debit', Status: 'Pending', BookingDateTime: '2026-08-30T00:00:00+02:00',
        TransactionInformation: 'PENDING CARD AUTH',
      },
      // an overdrawn closing balance
      {
        AccountId: 'NB-1', TransactionId: 'OB-4', Amount: { Amount: '99.00', Currency: 'ZAR' },
        CreditDebitIndicator: 'Debit', Status: 'Booked', BookingDateTime: '2026-08-31T00:00:00+02:00',
        TransactionInformation: 'DOMAINS CO ZA',
        Balance: { Amount: { Amount: '250.00', Currency: 'ZAR' }, CreditDebitIndicator: 'Debit' },
      },
    ],
  },
  Links: { Self: 'https://api.nedbank.co.za/...' },
  Meta: { TotalPages: 1 },
};

console.log('envelope');
eq(obTransactionList(payload).length, 4, 'transactions are read from Data.Transaction');
eq(obTransactionList({ Data: { Transactions: [{ TransactionId: 'x' }] } }).length, 1,
  'the plural Transactions spelling is also accepted');
eq(obTransactionList({}), [], 'a payload with no Data yields nothing rather than throwing');
eq(obTransactionList(null), [], 'a null payload is handled');
eq(obTransactionList({ Data: { Transaction: 'oops' } }), [], 'a non-array is not treated as transactions');

console.log('\nvalues');
eq(obAmount({ Amount: '1932.07' }), 1932.07, 'string amounts are parsed');
eq(obAmount({ Amount: 1932.07 }), 1932.07, 'numeric amounts are accepted');
// Regression: a forgiving parser once stripped separators and turned this
// into 193207 — a hundredfold overstatement posted silently.
eq(obAmount({ Amount: '1 932,07' }), null, 'a comma/space amount is rejected, not silently rescaled');
eq(obAmount({ Amount: '1,932.07' }), null, 'a thousands-separated amount is rejected too');
eq(obAmount({ Amount: 'R1932.07' }), null, 'a currency-prefixed amount is rejected');
eq(obAmount({ Amount: '' }), null, 'an empty amount is null');
eq(obAmount({ Amount: '-1932.07' }), -1932.07, 'a signed decimal is accepted');
eq(obAmount(undefined), null, 'a missing amount is null');
eq(obDate('2026-08-08T00:00:00+02:00'), '2026-08-08', 'the booking date is taken as the bank stated it');
eq(obDate('2026-08-08T23:30:00Z'), '2026-08-08', 'a late-evening UTC instant does not roll to the next day');
eq(obDate('2026-13-01T00:00:00Z'), null, 'an impossible month is rejected');
eq(obDate(undefined), null, 'a missing date is null');
eq(obBalance(payload.Data.Transaction[0]), 15000, 'a credit balance is positive');
eq(obBalance(payload.Data.Transaction[3]), -250, 'a debit (overdrawn) balance is negative');
eq(obBalance({ TransactionId: 'x' }), null, 'a transaction with no balance is null');

console.log('\nmapping');
const { rows, skipped } = mapTransactions(payload);
eq(rows.length, 3, 'three booked transactions map');
eq(skipped.length, 1, 'the pending one is skipped');
ok(skipped[0].reason.includes('Pending'), 'and the reason says why, rather than vanishing');
eq(rows[0], {
  providerTxId: 'OB-1', bookedOn: '2026-08-08', amount: 1932.07, direction: 'debit',
  description: 'ANTHROPIC* CLAUDE SUB ANTHROPIC.COM US', reference: 'CLAUDE', balanceAfter: 15000,
  raw: payload.Data.Transaction[0],
}, 'a debit maps completely');
eq(rows[1].direction, 'credit', 'a credit maps as a credit');
eq(directionToKind('credit'), 'income', 'credit becomes income');
eq(directionToKind('debit'), 'expense', 'debit becomes expense');

// The sign must come from the indicator only, never doubled up.
const negative = mapTransactions({
  Data: { Transaction: [{ TransactionId: 'N1', Status: 'Booked', BookingDateTime: '2026-08-08T00:00:00Z',
    Amount: { Amount: '-500.00' }, CreditDebitIndicator: 'Debit', TransactionInformation: 'X' }] },
});
eq(negative.rows[0].amount, 500, 'a negative magnitude is not double-counted against the indicator');
eq(negative.rows[0].direction, 'debit', 'the indicator still decides the direction');

// Rows that cannot be trusted are reported, not guessed at.
const bad = mapTransactions({
  Data: { Transaction: [
    { Status: 'Booked', BookingDateTime: '2026-08-08T00:00:00Z', Amount: { Amount: '1.00' } },
    { TransactionId: 'B2', Status: 'Booked', Amount: { Amount: '1.00' } },
    { TransactionId: 'B3', Status: 'Booked', BookingDateTime: '2026-08-08T00:00:00Z' },
  ] },
});
eq(bad.rows.length, 0, 'nothing unmappable is let through');
eq(bad.skipped.length, 3, 'every unmappable row is reported');
ok(bad.skipped[0].reason.includes('TransactionId'), 'a missing id is called out (it is the dedupe key)');
ok(bad.skipped[1].reason.includes('BookingDateTime'), 'a missing date is called out');
ok(bad.skipped[2].reason.includes('amount'), 'a missing amount is called out');

console.log('\naccounts');
const accts = {
  Data: { Account: [
    { AccountId: 'NB-1', Currency: 'ZAR', AccountType: 'Business', AccountSubType: 'CurrentAccount',
      Nickname: 'Tsamaya Current', Account: [{ Identification: '1347984453', Name: 'TSAMAYA PTY LTD' }] },
    { AccountId: 'NB-2', Account: [{ Identification: '9999' }] },
  ] },
};
eq(obAccountList(accts).length, 2, 'accounts are read from Data.Account');
eq(accountLabel(obAccountList(accts)[0]), 'Tsamaya Current (••••4453)', 'the account number is masked in the label');
ok(!accountLabel(obAccountList(accts)[0]).includes('1347984'), 'the full account number never appears in a label');
eq(accountLabel(obAccountList(accts)[1]), 'Account (9999)', 'a sparse account still gets a usable label');

if (failures) {
  console.error(`\n${failures} open banking test(s) FAILED`);
  process.exit(1);
}
console.log('\nAll open banking tests passed.');
