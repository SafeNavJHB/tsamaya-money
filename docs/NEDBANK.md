# Nedbank bank feed

Pulls transactions from the **Nedbank API Marketplace**, which serves the UK
Open Banking v3.1 account-information (AISP) shape — the `x-fapi-financial-id`
header and the `Data`/`Links`/`Meta` envelope are straight from that spec.

**Status: built and tested, not yet connected.** Everything below the bank
boundary works and is covered by tests. What is missing is credentials, and
three of the steps to get them can only be done by you.

---

## Why the sync runs server-side

Every Nedbank call carries `x-ibm-client-secret`. This app is a static site on
GitHub Pages, so a secret in the bundle is a **published** secret — anyone
could read it with View Source and pull the company's bank data. The bank's
origin would not permit browser calls anyway.

So the sync lives in a Supabase Edge Function
([`supabase/functions/nedbank-sync`](../supabase/functions/nedbank-sync/index.ts)).
The app calls it with your Supabase session; the function holds the
credentials and the app never sees them. Tokens live in `fin_bank_secrets`,
a table with RLS on and **no policies and no grant** to `authenticated` —
only the service role can read it, so even a signed-in browser cannot.

## What it will and will not do

- Fetched transactions land in `fin_bank_feed` as **pending**. They are not
  ledger postings. You review them on the Bank feed screen and post them, the
  same discipline as the CSV importer. A feed writing straight into the books
  would mean the statements change without anyone deciding they should.
- Only `Booked` transactions are taken. A pending card authorisation can change
  amount or vanish, and posting one would put a figure in the books the bank has
  not committed to.
- Re-syncing an overlapping window is genuinely idempotent: Nedbank returns a
  stable OB `TransactionId` and there is a unique index on
  `(user_id, provider, provider_tx_id)`. This is a stronger guarantee than the
  CSV importer's date/amount heuristic.
- Amounts are parsed **strictly** (`^[+-]?\d+(\.\d+)?$`). Anything else is
  skipped and reported rather than coerced — an earlier forgiving version turned
  `"1 932,07"` into `193207`, a hundredfold overstatement, which is exactly the
  kind of silent corruption a ledger must never accept.

## Activating it

### 1. Get credentials (you)

1. Register at **<https://apim.nedbank.co.za>** and create an application.
   You get a **client ID** and **client secret**, and sandbox access immediately.
2. Subscribe the app to the **Nedbank Authorisation API** (required for OAuth on
   every other product) and to either:
   - **Business Transactions API** — built for exactly this: transactions and
     balances on Nedbank *business* current and savings accounts; or
   - **Accounts API** — the general Open Banking AISP product.
3. Ask Nedbank to move the app from **sandbox to production** against the
   business current account. Production access is *requested, reviewed and
   approved* by Nedbank and they assign a relationship manager. Budget real
   calendar time for this — it is not self-service.

### 2. Set the secrets (never committed, never in the bundle)

```bash
supabase secrets set NEDBANK_CLIENT_ID=... NEDBANK_CLIENT_SECRET=... NEDBANK_BASE=https://api.nedbank.co.za/apimarket/sandbox --project-ref uthvorhglqysehayyxzy
```

Swap `NEDBANK_BASE` to the production base Nedbank gives you when approved.

### 3. Deploy the function

```bash
supabase functions deploy nedbank-sync --project-ref uthvorhglqysehayyxzy
```

### 4. Authorise the consent (you, once)

This is the step where you log in to Nedbank. **Your banking credentials go to
Nedbank and nowhere else** — this app never sees them, and neither does anyone
helping you build it. The flow, per Nedbank's docs:

1. `POST /nboauth/oauth20/token` with `grant_type=client_credentials` → a
   **light** token.
2. `POST /open-banking/v3.1/aisp/account-access-consents` with permissions
   `ReadAccountsDetail`, `ReadBalances`, `ReadTransactionsDetail`,
   `ReadTransactionsCredits`, `ReadTransactionsDebits` → a `ConsentId` and an
   `SCARedirectURL`.
3. Open the `SCARedirectURL` and approve in your Nedbank login → you are
   returned with `?code=...`.
4. `POST /nboauth/oauth20/token` with `grant_type=authorization_code` → the
   **heavy** token and a refresh token.
5. Store the refresh token in `fin_bank_secrets` and insert a row in
   `fin_bank_connections` with the bank's `AccountId`, `status='active'`, and
   the app account it posts to (the Bank feed screen sets that mapping).

From then on the function refreshes the heavy token itself, and **Sync now** on
the Bank feed screen is all you touch.

## Endpoints used

| Purpose | Path (relative to `NEDBANK_BASE`) |
|---|---|
| Token (light, heavy, refresh) | `/nboauth/oauth20/token` |
| Authorise | `/nboauth/oauth20/authorize` |
| Create consent | `/open-banking/v3.1/aisp/account-access-consents` |
| Accounts | `/open-banking/v3.1/aisp/accounts` |
| Transactions | `/open-banking/v3.1/aisp/accounts/{AccountId}/transactions` |

Sandbox base: `https://api.nedbank.co.za/apimarket/sandbox`.
Verified reachable — an unauthenticated call returns
`401 {"httpMessage":"Unauthorized","moreInformation":"Invalid client id or secret."}`,
which confirms the path and that credentials are the only thing missing.

## Until it is connected

The CSV importer is the fallback and needs nothing from Nedbank: export the
statement from Nedbank online banking and drop it on the Import screen. It
reads Nedbank's CSV format, flags rows already on file, and applies the same
categorisation rules the feed will.
