// Nedbank API Marketplace sync — Supabase Edge Function (Deno).
//
// WHY THIS RUNS SERVER-SIDE
// Every Nedbank call carries `x-ibm-client-secret`. Tsamaya Money is a static
// site on GitHub Pages, so a secret in the bundle is a published secret, and
// the bank's origin would not permit browser calls anyway. This function is
// the only place credentials exist; the app calls it with the user's Supabase
// JWT and never sees them.
//
// WHAT IT DOES NOT DO
// It never posts to the ledger. Fetched transactions land in fin_bank_feed as
// `pending` for a human to review, the same discipline as the CSV importer.
//
// SECRETS (set with `supabase secrets set …`, never committed):
//   NEDBANK_CLIENT_ID, NEDBANK_CLIENT_SECRET
//   NEDBANK_BASE          e.g. https://api.nedbank.co.za/apimarket/sandbox
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   (provided by the platform)
//
// The OAuth dance (Nedbank docs, Open Banking v3.1 AISP):
//   1. client_credentials  -> "light" token
//   2. POST account-access-consents (light) -> ConsentId + SCARedirectURL
//   3. the user authorises at the bank -> ?code=...
//   4. authorization_code -> "heavy" token + refresh token
//   5. call /accounts, /balances, /transactions with the heavy token
//   6. refresh_token when the heavy token expires
// Steps 1-4 are the one-off link; this function does 5 and 6.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const FAPI_ID = 'OB/2017/001';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const env = (k: string): string => {
  const v = Deno.env.get(k);
  if (!v) throw new Error(`Missing secret ${k}`);
  return v;
};

