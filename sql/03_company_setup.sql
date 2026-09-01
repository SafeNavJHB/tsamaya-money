-- Tsamaya Money — switch from the personal starter chart to TSAMAYA (PTY) LTD.
-- Applied 2026-09-01.
--
-- Source data: the two reconstruction sheets (from_statement.csv = confirmed
-- Standard Bank lines; RECONSTRUCTION_WORKSHEET.csv = open items). ONLY the
-- confirmed lines are posted here — nothing with an estimated or unknown
-- amount is invented into the ledger.
--
-- How the Beancount accounts in those sheets map onto this app:
--   Liabilities:DirectorLoan:Kyle  -> an ACCOUNT ("Director loan — Kyle").
--       Kyle paid these costs personally, so they are spent FROM that account
--       and its balance goes negative: the negative balance IS what the
--       company owes him, and its ledger is the director-loan statement.
--   Assets:Prepaid:CIPC            -> an ACCOUNT ("CIPC deposit"). Loading the
--       R500 is a TRANSFER into it; each filing fee is an expense paid from
--       it, so the deposit visibly draws down.
--   Expenses:*                     -> categories below.
--   Equity:ShareCapital            -> deliberately NOT posted: the worksheet
--       says to read the actual subscription off the MOI/CoR15.1 first.

do $$
declare uid uuid := (select user_id from public.fin_members order by added_at limit 1);
  a_loan uuid; a_bank uuid; a_cipc uuid;
  c_ai uuid; c_platform uuid; c_domain uuid; c_fees uuid; c_cipc uuid;
