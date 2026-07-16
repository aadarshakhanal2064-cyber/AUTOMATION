-- ════════════════════════════════════════════════════════════════════
--  SECURITY HARDENING — RLS lockdown (2026-07-16)
--
--  Before this migration the publishable key (public, in the repo) had
--  unrestricted read/write on every table. This enables RLS everywhere
--  with policies that mirror the UI's existing permission model:
--    · "member"  = signed-in Google account whose email is in app_users
--    · "admin"   = member whose app_users.role = 'admin'
--  Any other authenticated JWT (any Google account can complete Supabase
--  sign-in!) and the anon key get ZERO rows — membership in app_users is
--  what grants access, not authentication alone.
--
--  Deliberate behavior change (user-approved): firm_bank_details writes
--  are now admin-only (was: any staff). It holds the firm's bank account
--  + payment QR — the payment-fraud target.
--
--  Rollback: db/2026-07-16_rls_lockdown_rollback.sql
-- ════════════════════════════════════════════════════════════════════

-- ── 1. Membership helpers in a private schema (not exposed via PostgREST) ──
create schema if not exists private;

-- SECURITY DEFINER so they can read app_users regardless of its RLS;
-- search_path pinned empty, all references fully qualified.
create or replace function private.jwt_email()
returns text
language sql stable security definer set search_path = ''
as $$
  select lower(coalesce(auth.jwt() ->> 'email', ''));
$$;

create or replace function private.is_app_user()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.app_users u
    where lower(u.email) = private.jwt_email()
  );
$$;

create or replace function private.is_admin()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.app_users u
    where lower(u.email) = private.jwt_email() and u.role = 'admin'
  );
$$;

-- Policy expressions run as the querying role, so `authenticated` needs
-- USAGE + EXECUTE. anon gets nothing (it has no policies to evaluate).
revoke all on schema private from public;
grant usage on schema private to authenticated;
revoke all on function private.jwt_email()   from public;
revoke all on function private.is_app_user() from public;
revoke all on function private.is_admin()    from public;
grant execute on function private.jwt_email(), private.is_app_user(), private.is_admin() to authenticated;

-- ── 2. Enable RLS on all 10 tables ──
alter table public.app_users           enable row level security;
alter table public.clients             enable row level security;
alter table public.client_shareholders enable row level security;
alter table public.send_logs           enable row level security;
alter table public.audit_log           enable row level security;
alter table public.vat_filings         enable row level security;
alter table public.firm_bank_details   enable row level security;
alter table public.invoices            enable row level security;
alter table public.invoice_items       enable row level security;
alter table public.invoice_payments    enable row level security;

-- ── 3. Policies (idempotent: drop-if-exists then create) ──
-- app_users: members read all rows (sign-in self-check + VAT staff
-- dropdown). No client-side writes — managed via the Supabase dashboard.
drop policy if exists app_users_select_member on public.app_users;
create policy app_users_select_member on public.app_users
  for select to authenticated using (private.is_app_user());

-- clients: member read/update (VAT picker toggles vat_status from
-- non-admin staff); add/import/delete are admin-gated in the UI.
drop policy if exists clients_select_member on public.clients;
create policy clients_select_member on public.clients
  for select to authenticated using (private.is_app_user());
drop policy if exists clients_insert_admin on public.clients;
create policy clients_insert_admin on public.clients
  for insert to authenticated with check (private.is_admin());
drop policy if exists clients_update_member on public.clients;
create policy clients_update_member on public.clients
  for update to authenticated using (private.is_app_user()) with check (private.is_app_user());
drop policy if exists clients_delete_admin on public.clients;
create policy clients_delete_admin on public.clients
  for delete to authenticated using (private.is_admin());

-- client_shareholders: read for members; writes only happen through the
-- admin-gated import. (Cascade delete from clients bypasses RLS — fine.)
drop policy if exists client_shareholders_select_member on public.client_shareholders;
create policy client_shareholders_select_member on public.client_shareholders
  for select to authenticated using (private.is_app_user());
drop policy if exists client_shareholders_insert_admin on public.client_shareholders;
create policy client_shareholders_insert_admin on public.client_shareholders
  for insert to authenticated with check (private.is_admin());

-- send_logs: immutable audit trail. Staff read own rows, admins read all;
-- inserts must carry the writer's own email (no spoofing another sender).
drop policy if exists send_logs_select_own_or_admin on public.send_logs;
create policy send_logs_select_own_or_admin on public.send_logs
  for select to authenticated
  using (private.is_admin() or lower(sent_by) = private.jwt_email());
drop policy if exists send_logs_insert_member on public.send_logs;
create policy send_logs_insert_member on public.send_logs
  for insert to authenticated
  with check (private.is_app_user() and lower(sent_by) = private.jwt_email());

-- audit_log: insert + read for members (feeds the shared Dashboard).
-- No update/delete policies — the log is immutable from the client.
drop policy if exists audit_log_select_member on public.audit_log;
create policy audit_log_select_member on public.audit_log
  for select to authenticated using (private.is_app_user());
