-- Tsamaya Money — bank feed (Nedbank API Marketplace, Open Banking v3.1 AISP).
-- Applied 2026-09-01.
--
-- Why this shape:
--
--   Every Nedbank call needs `x-ibm-client-secret`, so the integration CANNOT
--   run in the browser: this app is a static site and a bundled secret is a
--   published secret. The sync therefore runs in a Supabase Edge Function
--   (supabase/functions/nedbank-sync), and these tables are the contract
--   between it and the app.
--
--   Fetched transactions land in fin_bank_feed as PENDING. They are not ledger
--   postings. A human reviews and posts them, exactly like the CSV importer —
--   a bank feed writing straight into the books would mean the statements
--   change without anyone deciding they should.
--
--   Nedbank returns a stable OB `TransactionId`, so the unique index on
--   (user_id, provider, provider_tx_id) makes re-syncing an overlapping window
--   genuinely idempotent — a much stronger guarantee than the CSV importer's
--   date/amount heuristic.

-- ---------------------------------------------------------------- connections
create table if not exists public.fin_bank_connections (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null default auth.uid(),
  provider            text not null default 'nedbank',
  label               text not null,
  -- The bank's own identifier for the account (OB AccountId).
  provider_account_id text not null,
  -- Which of our accounts its transactions post to.
  account_id          uuid references public.fin_accounts (id) on delete set null,
  consent_id          text,
  consent_expires_at  timestamptz,
  status              text not null default 'pending'
                      check (status in ('pending','active','expired','revoked','error')),
  last_synced_at      timestamptz,
  last_sync_error     text,
  created_at          timestamptz not null default now(),
  unique (user_id, provider, provider_account_id)
);

-- ---------------------------------------------------------------- feed
create table if not exists public.fin_bank_feed (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null default auth.uid(),
  connection_id   uuid references public.fin_bank_connections (id) on delete cascade,
  provider        text not null default 'nedbank',
  -- OB TransactionId: the bank's stable id, and our idempotency key.
  provider_tx_id  text not null,
  account_id      uuid references public.fin_accounts (id) on delete set null,
  booked_on       date not null,
  amount          numeric(14,2) not null check (amount > 0),
  direction       text not null check (direction in ('credit','debit')),
  description     text,
  reference       text,
  balance_after   numeric(14,2),
  raw             jsonb,
  status          text not null default 'pending'
                  check (status in ('pending','imported','ignored')),
  -- Set once posted, so a feed row can always be traced to its ledger entry.
  transaction_id  uuid references public.fin_transactions (id) on delete set null,
  fetched_at      timestamptz not null default now(),
  unique (user_id, provider, provider_tx_id)
);

create index if not exists fin_bank_feed_pending
  on public.fin_bank_feed (user_id, status, booked_on desc);

-- ---------------------------------------------------------------- secrets
-- OAuth tokens for the bank connection. Deliberately NO policies and no grant
-- to `authenticated`: only the service role (the Edge Function) may read or
-- write these. The same lockdown as fin_members.
create table if not exists public.fin_bank_secrets (
  user_id           uuid not null,
  provider          text not null default 'nedbank',
  refresh_token     text,
  access_token      text,
  access_expires_at timestamptz,
  updated_at        timestamptz not null default now(),
  primary key (user_id, provider)
);

alter table public.fin_bank_secrets enable row level security;
revoke all on table public.fin_bank_secrets from public, anon, authenticated;

-- ---------------------------------------------------------------- RLS + grants
do $$
declare t text;
begin
  foreach t in array array['fin_bank_connections','fin_bank_feed']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
    execute format('grant select, insert, update, delete on table public.%I to authenticated', t);
    execute format('drop policy if exists %I on public.%I', t || '_member_own', t);
    execute format(
      'create policy %I on public.%I for all to authenticated
         using (user_id = auth.uid() and public.fin_is_member())
         with check (user_id = auth.uid() and public.fin_is_member())',
      t || '_member_own', t);
  end loop;
end $$;

notify pgrst, 'reload schema';
