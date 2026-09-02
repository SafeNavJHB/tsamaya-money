// Nedbank account link — Supabase Edge Function (Deno).
//
// Turns the multi-step Open Banking consent dance into one click. Two routes:
//
//   POST /nedbank-link          (with the user's Supabase JWT)
//     client_credentials -> light token
//     POST account-access-consents -> ConsentId + SCARedirectURL
//     stores a random `state` against the user, returns the URL to open
//
//   GET  /nedbank-link/callback?code=...&state=...   (the bank redirects here)
//     verifies `state`, exchanges the code for the heavy token + refresh token,
//     stores them service-side, reads /accounts and creates the connections,
//     then bounces the browser back to the app.
//
// The redirect URI to register on the Nedbank portal is exactly:
//   https://<project>.supabase.co/functions/v1/nedbank-link/callback
//
// The user authenticates with Nedbank on Nedbank's own page. Their banking
// credentials never pass through this function, the app, or the database.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const FAPI_ID = 'OB/2017/001';
const APP_URL = 'https://money.tsamayaapp.co.za/#/bank';

const env = (k: string): string => {
  const v = Deno.env.get(k);
  if (!v) throw new Error(`Missing secret ${k}`);
  return v;
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), {
    status,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'authorization, content-type',
    },
  });
const bounce = (msg: string, ok: boolean) =>
  new Response(null, { status: 302, headers: { location: `${APP_URL}?linked=${ok ? 'ok' : 'error'}&m=${encodeURIComponent(msg)}` } });

const bankHeaders = (token?: string): Record<string, string> => {
  const h: Record<string, string> = {
    'x-fapi-financial-id': FAPI_ID,
    'x-fapi-interaction-id': crypto.randomUUID(),
    'x-ibm-client-id': env('NEDBANK_CLIENT_ID'),
    'x-ibm-client-secret': env('NEDBANK_CLIENT_SECRET'),
    accept: 'application/json',
  };
  if (token) h.authorization = `Bearer ${token}`;
  return h;
};

async function tokenCall(body: Record<string, string>) {
  const res = await fetch(`${env('NEDBANK_BASE')}/nboauth/oauth20/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...bankHeaders() },
    body: new URLSearchParams({
      client_id: env('NEDBANK_CLIENT_ID'),
      client_secret: env('NEDBANK_CLIENT_SECRET'),
      ...body,
    }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Token call failed (${res.status}): ${JSON.stringify(out).slice(0, 300)}`);
  return out as { access_token: string; refresh_token?: string; expires_in?: number };
}

