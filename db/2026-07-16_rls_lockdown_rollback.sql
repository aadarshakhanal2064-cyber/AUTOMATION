-- ════════════════════════════════════════════════════════════════════
--  ROLLBACK for 2026-07-16_rls_lockdown.sql
--  Restores the pre-migration state: RLS disabled everywhere, original
--  get_db_storage_usage (no membership guard), default search_paths.
--  WARNING: running this reopens the database to anyone with the
--  publishable key. Emergency use only.
-- ════════════════════════════════════════════════════════════════════

-- ── Policies ──
drop policy if exists app_users_select_member            on public.app_users;
drop policy if exists clients_select_member              on public.clients;
drop policy if exists clients_insert_admin               on public.clients;
drop policy if exists clients_update_member              on public.clients;
drop policy if exists clients_delete_admin               on public.clients;
drop policy if exists client_shareholders_select_member  on public.client_shareholders;
drop policy if exists client_shareholders_insert_admin   on public.client_shareholders;
drop policy if exists send_logs_select_own_or_admin      on public.send_logs;
drop policy if exists send_logs_insert_member            on public.send_logs;
drop policy if exists audit_log_select_member            on public.audit_log;
drop policy if exists audit_log_insert_member            on public.audit_log;
drop policy if exists vat_filings_select_member          on public.vat_filings;
drop policy if exists vat_filings_insert_member          on public.vat_filings;
drop policy if exists vat_filings_update_member          on public.vat_filings;
drop policy if exists firm_bank_details_select_member    on public.firm_bank_details;
drop policy if exists firm_bank_details_insert_admin     on public.firm_bank_details;
drop policy if exists firm_bank_details_update_admin     on public.firm_bank_details;
drop policy if exists invoices_select_member             on public.invoices;
drop policy if exists invoices_insert_member             on public.invoices;
drop policy if exists invoices_update_member             on public.invoices;
drop policy if exists invoices_delete_member             on public.invoices;
drop policy if exists invoice_items_select_member        on public.invoice_items;
drop policy if exists invoice_items_insert_member        on public.invoice_items;
drop policy if exists invoice_items_delete_member        on public.invoice_items;
drop policy if exists invoice_payments_select_member     on public.invoice_payments;
drop policy if exists invoice_payments_insert_member     on public.invoice_payments;

-- ── RLS off ──
alter table public.app_users           disable row level security;
alter table public.clients             disable row level security;
alter table public.client_shareholders disable row level security;
alter table public.send_logs           disable row level security;
alter table public.audit_log           disable row level security;
alter table public.vat_filings         disable row level security;
alter table public.firm_bank_details   disable row level security;
alter table public.invoices            disable row level security;
alter table public.invoice_items       disable row level security;
alter table public.invoice_payments    disable row level security;

-- ── Restore original get_db_storage_usage (captured pre-migration) ──
create or replace function public.get_db_storage_usage()
returns table(bytes_used bigint)
language sql stable security definer
as $$
  select pg_database_size(current_database());
$$;
grant execute on function public.get_db_storage_usage() to anon, authenticated;

-- ── Reset search_paths ──
alter function public.set_updated_at()              reset search_path;
alter function public.set_invoice_number()          reset search_path;
alter function public.sync_invoice_payment_totals() reset search_path;
alter function public.get_vat_fy_stats(text)        reset search_path;
alter function public.get_billing_stats()           reset search_path;
alter function public.get_monthly_income(integer)   reset search_path;
grant execute on function public.get_vat_fy_stats(text)      to anon, authenticated;
grant execute on function public.get_billing_stats()         to anon, authenticated;
grant execute on function public.get_monthly_income(integer) to anon, authenticated;

-- ── Helper functions/schema ──
drop function if exists private.is_admin();
drop function if exists private.is_app_user();
drop function if exists private.jwt_email();
drop schema if exists private;
