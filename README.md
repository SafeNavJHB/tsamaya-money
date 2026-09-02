# Tsamaya Money

The financial tracker for **TSAMAYA (PTY) LTD** — income, expenses, transfers,
assets & liabilities, recurring costs, bank statement import, reports, ledgers,
and CSV/Excel/PDF export. Lives at **https://money.tsamayaapp.co.za**
(GitHub Pages, deployed by `.github/workflows/deploy.yml` on every push to `main`).

This repo holds **code only**. All data lives in the shared Tsamaya Supabase
project in `fin_*` tables, locked down by row-level security:

- every row carries `user_id` and policies require `user_id = auth.uid()`
- `fin_is_member()` additionally requires the uid to be listed in
  `fin_members`, which clients can neither read nor write — a stranger who
  signs up sees nothing and can write nothing
- the anon key in `src/config.ts` is Supabase's *publishable* key (public by
  design; it grants nothing without a signed-in session)

## Relationship to the Beancount books

`~/Projects/Tsamaya_Books` (Beancount + Fava) remains the formal accounting
record. This app is the **day-to-day capture and reporting layer** feeding it:
the same source data, reachable from a phone, exportable for the accountant.
The two agree — the director loan reconciles to R10,918.86 in both.

Beancount accounts map onto this app's model like this:

| Beancount | Here |
|---|---|
| `Liabilities:DirectorLoan:Kyle` | the **"Director loan — Kyle" account**. Costs Kyle paid personally are spent from it, so its negative balance is what the company owes him, and its ledger is the director-loan statement |
| `Assets:Prepaid:CIPC` | the **"CIPC deposit" account**. Loading R500 is a transfer in; filing fees are expenses paid from it, so the deposit draws down |
| `Expenses:*` | categories |
| `Equity:ShareCapital` | deliberately not posted — read the real subscription off the MOI/CoR15.1 first |

## Schema

| File | What it did |
|---|---|
| [`sql/01_init.sql`](sql/01_init.sql) | tables, RLS, member gate |
| [`sql/02_recurring_and_import.sql`](sql/02_recurring_and_import.sql) | recurring series, import rules, transaction provenance |
| [`sql/03_company_setup.sql`](sql/03_company_setup.sql) | company chart of accounts + the confirmed history from the reconstruction sheets |
| [`sql/04_ifrs_statements.sql`](sql/04_ifrs_statements.sql) | equity movements, entity settings, balance-sheet classification, capitalisation |
| [`sql/05_cashflow_and_notes.sql`](sql/05_cashflow_and_notes.sql) | cash/activity classification per account, narrative notes |
| [`sql/06_depreciation.sql`](sql/06_depreciation.sql) | fixed asset settings and the posted depreciation register |
| [`sql/07_disposals_journals_lock.sql`](sql/07_disposals_journals_lock.sql) | asset disposals, manual journal entries, period locking |
| [`sql/08_bank_feed.sql`](sql/08_bank_feed.sql) | Nedbank bank feed: connections, staged transactions, service-role-only tokens |
| [`sql/09_bank_link_state.sql`](sql/09_bank_link_state.sql) | pending OAuth link states for the one-click bank connect |

All applied against the live database. To add a member: insert their auth uid
into `fin_members` via SQL.

## Concepts

- **Transactions** are stored with a positive amount; `kind`
  (income/expense/transfer) carries the sign. Transfers move money between
  accounts and are excluded from income/expense reporting.
- **Accounts** have an opening balance; balances are computed from the ledger,
  never stored.
- **Assets & liabilities** carry dated valuations; net worth = account
  balances + latest asset values − latest liability values.
- **Recurring** series carry an anchor day so a month-end series doesn't drift
  (31 Jan → 28 Feb → 31 Mar), and every missed occurrence surfaces separately
  for catch-up. Auto-post runs when the app is opened — there is no server.
