export interface Customer {
  id: string;
  name: string;
  /** Postal address, up to 4 lines (street, postcode and city); printed on Word reports. */
  address?: string | null;
  ae_rate: number;
  active: boolean;
  created_at: string;
  updated_at: string;
  /** SelectLine customer number; set only by the import (edge function "selectline"). Null: old app customer. */
  sl_number?: string | null;
  sl_synced_at?: string | null;
}

export interface SessionType {
  id: string;
  label: string;
  created_at: string;
}

// One line of material delivered or used on site. Menge is free text ("2 Stück",
// "5 m"): there are no prices or sums, so there is nothing to compute with it.
export interface MaterialItem {
  name: string;
  menge: string;
  /** SelectLine article number, when the material was picked from the SelectLine articles. */
  artikel?: string | null;
}

export interface TimeEntry {
  id: string;
  customer_id: string;
  session_type_id: string;
  duration_minutes: number;
  notes: string | null;
  entry_date: string;
  /** Last day when the work spanned several days (entry_date is the first); null/absent for one day. */
  end_date?: string | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
  /** Owner of the entry; filled in by the server (default auth.uid()). */
  user_id?: string;
  /** Optional finger signatures as PNG data URLs, captured right after a timer session. */
  technician_signature?: string | null;
  customer_signature?: string | null;
  signed_at?: string | null;
  /** Material delivered or used on site; entered on the finish card of a timer session. */
  materials?: MaterialItem[];
  /** Kilometers driven to the customer; informational only (no price). */
  travel_km?: number | null;
  /** SelectLine Auftrag chosen by the technician (null: automatic). Fixed once transferred. */
  sl_order_key?: string | null;
  /** SelectLine article for the working time. Entries without it are not transferred. */
  sl_article_number?: string | null;
}

export interface SyncQueueItem {
  id: string;
  table: 'customers' | 'session_types' | 'time_entries';
  operation: 'insert' | 'update' | 'delete';
  payload: Record<string, unknown>;
  timestamp: number;
}

export interface TimerState {
  /** One uuid per timer; the legacy single timer used the fixed key 'active'. */
  key: string;
  customer_id: string;
  session_type_id: string;
  /** Start of the current running stretch (reset on resume). */
  started_at: string;
  /** Set once when the timer is created; used for stable ordering. */
  created_at?: string;
  status: 'running' | 'paused' | 'stopped';
  accumulated_seconds: number;
  /** Rounded minutes frozen by "Stoppen", waiting to be saved or discarded. */
  frozen_minutes?: number;
}

// monthly: "Alle Arbeit" and per-customer month reports; session: single-session report.
export type ReportTemplateKind = 'monthly' | 'session';

export interface StoredTemplate {
  kind: ReportTemplateKind;
  file_name: string;
  /** The .docx, base64 encoded. */
  content: string;
  updated_at: string;
}

export type TemplateMeta = Pick<StoredTemplate, 'kind' | 'file_name' | 'updated_at'>;

export type UserRole = 'admin' | 'user';

export interface Profile {
  id: string;
  username: string | null;
  role: UserRole;
  disabled: boolean;
}

export interface AdminUser {
  id: string;
  email: string | null;
  username: string | null;
  role: UserRole | null;
  disabled: boolean;
  has_profile: boolean;
  /** At least one verified authenticator (TOTP) is set up. */
  mfa_enabled: boolean;
  providers: string[];
  created_at: string;
  last_sign_in_at: string | null;
  entry_count: number;
  /** Total recorded minutes of this user. */
  total_minutes: number;
  /** Sessions with an entry date in the current month. */
  month_entries: number;
  /** Most recent report of any of the user's open apps (null: none in the last 7 days). */
  last_seen_at: string | null;
  /** Timers reported by the user's devices (running or paused), with the report time. */
  timers: AdminUserTimer[];
}

export interface AdminUserTimer {
  customer_id: string;
  session_type_id: string;
  status: 'running' | 'paused';
  elapsed_seconds: number;
  reported_at: string;
}

export type SyncStatus = 'synced' | 'syncing' | 'offline' | 'error';

export interface MonthlyReportRow {
  customer: Customer;
  entries: TimeEntry[];
  total_minutes: number;
  total_ae: number;
  total_value: number;
}
