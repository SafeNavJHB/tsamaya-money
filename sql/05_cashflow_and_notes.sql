-- Tsamaya Money — statement of cash flows (Section 7) and notes (Section 8).
-- Applied 2026-09-01.
--
-- Two additions:
--   1. classification — a cash flow statement cannot be inferred: the app must
--      be told which accounts ARE cash, and how every other balance-sheet
--      account maps to operating / investing / financing. Guessing from
--      `kind` would silently misclassify the director loan (financing) and the
--      CIPC deposit (an operating prepayment), both of which are kind='other'.
--   2. fin_notes — narrative notes. The FIGURES in the notes are computed from
--      the ledger; the words are the preparer's, so they are stored and
--      editable rather than generated. Seeded text is a starting draft.

alter table public.fin_accounts
  -- NULL means "derive from kind" (bank/cash/savings are cash) so existing and
  -- newly created rows behave sensibly without a migration each time.
  add column if not exists is_cash boolean,
  add column if not exists cf_class text
    check (cf_class is null or cf_class in ('operating','investing','financing'));

alter table public.fin_assets
  add column if not exists cf_class text
    check (cf_class is null or cf_class in ('operating','investing','financing'));

-- ---------------------------------------------------------------- notes
create table if not exists public.fin_notes (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid(),
  note_key   text not null,
  title      text not null,
  body       text not null default '',
  sort       integer not null default 0,
  hidden     boolean not null default false,
  created_at timestamptz not null default now(),
  unique (user_id, note_key)
);

do $$
begin
  execute 'alter table public.fin_notes enable row level security';
  execute 'revoke all on table public.fin_notes from public, anon, authenticated';
  execute 'grant select, insert, update, delete on table public.fin_notes to authenticated';
  execute 'drop policy if exists fin_notes_member_own on public.fin_notes';
  execute 'create policy fin_notes_member_own on public.fin_notes for all to authenticated
             using (user_id = auth.uid() and public.fin_is_member())
             with check (user_id = auth.uid() and public.fin_is_member())';
end $$;

-- ---------------------------------------------------------------- seed
do $$
declare uid uuid := (select user_id from public.fin_members order by added_at limit 1);
begin
  if uid is null then raise exception 'no member row to seed against'; end if;

  update public.fin_accounts set is_cash = true, cf_class = 'operating'
   where user_id = uid and name = 'Business bank account' and is_cash is null;
  -- The director loan funds the company: its movement is a financing cash flow.
  update public.fin_accounts set is_cash = false, cf_class = 'financing'
   where user_id = uid and name = 'Director loan — Kyle' and is_cash is null;
  -- A prepaid filing deposit is working capital.
  update public.fin_accounts set is_cash = false, cf_class = 'operating'
   where user_id = uid and name = 'CIPC deposit' and is_cash is null;

  insert into public.fin_notes (user_id, note_key, title, body, sort)
  select uid, v.note_key, v.title, v.body, v.sort
    from (values
      ('general', 'General information',
       'The company is a private company incorporated and domiciled in the Republic of South Africa. Its principal activity is the development and operation of the Tsamaya navigation application.'
       || E'\n\nReview this note and add the registration number and incorporation date before issuing the statements.', 10),
      ('basis', 'Basis of preparation',
       'The annual financial statements have been prepared in accordance with the International Financial Reporting Standard for Small and Medium-sized Entities (IFRS for SMEs) and the Companies Act of South Africa.'
       || E'\n\nThey are prepared on the historical cost basis, under the accrual basis of accounting, and are presented in South African rand, which is the company''s functional currency. All amounts are stated in rand unless otherwise indicated.', 20),
      ('policies', 'Significant accounting policies',
       'Property, plant and equipment is measured at cost less any accumulated depreciation and impairment losses (Section 17 cost model).'
       || E'\n\nFinancial instruments comprise basic financial instruments measured at amortised cost, being cash and cash equivalents, prepayments and the loan from the director.'
       || E'\n\nExpenses are recognised as incurred. Revenue is recognised when the company has transferred the significant risks and rewards of ownership to the customer and the amount can be measured reliably.'
       || E'\n\n[Review and expand for depreciation rates, revenue recognition and taxation once the company has revenue.]', 30),
      ('going_concern', 'Going concern',
       '[REQUIRES THE PREPARER''S JUDGEMENT — do not issue the statements with this placeholder in place.]'
       || E'\n\nThe company is in a net liability position and is funded by the loan from the director. Management must assess whether the company is a going concern for at least twelve months from the date of approval of these statements, and disclose the basis for that conclusion together with any material uncertainty, including confirmation of the director''s intention and ability to continue funding the company and not to demand repayment of the loan.', 40),
      ('related_parties', 'Related party transactions',
       'The director is a related party of the company. Amounts owing to the director are disclosed in the note on the loan from the director.'
       || E'\n\nThe loan is unsecured, interest free and has no fixed terms of repayment. [Confirm these terms, and disclose any key management personnel remuneration.]', 50),
      ('tax', 'Taxation',
       'No provision for income tax has been made as the company has not generated taxable income. The company has an assessed loss carried forward, the recognition of which as a deferred tax asset requires an assessment of probable future taxable profits. [Confirm the assessed loss balance against the SARS assessment.]', 60),
      ('subsequent', 'Events after the end of the reporting period',
       'No matters or circumstances arising since the end of the reporting period require disclosure or adjustment to these financial statements. [Confirm at the date of approval.]', 70)
    ) as v(note_key, title, body, sort)
   where not exists (select 1 from public.fin_notes n where n.user_id = uid and n.note_key = v.note_key);
end $$;

notify pgrst, 'reload schema';