const admin = () => createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));
const redirectUri = (req: Request) => `${new URL(req.url).origin}/functions/v1/nedbank-link/callback`;

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'authorization, content-type',
        'access-control-allow-methods': 'POST, GET, OPTIONS',
      },
    });
  }

  // ------------------------------------------------------------ callback
  if (url.pathname.endsWith('/callback')) {
    try {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      if (!code || !state) return bounce('The bank did not return an authorisation code.', false);

      const db = admin();
      const { data: pending } = await db.from('fin_bank_link_states').select('*').eq('state', state).maybeSingle();
      // An unknown or expired state means this callback was not started by us.
      if (!pending) return bounce('That link request is unknown or has expired. Start again.', false);
      await db.from('fin_bank_link_states').delete().eq('state', state);
      if (Date.parse(pending.expires_at) < Date.now()) return bounce('That link request expired. Start again.', false);

      const tok = await tokenCall({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri(req),
      });
      if (!tok.refresh_token) return bounce('Nedbank returned no refresh token, so the link would expire immediately.', false);

      await db.from('fin_bank_secrets').upsert({
        user_id: pending.user_id,
        provider: 'nedbank',
        refresh_token: tok.refresh_token,
        access_token: tok.access_token,
        access_expires_at: new Date(Date.now() + (tok.expires_in ?? 300) * 1000).toISOString(),
        updated_at: new Date().toISOString(),
      });

      // Read the authorised accounts and create a connection per account.
      const accRes = await fetch(`${env('NEDBANK_BASE')}/open-banking/v3.1/aisp/accounts`, {
        headers: bankHeaders(tok.access_token),
      });
      const accBody = await accRes.json().catch(() => ({}));
      if (!accRes.ok) return bounce(`Linked, but reading accounts failed (${accRes.status}).`, false);

      const list = accBody?.Data?.Account ?? accBody?.Data?.Accounts ?? [];
      let linked = 0;
      for (const a of Array.isArray(list) ? list : []) {
        const ident = String(a?.Account?.[0]?.Identification ?? '');
        const name = a?.Nickname ?? a?.Account?.[0]?.Name ?? a?.AccountSubType ?? 'Account';
        // Never store or display the full account number.
        const label = ident.length > 4 ? `${name} (••••${ident.slice(-4)})` : String(name);
        const { error } = await db.from('fin_bank_connections').upsert(
          {
            user_id: pending.user_id,
            provider: 'nedbank',
            label,
            provider_account_id: String(a?.AccountId ?? ''),
            consent_id: pending.consent_id,
            status: 'active',
          },
          { onConflict: 'user_id,provider,provider_account_id' },
        );
        if (!error) linked++;
      }
      return bounce(`Linked ${linked} account${linked === 1 ? '' : 's'}. Map each to an account, then Sync now.`, true);
    } catch (e) {
      return bounce(e instanceof Error ? e.message : String(e), false);
    }
  }

  // ------------------------------------------------------------ start
  try {
    const jwt = req.headers.get('authorization')?.replace(/^Bearer /i, '');
    if (!jwt) return json({ error: 'Not signed in.' }, 401);
    const db = admin();
    const { data: userData, error: userErr } = await db.auth.getUser(jwt);
    if (userErr || !userData?.user) return json({ error: 'Invalid session.' }, 401);
    const userId = userData.user.id;
    const { data: member } = await db.from('fin_members').select('user_id').eq('user_id', userId).maybeSingle();
    if (!member) return json({ error: 'Not a member of these books.' }, 403);

    // 1. Light token.
    const light = await tokenCall({ grant_type: 'client_credentials', scope: 'accounts' });

    // 2. Consent. Read-only permissions: this app never initiates payments.
    const year = new Date();
    year.setFullYear(year.getFullYear() + 1);
    const consentRes = await fetch(`${env('NEDBANK_BASE')}/open-banking/v3.1/aisp/account-access-consents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...bankHeaders(light.access_token) },
      body: JSON.stringify({
        Data: {
          Permissions: [
            'ReadAccountsDetail',
            'ReadBalances',
            'ReadTransactionsDetail',
            'ReadTransactionsCredits',
            'ReadTransactionsDebits',
          ],
          ExpirationDateTime: year.toISOString(),
        },
        Risk: {},
      }),
    });
    const consent = await consentRes.json().catch(() => ({}));
    if (!consentRes.ok) {
      return json({ error: `Consent request failed (${consentRes.status}): ${JSON.stringify(consent).slice(0, 300)}` }, 502);
    }
    const consentId = consent?.Data?.ConsentId;
    const scaUrl = consent?.Links?.SCARedirectURL;
    if (!consentId) return json({ error: 'Nedbank returned no ConsentId.' }, 502);

    // 3. Remember who started this, and prove the callback is ours.
    const state = crypto.randomUUID();
    await db.from('fin_bank_link_states').insert({ state, user_id: userId, provider: 'nedbank', consent_id: consentId });

    const authorize = new URL(scaUrl ?? `${env('NEDBANK_BASE')}/nboauth/oauth20/authorize`);
    authorize.searchParams.set('client_id', env('NEDBANK_CLIENT_ID'));
    authorize.searchParams.set('response_type', 'code');
    authorize.searchParams.set('scope', 'openid accounts');
    authorize.searchParams.set('redirect_uri', redirectUri(req));
    authorize.searchParams.set('state', state);
    authorize.searchParams.set('intentid', consentId);
    authorize.searchParams.set('itype', 'accounts');

    return json({ authorizeUrl: authorize.toString(), consentId });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
