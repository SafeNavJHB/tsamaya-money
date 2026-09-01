-- Tsamaya Money — recurring transactions + bank statement import.
-- Applied 2026-09-01. Same lockdown pattern as sql/01_init.sql: RLS requires
-- user_id = auth.uid() AND fin_is_member().

-- ---------------------------------------------------------------- recurring
create table if not exists public.fin_recurring (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null default auth.uid(),
  name                text not null,
  kind                text not null check (kind in ('income','expense','transfer')),
  amount              numeric(14,2) not null check (amount > 0),
  category_id         uuid references public.fin_categories (id) on delete restrict,
  account_id          uuid not null references public.fin_accounts (id) on delete restrict,
  transfer_account_id uuid references public.fin_accounts (id) on delete restrict,
  payee               text,
  notes               text,
  frequency           text not null default 'monthly'
                      check (frequency in ('weekly','fortnightly','monthly','quarterly','annually')),
  -- Day of month the series is anchored to (from start_date). Kept separate
  -- from next_date so a 31st series does not drift to the 28th after February.
  anchor_day          smallint not null default 1 check (anchor_day between 1 and 31),
  start_date          date not null,
  end_date            date,
  next_date           date not null,
  auto_post           boolean not null default false,
  archived            boolean not null default false,
  created_at          timestamptz not null default now(),
  -- same shape rules as fin_transactions
  check (kind <> 'transfer' or (transfer_account_id is not null and category_id is null)),
  check (kind =  'transfer' or transfer_account_id is null),
  check (transfer_account_id is null or transfer_account_id <> account_id),
  check (end_date is null or end_date >= start_date)
);

create index if not exists fin_recurring_user_next
  on public.fin_recurring (user_id, next_date);

-- ---------------------------------------------------------------- import rules
-- Case-insensitive substring match against the raw statement description.
-- Longest match_text wins (applied client-side), so a specific rule can sit
-- above a general one.
create table if not exists public.fin_import_rules (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid(),
  match_text  text not null check (length(btrim(match_text)) >= 2),
  category_id uuid references public.fin_categories (id) on delete cascade,
  payee       text,
  created_at  timestamptz not null default now(),
  unique (user_id, match_text)
);

-- ---------------------------------------------------------------- transaction provenance
alter table public.fin_transactions
  add column if not exists recurring_id uuid references public.fin_recurring (id) on delete set null,
  add column if not exists import_ref text;

-- One posting per template per date. This is the real guard against a
-- double-click or a second device posting the same occurrence twice; the app
-- catches 23505 and reports it as "already posted" rather than an error.
create unique index if not exists fin_transactions_recurring_once
  on public.fin_transactions (recurring_id, tx_date)
  where recurring_id is not null;

-- Speeds up the importer's duplicate scan.
create index if not exists fin_transactions_dupe_scan
  on public.fin_transactions (user_id, account_id, tx_date, amount);

-- ---------------------------------------------------------------- RLS + grants
do $$
declare t text;
begin
  foreach t in array array['fin_recurring','fin_import_rules']
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
