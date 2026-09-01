-- Tsamaya Money — fixed asset / depreciation register (IFRS for SMEs Section 17).
-- Applied 2026-09-01.
--
-- Depreciation is POSTED, not derived on the fly. That matters: a change in
-- useful life or residual value is a change in accounting estimate and is
-- applied PROSPECTIVELY (Section 10.15-10.18). If the charge were recomputed
-- from the current settings every time, changing an estimate would silently
-- restate prior years, which is wrong.
--
-- One charge per asset per period, enforced by a unique index, so running the
-- depreciation catch-up twice cannot double-charge.

alter table public.fin_assets
  add column if not exists depreciate         boolean not null default false,
  add column if not exists depr_method        text
    check (depr_method is null or depr_method in ('straight_line','reducing_balance')),
  add column if not exists useful_life_months integer
    check (useful_life_months is null or useful_life_months > 0),
  add column if not exists residual_value     numeric(14,2) not null default 0
    check (residual_value >= 0),
  -- Annual percentage, used by the reducing-balance method only.
  add column if not exists depr_rate_pct      numeric(6,3)
    check (depr_rate_pct is null or (depr_rate_pct > 0 and depr_rate_pct <= 100)),
  -- The date the asset became available for use (Section 17.20), which is when
  -- depreciation begins — not necessarily the purchase date.
  add column if not exists depr_start         date,
  -- Groups assets into classes for the Section 17.31 reconciliation.
  add column if not exists asset_class        text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'fin_assets_depr_settings') then
    alter table public.fin_assets add constraint fin_assets_depr_settings check (
      not depreciate
      or (
        side = 'asset'
        and depr_start is not null
        and depr_method is not null
        and (
          (depr_method = 'straight_line'    and useful_life_months is not null)
          or (depr_method = 'reducing_balance' and depr_rate_pct is not null)
        )
      )
    );
  end if;
end $$;

create table if not exists public.fin_depreciation (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid(),
  asset_id   uuid not null references public.fin_assets (id) on delete cascade,
  -- Last day of the month the charge relates to.
  period_end date not null,
  amount     numeric(14,2) not null check (amount > 0),
  method     text not null,
  basis      text,
  created_at timestamptz not null default now(),
  unique (asset_id, period_end)
);

create index if not exists fin_depreciation_user_period
  on public.fin_depreciation (user_id, period_end);

do $$
begin
  execute 'alter table public.fin_depreciation enable row level security';
  execute 'revoke all on table public.fin_depreciation from public, anon, authenticated';
  execute 'grant select, insert, update, delete on table public.fin_depreciation to authenticated';
  execute 'drop policy if exists fin_depreciation_member_own on public.fin_depreciation';
  execute 'create policy fin_depreciation_member_own on public.fin_depreciation for all to authenticated
             using (user_id = auth.uid() and public.fin_is_member())
             with check (user_id = auth.uid() and public.fin_is_member())';
end $$;

notify pgrst, 'reload schema';