- **Import** parses a bank statement CSV: delimiter, header row, column roles,
  SA date and money formats (`1 234,56`, trailing minus, parentheses), single
  signed amount or debit/credit pair. Rows already on file are flagged and
  unticked; saved rules categorise known payees automatically.
- All maths lives in pure functions in `src/logic/`, exercised by `npm test`
  (`scripts/logic-tests.ts` + `scripts/accounting-tests.ts`) — CI runs
  typecheck + tests before every deploy.

## Double entry and the IFRS for SMEs statements

`src/logic/ledger.ts` turns every stored row into a balanced pair of postings,
and **every** statement — trial balance, general ledger, T-accounts, statement
of financial position, statement of changes in equity — reads that one list, so
no two surfaces can disagree.

| Source row | Debit | Credit |
|---|---|---|
| Expense | expense category (or the asset, when capitalised) | account |
| Income | account | income category |
| Transfer | destination account | source account |
| Share issue | contra account, else share capital receivable | share capital |
| Dividend | dividends declared (equity) | contra account, else dividend payable |
| Prior-period adjustment | retained earnings ↔ contra account (signed) | |

Presentation decisions worth knowing:

- **Accounts are sided by their balance, not their nature.** An overdrawn bank
  account presents in current liabilities and a director loan in credit
  presents as a liability, in the statements *and* in the T-account captions.
- **The asset register is not posted.** A valuation has no second leg, so
  assets reach the balance sheet at posted cost (Section 17 cost model) by
  capitalising the purchase against the asset; valuations stay a memorandum
  figure. Register items with a valuation but no posted purchase are excluded
  and called out in a note beneath the statement.
- **Capital transactions never touch profit or loss**, which is what keeps the
  SOCIE and the income statement independent of each other.
- The financial year end is a setting (`fin_settings.fy_end_month`, default
  February). P&L accounts reset each year; balance sheet accounts carry forward.

The test suite asserts the identities rather than the arithmetic: every entry
balances, the trial balance balances, assets = liabilities + equity in
consecutive years, SOCIE closing equity ties to the balance sheet, the cash
flow statement reconciles to the actual movement in cash, note schedules tie to
the face of the statements, and the two independently-computed income
statements agree.

### Cash flows and notes

The **statement of cash flows** (Section 7) uses the indirect method, and the
reconciliation is not computed twice and compared — it falls out of double
entry. Over any period, summing (debits − credits) across every account is
zero, so `Δcash = profit − Δ(other balance-sheet) − Δ(equity)`. Each term is
then presented under operating, investing or financing per the account's
`cf_class`. If `reconciles` ever goes false, a classification is missing rather
than the arithmetic being wrong.

Which accounts count as **cash** is explicit (`fin_accounts.is_cash`, null =
derive from `kind`), because guessing would misclassify the director loan and
the CIPC deposit — both `kind='other'`. Both settings are editable per account
on the Accounts page.

The **notes** (Section 8) are split deliberately: the figures are computed from
the ledger so a note cannot disagree with the statement it supports, while the
wording lives in `fin_notes` and is edited by the preparer — an accounting
policy and a going-concern conclusion are professional judgements and are not
generated. Seeded text is a starting draft; any note still containing a
`[bracketed placeholder]` is flagged in red on the Notes tab and must be
resolved before the statements are issued.

**Full AFS pack (PDF)** on the Reports page emits the balance sheet, income
statement, SOCIE, cash flow statement and all notes as one document.

### Depreciation register

Charges are **posted monthly and stored**, never re-derived from the current
settings. That is the whole point: a revised useful life or residual value is a
change in accounting estimate applied *prospectively* (Section 10.15), so prior
periods must keep the charge actually raised. Recomputing from today's settings
would silently restate history.

- Straight line over a useful life in months, or reducing balance at an annual
  rate, both to an optional residual value; the final charge is capped so the
  carrying amount never falls below residual.
- Depreciation starts when the asset is **available for use** (Section 17.20),
  which is not necessarily the purchase date, and cost comes from expenses
  tagged to the asset — an asset with no capitalised purchase depreciates nil.
