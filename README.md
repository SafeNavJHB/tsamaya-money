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
  (`scripts/logic-tests.ts`) — CI runs typecheck + tests before every deploy.

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
