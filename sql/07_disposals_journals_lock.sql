-- Tsamaya Money — asset disposals, manual journal entries, and period locking.
-- Applied 2026-09-01.
--
-- Three things a real set of books needs that the fixed schemas cannot express:
--
--   1. fin_disposals   — removing an asset at its carrying amount and
--                        recognising the gain or loss (Section 17.27-17.30).
--   2. fin_journals    — an arbitrary balanced Dr/Cr entry. This is the escape
--                        hatch that makes accruals, provisions, prepayment
--                        releases, reclassifications, corrections and opening
--                        balances possible without new tables for each.
--   3. locked_until    — once statements are issued the period must stop
--                        moving. Enforced by triggers, not by the UI, so a
--                        stray API call cannot restate a closed year.

-- ---------------------------------------------------------------- disposals
create table if not exists public.fin_disposals (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null default auth.uid(),
  asset_id            uuid not null references public.fin_assets (id) on delete cascade,
  disposal_date       date not null,
  proceeds            numeric(14,2) not null default 0 check (proceeds >= 0),
  -- Where the proceeds landed. NULL means not yet received, which leaves a
  -- receivable rather than pretending cash arrived.
  proceeds_account_id uuid references public.fin_accounts (id) on delete restrict,
  notes               text,
  created_at          timestamptz not null default now(),
  -- An asset can only be disposed of once.
  unique (asset_id)
);

-- ---------------------------------------------------------------- journals
create table if not exists public.fin_journals (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid(),
  entry_date date not null,
  reference  text,
  narration  text not null check (length(btrim(narration)) > 0),
  created_at timestamptz not null default now()
);

create table if not exists public.fin_journal_lines (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid(),
  journal_id  uuid not null references public.fin_journals (id) on delete cascade,
  -- A ledger account key as the app builds them: 'acc:<uuid>', 'cat:<uuid>',
  -- 'ast:<uuid>', 'accdep:<uuid>', 'eq:…', 'sys:…'. Not a foreign key because
  -- several of those accounts are synthetic and have no row of their own.
  account_key text not null check (length(btrim(account_key)) > 0),
  debit       numeric(14,2) not null default 0 check (debit >= 0),
  credit      numeric(14,2) not null default 0 check (credit >= 0),
  line_note   text,
  -- Every line is one-sided, which is what makes a journal readable.
  check ((debit > 0 and credit = 0) or (credit > 0 and debit = 0))
);

create index if not exists fin_journal_lines_journal on public.fin_journal_lines (journal_id);
create index if not exists fin_journals_user_date on public.fin_journals (user_id, entry_date);

-- A journal that does not balance is not an entry. Deferred so the client can
-- insert the header and its lines in the usual order within one transaction.
create or replace function public.fin_journal_balanced()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare d numeric; c numeric; n integer; jid uuid;
begin
  jid := coalesce(new.journal_id, old.journal_id);
  select coalesce(sum(debit), 0), coalesce(sum(credit), 0), count(*)
    into d, c, n
    from public.fin_journal_lines where journal_id = jid;
  if n = 0 then return null; end if;
  if n < 2 then
    raise exception 'A journal entry needs at least two lines (got %)', n;
  end if;
  if abs(d - c) > 0.005 then
    raise exception 'Journal does not balance: debits %, credits %', d, c;
  end if;
  return null;
end $$;

drop trigger if exists fin_journal_lines_balanced on public.fin_journal_lines;
create constraint trigger fin_journal_lines_balanced
  after insert or update or delete on public.fin_journal_lines
  deferrable initially deferred
  for each row execute function public.fin_journal_balanced();

-- ---------------------------------------------------------------- period lock
alter table public.fin_settings
  add column if not exists locked_until date;

create or replace function public.fin_period_locked()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare lock_date date; new_date date; old_date date;
begin
  select s.locked_until into lock_date from public.fin_settings s where s.user_id = auth.uid();
  if lock_date is null then return coalesce(new, old); end if;

  if tg_op <> 'DELETE' then
    new_date := (to_jsonb(new) ->> tg_argv[0])::date;
    if new_date <= lock_date then
      raise exception 'The period up to % is closed. Move the lock date in Settings to post here.', lock_date
        using errcode = 'check_violation';
    end if;
  end if;

  if tg_op <> 'INSERT' then
    old_date := (to_jsonb(old) ->> tg_argv[0])::date;
    if old_date <= lock_date then
      raise exception 'That entry falls in the closed period up to %.', lock_date
        using errcode = 'check_violation';
    end if;
  end if;

  return coalesce(new, old);
end $$;

do $$
declare t text; col text;
begin
  foreach t in array array['fin_transactions:tx_date','fin_journals:entry_date','fin_equity:mv_date',
                           'fin_depreciation:period_end','fin_disposals:disposal_date']
  loop
    col := split_part(t, ':', 2);
    t   := split_part(t, ':', 1);
    execute format('drop trigger if exists %I on public.%I', t || '_period_lock', t);
    execute format(
      'create trigger %I before insert or update or delete on public.%I
         for each row execute function public.fin_period_locked(%L)',
      t || '_period_lock', t, col);
  end loop;
end $$;

-- ---------------------------------------------------------------- RLS + grants
do $$
declare t text;
begin
  foreach t in array array['fin_disposals','fin_journals','fin_journal_lines']
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

revoke all on function public.fin_journal_balanced() from public, anon;
revoke all on function public.fin_period_locked() from public, anon;

notify pgrst, 'reload schema';
