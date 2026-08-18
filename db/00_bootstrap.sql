-- ════════════════════════════════════════════════════════════════════════════
--  00_bootstrap.sql — build the entire database from nothing
--  Generated 2026-08-18 by reading the live schema of project
--  rennqzmwyhkdsizvlqwd, which is the authority. Regenerate rather than
--  hand-patch if the two ever disagree.
-- ════════════════════════════════════════════════════════════════════════════
--
--  WHY THIS FILE EXISTS
--
--  The 25 dated migrations beside it are an INCREMENTAL history that starts
--  on 2026-07-16. Nine tables predate it — app_users, clients,
--  client_shareholders, invoices, invoice_items, invoice_payments,
--  firm_bank_details, audit_log, send_logs — because they were built by hand
--  in the Supabase dashboard before the migration workflow existed, and three
--  functions are in the same state: set_updated_at, set_invoice_number and
--  sync_invoice_payment_totals are only ever ALTERed by 2026-07-16_rls_lockdown,
--  never created. Running db/*.sql in date order against an empty project
--  therefore fails on the very first migration (14 triggers reference
--  set_updated_at), and even if it didn't, a third of the schema would be
--  missing. Until this file existed the database could not be rebuilt from
--  the repo at all.
--
--  USE IT FOR
--    · standing the app up on a NEW Supabase project (a second firm, a test
--      instance, a handover to another organisation)
--    · disaster recovery — this plus a data backup is a full restore
--
--  DO NOT run it against the live project. Every statement is CREATE, and it
--  will error on the first object that already exists. That is deliberate:
--  no IF NOT EXISTS, so a misfire stops instead of half-applying.
--
--  WHAT IT CONTAINS: 27 tables, 5 trigger functions, 3 private auth helpers,
--  3 RPCs, 56 indexes, 20 triggers, 94 RLS policies, 18 table comments.
--  Counts verified against what this file emits, and against the live schema.
--
--  WHAT IT DELIBERATELY DOES NOT CONTAIN
--    · Any data. Not one client, invoice or log row. A new instance starts
--      empty; the repo is public and client data never belongs in it.
--    · public.get_vat_fy_stats(). It still exists on the live project but
--      reads public.vat_filings, dropped 2026-08-10 with the VAT Compliance
--      module — so it is already broken there and would fail outright here
--      (a LANGUAGE sql body is validated at CREATE time). Nothing calls it.
--      See the note at the bottom of this file.
--    · auth.users. Supabase owns that table. Creating a staff login is two
--      steps and this file can only do the second one — see §11.
--
--  ORDER IS LOAD-BEARING. private.is_app_user() and the three RPCs are
--  LANGUAGE sql, so Postgres validates their bodies at CREATE time: every
--  table they read must already exist. Tables therefore come before
--  functions, not after. The plpgsql trigger functions have no such
--  constraint but are kept beside them for readability.
--
--  Apply: Supabase dashboard → SQL Editor → paste → Run. Or via the MCP's
--  apply_migration. Takes a few seconds. The verification query at the
--  bottom (§12) prints the object counts to check against.
-- ════════════════════════════════════════════════════════════════════════════


-- ════════════════════════════════════════════════════════════════════════════
--  §1  THE private SCHEMA
--  Not exposed through PostgREST, which is the whole point: the RLS helpers
--  live here so they can read app_users with SECURITY DEFINER without that
--  read itself being subject to app_users' RLS, and without the helpers
--  becoming callable API endpoints.
-- ════════════════════════════════════════════════════════════════════════════

create schema private;
grant usage on schema private to authenticated;


-- ════════════════════════════════════════════════════════════════════════════
--  §2  TABLES
--  Dependency order: clients and firm_bank_details first, everything that
--  references them after.
-- ════════════════════════════════════════════════════════════════════════════

-- ── 2.1 Roots (no foreign keys) ─────────────────────────────────────────────

-- Membership list. Authentication (auth.users) proves WHO you are; a row here
-- is what grants access to any data at all. Both are required — see §11.
create table public.app_users (
  id bigserial primary key,
  email text not null unique,
  role text not null default 'staff',
  created_at timestamptz default now()
);

create table public.clients (
  id bigserial primary key,
  name text not null,
  email text,
  pan text,
  phone text,
  address text,
  created_at timestamptz default now(),
  entity_type text,
  business_nature text,
  registration_number text,
  chairman_name text,
  shareholder_name text,
  -- Capital amounts are TEXT on purpose — it preserves the firm's own comma
  -- grouping ("25,00,000"). Do not "fix" these to numeric.
  authorized_capital text,
  issued_capital text,
  paid_up_capital text,
  vat_status text not null default 'not_registered',
  district text,
  country text,
  -- Free text, deliberately not CHECK-constrained: 'D1/D2' is a real single
  -- value meaning "either", not a placeholder to be split.
  it_return_type text,
  tax_type_d3 text,
  tax_registration_type text,
  constraint clients_vat_status_check
    check (vat_status = any (array['active','inactive','not_registered']))
);

-- Per-firm invoice prefix and bank/QR details. invoices.firm_key points here,
-- so at least one row must exist before any invoice can be raised (§10).
create table public.firm_bank_details (
  firm_key text primary key,
  invoice_prefix text not null,
  bank_name text,
  account_name text,
  account_number text,
  branch text,
  qr_image text,
  updated_at timestamptz not null default now(),
  updated_by text
);

create table public.audit_log (
  id bigint generated by default as identity primary key,
  created_at timestamptz not null default now(),
  event_type text not null,
  module text,
  status text not null default 'success',
  user_email text,
  client_name text,
  -- BIGINT, not text. Passing a descriptive string here rejects the whole
  -- INSERT with "invalid input syntax for type bigint" and AuditLog swallows
  -- it, so nothing is logged at all and nothing errors visibly. Put the
  -- description in `detail` and a row id here.
  record_ref bigint,
  -- Keys are camelCase (clientName, recordRef). snake_case is silently
  -- dropped on the JS side.
  detail jsonb not null default '{}'::jsonb
);

-- Legacy: the Send Document module was removed 2026-08-01 with Google auth.
-- The table stays because its rows are an immutable delivery record.
create table public.send_logs (
  id bigserial primary key,
  sent_by text,
  client_name text,
  client_email text,
  doc_type text,
  fiscal_year text,
  file_name text,
  drive_file_id text,
  status text,
  error_msg text,
  sent_at timestamptz default now()
);

-- ── 2.2 Client directory ────────────────────────────────────────────────────

create table public.client_shareholders (
  id bigint generated by default as identity primary key,
  client_id bigint not null references public.clients(id) on delete cascade,
  name text not null,
  sort_order integer not null default 0
);

-- ── 2.3 Billing ─────────────────────────────────────────────────────────────

create table public.invoices (
  id bigint generated by default as identity primary key,
  -- Assigned by the set_invoice_number trigger AFTER insert, so it is NOT in
  -- INSERT's RETURNING — re-fetch the row.
  invoice_number text unique,
  client_id bigint not null references public.clients(id) on delete restrict,
  firm_key text not null references public.firm_bank_details(firm_key),
  issue_date date not null default current_date,
  due_date date,
  fiscal_year text,
  -- Trigger-owned once payments exist. Never set paid/partially_paid from JS.
  status text not null default 'draft',
  subtotal numeric(14,2) not null default 0,
  tax_rate numeric(5,4) not null default 0.13,
  tax_amount numeric(14,2) not null default 0,
  total_amount numeric(14,2) not null default 0,
  amount_paid numeric(14,2) not null default 0,
  notes text,
  pdf_filename text,
  created_at timestamptz not null default now(),
  created_by text,
  updated_at timestamptz not null default now(),
  updated_by text,
  constraint invoices_status_check
    check (status = any (array['draft','sent','partially_paid','paid','void']))
);

create table public.invoice_items (
  id bigint generated by default as identity primary key,
  invoice_id bigint not null references public.invoices(id) on delete cascade,
  description text not null,
  quantity numeric(10,2) not null default 1,
  rate numeric(14,2) not null default 0,
  amount numeric(14,2) not null default 0,
  sort_order integer not null default 0
);

create table public.invoice_payments (
  id bigint generated by default as identity primary key,
  invoice_id bigint not null references public.invoices(id) on delete restrict,
  client_id bigint not null references public.clients(id) on delete restrict,
  amount numeric(14,2) not null,
  paid_date date not null default current_date,
  method text not null default 'bank_transfer',
  note text,
  recorded_by text,
  created_at timestamptz not null default now(),
  constraint invoice_payments_amount_check check (amount > 0),
  constraint invoice_payments_method_check
    check (method = any (array['cash','bank_transfer','qr','cheque','other']))
);

-- ── 2.4 Financial management ────────────────────────────────────────────────

create table public.bank_accounts (
  id bigint generated by default as identity primary key,
  account_name text not null,
  bank_name text not null,
  account_number text,
  opening_balance numeric(16,2) not null default 0,
  opening_date text,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_by text,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  firm_key text
);

create table public.bank_transactions (
  id bigint generated by default as identity primary key,
  account_id bigint not null references public.bank_accounts(id) on delete restrict,
  txn_type text not null,
  txn_date text not null,
  particular text not null,
  amount numeric(16,2) not null,
  counterparty_name text,
  client_id bigint references public.clients(id) on delete set null,
  counterparty_account_id bigint references public.bank_accounts(id) on delete set null,
  transfer_group_id uuid,
  description text,
  -- Derived from the transaction's own date. This is data, not a default.
  fiscal_year text,
  created_by text,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bank_transactions_amount_check check (amount > 0),
  constraint bank_transactions_txn_type_check
    check (txn_type = any (array['receipt','payment'])),
  constraint bank_transactions_particular_check
    check (particular = any (array['fee_receipt','for_tax','expenses','tax_payment','sapati','inter_bank_transfer']))
);

create table public.party_opening_balances (
  id bigint generated by default as identity primary key,
  client_id bigint not null references public.clients(id) on delete cascade,
  firm_key text not null,
  fiscal_year text not null,
  as_on_date text,
  opening_amount numeric(16,2) not null default 0,
  client_name text,
  created_by text,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint party_opening_balances_client_id_firm_key_fiscal_year_key
    unique (client_id, firm_key, fiscal_year)
);

create table public.service_memos (
  id bigint generated by default as identity primary key,
  -- Assigned by the set_service_memo_number trigger AFTER insert — re-fetch.
  memo_number text,
  memo_prefix text not null,
  firm_key text not null,
  memo_date date not null default current_date,
  client_id bigint references public.clients(id) on delete set null,
  client_name text not null,
  client_pan text,
  client_address text,
  nature_category text not null,
  nature_subcategory text,
  nature_other text,
  description text,
  fiscal_year text,
  professional_fee numeric(14,2) not null default 0,
  apply_vat boolean not null default false,
  vat_amount numeric(14,2) not null default 0,
  total_amount numeric(14,2) not null default 0,
  remarks text,
  created_by text,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  firm_other text
);

-- Dismissed reminders, not records. See the table comment in §8.
create table public.service_memo_fee_skips (
  id bigint generated by default as identity primary key,
  client_id bigint references public.clients(id) on delete cascade,
  client_name text not null,
  -- The normalized B.S. START year, never ARF's slash or Service Memo's dash
  -- string, so the join can't drift from the rest of smFeeDueRows().
  fy_start_year integer not null,
  kind text not null,
  dismissed_by text,
  created_at timestamptz not null default now(),
  constraint service_memo_fee_skips_kind_check
    check (kind = any (array['audit','projection']))
);

-- ── 2.5 Automation Hub ──────────────────────────────────────────────────────

create table public.depreciation_schedules (
  id bigint generated by default as identity primary key,
  client_id bigint not null references public.clients(id) on delete cascade,
  scheme text not null default 'normal',
  fiscal_year text not null,
  company_name text,
  pan text,
  pools jsonb not null default '[]'::jsonb,
  addition_details jsonb not null default '[]'::jsonb,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint depreciation_schedules_client_id_scheme_fiscal_year_key
    unique (client_id, scheme, fiscal_year),
  constraint depreciation_schedules_scheme_check
    check (scheme = any (array['normal','special','slm']))
);

create table public.financial_statements (
  id bigint generated by default as identity primary key,
  client_id bigint references public.clients(id) on delete set null,
  company_name text not null,
  pan text,
  fiscal_year text not null,
  basis text not null default 'provisional',
  return_type text,
  entity_type text,
  inputs jsonb not null default '{}'::jsonb,
  computed jsonb not null default '{}'::jsonb,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint financial_statements_basis_check
    check (basis = any (array['provisional','audited']))
);

create table public.projection_reports (
  id bigint generated by default as identity primary key,
  client_id bigint references public.clients(id) on delete set null,
  company_name text not null,
  pan text,
  fiscal_year_base text not null,
  years integer not null default 3,
  inputs jsonb not null default '{}'::jsonb,
  computed jsonb not null default '{}'::jsonb,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- UI-only: who did the work, for the firm's own tracking. Must never reach
  -- the bank-facing report output.
  performed_by text,
  constraint projection_reports_years_check check (years >= 1 and years <= 10)
);

-- ONE table with a `module` discriminator, not one per builder. Adding a
-- builder means adding a value to the CHECK, not a migration and a drawer.
create table public.saved_documents (
  id bigint generated by default as identity primary key,
  module text not null,
  client_id bigint references public.clients(id) on delete set null,
  client_name text not null,
  pan text,
  fiscal_year text,
  doc_type text,
  title text not null,
  -- Both are kept on purpose: `state` is re-editable, `doc_html` is the
  -- document exactly as issued (the preview is contenteditable, so state
  -- alone loses every hand-edit).
  state jsonb not null default '{}'::jsonb,
  doc_html text,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint saved_documents_module_check
    check (module = any (array['report','notesToAccounts']))
);

-- ── 2.6 Autobooks ───────────────────────────────────────────────────────────

create table public.autobooks_books (
  id bigint generated by default as identity primary key,
  client_id bigint references public.clients(id) on delete set null,
  client_name text not null,
  pan text,
  fiscal_year text not null,
  reg_type text not null default 'vat',
  merge_map jsonb not null default '{}'::jsonb,
  overrides jsonb not null default '{}'::jsonb,
  correction_log jsonb not null default '[]'::jsonb,
  vat_return jsonb not null default '{}'::jsonb,
  import_notes jsonb not null default '[]'::jsonb,
  sections jsonb not null default '{}'::jsonb,
  created_by text,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- GENERATED STORED, not a default — a plain DEFAULT cannot reference other
  -- columns. This is what makes one book per (client, fiscal year) unique
  -- whether the client is a directory row or a typed name.
  book_key text generated always as (
    (coalesce('c:' || client_id::text, 'n:' || btrim(lower(client_name))) || '|') || fiscal_year
  ) stored,
  constraint autobooks_books_reg_type_check
    check (reg_type = any (array['vat','pan']))
);

create table public.autobooks_entries (
  id bigint generated by default as identity primary key,
  book_id bigint not null references public.autobooks_books(id) on delete cascade,
  section text not null,
  -- 'omitted' = a bill entered after the register closed. It prints after the
  -- Ashadh total but still counts toward the party total, and it survives a
  -- re-import (only kind='regular' lines are replaced).
  kind text not null default 'regular',
  bill_type text,
  bs_date text,
  -- 1-12 with 1 = Shrawan, NOT the B.S. calendar month number.
  fiscal_month smallint,
  bill_no text,
  party_name text not null default '',
  party_key text not null default '',
  pan text,
  tax_free numeric not null default 0,
  taxable numeric not null default 0,
  vat numeric not null default 0,
  taxable_import numeric not null default 0,
  import_vat numeric not null default 0,
  -- Capital is a SLICE OF taxable, not an addition to it.
  capital numeric not null default 0,
  capital_vat numeric not null default 0,
  note text,
  source text not null default 'import',
  excel_row integer,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  constraint autobooks_entries_section_check
    check (section = any (array['sales','purchase'])),
  constraint autobooks_entries_kind_check
    check (kind = any (array['regular','omitted'])),
  constraint autobooks_entries_bill_type_check
    check (bill_type = any (array['sales','sales_return','purchase','purchase_return'])),
  constraint autobooks_entries_source_check
    check (source = any (array['import','manual'])),
  constraint autobooks_entries_fiscal_month_check
    check (fiscal_month >= 1 and fiscal_month <= 12)
);

create table public.autobooks_parties (
  id bigint generated by default as identity primary key,
  book_id bigint not null references public.autobooks_books(id) on delete cascade,
  section text not null,
  party_key text not null,
  party_name text not null,
  pan text,
  -- These three come off a signed confirmation letter. A re-import refreshes
  -- name/PAN but must never overwrite them.
  opening_balance numeric,
  confirmed_taxable numeric,
  confirmed_closing numeric,
  ann13_category text,
  remarks text,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint autobooks_parties_book_id_section_party_key_key
    unique (book_id, section, party_key),
  constraint autobooks_parties_section_check
    check (section = any (array['sales','purchase']))
);

create table public.autobooks_adjustments (
  id bigint generated by default as identity primary key,
  book_id bigint not null references public.autobooks_books(id) on delete cascade,
  statement text not null,
  direction text not null,
  description text not null default '',
  amount numeric not null default 0,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  constraint autobooks_adjustments_statement_check
    check (statement = any (array['sales','purchase','vat'])),
  constraint autobooks_adjustments_direction_check
    check (direction = any (array['add','less']))
);

-- ── 2.7 Work tracking ───────────────────────────────────────────────────────

create table public.document_register (
  id bigint generated by default as identity primary key,
  -- Assigned by the set_document_register_number trigger AFTER insert.
  register_no text,
  -- Nullable: the firm accepts paperwork from walk-ins who aren't in the
  -- directory. Unlike work_done / audit_checklists / ARF, which are NOT NULL.
  client_id bigint references public.clients(id) on delete set null,
  client_name text not null,
  client_pan text,
  date_received date not null default current_date,
  doc_types jsonb not null default '[]'::jsonb,
  doc_other text,
  brought_by_name text,
  brought_by_phone text,
  remarks text,
  -- DERIVED from doc_types vs outtakes on every change (fmDeriveStatus),
  -- never hand-set from a button value.
  status text not null default 'pending',
  created_by text,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  fiscal_year text,
  mode_received text not null default 'physical',
  email_received text,
  -- Repeatable handover events. The firm doesn't always give everything back
  -- at once, so this is a list, not a single return flag.
  outtakes jsonb not null default '[]'::jsonb,
  constraint document_register_status_check
    check (status = any (array['pending','partial','returned'])),
  constraint document_register_mode_received_check
    check (mode_received = any (array['online','physical']))
);

create table public.audit_report_finalization (
  id bigint generated by default as identity primary key,
  client_id bigint not null references public.clients(id) on delete restrict,
  client_name text not null,
  client_pan text,
  fiscal_year text not null,
  -- FIRM names, not partner names. Free text with no CHECK on purpose: the
  -- UI offers "Other, type a name".
  auditor text not null,
  it_entered_by text,
  it_submission_no text,
  it_verified boolean,
  estimate_entered_by text,
  estimate_verified boolean,
  tax_clearance boolean not null default false,
  tax_clearance_date date,
  remarks text,
  created_by text,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  return_type text not null,
  it_return_type text,
  it_checked_by text,
  estimate_submission_no text,
  tax_clearance_remarks text,
  -- NOT created_at. Staff routinely log on Monday work done on Friday, and
  -- the From/To filter has to reflect the work, not the typing.
  recorded_date date not null default current_date,
  -- One record per (client, fiscal year, RETURN TYPE) — three separate jobs
  -- done by different staff at different times.
  constraint audit_report_finalization_client_fy_type_uniq
    unique (client_id, fiscal_year, return_type),
  constraint arf_return_type_check
    check (return_type = any (array['it_return','estimate_return','tax_clearance'])),
  constraint arf_it_return_type_check
    check (it_return_type is null or it_return_type = any (array['D-2','D-3'])),
  constraint arf_it_submission_no_check
    check (it_submission_no is null or it_submission_no ~ '^[0-9]{12}$'),
  constraint arf_estimate_submission_no_check
    check (estimate_submission_no is null or estimate_submission_no ~ '^[0-9]{12}$')
);

create table public.audit_checklists (
  id bigint generated by default as identity primary key,
  client_id bigint not null references public.clients(id) on delete restrict,
  client_name text not null,
  client_pan text,
  fiscal_year text not null,
  recorded_date date not null default current_date,
  items jsonb not null default '[]'::jsonb,
  remarks text,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint audit_checklists_client_fy_uniq unique (client_id, fiscal_year)
);

create table public.work_done (
  id bigint generated by default as identity primary key,
  client_id bigint not null references public.clients(id) on delete restrict,
  client_name text not null,
  client_pan text,
  fiscal_year text not null,
  recorded_date date not null default current_date,
  items jsonb not null default '[]'::jsonb,
  remarks text,
  created_by text,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One page per (client, fiscal year). This UNIQUE is exactly why the
  -- To-Do List needed its own table — six tasks for one client in one year
  -- are legitimate and this forbids them.
  constraint work_done_client_fy_uniq unique (client_id, fiscal_year)
);

create table public.work_todos (
  id bigint generated by default as identity primary key,
  task_date date not null default current_date,
  -- Nullable / SET NULL, deliberately unlike work_done and ARF: a to-do is
  -- routinely internal ("renew the office firm registration") or against a
  -- walk-in, and refusing those sends staff back to paper.
  client_id bigint references public.clients(id) on delete set null,
  client_name text,
  client_pan text,
  nature_of_work text not null,
  remarks text,
  -- STORED, not derived — a to-do has no underlying fact elsewhere to derive
  -- from; its state IS the record.
  status text not null default 'not_started',
  priority text not null default 'normal',
  assigned_to text,
  due_date date,
  completed_at timestamptz,
  created_by text,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- No fiscal_year on purpose: a to-do is pinned to a date, not a year.
  constraint work_todos_status_chk
    check (status = any (array['not_started','in_progress','done'])),
  constraint work_todos_priority_chk
    check (priority = any (array['low','normal','high'])),
  -- done <=> stamped, enforced in Postgres so a reopened task can never keep
  -- a stale completion stamp.
  constraint work_todos_completed_chk
    check ((status = 'done') = (completed_at is not null))
);


-- ════════════════════════════════════════════════════════════════════════════
--  §3  TRIGGER FUNCTIONS
--  plpgsql, so bodies are not validated at CREATE time — but they are placed
--  after the tables anyway so the file reads in dependency order throughout.
--  Every one sets search_path = '' (2026-07-16 hardening); that is why every
--  reference inside them is schema-qualified.
-- ════════════════════════════════════════════════════════════════════════════

create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path to ''
as $function$
begin
  new.updated_at = now();
  return new;
end $function$;

-- AFTER INSERT, so the id exists. This is why invoice_number is absent from
-- INSERT's RETURNING and the row must be re-fetched.
create or replace function public.set_invoice_number()
returns trigger language plpgsql set search_path to ''
as $function$
declare prefix text;
begin
  if new.invoice_number is null then
    select invoice_prefix into prefix from public.firm_bank_details where firm_key = new.firm_key;
    update public.invoices set invoice_number = coalesce(prefix, 'INV') || '-' || lpad(new.id::text, 5, '0')
      where id = new.id;
  end if;
  return null;
end $function$;

create or replace function public.set_service_memo_number()
returns trigger language plpgsql set search_path to ''
as $function$
begin
  if new.memo_number is null then
    update public.service_memos
      set memo_number = coalesce(new.memo_prefix, 'SM') || '-' || lpad(new.id::text, 5, '0')
      where id = new.id;
  end if;
  return null;
end $function$;

create or replace function public.set_document_register_number()
returns trigger language plpgsql set search_path to ''
as $function$
begin
  if new.register_no is null then
    update public.document_register
      set register_no = 'FM-' || lpad(new.id::text, 5, '0')
      where id = new.id;
  end if;
  return null;
end $function$;

-- Invoice status is TRIGGER-OWNED. Never set paid/partially_paid from JS.
create or replace function public.sync_invoice_payment_totals()
returns trigger language plpgsql set search_path to ''
as $function$
declare
  v_invoice_id bigint := coalesce(new.invoice_id, old.invoice_id);
  v_total numeric(14,2);
  v_status text;
  v_paid numeric(14,2);
begin
  select total_amount, status into v_total, v_status from public.invoices where id = v_invoice_id;
  select coalesce(sum(amount), 0) into v_paid from public.invoice_payments where invoice_id = v_invoice_id;

  update public.invoices
    set amount_paid = v_paid,
        status = case
          when status = 'void' then status
          when v_paid <= 0 then case when status in ('paid','partially_paid') then 'sent' else status end
          when v_paid >= v_total and v_total > 0 then 'paid'
          else 'partially_paid'
        end
    where id = v_invoice_id;
  return null;
end $function$;


-- ════════════════════════════════════════════════════════════════════════════
--  §4  THE RLS HELPERS
--  MEMBERSHIP, NOT AUTHENTICATION, GRANTS ACCESS. Anyone who can sign in
--  holds an `authenticated` JWT, so every policy checks app_users through
--  these. SECURITY DEFINER lets them read app_users regardless of its own RLS.
--
--  LANGUAGE sql — validated at CREATE time, which is why public.app_users had
--  to be created first.
--
--  jwt_email() LOWERCASES. The JS membership lookup in auth.js must therefore
--  use .ilike() and not .eq(), or a mixed-case address RLS accepts would be
--  rejected there and the two layers would disagree.
-- ════════════════════════════════════════════════════════════════════════════

create or replace function private.jwt_email()
returns text language sql stable security definer set search_path to ''
as $function$
  select lower(coalesce(auth.jwt() ->> 'email', ''));
$function$;

create or replace function private.is_app_user()
returns boolean language sql stable security definer set search_path to ''
as $function$
  select exists (
    select 1 from public.app_users u
    where lower(u.email) = private.jwt_email()
  );
$function$;

create or replace function private.is_admin()
returns boolean language sql stable security definer set search_path to ''
as $function$
  select exists (
    select 1 from public.app_users u
    where lower(u.email) = private.jwt_email() and u.role = 'admin'
  );
$function$;

revoke all on function private.jwt_email()   from public;
revoke all on function private.is_app_user() from public;
revoke all on function private.is_admin()    from public;
grant execute on function private.jwt_email(), private.is_app_user(), private.is_admin() to authenticated;


-- ════════════════════════════════════════════════════════════════════════════
--  §5  RPCs
--  Called from JS via sb.rpc(). LANGUAGE sql, so the tables they read must
--  already exist — hence their position here.
-- ════════════════════════════════════════════════════════════════════════════

create or replace function public.get_billing_stats()
returns table(total_outstanding numeric, overdue_amount numeric, month_income numeric,
              invoices_sent_month bigint, draft_count bigint, paid_month_count bigint)
language sql stable set search_path to ''
as $function$
  select
    (select coalesce(sum(total_amount - amount_paid), 0) from public.invoices where status not in ('paid','void')),
    (select coalesce(sum(total_amount - amount_paid), 0) from public.invoices where status not in ('paid','void') and due_date < current_date),
    (select coalesce(sum(amount), 0) from public.invoice_payments where paid_date >= date_trunc('month', current_date)),
    (select count(*) from public.invoices where status <> 'draft' and created_at >= date_trunc('month', current_date)),
    (select count(*) from public.invoices where status = 'draft'),
    (select count(*) from public.invoices where status = 'paid' and updated_at >= date_trunc('month', current_date));
$function$;

create or replace function public.get_monthly_income(p_months integer default 6)
returns table(month_start date, total numeric)
language sql stable set search_path to ''
as $function$
  select date_trunc('month', paid_date)::date, sum(amount)
  from public.invoice_payments
  where paid_date >= date_trunc('month', current_date) - (p_months - 1) * interval '1 month'
  group by 1 order by 1;
$function$;

create or replace function public.get_db_storage_usage()
returns table(bytes_used bigint)
language sql stable security definer set search_path to ''
as $function$
  select pg_database_size(current_database()) where private.is_app_user();
$function$;


-- ════════════════════════════════════════════════════════════════════════════
--  §6  INDEXES
--  Constraint-backed indexes (PK/UNIQUE) are created by §2 and not repeated.
-- ════════════════════════════════════════════════════════════════════════════

create index achk_client_idx        on public.audit_checklists using btree (client_id);
create index achk_fiscal_year_idx   on public.audit_checklists using btree (fiscal_year);
create index achk_recorded_date_idx on public.audit_checklists using btree (recorded_date desc);

create index audit_log_event_created_idx on public.audit_log using btree (event_type, created_at desc);
create index audit_log_record_ref_idx    on public.audit_log using btree (record_ref) where (record_ref is not null);

create index arf_auditor_idx       on public.audit_report_finalization using btree (auditor);
create index arf_client_idx        on public.audit_report_finalization using btree (client_id);
create index arf_fiscal_year_idx   on public.audit_report_finalization using btree (fiscal_year);
create index arf_recorded_date_idx on public.audit_report_finalization using btree (recorded_date desc);
create index arf_return_type_idx   on public.audit_report_finalization using btree (return_type);

create index autobooks_adjustments_book_idx on public.autobooks_adjustments using btree (book_id, statement, sort_order);
create index autobooks_books_client_idx     on public.autobooks_books using btree (client_id, fiscal_year);
create unique index autobooks_books_key_uniq on public.autobooks_books using btree (book_key);
create index autobooks_entries_book_idx     on public.autobooks_entries using btree (book_id, section, kind, fiscal_month, sort_order);
create index autobooks_entries_party_idx    on public.autobooks_entries using btree (book_id, section, party_key);

create index bank_accounts_active_idx on public.bank_accounts using btree (is_active);
create index bank_accounts_firm_idx   on public.bank_accounts using btree (firm_key);
create index bank_accounts_sort_idx   on public.bank_accounts using btree (sort_order);

create index bank_transactions_account_idx  on public.bank_transactions using btree (account_id);
create index bank_transactions_date_idx     on public.bank_transactions using btree (txn_date);
create index bank_transactions_fy_idx       on public.bank_transactions using btree (fiscal_year);
create index bank_transactions_transfer_idx on public.bank_transactions using btree (transfer_group_id);
create index bank_transactions_type_idx     on public.bank_transactions using btree (txn_type);

create index depreciation_schedules_client_scheme_idx on public.depreciation_schedules using btree (client_id, scheme, fiscal_year);

create index document_register_client_idx  on public.document_register using btree (client_id);
create index document_register_created_idx on public.document_register using btree (created_at desc);
create index document_register_status_idx  on public.document_register using btree (status);

create unique index financial_statements_client_fy_basis_idx on public.financial_statements using btree (client_id, fiscal_year, basis) where (client_id is not null);
create index financial_statements_created_idx on public.financial_statements using btree (created_at desc);
create index financial_statements_fy_idx      on public.financial_statements using btree (fiscal_year);

create index invoice_items_invoice_idx   on public.invoice_items using btree (invoice_id);
create index invoice_payments_client_idx  on public.invoice_payments using btree (client_id);
create index invoice_payments_date_idx    on public.invoice_payments using btree (paid_date);
create index invoice_payments_invoice_idx on public.invoice_payments using btree (invoice_id);
create index invoices_client_idx   on public.invoices using btree (client_id);
create index invoices_due_date_idx on public.invoices using btree (due_date) where (status <> all (array['paid','void']));
create index invoices_status_idx   on public.invoices using btree (status);

create index party_opening_balances_client_idx on public.party_opening_balances using btree (client_id);
create index party_opening_balances_firm_idx   on public.party_opening_balances using btree (firm_key);
create index party_opening_balances_fy_idx     on public.party_opening_balances using btree (fiscal_year);

create index projection_reports_client_idx  on public.projection_reports using btree (client_id);
create index projection_reports_created_idx on public.projection_reports using btree (created_at desc);
create index projection_reports_fy_idx      on public.projection_reports using btree (fiscal_year_base);

create index saved_documents_client_idx on public.saved_documents using btree (client_id);
create index saved_documents_module_idx on public.saved_documents using btree (module, created_at desc);

create index service_memo_fee_skips_lookup_idx on public.service_memo_fee_skips using btree (kind, fy_start_year, client_id);
create index service_memos_client_idx  on public.service_memos using btree (client_id);
create index service_memos_created_idx on public.service_memos using btree (created_at desc);
create index service_memos_firm_idx    on public.service_memos using btree (firm_key);

create index wd_client_idx        on public.work_done using btree (client_id);
create index wd_fiscal_year_idx   on public.work_done using btree (fiscal_year);
create index wd_recorded_date_idx on public.work_done using btree (recorded_date desc);

create index wt_assigned_to_idx on public.work_todos using btree (assigned_to);
create index wt_client_idx      on public.work_todos using btree (client_id);
create index wt_open_due_idx    on public.work_todos using btree (status, due_date) where (status <> 'done');
create index wt_task_date_idx   on public.work_todos using btree (task_date desc);


-- ════════════════════════════════════════════════════════════════════════════
--  §7  TRIGGERS
-- ════════════════════════════════════════════════════════════════════════════

create trigger set_achk_updated_at              before update on public.audit_checklists          for each row execute function public.set_updated_at();
create trigger set_arf_updated_at               before update on public.audit_report_finalization for each row execute function public.set_updated_at();
create trigger autobooks_books_set_updated_at   before update on public.autobooks_books           for each row execute function public.set_updated_at();
create trigger autobooks_parties_set_updated_at before update on public.autobooks_parties         for each row execute function public.set_updated_at();
create trigger set_bank_accounts_updated_at     before update on public.bank_accounts             for each row execute function public.set_updated_at();
create trigger set_bank_transactions_updated_at before update on public.bank_transactions         for each row execute function public.set_updated_at();
create trigger set_depreciation_schedules_updated_at before update on public.depreciation_schedules for each row execute function public.set_updated_at();
create trigger set_document_register_updated_at before update on public.document_register         for each row execute function public.set_updated_at();
create trigger set_financial_statements_updated_at   before update on public.financial_statements for each row execute function public.set_updated_at();
create trigger invoices_set_updated_at          before update on public.invoices                  for each row execute function public.set_updated_at();
create trigger set_party_opening_balances_updated_at before update on public.party_opening_balances for each row execute function public.set_updated_at();
create trigger set_projection_reports_updated_at before update on public.projection_reports       for each row execute function public.set_updated_at();
create trigger set_saved_documents_updated_at   before update on public.saved_documents           for each row execute function public.set_updated_at();
create trigger set_service_memos_updated_at     before update on public.service_memos             for each row execute function public.set_updated_at();
create trigger set_wd_updated_at                before update on public.work_done                 for each row execute function public.set_updated_at();
create trigger set_wt_updated_at                before update on public.work_todos                for each row execute function public.set_updated_at();

-- AFTER INSERT number stamps — the id has to exist first.
create trigger set_document_register_number after insert on public.document_register for each row execute function public.set_document_register_number();
create trigger invoices_set_number          after insert on public.invoices          for each row execute function public.set_invoice_number();
create trigger set_service_memo_number      after insert on public.service_memos     for each row execute function public.set_service_memo_number();

create trigger invoice_payments_sync after insert or delete or update on public.invoice_payments for each row execute function public.sync_invoice_payment_totals();


-- ════════════════════════════════════════════════════════════════════════════
--  §8  TABLE COMMENTS
--  These are the schema's own documentation and show in the Supabase table
--  editor. Worth keeping in step with docs/database.md.
-- ════════════════════════════════════════════════════════════════════════════

comment on table public.bank_accounts is 'Firm-owned bank accounts (Bank Book module). Holder/bank list is user-managed data, not JS config.';
comment on table public.bank_transactions is 'Bank Book receipts & payments. Inter-bank transfers = two paired rows sharing transfer_group_id (payment leg + receipt leg).';
comment on table public.service_memos is 'Internal service records + fee tracking (Service Memo module). Not a tax invoice — see public.invoices for accounting invoices.';
comment on table public.service_memo_fee_skips is 'Dismissed entries from Service Memo''s Pending Memos list — excludes a specific (client, fiscal year, kind) reminder derived from audit_report_finalization or projection_reports.';
comment on table public.party_opening_balances is 'Per-client opening balance for the Party Ledger. The only figure in that ledger that is stored rather than derived.';
comment on table public.depreciation_schedules is 'Saved depreciation working per (client, scheme, fiscal_year); closing WDV in pools carries forward to next year''s Opening. Manual save from the Depreciation module.';
comment on table public.financial_statements is 'Saved NFRS financial statement sets (Financial Statement module): prior-year comparative + figures A-N in `inputs`, solved statements in `computed`.';
comment on table public.projection_reports is 'Saved multi-year financial projections (Projection Report module): parsed statement + assumptions in `inputs`, full engine output in `computed`.';
comment on table public.saved_documents is 'Saved output of the HTML document builders (Audit Report, Notes to Accounts): editable form state in `state`, the rendered document in `doc_html`. One row per saved document, discriminated by `module`.';
comment on table public.document_register is 'Physical document intake/handover log (File Management module) — one row per visit, updated on return.';
comment on table public.audit_report_finalization is 'Per-client, per-fiscal-year, per-return-type tracker for IT return / Estimate return submission & tax clearance status (Audit Report Finalization module).';
comment on table public.audit_checklists is 'Per-client, per-fiscal-year QC checklist run before an audit report is finalized (Audit Checklist module). items is a jsonb array of {key,label,checked,checked_by,custom}.';
comment on table public.work_done is 'Per-client, per-fiscal-year record of which pieces of work have actually been finished (Work Done module). items is a jsonb array of {key,label,state,staff,remarks,done_date,custom}; state is not_started/in_progress/done. Status is derived in JS, never stored. The module''s Pending List is a join against public.document_register, not a column here.';
comment on table public.work_todos is 'Free-form task list for the firm (Work Done -> To-Do List view). One row per task, unlike work_done''s one row per client+fiscal year. client_id is nullable so internal and walk-in tasks can be recorded; nature_of_work is free text with a UI datalist. status is stored (not derived) because a to-do has no underlying fact to derive from, and completed_at is CHECK-tied to it.';
comment on table public.autobooks_books is 'One Autobooks working session per client per fiscal year — the anchor for its bill lines, confirmation ledger and reconciliation adjustments.';
comment on table public.autobooks_entries is 'Every Autobooks bill line. kind=''omitted'' marks a bill entered after the year''s register was closed — it prints after the Ashadh total but still counts toward the party total.';
comment on table public.autobooks_parties is 'Autobooks confirmation ledger — the figures a human types against a party (opening balance, as-per-confirmation taxable, closing balance, Annexure-13 category). Book figures are computed from autobooks_entries, never stored here.';
comment on table public.autobooks_adjustments is 'Ad-hoc add/less lines on an Autobooks reconciliation statement (Sales/Purchase/VAT). Free text on purpose — the adjustments differ per client and year.';


-- ════════════════════════════════════════════════════════════════════════════
--  §9  GRANTS + RLS
--
--  The grants below are what a new Supabase project applies by default to the
--  public schema; they are restated so this file is self-sufficient. They are
--  NOT the security boundary — RLS is. `anon` receives table grants and has
--  ZERO policies, which is what reduces it to no access at all.
-- ════════════════════════════════════════════════════════════════════════════

grant all on all tables    in schema public to anon, authenticated, service_role;
grant all on all sequences in schema public to anon, authenticated, service_role;

grant execute on function public.get_billing_stats()             to authenticated, service_role;
grant execute on function public.get_monthly_income(integer)     to authenticated, service_role;
grant execute on function public.get_db_storage_usage()          to authenticated, service_role;

alter table public.app_users                 enable row level security;
alter table public.audit_checklists          enable row level security;
alter table public.audit_log                 enable row level security;
alter table public.audit_report_finalization enable row level security;
alter table public.autobooks_adjustments     enable row level security;
alter table public.autobooks_books           enable row level security;
alter table public.autobooks_entries         enable row level security;
alter table public.autobooks_parties         enable row level security;
alter table public.bank_accounts             enable row level security;
alter table public.bank_transactions         enable row level security;
alter table public.client_shareholders       enable row level security;
alter table public.clients                   enable row level security;
alter table public.depreciation_schedules    enable row level security;
alter table public.document_register         enable row level security;
alter table public.financial_statements      enable row level security;
alter table public.firm_bank_details         enable row level security;
alter table public.invoice_items             enable row level security;
alter table public.invoice_payments          enable row level security;
alter table public.invoices                  enable row level security;
alter table public.party_opening_balances    enable row level security;
alter table public.projection_reports        enable row level security;
alter table public.saved_documents           enable row level security;
alter table public.send_logs                 enable row level security;
alter table public.service_memo_fee_skips    enable row level security;
alter table public.service_memos             enable row level security;
alter table public.work_done                 enable row level security;
alter table public.work_todos                enable row level security;

-- ── 9.1 Membership list — readable, never writable from the app ─────────────
create policy app_users_select_member on public.app_users for select to authenticated using (private.is_app_user());

-- ── 9.2 Client directory — INSERT/DELETE are admin-only ─────────────────────
create policy clients_select_member on public.clients for select to authenticated using (private.is_app_user());
create policy clients_insert_admin  on public.clients for insert to authenticated with check (private.is_admin());
create policy clients_update_member on public.clients for update to authenticated using (private.is_app_user()) with check (private.is_app_user());
create policy clients_delete_admin  on public.clients for delete to authenticated using (private.is_admin());

create policy client_shareholders_select_member on public.client_shareholders for select to authenticated using (private.is_app_user());
create policy client_shareholders_insert_admin  on public.client_shareholders for insert to authenticated with check (private.is_admin());

-- ── 9.3 Immutable logs — insert and read, never update or delete ────────────
create policy audit_log_select_member on public.audit_log for select to authenticated using (private.is_app_user());
create policy audit_log_insert_member on public.audit_log for insert to authenticated with check (private.is_app_user());

create policy send_logs_select_own_or_admin on public.send_logs for select to authenticated using (private.is_admin() or lower(sent_by) = private.jwt_email());
create policy send_logs_insert_member       on public.send_logs for insert to authenticated with check (private.is_app_user() and lower(sent_by) = private.jwt_email());

-- ── 9.4 Firm bank details — WRITES ARE ADMIN-ONLY (payment-fraud target) ────
create policy firm_bank_details_select_member on public.firm_bank_details for select to authenticated using (private.is_app_user());
create policy firm_bank_details_insert_admin  on public.firm_bank_details for insert to authenticated with check (private.is_admin());
create policy firm_bank_details_update_admin  on public.firm_bank_details for update to authenticated using (private.is_admin()) with check (private.is_admin());

-- ── 9.5 Billing ─────────────────────────────────────────────────────────────
create policy invoices_select_member on public.invoices for select to authenticated using (private.is_app_user());
create policy invoices_insert_member on public.invoices for insert to authenticated with check (private.is_app_user());
create policy invoices_update_member on public.invoices for update to authenticated using (private.is_app_user()) with check (private.is_app_user());
create policy invoices_delete_member on public.invoices for delete to authenticated using (private.is_app_user());

create policy invoice_items_select_member on public.invoice_items for select to authenticated using (private.is_app_user());
create policy invoice_items_insert_member on public.invoice_items for insert to authenticated with check (private.is_app_user());
create policy invoice_items_delete_member on public.invoice_items for delete to authenticated using (private.is_app_user());

-- A recorded payment is not editable or deletable — it drives the invoice
-- status trigger, so the two would drift.
create policy invoice_payments_select_member on public.invoice_payments for select to authenticated using (private.is_app_user());
create policy invoice_payments_insert_member on public.invoice_payments for insert to authenticated with check (private.is_app_user());

-- ── 9.6 Everything else: full CRUD for members ──────────────────────────────
create policy achk_select_member on public.audit_checklists for select to authenticated using (private.is_app_user());
create policy achk_insert_member on public.audit_checklists for insert to authenticated with check (private.is_app_user());
create policy achk_update_member on public.audit_checklists for update to authenticated using (private.is_app_user()) with check (private.is_app_user());
create policy achk_delete_member on public.audit_checklists for delete to authenticated using (private.is_app_user());

create policy arf_select_member on public.audit_report_finalization for select to authenticated using (private.is_app_user());
create policy arf_insert_member on public.audit_report_finalization for insert to authenticated with check (private.is_app_user());
create policy arf_update_member on public.audit_report_finalization for update to authenticated using (private.is_app_user()) with check (private.is_app_user());
create policy arf_delete_member on public.audit_report_finalization for delete to authenticated using (private.is_app_user());

create policy autobooks_adjustments_select_member on public.autobooks_adjustments for select to authenticated using (private.is_app_user());
create policy autobooks_adjustments_insert_member on public.autobooks_adjustments for insert to authenticated with check (private.is_app_user());
create policy autobooks_adjustments_update_member on public.autobooks_adjustments for update to authenticated using (private.is_app_user()) with check (private.is_app_user());
create policy autobooks_adjustments_delete_member on public.autobooks_adjustments for delete to authenticated using (private.is_app_user());

create policy autobooks_books_select_member on public.autobooks_books for select to authenticated using (private.is_app_user());
create policy autobooks_books_insert_member on public.autobooks_books for insert to authenticated with check (private.is_app_user());
create policy autobooks_books_update_member on public.autobooks_books for update to authenticated using (private.is_app_user()) with check (private.is_app_user());
create policy autobooks_books_delete_member on public.autobooks_books for delete to authenticated using (private.is_app_user());

create policy autobooks_entries_select_member on public.autobooks_entries for select to authenticated using (private.is_app_user());
create policy autobooks_entries_insert_member on public.autobooks_entries for insert to authenticated with check (private.is_app_user());
create policy autobooks_entries_update_member on public.autobooks_entries for update to authenticated using (private.is_app_user()) with check (private.is_app_user());
create policy autobooks_entries_delete_member on public.autobooks_entries for delete to authenticated using (private.is_app_user());

create policy autobooks_parties_select_member on public.autobooks_parties for select to authenticated using (private.is_app_user());
create policy autobooks_parties_insert_member on public.autobooks_parties for insert to authenticated with check (private.is_app_user());
create policy autobooks_parties_update_member on public.autobooks_parties for update to authenticated using (private.is_app_user()) with check (private.is_app_user());
create policy autobooks_parties_delete_member on public.autobooks_parties for delete to authenticated using (private.is_app_user());

create policy bank_accounts_select_member on public.bank_accounts for select to authenticated using (private.is_app_user());
create policy bank_accounts_insert_member on public.bank_accounts for insert to authenticated with check (private.is_app_user());
create policy bank_accounts_update_member on public.bank_accounts for update to authenticated using (private.is_app_user()) with check (private.is_app_user());
create policy bank_accounts_delete_member on public.bank_accounts for delete to authenticated using (private.is_app_user());

create policy bank_transactions_select_member on public.bank_transactions for select to authenticated using (private.is_app_user());
create policy bank_transactions_insert_member on public.bank_transactions for insert to authenticated with check (private.is_app_user());
create policy bank_transactions_update_member on public.bank_transactions for update to authenticated using (private.is_app_user()) with check (private.is_app_user());
create policy bank_transactions_delete_member on public.bank_transactions for delete to authenticated using (private.is_app_user());

create policy depreciation_schedules_select_member on public.depreciation_schedules for select to authenticated using (private.is_app_user());
create policy depreciation_schedules_insert_member on public.depreciation_schedules for insert to authenticated with check (private.is_app_user());
create policy depreciation_schedules_update_member on public.depreciation_schedules for update to authenticated using (private.is_app_user()) with check (private.is_app_user());
create policy depreciation_schedules_delete_member on public.depreciation_schedules for delete to authenticated using (private.is_app_user());

create policy document_register_select_member on public.document_register for select to authenticated using (private.is_app_user());
create policy document_register_insert_member on public.document_register for insert to authenticated with check (private.is_app_user());
create policy document_register_update_member on public.document_register for update to authenticated using (private.is_app_user()) with check (private.is_app_user());
create policy document_register_delete_member on public.document_register for delete to authenticated using (private.is_app_user());

create policy financial_statements_select_member on public.financial_statements for select to authenticated using (private.is_app_user());
create policy financial_statements_insert_member on public.financial_statements for insert to authenticated with check (private.is_app_user());
create policy financial_statements_update_member on public.financial_statements for update to authenticated using (private.is_app_user()) with check (private.is_app_user());
create policy financial_statements_delete_member on public.financial_statements for delete to authenticated using (private.is_app_user());

create policy party_opening_balances_select_member on public.party_opening_balances for select to authenticated using (private.is_app_user());
create policy party_opening_balances_insert_member on public.party_opening_balances for insert to authenticated with check (private.is_app_user());
create policy party_opening_balances_update_member on public.party_opening_balances for update to authenticated using (private.is_app_user()) with check (private.is_app_user());
create policy party_opening_balances_delete_member on public.party_opening_balances for delete to authenticated using (private.is_app_user());

create policy projection_reports_select_member on public.projection_reports for select to authenticated using (private.is_app_user());
create policy projection_reports_insert_member on public.projection_reports for insert to authenticated with check (private.is_app_user());
create policy projection_reports_update_member on public.projection_reports for update to authenticated using (private.is_app_user()) with check (private.is_app_user());
create policy projection_reports_delete_member on public.projection_reports for delete to authenticated using (private.is_app_user());

create policy saved_documents_select_member on public.saved_documents for select to authenticated using (private.is_app_user());
create policy saved_documents_insert_member on public.saved_documents for insert to authenticated with check (private.is_app_user());
create policy saved_documents_update_member on public.saved_documents for update to authenticated using (private.is_app_user()) with check (private.is_app_user());
create policy saved_documents_delete_member on public.saved_documents for delete to authenticated using (private.is_app_user());

-- No UPDATE policy on purpose: a skip is created or deleted, never edited.
create policy service_memo_fee_skips_select_member on public.service_memo_fee_skips for select to authenticated using (private.is_app_user());
create policy service_memo_fee_skips_insert_member on public.service_memo_fee_skips for insert to authenticated with check (private.is_app_user());
create policy service_memo_fee_skips_delete_member on public.service_memo_fee_skips for delete to authenticated using (private.is_app_user());

create policy service_memos_select_member on public.service_memos for select to authenticated using (private.is_app_user());
create policy service_memos_insert_member on public.service_memos for insert to authenticated with check (private.is_app_user());
create policy service_memos_update_member on public.service_memos for update to authenticated using (private.is_app_user()) with check (private.is_app_user());
create policy service_memos_delete_member on public.service_memos for delete to authenticated using (private.is_app_user());

create policy wd_select_member on public.work_done for select to authenticated using (private.is_app_user());
create policy wd_insert_member on public.work_done for insert to authenticated with check (private.is_app_user());
create policy wd_update_member on public.work_done for update to authenticated using (private.is_app_user()) with check (private.is_app_user());
create policy wd_delete_member on public.work_done for delete to authenticated using (private.is_app_user());

create policy wt_select_member on public.work_todos for select to authenticated using (private.is_app_user());
create policy wt_insert_member on public.work_todos for insert to authenticated with check (private.is_app_user());
create policy wt_update_member on public.work_todos for update to authenticated using (private.is_app_user()) with check (private.is_app_user());
create policy wt_delete_member on public.work_todos for delete to authenticated using (private.is_app_user());


-- ════════════════════════════════════════════════════════════════════════════
--  §10  SEED — the two rows a new instance cannot start without
--  Commented out because the values are per-organisation. Uncomment, replace,
--  run. Everything else the app creates for itself.
-- ════════════════════════════════════════════════════════════════════════════

--  (a) One firm_bank_details row per firm. REQUIRED before any invoice can be
--      raised — invoices.firm_key is a foreign key to this table, and
--      invoice_prefix is what set_invoice_number() stamps onto the number
--      (prefix 'SA' gives SA-00001). firm_key must match the keys in
--      window.REP_FIRMS / SERVICE_MEMO_FIRMS in js/config.js.
--
-- insert into public.firm_bank_details (firm_key, invoice_prefix) values
--   ('firm_one', 'F1'),
--   ('firm_two', 'F2');

--  (b) The first admin. See §11 — this is only HALF of creating a login.
--
-- insert into public.app_users (email, role) values
--   ('admin@example.com', 'admin');


-- ════════════════════════════════════════════════════════════════════════════
--  §11  CREATING A STAFF LOGIN IS TWO STEPS — this file can only do one
--
--  1. Supabase dashboard → Authentication → Users → Add user. Sets the
--     password. (Signup is disabled deliberately; there is no self-serve
--     password reset — an admin resets it here.)
--  2. insert into public.app_users (email, role) values ('them@x.com','staff');
--
--  Do only step 1 and the person authenticates successfully and is then shown
--  Access Denied, because membership — not authentication — is what grants
--  access. Do only step 2 and they cannot sign in at all.
--
--  role is 'admin' or 'staff' and affects UI visibility plus the four
--  admin-only policies above (clients INSERT/DELETE, client_shareholders
--  INSERT, firm_bank_details writes).
-- ════════════════════════════════════════════════════════════════════════════


-- ════════════════════════════════════════════════════════════════════════════
--  §12  VERIFY
--  Run this after applying, and check against these:
--
--    tables 27 | public_functions 8 | private_helpers 3
--    extra_indexes 56 | triggers 20 | policies 94 | rls_enabled 27
--
--  public_functions is 5 trigger functions + 3 RPCs. extra_indexes excludes
--  the PK/UNIQUE indexes Postgres creates from the constraints in §2.
--
--  Note the LIVE project reports 9 public functions, not 8 — the extra one is
--  the dead get_vat_fy_stats described at the foot of this file.
-- ════════════════════════════════════════════════════════════════════════════

select
  (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
     where n.nspname='public' and c.relkind='r')                                  as tables,
  (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public')                                                    as public_functions,
  (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='private')                                                   as private_helpers,
  (select count(*) from pg_indexes where schemaname='public'
     and indexname not in (select conname from pg_constraint con
                           join pg_class c on c.oid=con.conrelid
                           join pg_namespace n on n.oid=c.relnamespace
                           where n.nspname='public'))                             as extra_indexes,
  (select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid
     join pg_namespace n on n.oid=c.relnamespace
     where not t.tgisinternal and n.nspname='public')                             as triggers,
  (select count(*) from pg_policies where schemaname='public')                    as policies,
  (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
     where n.nspname='public' and c.relkind='r' and c.relrowsecurity)             as rls_enabled;


-- ════════════════════════════════════════════════════════════════════════════
--  KNOWN DIVERGENCE FROM THE LIVE PROJECT (2026-08-18)
--
--  public.get_vat_fy_stats(text) exists on rennqzmwyhkdsizvlqwd and is NOT in
--  this file. It reads public.vat_filings, which was dropped 2026-08-10 with
--  the VAT Compliance module, so it is already broken there — calling it
--  errors. Nothing in js/ calls it. It is excluded here rather than carried
--  forward; a new instance should not inherit a dead function. Dropping it
--  from the live project is a separate one-line migration, not done here
--  because this file is not supposed to modify anything.
-- ════════════════════════════════════════════════════════════════════════════