begin
  if uid is null then raise exception 'no member row to seed against'; end if;

  -- 1. Retire the personal starter chart, but ONLY while it is unused, so
  --    re-running this after real data exists can never destroy anything.
  if not exists (select 1 from public.fin_transactions where user_id = uid)
     and not exists (select 1 from public.fin_recurring where user_id = uid) then
    delete from public.fin_categories
     where user_id = uid
       and name in ('Salary','Interest','Dividends','Other income','Rent & housing',
                    'Utilities & rates','Groceries','Eating out','Fuel & transport','Vehicle',
                    'Insurance','Medical','Phone & internet','Subscriptions','Entertainment',
                    'Clothing','Gifts & donations','Education','Travel','Bank fees','Tax','Other');
    delete from public.fin_accounts
     where user_id = uid and name in ('Bank account','Credit card','Cash');
  end if;

  -- 2. Company accounts
  insert into public.fin_accounts (user_id, name, kind, opening_balance, sort)
  select uid, v.name, v.kind, 0, v.sort
    from (values
      ('Business bank account','bank',0),
      ('Director loan — Kyle','other',1),
      ('CIPC deposit','other',2)
    ) as v(name, kind, sort)
   where not exists (select 1 from public.fin_accounts a where a.user_id = uid and a.name = v.name);

  select id into a_bank from public.fin_accounts where user_id = uid and name = 'Business bank account';
  select id into a_loan from public.fin_accounts where user_id = uid and name = 'Director loan — Kyle';
  select id into a_cipc from public.fin_accounts where user_id = uid and name = 'CIPC deposit';

  -- 3. Company categories
  insert into public.fin_categories (user_id, name, kind, sort)
  select uid, v.name, v.kind, v.sort
    from (values
      ('App revenue','income',0),
      ('Grant & funding income','income',1),
      ('Interest received','income',2),
      ('Other income','income',3),
      ('AI & developer tools','expense',10),
      ('App stores & platforms','expense',11),
      ('Cloud & infrastructure','expense',12),
      ('Domains & hosting','expense',13),
      ('Software & subscriptions','expense',14),
      ('CIPC & compliance','expense',15),
      ('Trademark & IP','expense',16),
      ('Professional fees','expense',17),
      ('Bank & forex fees','expense',18),
      ('Marketing & advertising','expense',19),
      ('Equipment & hardware','expense',20),
      ('Telecoms & internet','expense',21),
      ('Travel & vehicle','expense',22),
      ('Tax (SARS)','expense',23),
      ('Other expenses','expense',24)
    ) as v(name, kind, sort)
   where not exists (select 1 from public.fin_categories c where c.user_id = uid and c.name = v.name);

  select id into c_ai       from public.fin_categories where user_id = uid and name = 'AI & developer tools';
  select id into c_platform from public.fin_categories where user_id = uid and name = 'App stores & platforms';
  select id into c_domain   from public.fin_categories where user_id = uid and name = 'Domains & hosting';
  select id into c_fees     from public.fin_categories where user_id = uid and name = 'Bank & forex fees';
  select id into c_cipc     from public.fin_categories where user_id = uid and name = 'CIPC & compliance';

  -- 4. Confirmed history (from_statement.csv). Guarded so re-running is a no-op.
  if not exists (select 1 from public.fin_transactions where user_id = uid) then
    insert into public.fin_transactions
      (user_id, tx_date, kind, amount, category_id, account_id, payee, notes, import_ref)
    values
      (uid,'2026-03-01','expense', 377.47, c_ai,       a_loan,'Anthropic','Claude subscription','CLAUDE.AI SUBSCRIPTION ANTHROPIC.COM US'),
      (uid,'2026-05-02','expense',1976.15, c_ai,       a_loan,'Anthropic','Claude subscription','CLAUDE.AI SUBSCRIPTION ANTHROPIC.COM US'),
      (uid,'2026-06-07','expense',1959.70, c_ai,       a_loan,'Anthropic','Claude subscription','ANTHROPIC* CLAUDE SUB ANTHROPIC.COM US'),
      (uid,'2026-06-10','expense',1699.99, c_platform, a_loan,'Apple','Apple Developer Program annual fee (USD 99) — confirm on the receipt','APPLE.COM/BILL ITUNES.COM IE'),
      (uid,'2026-06-10','expense',  33.99, c_fees,     a_loan,'Standard Bank','Cross-border fee on the Apple charge','INTERNATIONAL TRANSACTION FEE'),
      (uid,'2026-06-15','expense',  99.00, c_domain,   a_loan,'Domains.co.za','tsamayaapp.co.za registration','DOMAINS CO ZA JOHANNESBURG ZA'),
      (uid,'2026-07-08','expense',1924.82, c_ai,       a_loan,'Anthropic','Claude subscription','ANTHROPIC* CLAUDE SUB ANTHROPIC.COM US'),
      (uid,'2026-08-08','expense',1932.07, c_ai,       a_loan,'Anthropic','Claude subscription','ANTHROPIC* CLAUDE SUB ANTHROPIC.COM US'),
      (uid,'2026-08-15','expense', 415.67, c_platform, a_loan,'Google','Play Console developer registration — confirm on the receipt','GOOGLE PLAY 650-2530000 US');

    -- The R500 CIPC deposit is a transfer, not a cost: it stays an asset
    -- until filings draw it down.
    insert into public.fin_transactions
      (user_id, tx_date, kind, amount, account_id, transfer_account_id, payee, notes, import_ref)
    values
      (uid,'2026-06-17','transfer',500.00, a_loan, a_cipc,'CIPC','Deposit loaded to CIPC customer account ACHEHS','CIPC');
  end if;

  -- 5. Known recurring costs
  insert into public.fin_recurring
    (user_id, name, kind, amount, category_id, account_id, payee, notes,
     frequency, anchor_day, start_date, next_date, auto_post)
  select uid, v.name, 'expense', v.amount, v.cat, a_loan, v.payee, v.notes,
         v.freq, v.anchor, v.start_date, v.next_date, false
    from (values
      ('Claude subscription', 1932.07, c_ai,       'Anthropic',     'Amount moves with the exchange rate — edit the posted transaction to the real figure', 'monthly',  8, date '2026-06-08', date '2026-09-08'),
      ('Apple Developer Program', 1699.99, c_platform, 'Apple',     'Annual renewal (USD 99)',                                                             'annually',10, date '2026-06-10', date '2027-06-10'),
      ('Domain renewal — tsamayaapp.co.za', 99.00, c_domain, 'Domains.co.za', 'Domain expires 2027-06-15',                                                 'annually',15, date '2026-06-15', date '2027-06-15')
    ) as v(name, amount, cat, payee, notes, freq, anchor, start_date, next_date)
   where not exists (select 1 from public.fin_recurring r where r.user_id = uid and r.name = v.name);

  -- 6. Import rules, so the first real bank statement lands pre-categorised
  insert into public.fin_import_rules (user_id, match_text, category_id, payee)
  select uid, v.match_text, v.cat, v.payee
    from (values
      ('ANTHROPIC',                     c_ai,       'Anthropic'),
      ('CLAUDE.AI',                     c_ai,       'Anthropic'),
      ('CURSOR',                        c_ai,       'Cursor'),
      ('OPENAI',                        c_ai,       'OpenAI'),
      ('APPLE.COM/BILL',                c_platform, 'Apple'),
      ('GOOGLE PLAY',                   c_platform, 'Google'),
      ('DOMAINS CO ZA',                 c_domain,   'Domains.co.za'),
      ('CIPC',                          c_cipc,     'CIPC'),
      ('INTERNATIONAL TRANSACTION FEE', c_fees,     'Standard Bank'),
      ('CROSS BORDER',                  c_fees,     'Standard Bank'),
      ('SUPABASE',    (select id from public.fin_categories where user_id = uid and name = 'Cloud & infrastructure'), 'Supabase'),
      ('MAPBOX',      (select id from public.fin_categories where user_id = uid and name = 'Cloud & infrastructure'), 'Mapbox'),
      ('GOOGLE CLOUD',(select id from public.fin_categories where user_id = uid and name = 'Cloud & infrastructure'), 'Google Cloud'),
      ('EXPO',        (select id from public.fin_categories where user_id = uid and name = 'Cloud & infrastructure'), 'Expo'),
      ('SENTRY',      (select id from public.fin_categories where user_id = uid and name = 'Cloud & infrastructure'), 'Sentry')
    ) as v(match_text, cat, payee)
   where not exists (select 1 from public.fin_import_rules r where r.user_id = uid and r.match_text = v.match_text);
end $$;

notify pgrst, 'reload schema';