function bankHeaders(token?: string): Record<string, string> {
  const h: Record<string, string> = {
    'x-fapi-financial-id': FAPI_ID,
    'x-fapi-interaction-id': crypto.randomUUID(),
    'x-ibm-client-id': env('NEDBANK_CLIENT_ID'),
    'x-ibm-client-secret': env('NEDBANK_CLIENT_SECRET'),
    accept: 'application/json',
  };
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

/** Exchange the stored refresh token for a fresh heavy token. */
async function refreshHeavyToken(refreshToken: string): Promise<{ access_token: string; refresh_token?: string; expires_in?: number }> {
  const res = await fetch(`${env('NEDBANK_BASE')}/nboauth/oauth20/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...bankHeaders() },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: env('NEDBANK_CLIENT_ID'),
      client_secret: env('NEDBANK_CLIENT_SECRET'),
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Token refresh failed (${res.status}): ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'authorization, content-type',
        'access-control-allow-methods': 'POST, OPTIONS',
      },
    });
  }
  try {
    // 1. Authenticate the caller as a member. The service-role client is only
    //    used AFTER the caller's identity is established.
    const jwt = req.headers.get('authorization')?.replace(/^Bearer /i, '');
    if (!jwt) return json({ error: 'Not signed in.' }, 401);

    const admin = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));
    const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
    if (userErr || !userData?.user) return json({ error: 'Invalid session.' }, 401);
    const userId = userData.user.id;

    const { data: member } = await admin.from('fin_members').select('user_id').eq('user_id', userId).maybeSingle();
    if (!member) return json({ error: 'Not a member of these books.' }, 403);

    const { from, to } = await req.json().catch(() => ({}));
    const toDate = (to as string) ?? new Date().toISOString().slice(0, 10);
    const fromDate = (from as string) ?? new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);

    // 2. Active connections for this user.
    const { data: connections, error: connErr } = await admin
      .from('fin_bank_connections')
      .select('*')
      .eq('user_id', userId)
      .eq('provider', 'nedbank')
      .eq('status', 'active');
    if (connErr) return json({ error: connErr.message }, 500);
    if (!connections?.length) return json({ error: 'No active Nedbank connection. Link the account first.' }, 400);

    // 3. A heavy token, refreshed if needed.
    const { data: secrets } = await admin
      .from('fin_bank_secrets')
      .select('*')
      .eq('user_id', userId)
      .eq('provider', 'nedbank')
      .maybeSingle();
    if (!secrets?.refresh_token) {
      return json({ error: 'The bank connection needs re-authorising.' }, 400);
    }

    let accessToken = secrets.access_token as string | null;
    const expiresAt = secrets.access_expires_at ? Date.parse(secrets.access_expires_at) : 0;
    if (!accessToken || expiresAt - 60_000 < Date.now()) {
      const t = await refreshHeavyToken(secrets.refresh_token);
      accessToken = t.access_token;
      await admin.from('fin_bank_secrets').update({
        access_token: t.access_token,
        refresh_token: t.refresh_token ?? secrets.refresh_token,
        access_expires_at: new Date(Date.now() + (t.expires_in ?? 300) * 1000).toISOString(),
        updated_at: new Date().toISOString(),
      }).eq('user_id', userId).eq('provider', 'nedbank');
    }

    // 4. Fetch and stage, one connection at a time.
    const summary: Record<string, unknown>[] = [];
    for (const conn of connections) {
      try {
        const url = new URL(`${env('NEDBANK_BASE')}/open-banking/v3.1/aisp/accounts/${conn.provider_account_id}/transactions`);
        url.searchParams.set('fromBookingDateTime', `${fromDate}T00:00:00Z`);
        url.searchParams.set('toBookingDateTime', `${toDate}T23:59:59Z`);

        const res = await fetch(url, { headers: bankHeaders(accessToken!) });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(`Nedbank returned ${res.status}: ${JSON.stringify(payload).slice(0, 300)}`);

        // The mapping mirrors src/logic/openBanking.ts, which is unit-tested.
        const list = payload?.Data?.Transaction ?? payload?.Data?.Transactions ?? [];
        const rows: Record<string, unknown>[] = [];
        let skipped = 0;
        for (const t of Array.isArray(list) ? list : []) {
          if ((t.Status ?? 'Booked').toLowerCase() !== 'booked') { skipped++; continue; }
          const id = String(t.TransactionId ?? '').trim();
          const dateMatch = String(t.BookingDateTime ?? t.ValueDateTime ?? '').match(/^(\d{4}-\d{2}-\d{2})/);
          const rawAmount = String(t.Amount?.Amount ?? '').trim();
          // Strict: a non-decimal amount is skipped, never coerced.
          if (!id || !dateMatch || !/^[+-]?\d+(\.\d+)?$/.test(rawAmount)) { skipped++; continue; }
          const amount = Math.abs(Number(rawAmount));
          if (!amount) { skipped++; continue; }
          const bal = String(t.Balance?.Amount?.Amount ?? '').trim();
          const balOk = /^[+-]?\d+(\.\d+)?$/.test(bal);
          rows.push({
            user_id: userId,
            connection_id: conn.id,
            provider: 'nedbank',
            provider_tx_id: id,
            account_id: conn.account_id,
            booked_on: dateMatch[1],
            amount,
            direction: String(t.CreditDebitIndicator ?? '').toLowerCase().startsWith('credit') ? 'credit' : 'debit',
            description: String(t.TransactionInformation ?? t.TransactionReference ?? '').trim().slice(0, 300),
            reference: String(t.TransactionReference ?? '').trim().slice(0, 120) || null,
            balance_after: balOk
              ? (String(t.Balance?.CreditDebitIndicator ?? '').toLowerCase() === 'debit' ? -Math.abs(Number(bal)) : Math.abs(Number(bal)))
              : null,
            raw: t,
          });
        }

        // ignoreDuplicates: a re-sync of an overlapping window must not disturb
        // a row a human has already reviewed.
        let inserted = 0;
        for (let i = 0; i < rows.length; i += 200) {
          const chunk = rows.slice(i, i + 200);
          const { error: upErr, count } = await admin
            .from('fin_bank_feed')
            .upsert(chunk, { onConflict: 'user_id,provider,provider_tx_id', ignoreDuplicates: true, count: 'exact' });
          if (upErr) throw new Error(upErr.message);
          inserted += count ?? 0;
        }

        await admin.from('fin_bank_connections')
          .update({ last_synced_at: new Date().toISOString(), last_sync_error: null })
          .eq('id', conn.id);
        summary.push({ connection: conn.label, fetched: rows.length, new: inserted, skipped });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        await admin.from('fin_bank_connections')
          .update({ last_sync_error: message.slice(0, 500), status: 'error' })
          .eq('id', conn.id);
        summary.push({ connection: conn.label, error: message });
      }
    }

    return json({ from: fromDate, to: toDate, results: summary }, 200);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