- The register shows what is owed and posts the catch-up in one action; a
  unique index on `(asset_id, period_end)` makes double-charging impossible.
- Postings are `Dr Depreciation / Cr Accumulated depreciation`. Accumulated
  depreciation is a **contra-asset** (`netsInto` on its ledger account): it nets
  against its asset on the balance sheet rather than appearing among
  liabilities, and is added back as a non-cash item in operating cash flows
  while the purchase stays an investing outflow at full cost.
- The PPE note is the Section 17.31 reconciliation — cost and accumulated
  depreciation shown separately, with the method, life and residual disclosed.

Known limitation, stated rather than hidden: each asset row is depreciated as a
single unit from its start date, so a later addition to the same row is written
off over that row's remaining life. Record a separate asset row per addition
when that matters.

**Disposals** (Section 17.27-17.30) remove the cost and the accumulated
depreciation in one entry, bring in the proceeds, and put the balancing figure
to gain or loss. Depreciation stops from the disposal date. Proceeds that have
not been received sit as a receivable rather than pretending cash arrived. On
the statement of cash flows the proceeds are the investing inflow and the gain
or loss is reversed out of operating as a non-cash item — the raw movement is
the carrying amount, which is neither.

### Journal entries

`fin_journals` + `fin_journal_lines` allow any balanced Dr/Cr against any
account in the chart. This is the escape hatch that makes accruals, provisions,
prepayment releases, reclassifications, corrections and opening balances
possible without a bespoke table for each. A deferred constraint trigger
rejects an entry that does not balance or has fewer than two lines, so an
unbalanced journal cannot exist even if written straight to the API. A line
referencing an unknown account key is surfaced as an "Unrecognised account"
rather than dropped, because dropping it would unbalance the books silently.

### Bank feed (Nedbank)

Pulls transactions from the **Nedbank API Marketplace**, which serves the UK
Open Banking v3.1 AISP shape. **Built and tested, not yet connected** —
credentials need Nedbank's approval. Full runbook: [`docs/NEDBANK.md`](docs/NEDBANK.md).

The sync runs in a Supabase Edge Function
([`supabase/functions/nedbank-sync`](supabase/functions/nedbank-sync/index.ts)),
never in the browser: every Nedbank call carries `x-ibm-client-secret`, and
this is a static site, so a bundled secret is a published secret. Tokens live
in `fin_bank_secrets` — RLS on, **no policies and no grant** to `authenticated`
— so only the service role can read them.

Fetched rows land in `fin_bank_feed` as `pending` and are reviewed on the Bank
feed screen before becoming ledger entries, the same discipline as the CSV
importer. Only `Booked` transactions are taken. Re-syncing an overlapping
window is genuinely idempotent thanks to a unique index on the bank's own
`TransactionId` — a stronger guarantee than the CSV importer's date/amount
heuristic. Amounts parse strictly: a regression test pins that `"1 932,07"` is
rejected rather than silently becoming `193207`.

### Closing a period

`fin_settings.locked_until` stops anything being posted, edited or deleted on
or before that date — transactions, journals, capital transactions,
depreciation and disposals alike. Triggers enforce it on every table, not the
UI, so statements already issued cannot move underneath you. Clear the date in
Settings to reopen.

## Development

```bash
npm install
npm run dev        # http://localhost:5173
npm run typecheck
npm test
npm run build
```

An untracked smoke harness (`smoke.html` + `src/smoke.tsx`, both gitignored)
stubs the Supabase REST layer and session so every authenticated screen can be
driven in a browser with canned data.

## Hosting notes

- GitHub Pages serves `dist/` (`base: './'` + hash routing, so the build works
  at both the custom domain and the *.github.io project path).
- DNS: `money.tsamayaapp.co.za` is a CNAME to `safenavjhb.github.io` at
  domains.co.za (same pattern as `admin.` → Cloudflare Pages).
- The page carries `noindex`; the app is private behind Supabase auth either way.
