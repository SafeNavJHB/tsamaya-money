-- Tsamaya Money — pending OAuth link states for the bank connect flow.
-- Applied 2026-09-02.
--
-- The bank redirects back to us with ?code=... and no Supabase session, so
-- something must say WHICH user started the link. That is the OAuth `state`
-- parameter: a random value stored here against the user id, checked on the
-- way back. It doubles as CSRF protection, which is what `state` is for.
--
-- Service-role only, like fin_bank_secrets: RLS on, no policies, no grant to
-- `authenticated`. A client can neither read nor forge one.
create table if not exists public.fin_bank_link_states (
  state       text primary key,
  user_id     uuid not null,
  provider    text not null default 'nedbank',
  consent_id  text,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '30 minutes'
);

alter table public.fin_bank_link_states enable row level security;
revoke all on table public.fin_bank_link_states from public, anon, authenticated;

create index if not exists fin_bank_link_states_expiry
  on public.fin_bank_link_states (expires_at);

notify pgrst, 'reload schema';
