import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { supabase } from '../lib/supabase';
import type {
  Account,
  AllData,
  Asset,
  Category,
  DepreciationCharge,
  Disposal,
  Journal,
  JournalLine,
  EquityMovement,
  ImportRule,
  RecurringRule,
  NarrativeNote,
  Settings,
  Tx,
  Valuation,
} from '../types';

const DEFAULT_SETTINGS: Settings = {
  entity_name: 'TSAMAYA (PTY) LTD',
  registration_number: null,
  fy_end_month: 2,
};

interface DataState extends AllData {
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  categoryById: Map<string, Category>;
  accountById: Map<string, Account>;
}

const empty: AllData = {
  categories: [],
  accounts: [],
  transactions: [],
  assets: [],
  valuations: [],
  recurring: [],
  importRules: [],
  equity: [],
  settings: DEFAULT_SETTINGS,
  notes: [],
  depreciation: [],
  disposals: [],
  journals: [],
};

const DataContext = createContext<DataState | null>(null);

const num = (v: unknown): number => (v == null ? 0 : Number(v));

export function DataProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<AllData>(empty);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    const [cats, accs, txns, assets, vals, recur, rules, equity, setts, notes, depr, disp, jrnl] = await Promise.all([
      supabase.from('fin_categories').select('*').order('sort').order('name'),
      supabase.from('fin_accounts').select('*').order('sort').order('name'),
      supabase.from('fin_transactions').select('*').order('tx_date', { ascending: false }).order('created_at', { ascending: false }),
      supabase.from('fin_assets').select('*').order('sort').order('name'),
      supabase.from('fin_valuations').select('*').order('val_date'),
      supabase.from('fin_recurring').select('*').order('next_date'),
      supabase.from('fin_import_rules').select('*').order('match_text'),
      supabase.from('fin_equity').select('*').order('mv_date'),
      supabase.from('fin_settings').select('*').maybeSingle(),
      supabase.from('fin_notes').select('*').order('sort'),
      supabase.from('fin_depreciation').select('*').order('period_end'),
      supabase.from('fin_disposals').select('*').order('disposal_date'),
      supabase.from('fin_journals').select('*, lines:fin_journal_lines(*)').order('entry_date'),
    ]);
    const firstError = [cats, accs, txns, assets, vals, recur, rules, equity, setts, notes, depr, disp, jrnl].find((r) => r.error)?.error;
    if (firstError) {
      setError(firstError.message);
      setLoading(false);
      return;
    }
    setData({
      categories: (cats.data as Category[]).map((c) => ({
        ...c,
        monthly_budget: c.monthly_budget == null ? null : num(c.monthly_budget),
      })),
      accounts: (accs.data as Account[]).map((a) => ({ ...a, opening_balance: num(a.opening_balance) })),
      transactions: (txns.data as Tx[]).map((t) => ({ ...t, amount: num(t.amount) })),
      assets: (assets.data as Asset[]).map((a) => ({ ...a, residual_value: num(a.residual_value), depr_rate_pct: a.depr_rate_pct == null ? null : num(a.depr_rate_pct) })),
      valuations: (vals.data as Valuation[]).map((v) => ({ ...v, value: num(v.value) })),
      recurring: (recur.data as RecurringRule[]).map((r) => ({ ...r, amount: num(r.amount) })),
      importRules: rules.data as ImportRule[],
      equity: (equity.data as EquityMovement[]).map((e) => ({ ...e, amount: num(e.amount) })),
      settings: (setts.data as Settings | null) ?? DEFAULT_SETTINGS,
      notes: notes.data as NarrativeNote[],
      depreciation: (depr.data as DepreciationCharge[]).map((d) => ({ ...d, amount: num(d.amount) })),
      disposals: (disp.data as Disposal[]).map((d) => ({ ...d, proceeds: num(d.proceeds) })),
      journals: (jrnl.data as Journal[]).map((j) => ({
        ...j,
        lines: (j.lines ?? []).map((l: JournalLine) => ({ ...l, debit: num(l.debit), credit: num(l.credit) })),
      })),
    });
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo<DataState>(
    () => ({
      ...data,
      loading,
      error,
      refresh,
      categoryById: new Map(data.categories.map((c) => [c.id, c])),
      accountById: new Map(data.accounts.map((a) => [a.id, a])),
    }),
    [data, loading, error, refresh],
  );

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

export function useData(): DataState {
  const ctx = useContext(DataContext);
  if (!ctx) throw new Error('useData outside DataProvider');
  return ctx;
}
