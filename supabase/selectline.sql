-- SelectLine connection (migration "selectline_foundation"). Applied after schema.sql and
-- mfa_enforcement.sql. Everything here is inert until an admin switches the transfer on
-- (sl_settings.enabled) and the SelectLine secrets are set on the edge function "selectline".
--
-- Principles:
--  * SelectLine data (customer numbers, articles, employees, transfer state) is written ONLY by the
--    edge function (service role). Clients may read what they need, nothing more.
--  * A session that was transferred cannot be deleted, and its customer/Auftrag cannot change.

-- ---------------------------------------------------------------- columns on existing tables

-- Customers imported from SelectLine carry their SelectLine number. Customers without one are
-- the old app customers ("Alt").
alter table public.customers add column if not exists sl_number text
  check (sl_number is null or char_length(sl_number) between 1 and 40);
alter table public.customers add column if not exists sl_synced_at timestamptz;
alter table public.customers drop constraint if exists customers_sl_number_key;
alter table public.customers add constraint customers_sl_number_key unique (sl_number);

-- Link app user -> SelectLine Mitarbeiter (profiles are written only by edge functions).
alter table public.profiles add column if not exists sl_employee_number text
  check (sl_employee_number is null or char_length(sl_employee_number) between 1 and 6);

-- Chosen by the technician: Auftrag (null = automatic) and the article for the working time.
alter table public.time_entries add column if not exists sl_order_key text
  check (sl_order_key is null or char_length(sl_order_key) between 1 and 20);
alter table public.time_entries add column if not exists sl_article_number text
  check (sl_article_number is null or char_length(sl_article_number) between 1 and 40);

-- ---------------------------------------------------------------- new tables

create table if not exists public.sl_settings (
  id boolean primary key default true check (id),
  enabled boolean not null default false,          -- kill switch, off until go-live
  km_article_number text check (km_article_number is null or char_length(km_article_number) <= 40),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);
insert into public.sl_settings (id) values (true) on conflict do nothing;

create table if not exists public.sl_articles (
  number text primary key check (char_length(number) between 1 and 40),
  name text not null default '',
  unit text,
  is_effort boolean not null default false,
  is_warehouse boolean not null default false,
  synced_at timestamptz not null default now()
);

create table if not exists public.sl_employees (
  number text primary key check (char_length(number) between 1 and 6),
  name text not null default '',
  synced_at timestamptz not null default now()
);

-- One row per session that is (to be) transferred. parts = {"time": {"id": "<PositionIdentifier>",
-- "payload": "<json sent>"}, "km": …, "material:0": …}.
create table if not exists public.sl_transfers (
  entry_id uuid primary key references public.time_entries(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'sent', 'error')),
  order_key text,
  order_number text,
  parts jsonb not null default '{}'::jsonb check (jsonb_typeof(parts) = 'object'),
  attempts integer not null default 0,
  last_error text check (last_error is null or char_length(last_error) <= 500),
  locked_until timestamptz,
  last_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists sl_transfers_user_idx on public.sl_transfers (user_id);
create index if not exists sl_transfers_status_idx on public.sl_transfers (status);

-- Who sent what when. Admins read it through the edge function; kept 12 months.
create table if not exists public.sl_audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor uuid,
  action text not null check (char_length(action) <= 40),
  ok boolean not null,
  entry_id uuid,
  order_key text,
  detail text check (detail is null or char_length(detail) <= 500)
);
create index if not exists sl_audit_log_at_idx on public.sl_audit_log (at);
create index if not exists sl_audit_log_actor_at_idx on public.sl_audit_log (actor, at);

-- ---------------------------------------------------------------- rights

alter table public.sl_settings enable row level security;
alter table public.sl_articles enable row level security;
alter table public.sl_employees enable row level security;
alter table public.sl_transfers enable row level security;
alter table public.sl_audit_log enable row level security;

revoke all on public.sl_settings, public.sl_articles, public.sl_employees, public.sl_transfers, public.sl_audit_log
  from anon, public, authenticated;
-- Read only, and only what the app needs. sl_employees and sl_audit_log: no client access at all.
grant select on public.sl_settings, public.sl_articles, public.sl_transfers to authenticated;

