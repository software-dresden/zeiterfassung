-- Zeiterfassung schema (multi-user).
-- Run once in the Supabase SQL editor on a fresh project. The live project was
-- migrated step by step (migration "multi_user_profiles_and_rls"); this file
-- describes the resulting state.
--
-- Data model: customers and session_types are shared by all users, time_entries
-- are private per user. Every data access requires an enabled row in profiles.

create table customers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  address text check (address is null or char_length(address) <= 300),  -- postal address, up to 4 lines
  ae_rate numeric(10,2) not null default 0,
  active boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table session_types (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  created_at timestamptz default now()
);

insert into session_types (label) values
  ('Remote Support'),
  ('Entwicklung'),
  ('Beratung'),
  ('Meeting'),
  ('Sonstiges');

-- One row per auth user: role and disabled flag. Rows are created/changed by the
-- admin-users edge function (service role), never by the client.
create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique,
  role text not null default 'user' check (role in ('admin', 'user')),
  disabled boolean not null default false,
  created_at timestamptz not null default now()
);

-- Customers / types referenced by entries cannot be deleted (restrict), so
-- deleting a shared customer can never wipe another user's entries.
create table time_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  customer_id uuid references customers(id) on delete restrict,
  session_type_id uuid references session_types(id) on delete restrict,
  duration_minutes integer not null,
  notes text,
  entry_date date not null default current_date,
  end_date date,  -- last day when the work spanned several days (entry_date = first)
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  -- Optional finger signatures captured after a timer session (PNG data URLs, ~2-5 KB each).
  technician_signature text,
  customer_signature text,
  signed_at timestamptz,
  constraint time_entries_technician_signature_check
    check (technician_signature is null
      or (technician_signature like 'data:image/png;base64,%' and length(technician_signature) <= 100000)),
  constraint time_entries_customer_signature_check
    check (customer_signature is null
      or (customer_signature like 'data:image/png;base64,%' and length(customer_signature) <= 100000)),
  -- Material delivered or used on site, as [{"name": "...", "menge": "..."}] (Menge is free
  -- text), and kilometers driven. Informational only: no prices, no effect on any total.
  materials jsonb not null default '[]'::jsonb,
  travel_km numeric(7,1),
  constraint time_entries_materials_check
    check (case when jsonb_typeof(materials) = 'array' then jsonb_array_length(materials) <= 20 else false end),
  constraint time_entries_travel_km_check
    check (travel_km is null or (travel_km >= 0 and travel_km <= 9999.9))
);

create index time_entries_user_id_idx on time_entries (user_id);

alter table profiles enable row level security;
alter table customers enable row level security;
alter table session_types enable row level security;
alter table time_entries enable row level security;

create or replace function is_active_user()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = (select auth.uid()) and not disabled
  );
$$;

create or replace function is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = (select auth.uid()) and role = 'admin' and not disabled
  );
$$;

revoke execute on function is_active_user() from public, anon;
revoke execute on function is_admin() from public, anon;
grant execute on function is_active_user() to authenticated;
grant execute on function is_admin() to authenticated;

create policy "own profile" on profiles
  for select to authenticated
  using (id = (select auth.uid()));

create policy "own entries select" on time_entries
  for select to authenticated
  using (user_id = (select auth.uid()) and is_active_user());
create policy "own entries insert" on time_entries
  for insert to authenticated
  with check (user_id = (select auth.uid()) and is_active_user());
create policy "own entries update" on time_entries
  for update to authenticated
  using (user_id = (select auth.uid()) and is_active_user())
  with check (user_id = (select auth.uid()) and is_active_user());
create policy "own entries delete" on time_entries
  for delete to authenticated
  using (user_id = (select auth.uid()) and is_active_user());

create policy "customers select" on customers
  for select to authenticated using (is_active_user());
create policy "customers insert" on customers
  for insert to authenticated with check (is_active_user());
create policy "customers update" on customers
  for update to authenticated using (is_active_user()) with check (is_active_user());
create policy "customers delete" on customers
  for delete to authenticated using (is_admin());

create policy "session_types select" on session_types
  for select to authenticated using (is_active_user());
create policy "session_types insert" on session_types
  for insert to authenticated with check (is_active_user());
create policy "session_types update" on session_types
  for update to authenticated using (is_active_user()) with check (is_active_user());
create policy "session_types delete" on session_types
  for delete to authenticated using (is_admin());

-- One admin-uploaded Word template per report type, shared by all users. content is the
-- base64 of the .docx (max about 2 MB of file). Only admins may write; all active users read.
create table report_templates (
  kind text primary key check (kind in ('monthly', 'session')),
  file_name text not null,
  content text not null check (length(content) <= 3000000),
  uploaded_by uuid references auth.users(id) on delete set null default auth.uid(),
  updated_at timestamptz not null default now()
);

alter table report_templates enable row level security;

create policy "report_templates select" on report_templates
  for select to authenticated using (is_active_user());
create policy "report_templates insert" on report_templates
  for insert to authenticated with check (is_admin());
create policy "report_templates update" on report_templates
  for update to authenticated using (is_admin()) with check (is_admin());
create policy "report_templates delete" on report_templates
  for delete to authenticated using (is_admin());

create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql
set search_path = public;

create trigger customers_updated_at before update on customers for each row execute function update_updated_at();
create trigger time_entries_updated_at before update on time_entries for each row execute function update_updated_at();
create trigger report_templates_updated_at before update on report_templates for each row execute function update_updated_at();

-- First admin: create the user in Supabase Auth (dashboard), then run
--   insert into profiles (id, role) values ('<auth user id>', 'admin');
-- Further users are created in the app's Admin tab (edge function admin-users,
-- see supabase/functions/admin-users).

-- Hardening (defense in depth on top of RLS). Supabase grants the API roles every table
-- privilege by default; the app needs far less. TRUNCATE is not covered by RLS at all.
revoke all on profiles, customers, session_types, time_entries, report_templates from anon;
revoke truncate, trigger, references on profiles, customers, session_types, time_entries, report_templates from authenticated;
revoke insert, update, delete on profiles from authenticated;  -- profiles is written by the edge function only
alter default privileges for role postgres in schema public revoke all on tables from anon;
alter default privileges for role postgres in schema public revoke all on functions from anon;
alter default privileges for role postgres in schema public revoke all on sequences from anon;
-- Supabase's event-trigger helper must not be callable through the API (only exists on hosted projects):
-- revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
-- Two-factor enforcement in the database is a separate, deliberate step: supabase/mfa_enforcement.sql.

-- Date range entries: one entry from entry_date to end_date
alter table public.time_entries add column if not exists end_date date;
alter table public.time_entries drop constraint if exists time_entries_end_date_check;
alter table public.time_entries add constraint time_entries_end_date_check check (end_date is null or end_date > entry_date);
