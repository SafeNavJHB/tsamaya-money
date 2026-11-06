-- One company, several people: every member reads and writes the same books.
--
-- Until now each fin_* policy required user_id = auth.uid(), so a second member
-- would have seen an empty app, and their rows would have sat outside the
-- company's ledger. Rows keep user_id, which now always means the company owner,
-- and membership is what grants access.
--
-- Not shared: fin_bank_connections and fin_bank_feed stay per person, because the
-- Nedbank functions key on the signed-in user. fin_bank_secrets,
-- fin_bank_link_states and fin_members stay service-role only.
--
-- To add a member: insert their auth uid into fin_members (is_owner stays false).
-- To remove one: delete that row, and they see nothing again.

begin;

alter table public.fin_members
  add column if not exists is_owner boolean not null default false;

update public.fin_members set is_owner = true
 where user_id = 'be68588b-c8c2-475f-b9a3-2ba6cd69cde5';

create unique index if not exists fin_members_one_owner
  on public.fin_members (is_owner) where is_owner;

-- The uid the company's rows belong to, for members only.
create or replace function public.fin_company_owner()
returns uuid
language sql stable security definer
set search_path = public
as $$
  select m.user_id from public.fin_members m
   where m.is_owner and public.fin_is_member()
$$;

revoke all on function public.fin_company_owner() from public, anon;
grant execute on function public.fin_company_owner() to authenticated, service_role;

do $$
declare t text;
begin
  foreach t in array array[
    'fin_accounts', 'fin_assets', 'fin_categories', 'fin_depreciation', 'fin_disposals',
    'fin_equity', 'fin_import_rules', 'fin_journal_lines', 'fin_journals', 'fin_notes',
    'fin_recurring', 'fin_settings', 'fin_transactions', 'fin_valuations'
  ] loop
    execute format('drop policy if exists %I on public.%I', t || '_member_own', t);
    execute format('drop policy if exists %I on public.%I', t || '_members', t);
    execute format(
      'create policy %I on public.%I for all to authenticated
         using (user_id = public.fin_company_owner() and public.fin_is_member())
         with check (user_id = public.fin_company_owner() and public.fin_is_member())',
      t || '_members', t);
    execute format('alter table public.%I alter column user_id set default public.fin_company_owner()', t);
  end loop;
end $$;

-- Who entered a transaction, now that it can be more than one person.
alter table public.fin_transactions
  add column if not exists created_by uuid default auth.uid();

-- The period lock is the company's, whoever is signed in. Rebuilt from the live
-- definition; only the lookup changed.
create or replace function public.fin_period_locked()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare lock_date date; new_date date; old_date date;
begin
  select s.locked_until into lock_date from public.fin_settings s where s.user_id = public.fin_company_owner();
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
end $function$;

commit;
