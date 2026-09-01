export type TxKind = 'income' | 'expense' | 'transfer';
export type CategoryKind = 'income' | 'expense';
export type AccountKind = 'bank' | 'card' | 'cash' | 'savings' | 'investment' | 'other';
export type AssetSide = 'asset' | 'liability';
export type AssetCategory =
  | 'vehicle' | 'property' | 'investment' | 'retirement'
  | 'loan' | 'credit' | 'tax' | 'other';

export interface Category {
  id: string;
  name: string;
  kind: CategoryKind;
  monthly_budget: number | null;
  sort: number;
  archived: boolean;
}

export interface Account {
  id: string;
  name: string;
  kind: AccountKind;
  opening_balance: number;
  sort: number;
  archived: boolean;
  /** Statement of financial position caption (IFRS for SMEs Section 4). */
  bs_line?: string | null;
  is_current?: boolean;
}

export interface Tx {
  id: string;
  tx_date: string; // YYYY-MM-DD — kept as a plain string everywhere (no TZ drift)
  kind: TxKind;
  amount: number; // always positive; kind carries the sign
  category_id: string | null;
  account_id: string;
  transfer_account_id: string | null;
  payee: string | null;
  notes: string | null;
  created_at: string;
  /** Set when the row was posted from a recurring series. */
  recurring_id?: string | null;
  /** The raw statement description, when the row came from an import. */
  import_ref?: string | null;
  /** Set when the spend was capitalised: the debit goes to this asset, not to P&L. */
  asset_id?: string | null;
}

export type Frequency = 'weekly' | 'fortnightly' | 'monthly' | 'quarterly' | 'annually';

export interface RecurringRule {
  id: string;
  name: string;
  kind: TxKind;
  amount: number;
  category_id: string | null;
  account_id: string;
  transfer_account_id: string | null;
  payee: string | null;
  notes: string | null;
  frequency: Frequency;
  anchor_day: number;
  start_date: string;
  end_date: string | null;
  next_date: string;
  auto_post: boolean;
  archived: boolean;
}

export interface ImportRule {
  id: string;
  match_text: string;
  category_id: string | null;
  payee: string | null;
}

export interface Asset {
  id: string;
  name: string;
  side: AssetSide;
  category: AssetCategory;
  notes: string | null;
  sort: number;
  archived: boolean;
  bs_line?: string | null;
  is_current?: boolean;
}

export type EquityKind = 'share_issue' | 'dividend' | 'prior_period_adjustment';

export interface EquityMovement {
  id: string;
  mv_date: string;
  kind: EquityKind;
  /** Positive for issues and dividends; signed for a prior-period adjustment. */
  amount: number;
  contra_account_id: string | null;
  shares_issued: number | null;
  notes: string | null;
}

export interface Settings {
  entity_name: string;
  registration_number: string | null;
  /** Month the financial year ends in, 1-12. */
  fy_end_month: number;
}

export interface Valuation {
  id: string;
  asset_id: string;
  val_date: string; // YYYY-MM-DD
  value: number;
}

export interface AllData {
  categories: Category[];
  accounts: Account[];
  transactions: Tx[];
  assets: Asset[];
  valuations: Valuation[];
  recurring: RecurringRule[];
  importRules: ImportRule[];
  equity: EquityMovement[];
  settings: Settings;
}
