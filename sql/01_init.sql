-- Tsamaya Money — personal finance tracker schema
-- Applied 2026-09-01 via the eu-west-2 session pooler (see README).
-- All tables are prefixed fin_ and are fully independent of the SafeNav app
-- tables that share this Supabase project. Access is gated twice:
--   1. every row carries user_id and RLS requires user_id = auth.uid()
--   2. fin_is_member() requires the uid to be present in fin_members,
--      so a stranger who somehow obtains an auth session sees nothing.

-- ---------------------------------------------------------------- membership
create table if not exists public.fin_members (
  user_id  uuid primary key,
  added_at timestamptz not null default now()
);

alter table public.fin_members enable row level security;
-- No policies on purpose: clients can never read or write membership.
revoke all on table public.fin_members from public, anon, authenticated;

insert into public.fin_members (user_id)
values ('be68588b-c8c2-475f-b9a3-2ba6cd69cde5') -- the owner's auth uid
on conflict do nothing;

create or replace function public.fin_is_member()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (select 1 from public.fin_members m where m.user_id = auth.uid())
$$;

revoke all on function public.fin_is_member() from public, anon;
grant execute on function public.fin_is_member() to authenticated;

-- ---------------------------------------------------------------- accounts
create table if not exists public.fin_accounts (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null default auth.uid(),
  name            text not null,
  kind            text not null default 'bank'
                  check (kind in ('bank','card','cash','savings','investment','other')),
  opening_balance numeric(14,2) not null default 0,
  sort            integer not null default 0,
  archived        boolean not null default false,
  created_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------- categories
create table if not exists public.fin_categories (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid(),
  name           text not null,
  kind           text not null check (kind in ('income','expense')),
  monthly_budget numeric(14,2) check (monthly_budget is null or monthly_budget >= 0),
  sort           integer not null default 0,
  archived       boolean not null default false,
  created_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------- transactions
create table if not exists public.fin_transactions (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null default auth.uid(),
  tx_date             date not null,
  kind                text not null check (kind in ('income','expense','transfer')),
  amount              numeric(14,2) not null check (amount > 0),
  category_id         uuid references public.fin_categories (id) on delete restrict,
  account_id          uuid not null references public.fin_accounts (id) on delete restrict,
  transfer_account_id uuid references public.fin_accounts (id) on delete restrict,
  payee               text,
  notes               text,
  created_at          timestamptz not null default now(),
  -- a transfer must name a destination and carries no category;
  -- income/expense must not name a destination
  check (kind <> 'transfer' or (transfer_account_id is not null and category_id is null)),
  check (kind =  'transfer' or transfer_account_id is null),
  check (transfer_account_id is null or transfer_account_id <> account_id)
);

create index if not exists fin_transactions_user_date
  on public.fin_transactions (user_id, tx_date desc);
create index if not exists fin_transactions_category
  on public.fin_transactions (category_id);
create index if not exists fin_transactions_account
  on public.fin_transactions (account_id);

-- ---------------------------------------------------------------- assets & liabilities
create table if not exists public.fin_assets (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid(),
  name       text not null,
  side       text not null check (side in ('asset','liability')),
  category   text not null default 'other'
             check (category in ('vehicle','property','investment','retirement',
                                 'loan','credit','tax','other')),
  notes      text,
  sort       integer not null default 0,
  archived   boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.fin_valuations (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid(),
  asset_id   uuid not null references public.fin_assets (id) on delete cascade,
  val_date   date not null,
  value      numeric(14,2) not null check (value >= 0),
  created_at timestamptz not null default now(),
  unique (asset_id, val_date)
);

create index if not exists fin_valuations_asset_date
  on public.fin_valuations (asset_id, val_date desc);

-- ---------------------------------------------------------------- RLS + grants
-- Lockdown recipe: REVOKE ALL then GRANT back (never enumerated REVOKEs).
do $$
declare t text;
begin
  foreach t in array array['fin_accounts','fin_categories','fin_transactions',
                           'fin_assets','fin_valuations']
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

-- ---------------------------------------------------------------- seed data (Kyle)
do $$
declare uid uuid := 'be68588b-c8c2-475f-b9a3-2ba6cd69cde5';
begin
  if not exists (select 1 from public.fin_accounts where user_id = uid) then
    insert into public.fin_accounts (user_id, name, kind, sort) values
      (uid, 'Bank account', 'bank', 0),
      (uid, 'Credit card',  'card', 1),
      (uid, 'Cash',         'cash', 2);
  end if;

  if not exists (select 1 from public.fin_categories where user_id = uid) then
    insert into public.fin_categories (user_id, name, kind, sort) values
      (uid, 'Salary',               'income',  0),
      (uid, 'Interest',             'income',  1),
      (uid, 'Dividends',            'income',  2),
      (uid, 'Other income',         'income',  3),
      (uid, 'Rent & housing',       'expense', 10),
      (uid, 'Utilities & rates',    'expense', 11),
      (uid, 'Groceries',            'expense', 12),
      (uid, 'Eating out',           'expense', 13),
      (uid, 'Fuel & transport',     'expense', 14),
      (uid, 'Vehicle',              'expense', 15),
      (uid, 'Insurance',            'expense', 16),
      (uid, 'Medical',              'expense', 17),
      (uid, 'Phone & internet',     'expense', 18),
      (uid, 'Subscriptions',        'expense', 19),
      (uid, 'Entertainment',        'expense', 20),
      (uid, 'Clothing',             'expense', 21),
      (uid, 'Gifts & donations',    'expense', 22),
      (uid, 'Education',            'expense', 23),
      (uid, 'Travel',               'expense', 24),
      (uid, 'Bank fees',            'expense', 25),
      (uid, 'Tax',                  'expense', 26),
      (uid, 'Other',                'expense', 27);
  end if;
end $$;

-- PostgREST must re-read the schema before the new tables are visible over REST.
notify pgrst, 'reload schema';
