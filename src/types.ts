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
  /** Cash and cash equivalents. Null means derive from `kind`. */
  is_cash?: boolean | null;
  /** Cash flow classification (Section 7). Defaults to operating. */
  cf_class?: 'operating' | 'investing' | 'financing' | null;
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
  /** Cash flow classification (Section 7). Defaults to investing for assets. */
  cf_class?: 'operating' | 'investing' | 'financing' | null;
  // ---- depreciation register (Section 17) ----
  depreciate?: boolean;
  depr_method?: 'straight_line' | 'reducing_balance' | null;
  useful_life_months?: number | null;
  residual_value?: number;
  /** Annual percentage, reducing-balance method only. */
  depr_rate_pct?: number | null;
  /** Date the asset became available for use — when depreciation begins. */
  depr_start?: string | null;
  asset_class?: string | null;
}

export interface BankConnection {
  id: string;
  provider: string;
  label: string;
  provider_account_id: string;
  account_id: string | null;
  consent_id: string | null;
  consent_expires_at: string | null;
  status: 'pending' | 'active' | 'expired' | 'revoked' | 'error';
  last_synced_at: string | null;
  last_sync_error: string | null;
}

export interface BankFeedRow {
  id: string;
  connection_id: string | null;
  provider: string;
  provider_tx_id: string;
  account_id: string | null;
  booked_on: string;
  amount: number;
  direction: 'credit' | 'debit';
  description: string | null;
  reference: string | null;
  balance_after: number | null;
  status: 'pending' | 'imported' | 'ignored';
  transaction_id: string | null;
}

export interface Disposal {
  id: string;
  asset_id: string;
  disposal_date: string;
  proceeds: number;
  /** Null means the proceeds were not received in cash — a receivable. */
  proceeds_account_id: string | null;
  notes: string | null;
}

export interface JournalLine {
  id: string;
  journal_id: string;
  /** A ledger account key: 'acc:<id>' | 'cat:<id>' | 'ast:<id>' | 'eq:…' | 'sys:…'. */
  account_key: string;
  debit: number;
  credit: number;
  line_note: string | null;
}

export interface Journal {
  id: string;
  entry_date: string;
  reference: string | null;
  narration: string;
  lines: JournalLine[];
}

export interface DepreciationCharge {
  id: string;
  asset_id: string;
  /** Last day of the month the charge relates to. */
  period_end: string;
  amount: number;
  method: string;
  basis: string | null;
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
  /** Nothing may be posted, edited or deleted on or before this date. */
  locked_until?: string | null;
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
  notes: NarrativeNote[];
  depreciation: DepreciationCharge[];
  disposals: Disposal[];
  journals: Journal[];
  bankConnections: BankConnection[];
  bankFeed: BankFeedRow[];
}

export interface NarrativeNote {
  id: string;
  note_key: string;
  title: string;
  body: string;
  sort: number;
  hidden: boolean;
}