drop policy if exists audit_log_insert_member on public.audit_log;
create policy audit_log_insert_member on public.audit_log
  for insert to authenticated with check (private.is_app_user());

-- vat_filings: full member workflow (upsert needs INSERT + UPDATE).
-- No delete — the UI never deletes filings.
drop policy if exists vat_filings_select_member on public.vat_filings;
create policy vat_filings_select_member on public.vat_filings
  for select to authenticated using (private.is_app_user());
drop policy if exists vat_filings_insert_member on public.vat_filings;
create policy vat_filings_insert_member on public.vat_filings
  for insert to authenticated with check (private.is_app_user());
drop policy if exists vat_filings_update_member on public.vat_filings;
create policy vat_filings_update_member on public.vat_filings
  for update to authenticated using (private.is_app_user()) with check (private.is_app_user());

-- firm_bank_details: member read; ADMIN-ONLY writes (deliberate
-- tightening — bank account + payment QR are the fraud target).
drop policy if exists firm_bank_details_select_member on public.firm_bank_details;
create policy firm_bank_details_select_member on public.firm_bank_details
  for select to authenticated using (private.is_app_user());
drop policy if exists firm_bank_details_insert_admin on public.firm_bank_details;
create policy firm_bank_details_insert_admin on public.firm_bank_details
  for insert to authenticated with check (private.is_admin());
drop policy if exists firm_bank_details_update_admin on public.firm_bank_details;
create policy firm_bank_details_update_admin on public.firm_bank_details
  for update to authenticated using (private.is_admin()) with check (private.is_admin());

-- invoices: full member CRUD (billing is staff-accessible incl. draft
-- delete). The payment-totals / invoice-number triggers run as the
-- invoking member, so the member UPDATE policy covers their writes.
drop policy if exists invoices_select_member on public.invoices;
create policy invoices_select_member on public.invoices
  for select to authenticated using (private.is_app_user());
drop policy if exists invoices_insert_member on public.invoices;
create policy invoices_insert_member on public.invoices
  for insert to authenticated with check (private.is_app_user());
drop policy if exists invoices_update_member on public.invoices;
create policy invoices_update_member on public.invoices
  for update to authenticated using (private.is_app_user()) with check (private.is_app_user());
drop policy if exists invoices_delete_member on public.invoices;
create policy invoices_delete_member on public.invoices
  for delete to authenticated using (private.is_app_user());

-- invoice_items: member read/insert/delete (edit wipes + reinserts).
drop policy if exists invoice_items_select_member on public.invoice_items;
create policy invoice_items_select_member on public.invoice_items
  for select to authenticated using (private.is_app_user());
drop policy if exists invoice_items_insert_member on public.invoice_items;
create policy invoice_items_insert_member on public.invoice_items
  for insert to authenticated with check (private.is_app_user());
drop policy if exists invoice_items_delete_member on public.invoice_items;
create policy invoice_items_delete_member on public.invoice_items
  for delete to authenticated using (private.is_app_user());

-- invoice_payments: member read/insert; totals are trigger-owned, and
-- payments are never edited or deleted from the client.
drop policy if exists invoice_payments_select_member on public.invoice_payments;
create policy invoice_payments_select_member on public.invoice_payments
  for select to authenticated using (private.is_app_user());
drop policy if exists invoice_payments_insert_member on public.invoice_payments;
create policy invoice_payments_insert_member on public.invoice_payments
  for insert to authenticated with check (private.is_app_user());

-- ── 4. Function hardening (Supabase advisor findings) ──
-- Every body already schema-qualifies its references, so pinning an
-- empty search_path changes nothing functionally.
alter function public.set_updated_at()              set search_path = '';
alter function public.set_invoice_number()          set search_path = '';
alter function public.sync_invoice_payment_totals() set search_path = '';
alter function public.get_vat_fy_stats(text)        set search_path = '';
alter function public.get_billing_stats()           set search_path = '';
alter function public.get_monthly_income(integer)   set search_path = '';

-- get_db_storage_usage is SECURITY DEFINER (needs pg_database_size) and
-- was callable by anon. Add a membership guard (returns 0 rows for
-- non-members — auth.js already handles the empty result) + pin path.
create or replace function public.get_db_storage_usage()
returns table(bytes_used bigint)
language sql stable security definer set search_path = ''
as $$
  select pg_database_size(current_database()) where private.is_app_user();
$$;

-- RPCs: strip anon/default execute; only signed-in users may call them
-- (RLS inside them then filters by membership).
revoke execute on function public.get_db_storage_usage()      from public, anon;
revoke execute on function public.get_vat_fy_stats(text)      from public, anon;
revoke execute on function public.get_billing_stats()         from public, anon;
revoke execute on function public.get_monthly_income(integer) from public, anon;
grant execute on function
  public.get_db_storage_usage(),
  public.get_vat_fy_stats(text),
  public.get_billing_stats(),
  public.get_monthly_income(integer)
to authenticated;
