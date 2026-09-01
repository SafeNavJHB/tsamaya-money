# Tsamaya Money

Kyle's personal finance tracker — income, expenses, transfers, assets &
liabilities, reports, ledgers, and CSV/Excel/PDF export. Lives at
**https://money.tsamayaapp.co.za** (GitHub Pages, deployed by
`.github/workflows/deploy.yml` on every push to `main`).

This repo holds **code only**. All data lives in the shared Tsamaya Supabase
project in `fin_*` tables, locked down by row-level security:

- every row carries `user_id` and policies require `user_id = auth.uid()`
- `fin_is_member()` additionally requires the uid to be listed in
  `fin_members`, which clients can neither read nor write — a stranger who
  signs up sees nothing and can write nothing
- the anon key in `src/config.ts` is Supabase's *publishable* key (public by
  design; it grants nothing without a signed-in session)

Schema + policies: [`sql/01_init.sql`](sql/01_init.sql) (applied 2026-09-01).
To add a member: insert their auth uid into `fin_members` via SQL.

## Concepts

- **Transactions** are stored with a positive amount; `kind`
  (income/expense/transfer) carries the sign. Transfers move money between
  accounts and are excluded from income/expense reporting.
- **Accounts** (bank/card/cash/…) have an opening balance; balances are
  computed from the ledger, never stored.
- **Assets & liabilities** carry dated valuations; net worth = account
  balances + latest asset values − latest liability values. Transaction
  accounts must not be duplicated on the assets register.
- All maths lives in pure functions in `src/logic/compute.ts`, exercised by
  `npm test` (`scripts/logic-tests.ts`) — CI runs typecheck + tests before
  every deploy.

## Development

```bash
npm install
npm run dev        # http://localhost:5173
npm run typecheck
npm test
npm run build
```

## Hosting notes

- GitHub Pages serves `dist/` (`base: './'` + hash routing, so the build works
  at both the custom domain and the *.github.io project path).
- DNS: `money.tsamayaapp.co.za` is a CNAME to `safenavjhb.github.io` at
  domains.co.za (same pattern as `admin.` → Cloudflare Pages).
- The page carries `noindex`; the app is private behind Supabase auth either way.
