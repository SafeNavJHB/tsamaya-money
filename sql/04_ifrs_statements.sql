-- Tsamaya Money — IFRS for SMEs statement support.
-- Applied 2026-09-01.
--
-- Adds the equity dimension the tracker model lacked, so a Statement of
-- Financial Position (Section 4) and a Statement of Changes in Equity
-- (Section 6) can be produced from posted double entry rather than estimated.
--
-- Three additions:
--   1. fin_settings   — the Section 3.23 identification disclosures (entity
--                       name, registration number, financial year end).
--   2. fin_equity     — capital transactions that must NOT touch profit or
--                       loss: share issues, dividends, prior-period
--                       adjustments (Section 10 / Section 6.3(b)).
--   3. classification — presentation captions and current/non-current flags
--                       (Section 4.4-4.7), plus fin_transactions.asset_id so
--                       a capital purchase debits the asset instead of being
--                       expensed, keeping the SoFP complete and balanced.

-- ---------------------------------------------------------------- settings
create table if not exists public.fin_settings (
  user_id             uuid primary key default auth.uid(),
  entity_name         text not null default 'TSAMAYA (PTY) LTD',
  registration_number text,
  -- Month the financial year ENDS in. SA private companies commonly use
  -- February; the incorporation date does not fix it, so this is editable.
  fy_end_month        smallint not null default 2 check (fy_end_month between 1 and 12),
  created_at          timestamptz not null default now()
);

-- ---------------------------------------------------------------- equity movements
create table if not exists public.fin_equity (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null default auth.uid(),
  mv_date           date not null,
  kind              text not null
                    check (kind in ('share_issue','dividend','prior_period_adjustment')),
  -- Positive for share issues and dividends (direction comes from `kind`);
  -- signed for a prior-period adjustment, which may go either way.
  amount            numeric(14,2) not null,
  -- Where the cash went or came from. NULL means the movement was not settled
  -- in cash (shares issued but unpaid, or a dividend declared not yet paid).
  contra_account_id uuid references public.fin_accounts (id) on delete restrict,
  shares_issued     integer check (shares_issued is null or shares_issued > 0),
  notes             text,
  created_at        timestamptz not null default now(),
  check (kind = 'prior_period_adjustment' or amount > 0),
  check (kind <> 'prior_period_adjustment' or amount <> 0),
  check (kind = 'share_issue' or shares_issued is null)
);

create index if not exists fin_equity_user_date on public.fin_equity (user_id, mv_date);

-- ---------------------------------------------------------------- classification
alter table public.fin_accounts
  add column if not exists bs_line text,
  add column if not exists is_current boolean not null default true;

alter table public.fin_assets
  add column if not exists bs_line text,
  add column if not exists is_current boolean not null default false;

-- A capitalised purchase: the expense debits the asset, not a P&L category.
alter table public.fin_transactions
  add column if not exists asset_id uuid references public.fin_assets (id) on delete restrict;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'fin_transactions_capitalise') then
    alter table public.fin_transactions
      add constraint fin_transactions_capitalise
      check (asset_id is null or (kind = 'expense' and category_id is null));
  end if;
end $$;

-- ---------------------------------------------------------------- RLS + grants
do $$
declare t text;
begin
  foreach t in array array['fin_settings','fin_equity']
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

-- ---------------------------------------------------------------- seed
do $$
declare uid uuid := (select user_id from public.fin_members order by added_at limit 1);
begin
  if uid is null then raise exception 'no member row to seed against'; end if;

  insert into public.fin_settings (user_id) values (uid) on conflict do nothing;

  -- Presentation captions for the accounts created in sql/03. A director loan
  -- repayable on demand is a current liability; change is_current if terms say
  -- otherwise.
  update public.fin_accounts set bs_line = 'Cash and cash equivalents', is_current = true
   where user_id = uid and name = 'Business bank account' and bs_line is null;
  update public.fin_accounts set bs_line = 'Loan from director', is_current = true
   where user_id = uid and name = 'Director loan — Kyle' and bs_line is null;
  update public.fin_accounts set bs_line = 'Prepayments', is_current = true
   where user_id = uid and name = 'CIPC deposit' and bs_line is null;
end $$;

notify pgrst, 'reload schema';
