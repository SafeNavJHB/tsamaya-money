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

There is **no self-service signup**. Nedbank's own guide sets out four steps,
and credentials do not appear until step 3:

1. **Register your interest** at <https://apim.nedbank.co.za> ("Register your
   interest" in the top nav). This is the account-creation route, not just a
   sales enquiry.
2. **Due diligence.** Nedbank reviews the request and a specialist makes
   contact. On approval you get an activation email and a portal login. Have
   the company registration details and director ID ready; this step takes
   calendar time, not minutes.
3. **Create your app** on the portal. *This* is where the **client ID** and
   **client secret** are shown.
4. **Subscribe the app** to the **Nedbank Authorisation API** (required for
   OAuth on every other product) plus:
   - **Business Transactions API** (`accounts-b2b`) — the right one here:
     transactions and balances on your *own* Nedbank business current and
     savings accounts, pitched at automated reconciliation; or
   - **Accounts API** — the general Open Banking AISP product, framed for
     third-party providers reading *other people's* accounts with consent.

Then ask Nedbank to move the app from **sandbox to production** against the
business current account. Production is *requested, reviewed and approved* by
them with a relationship manager.

⚠ On the interest form the "Which API will you primarily use?" dropdown does
**not** list the Business Transactions API, and does **not** lock you in: you
choose products in step 4. Pick **Accounts API** (the family it belongs to) and
name the Business Transactions API in the free-text box so it routes correctly.

### 2. Set the secrets (never committed, never in the bundle)

```bash
supabase secrets set NEDBANK_CLIENT_ID=... NEDBANK_CLIENT_SECRET=... NEDBANK_BASE=https://api.nedbank.co.za/apimarket/sandbox --project-ref uthvorhglqysehayyxzy
```

Swap `NEDBANK_BASE` to the production base Nedbank gives you when approved.

### 3. Deploy the function

```bash
supabase functions deploy nedbank-sync --project-ref uthvorhglqysehayyxzy
```

### 4. Press **Connect Nedbank** (you, once)

Open the Bank feed screen and press **Connect Nedbank**. That is the whole
step: `nedbank-link` runs the entire consent dance for you.

**Your banking credentials go to Nedbank's own page and nowhere else.** They
never pass through this app, the Edge Function, or the database.

What runs behind that button, per Nedbank's documented flow:

1. `grant_type=client_credentials` → a **light** token.
2. `POST /open-banking/v3.1/aisp/account-access-consents` with read-only
   permissions (`ReadAccountsDetail`, `ReadBalances`, `ReadTransactionsDetail`,
   `ReadTransactionsCredits`, `ReadTransactionsDebits`) → a `ConsentId` and an
   `SCARedirectURL`. **No payment permission is ever requested**, so the
   connection cannot move money even if it were misused.
3. You are sent to Nedbank to approve, and returned to
   `/functions/v1/nedbank-link/callback?code=…&state=…`.
4. The `state` is checked against `fin_bank_link_states` (service-role only, so
   a client can neither read nor forge one). This both proves the callback is
   ours and says which user it belongs to, since the bank's redirect carries no
   Supabase session.
5. `grant_type=authorization_code` → the heavy token and refresh token, stored
   in `fin_bank_secrets`. `/accounts` is read and a connection row created per
   account, labelled with the last four digits only.

Then map each connection to one of your accounts on the Bank feed screen. From
there the function refreshes tokens itself and **Sync now** is all you touch.

### The redirect URI to register

When you create the app on the Nedbank portal it asks for a redirect URI. Use
exactly:

```
https://uthvorhglqysehayyxzy.supabase.co/functions/v1/nedbank-link/callback
```

## What it costs

Nedbank publishes **no pricing** for the API Marketplace: there is nothing on
the marketplace site and nothing in the
[API Marketplace terms and conditions](https://personal.nedbank.co.za/legal/terms-and-conditions/api-marketplace.html).

- Registration and the **sandbox** are self-service with no payment step
  documented anywhere, and Nedbank describes the sandbox as risk-free testing,
  so this part is almost certainly free.
- **Production** goes through a sales consultant and a relationship manager,
  which is the shape of an arrangement where commercial terms are set per
  client. Treat production pricing as unknown until they tell you.

Ask them directly, in writing:

> Is there any fee, once-off or recurring, for production access to the
> Business Transactions API (or the Accounts API) for a single business current
> account? Are there call-volume limits or charges beyond a free tier?

## Endpoints used

| Purpose | Path (relative to `NEDBANK_BASE`) |
|---|---|
| Token (light, heavy, refresh) | `/nboauth/oauth20/token` |
| Authorise | `/nboauth/oauth20/authorize` |
| Create consent | `/open-banking/v3.1/aisp/account-access-consents` |
| Link callback (ours) | `/functions/v1/nedbank-link/callback` |
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