drop policy if exists "sl_settings select" on public.sl_settings;
create policy "sl_settings select" on public.sl_settings
  for select to authenticated using (is_active_user());
drop policy if exists "sl_articles select" on public.sl_articles;
create policy "sl_articles select" on public.sl_articles
  for select to authenticated using (is_active_user());
drop policy if exists "own sl_transfers select" on public.sl_transfers;
create policy "own sl_transfers select" on public.sl_transfers
  for select to authenticated using (user_id = (select auth.uid()) and is_active_user());

-- MFA enforcement as on every other table.
drop policy if exists "require aal2" on public.sl_settings;
create policy "require aal2" on public.sl_settings as restrictive for all to authenticated
  using ((select auth.jwt() ->> 'aal') = 'aal2') with check ((select auth.jwt() ->> 'aal') = 'aal2');
drop policy if exists "require aal2" on public.sl_articles;
create policy "require aal2" on public.sl_articles as restrictive for all to authenticated
  using ((select auth.jwt() ->> 'aal') = 'aal2') with check ((select auth.jwt() ->> 'aal') = 'aal2');
drop policy if exists "require aal2" on public.sl_transfers;
create policy "require aal2" on public.sl_transfers as restrictive for all to authenticated
  using ((select auth.jwt() ->> 'aal') = 'aal2') with check ((select auth.jwt() ->> 'aal') = 'aal2');

-- ---------------------------------------------------------------- guards for client writes

-- Roles that may change SelectLine data: the edge functions (service_role) and maintenance.
create or replace function public.sl_is_privileged()
returns boolean language sql stable set search_path = public as $$
  select current_user in ('service_role', 'postgres', 'supabase_admin', 'supabase_auth_admin');
$$;

-- Customers from SelectLine are maintained only in SelectLine; nobody can attach or change a
-- SelectLine number from the app (that would redirect transfers to another customer).
create or replace function public.protect_sl_customers()
returns trigger language plpgsql set search_path = public as $$
begin
  if public.sl_is_privileged() then
    return coalesce(new, old);
  end if;
  if tg_op = 'INSERT' then
    if new.sl_number is not null or new.sl_synced_at is not null then
      raise exception 'SelectLine-Kunden werden nur per Import angelegt.' using errcode = '42501';
    end if;
    return new;
  end if;
  if old.sl_number is not null then
    raise exception 'Kunden aus SelectLine werden nur in SelectLine geändert.' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and (new.sl_number is not null or new.sl_synced_at is not null) then
    raise exception 'Die SelectLine-Nummer kann nicht gesetzt werden.' using errcode = '42501';
  end if;
  return coalesce(new, old);
end;
$$;
drop trigger if exists protect_sl_customers on public.customers;
create trigger protect_sl_customers before insert or update or delete on public.customers
  for each row execute function public.protect_sl_customers();

-- A transferred session (any position sent) cannot be deleted, and customer, Auftrag and owner are
-- fixed. Edits of time, notes etc. stay allowed (they are sent again). Error class 42 makes the
-- app's sync discard the change and restore the server state.
-- Runs as the caller (current_user must be the real role); the caller sees its own transfer rows.
create or replace function public.protect_sl_entries()
returns trigger language plpgsql set search_path = public as $$
declare
  sent boolean;
begin
  if public.sl_is_privileged() then
    return coalesce(new, old);
  end if;
  select (t.order_key is not null) into sent from public.sl_transfers t where t.entry_id = old.id;
  if not coalesce(sent, false) then
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Diese Session wurde an SelectLine übertragen und kann nicht gelöscht werden.'
      using errcode = '42501';
  end if;
  if new.customer_id is distinct from old.customer_id
     or new.sl_order_key is distinct from old.sl_order_key
     or new.user_id is distinct from old.user_id then
    raise exception 'Kunde und Auftrag einer übertragenen Session können nicht mehr geändert werden.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke execute on function public.protect_sl_entries() from public, anon, authenticated;
revoke execute on function public.protect_sl_customers() from public, anon, authenticated;
revoke execute on function public.sl_is_privileged() from public, anon;
grant execute on function public.sl_is_privileged() to authenticated;
drop trigger if exists protect_sl_entries on public.time_entries;
create trigger protect_sl_entries before update or delete on public.time_entries
  for each row execute function public.protect_sl_entries();
