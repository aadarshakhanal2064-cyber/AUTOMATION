-- ════════════════════════════════════════════════════════════════════════════
--  00_bootstrap.sql — build the entire database from nothing
--  REGENERATED 2026-08-28 by reading the live schema of project
--  rennqzmwyhkdsizvlqwd (Tokyo), which is the authority. Regenerate rather
--  than hand-patch if the two ever disagree.
--
--  Supersedes the 2026-08-18 generation, which predated: the VAT Register
--  tables (vat_purchases/vat_returns/vat_collections + set_vat_serial),
--  provisional_statements, the whole multi-tenant layer as applied (org_id
--  columns + private.* helpers + org-scoped policies), Stage 3 invitations
--  (org_invitations + 3 RPCs), reset_identity_sequences, the 2026-08-21
--  initplan policy rewrite, saved_documents' extra module values, and the
--  2026-08-28 registrar columns (name_english, ocr_username, ocr_password).
--
--  First used to stand up the Mumbai project (ap-south-1) for the region
--  migration of 2026-08-28 — the Tokyo→Nepal RTT was measured at 2.1 s
--  average per REST request from the office while every CDN answered in
--  13–270 ms, so the database moved to the region next door.
--
--  USE IT FOR
--    · standing the app up on a NEW Supabase project
--    · disaster recovery — this plus a data backup (tools/dbRestore.mjs)
--      is a full restore
--
--  DO NOT run it against a live project. Statements are CREATE without
--  IF NOT EXISTS on purpose: a misfire stops instead of half-applying.
--
--  NOT COVERED (Supabase-managed, done in the dashboard or by the auth API):
--    · auth.users rows (migrated separately — see the 2026-08-28 migration
--      notes; password hashes copy intact via direct insert)
--    · Auth settings (signup enabled, email confirmations, SMTP)
--    · API exposed schemas (default public+graphql_public is correct;
--      private must stay unexposed)
-- ════════════════════════════════════════════════════════════════════════════

-- Function bodies reference tables created later in this file (and table
-- DEFAULTs reference the functions), so body validation must be deferred —
-- the same thing pg_dump emits.
set check_function_bodies = off;

-- ── Schemas & extensions ────────────────────────────────────────────────────
create schema if not exists private;
grant usage on schema private to authenticated;
-- service_role too: PostgREST's bulk-insert path (Prefer: missing=default,
-- used by tools/dbRestore.mjs) references the org_id columns' DEFAULT
-- expression private.current_org_id(), and without schema USAGE the whole
-- insert fails 42501 — found live during the 2026-08-28 Mumbai restore.
-- Grants nothing new in practice: service_role already bypasses RLS.
grant usage on schema private to service_role;
-- anon deliberately gets NO usage on private (matches production: anon
-- probes against private.* fail rather than return empty).

create extension if not exists pgcrypto  with schema extensions;
create extension if not exists "uuid-ossp" with schema extensions;

-- ── private.* helpers (the RLS backbone) ────────────────────────────────────
CREATE OR REPLACE FUNCTION private.jwt_email()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select lower(coalesce(auth.jwt() ->> 'email', ''));
$function$;

CREATE OR REPLACE FUNCTION private.current_org_id()
 RETURNS bigint
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select m.org_id
  from public.org_members m
  join public.organizations o on o.id = m.org_id
  where lower(m.email) = private.jwt_email()
    and m.status = 'active'
    and o.status = 'active'
  limit 1;
$function$;

CREATE OR REPLACE FUNCTION private.is_app_user()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (
    select 1 from public.org_members m
    join public.organizations o on o.id = m.org_id
    where lower(m.email) = private.jwt_email()
      and m.status = 'active' and o.status = 'active'
  );
$function$;

CREATE OR REPLACE FUNCTION private.is_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (
    select 1 from public.org_members m
    join public.organizations o on o.id = m.org_id
    where lower(m.email) = private.jwt_email()
      and m.role in ('owner','admin')
      and m.status = 'active' and o.status = 'active'
  );
$function$;

CREATE OR REPLACE FUNCTION private.guard_last_owner()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_org  bigint := coalesce(old.org_id, new.org_id);
  v_left integer;
begin
  if tg_op = 'DELETE'
     and not exists (select 1 from public.organizations o where o.id = v_org) then
    return old;
  end if;

  select count(*) into v_left
  from public.org_members m
  where m.org_id = v_org
    and m.role = 'owner'
    and m.status = 'active'
    and m.id <> old.id;

  if v_left = 0
     and (tg_op = 'DELETE'
          or new.role <> 'owner'
          or new.status <> 'active') then
    raise exception 'This is the organisation''s last active owner. Make someone else an owner first.';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$function$;

-- ── public.* functions ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  new.updated_at = now();
  return new;
end $function$;

CREATE OR REPLACE FUNCTION public.set_service_memo_number()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if new.memo_number is null then
    update public.service_memos
      set memo_number = coalesce(new.memo_prefix, 'SM') || '-' || lpad(new.id::text, 5, '0')
      where id = new.id;
  end if;
  return null;
end $function$;

CREATE OR REPLACE FUNCTION public.set_document_register_number()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if new.register_no is null then
    update public.document_register
      set register_no = 'FM-' || lpad(new.id::text, 5, '0')
      where id = new.id;
  end if;
  return null;
end $function$;

CREATE OR REPLACE FUNCTION public.set_vat_serial()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if new.apply_vat and new.vat_serial is null then
    select coalesce(max(vat_serial), 0) + 1 into new.vat_serial
      from public.service_memos
      where org_id = new.org_id and firm_key = new.firm_key;
  end if;
  return new;
end $function$;

CREATE OR REPLACE FUNCTION public.get_db_storage_usage()
 RETURNS TABLE(bytes_used bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select pg_database_size(current_database()) where private.is_app_user();
$function$;

CREATE OR REPLACE FUNCTION public.reset_identity_sequences()
 RETURNS TABLE(table_name text, was bigint, now_at bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  r   record;
  seq text;
  mx  bigint;
  cur bigint;
begin
  for r in
    select c.relname::text as tbl
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
    order by c.relname
  loop
    seq := pg_get_serial_sequence('public.' || quote_ident(r.tbl), 'id');
    continue when seq is null;

    execute format('select coalesce(max(id), 0) from public.%I', r.tbl) into mx;
    execute format('select last_value from %s', seq) into cur;

    if mx > 0 then
      perform setval(seq, greatest(mx, cur), true);
    end if;

    table_name := r.tbl; was := cur; now_at := greatest(mx, cur);
    return next;
  end loop;
end;
$function$;

CREATE OR REPLACE FUNCTION public.create_invitation(p_email text, p_role text DEFAULT 'staff'::text, p_days integer DEFAULT 14)
 RETURNS TABLE(invitation_id bigint, token text, expires_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_org   bigint;
  v_email text := lower(btrim(p_email));
  v_token text;
begin
  if not private.is_admin() then
    raise exception 'Only an admin or owner can invite people.';
  end if;

  v_org := private.current_org_id();
  if v_org is null then
    raise exception 'No active organisation for the current user.';
  end if;

  if v_email = '' or position('@' in v_email) = 0 then
    raise exception 'A valid email address is required.';
  end if;

  if p_role not in ('owner','admin','staff') then
    raise exception 'Unknown role: %', p_role;
  end if;

  if exists (select 1 from public.org_members m where m.email = v_email) then
    raise exception '% already belongs to an organisation.', v_email;
  end if;

  update public.org_invitations
     set revoked_at = now()
   where org_id = v_org and email = v_email
     and accepted_at is null and revoked_at is null;

  v_token := encode(extensions.gen_random_bytes(32), 'hex');

  return query
  insert into public.org_invitations (org_id, email, role, token_hash, expires_at, created_by)
  values (
    v_org, v_email, p_role,
    encode(sha256(v_token::bytea), 'hex'),
    now() + make_interval(days => greatest(1, least(p_days, 90))),
    private.jwt_email()
  )
  returning public.org_invitations.id, v_token, public.org_invitations.expires_at;
end;
$function$;

CREATE OR REPLACE FUNCTION public.accept_invitation(p_token text)
 RETURNS TABLE(org_id bigint, org_name text, role text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_email text := private.jwt_email();
  v_inv   public.org_invitations%rowtype;
begin
  if v_email is null or v_email = '' then
    raise exception 'You must be signed in to accept an invitation.';
  end if;

  select * into v_inv
  from public.org_invitations
  where token_hash = encode(sha256(btrim(p_token)::bytea), 'hex');

  if v_inv.id is null then
    raise exception 'This invitation link is not valid.';
  end if;
  if v_inv.revoked_at is not null then
    raise exception 'This invitation has been revoked.';
  end if;
  if v_inv.accepted_at is not null then
    raise exception 'This invitation has already been used.';
  end if;
  if v_inv.expires_at < now() then
    raise exception 'This invitation expired on %.', to_char(v_inv.expires_at, 'DD Mon YYYY');
  end if;
  if v_inv.email <> v_email then
    raise exception 'This invitation was issued to a different email address.';
  end if;
  if exists (select 1 from public.org_members m where m.email = v_email) then
    raise exception 'You already belong to an organisation.';
  end if;

  insert into public.org_members (org_id, email, role, status, invited_by)
  values (v_inv.org_id, v_email, v_inv.role, 'active', v_inv.created_by);

  update public.org_invitations
     set accepted_at = now(), accepted_by = v_email
   where id = v_inv.id;

  return query
  select o.id, o.name, v_inv.role
  from public.organizations o
  where o.id = v_inv.org_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.invitation_info(p_token text)
 RETURNS TABLE(email text, role text, org_name text, status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_inv public.org_invitations%rowtype;
begin
  select * into v_inv
  from public.org_invitations
  where token_hash = encode(sha256(btrim(p_token)::bytea), 'hex');

  if v_inv.id is null then
    return;
  end if;

  return query
  select
    v_inv.email,
    v_inv.role,
    o.name,
    case
      when v_inv.revoked_at  is not null then 'revoked'
      when v_inv.accepted_at is not null then 'accepted'
      when v_inv.expires_at   <  now()   then 'expired'
      else 'pending'
    end
  from public.organizations o
  where o.id = v_inv.org_id;
end;
$function$;

-- ── Function grants (mirror production exactly) ─────────────────────────────
-- private.* : EXECUTE for authenticated only — anon must fail, not fall open.
revoke execute on function private.jwt_email()      from public, anon;
revoke execute on function private.current_org_id() from public, anon;
revoke execute on function private.is_app_user()    from public, anon;
revoke execute on function private.is_admin()       from public, anon;
grant  execute on function private.jwt_email()      to authenticated, service_role;
grant  execute on function private.current_org_id() to authenticated, service_role;
grant  execute on function private.is_app_user()    to authenticated, service_role;
grant  execute on function private.is_admin()       to authenticated, service_role;

-- get_db_storage_usage / invitation RPCs: not anon-callable except
-- invitation_info (the invitee has no account yet — deliberate).
revoke execute on function public.get_db_storage_usage()        from public, anon;
grant  execute on function public.get_db_storage_usage()        to authenticated, service_role;
revoke execute on function public.create_invitation(text,text,integer) from public, anon;
grant  execute on function public.create_invitation(text,text,integer) to authenticated, service_role;
revoke execute on function public.accept_invitation(text)       from public, anon;
grant  execute on function public.accept_invitation(text)       to authenticated, service_role;
-- reset_identity_sequences: service_role ONLY (a restore tool, not app surface).
revoke execute on function public.reset_identity_sequences()    from public, anon, authenticated;
grant  execute on function public.reset_identity_sequences()    to service_role;

-- ── Tables (32) — column-exact from the live catalog ────────────────────────
-- The three pre-migration-era serial tables (app_users, clients, send_logs)
-- are created as identity columns here; identical behaviour, and
-- reset_identity_sequences() handles both forms.

create table public.organizations (
  id bigint generated by default as identity not null,
  name text not null,
  slug text not null,
  status text not null default 'active'::text,
  staff_names jsonb not null default '[]'::jsonb,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create table public.org_members (
  id bigint generated by default as identity not null,
  org_id bigint not null,
  email text not null,
  role text not null default 'staff'::text,
  status text not null default 'active'::text,
  invited_by text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create table public.org_firms (
  id bigint generated by default as identity not null,
  org_id bigint not null,
  firm_key text not null,
  name text not null,
  title text,
  address text,
  email text,
  phone text,
  reg_no text,
  m_no text,
  pan text,
  cop_no text,
  signatory_name text,
  signatory_title text,
  logo text,
  name_np text,
  auditor_name_np text,
  title_np text,
  memo_prefix text,
  is_typed boolean not null default false,
  for_final_account boolean not null default false,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create table public.org_invitations (
  id bigint generated by default as identity not null,
  org_id bigint not null,
  email text not null,
  role text not null default 'staff'::text,
  token_hash text not null,
  expires_at timestamp with time zone not null,
  accepted_at timestamp with time zone,
  accepted_by text,
  revoked_at timestamp with time zone,
  created_by text,
  created_at timestamp with time zone not null default now()
);

create table public.app_users (
  id bigint generated by default as identity not null,
  email text not null,
  role text not null default 'staff'::text,
  created_at timestamp with time zone default now()
);

create table public.clients (
  id bigint generated by default as identity not null,
  name text not null,
  email text,
  pan text,
  phone text,
  address text,
  created_at timestamp with time zone default now(),
  entity_type text,
  business_nature text,
  registration_number text,
  chairman_name text,
  shareholder_name text,
  authorized_capital text,
  issued_capital text,
  paid_up_capital text,
  vat_status text not null default 'not_registered'::text,
  district text,
  country text,
  it_return_type text,
  tax_type_d3 text,
  tax_registration_type text,
  org_id bigint not null default private.current_org_id()
);

create table public.registrar_companies (
  id bigint generated always as identity not null,
  org_id bigint not null default private.current_org_id(),
  name text not null,
  registration_number text,
  pan text,
  address text,
  country text,
  chairman_name text,
  shareholder_name text,
  authorized_capital text,
  issued_capital text,
  paid_up_capital text,
  notes text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  name_english text,
  ocr_username text,
  ocr_password text
);

create table public.registrar_shareholders (
  id bigint generated always as identity not null,
  org_id bigint not null default private.current_org_id(),
  company_id bigint not null,
  name text not null,
  sort_order integer not null default 0
);

create table public.bank_accounts (
  id bigint generated by default as identity not null,
  account_name text not null,
  bank_name text not null,
  account_number text,
  opening_balance numeric(16,2) not null default 0,
  opening_date text,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_by text,
  updated_by text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  firm_key text,
  org_id bigint not null default private.current_org_id()
);

create table public.bank_transactions (
  id bigint generated by default as identity not null,
  account_id bigint not null,
  txn_type text not null,
  txn_date text not null,
  particular text not null,
  amount numeric(16,2) not null,
  counterparty_name text,
  client_id bigint,
  counterparty_account_id bigint,
  transfer_group_id uuid,
  description text,
  fiscal_year text,
  created_by text,
  updated_by text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  org_id bigint not null default private.current_org_id()
);

create table public.audit_checklists (
  id bigint generated by default as identity not null,
  client_id bigint not null,
  client_name text not null,
  client_pan text,
  fiscal_year text not null,
  recorded_date date not null default CURRENT_DATE,
  items jsonb not null default '[]'::jsonb,
  remarks text,
  created_by text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  org_id bigint not null default private.current_org_id()
);

create table public.audit_report_finalization (
  id bigint generated by default as identity not null,
  client_id bigint not null,
  client_name text not null,
  client_pan text,
  fiscal_year text not null,
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
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  return_type text not null,
  it_return_type text,
  it_checked_by text,
  estimate_submission_no text,
  tax_clearance_remarks text,
  recorded_date date not null default CURRENT_DATE,
  org_id bigint not null default private.current_org_id()
);

create table public.autobooks_books (
  id bigint generated by default as identity not null,
  client_id bigint,
  client_name text not null,
  pan text,
  fiscal_year text not null,
  reg_type text not null default 'vat'::text,
  merge_map jsonb not null default '{}'::jsonb,
  overrides jsonb not null default '{}'::jsonb,
  correction_log jsonb not null default '[]'::jsonb,
  vat_return jsonb not null default '{}'::jsonb,
  import_notes jsonb not null default '[]'::jsonb,
  sections jsonb not null default '{}'::jsonb,
  created_by text,
  updated_by text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  book_key text generated always as (((COALESCE(('c:'::text || (client_id)::text), ('n:'::text || btrim(lower(client_name)))) || '|'::text) || fiscal_year)) stored,
  org_id bigint not null default private.current_org_id()
);

create table public.autobooks_entries (
  id bigint generated by default as identity not null,
  book_id bigint not null,
  section text not null,
  kind text not null default 'regular'::text,
  bill_type text,
  bs_date text,
  fiscal_month smallint,
  bill_no text,
  party_name text not null default ''::text,
  party_key text not null default ''::text,
  pan text,
  tax_free numeric not null default 0,
  taxable numeric not null default 0,
  vat numeric not null default 0,
  taxable_import numeric not null default 0,
  import_vat numeric not null default 0,
  capital numeric not null default 0,
  capital_vat numeric not null default 0,
  note text,
  source text not null default 'import'::text,
  excel_row integer,
  sort_order integer not null default 0,
  created_at timestamp with time zone not null default now(),
  org_id bigint not null default private.current_org_id()
);

create table public.autobooks_parties (
  id bigint generated by default as identity not null,
  book_id bigint not null,
  section text not null,
  party_key text not null,
  party_name text not null,
  pan text,
  opening_balance numeric,
  confirmed_taxable numeric,
  confirmed_closing numeric,
  ann13_category text,
  remarks text,
  updated_by text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  org_id bigint not null default private.current_org_id()
);

create table public.autobooks_adjustments (
  id bigint generated by default as identity not null,
  book_id bigint not null,
  statement text not null,
  direction text not null,
  description text not null default ''::text,
  amount numeric not null default 0,
  sort_order integer not null default 0,
  created_at timestamp with time zone not null default now(),
  org_id bigint not null default private.current_org_id()
);

create table public.depreciation_schedules (
  id bigint generated by default as identity not null,
  client_id bigint not null,
  scheme text not null default 'normal'::text,
  fiscal_year text not null,
  company_name text,
  pan text,
  pools jsonb not null default '[]'::jsonb,
  addition_details jsonb not null default '[]'::jsonb,
  created_by text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  org_id bigint not null default private.current_org_id()
);

create table public.document_register (
  id bigint generated by default as identity not null,
  register_no text,
  client_id bigint,
  client_name text not null,
  client_pan text,
  date_received date not null default CURRENT_DATE,
  doc_types jsonb not null default '[]'::jsonb,
  doc_other text,
  brought_by_name text,
  brought_by_phone text,
  remarks text,
  status text not null default 'pending'::text,
  created_by text,
  updated_by text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  fiscal_year text,
  mode_received text not null default 'physical'::text,
  email_received text,
  outtakes jsonb not null default '[]'::jsonb,
  org_id bigint not null default private.current_org_id()
);

create table public.financial_statements (
  id bigint generated by default as identity not null,
  client_id bigint,
  company_name text not null,
  pan text,
  fiscal_year text not null,
  basis text not null default 'provisional'::text,
  return_type text,
  entity_type text,
  inputs jsonb not null default '{}'::jsonb,
  computed jsonb not null default '{}'::jsonb,
  created_by text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  org_id bigint not null default private.current_org_id()
);

create table public.party_opening_balances (
  id bigint generated by default as identity not null,
  client_id bigint not null,
  firm_key text not null,
  fiscal_year text not null,
  as_on_date text,
  opening_amount numeric(16,2) not null default 0,
  client_name text,
  created_by text,
  updated_by text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  org_id bigint not null default private.current_org_id()
);

create table public.projection_reports (
  id bigint generated by default as identity not null,
  client_id bigint,
  company_name text not null,
  pan text,
  fiscal_year_base text not null,
  years integer not null default 3,
  inputs jsonb not null default '{}'::jsonb,
  computed jsonb not null default '{}'::jsonb,
  created_by text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  performed_by text,
  org_id bigint not null default private.current_org_id()
);

create table public.provisional_statements (
  id bigint generated always as identity not null,
  org_id bigint not null default private.current_org_id(),
  client_id bigint,
  company_name text not null,
  pan text,
  fiscal_year text not null,
  inputs jsonb not null,
  created_by text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create table public.saved_documents (
  id bigint generated by default as identity not null,
  module text not null,
  client_id bigint,
  client_name text not null,
  pan text,
  fiscal_year text,
  doc_type text,
  title text not null,
  state jsonb not null default '{}'::jsonb,
  doc_html text,
  created_by text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  org_id bigint not null default private.current_org_id()
);

create table public.send_logs (
  id bigint generated by default as identity not null,
  sent_by text,
  client_name text,
  client_email text,
  doc_type text,
  fiscal_year text,
  file_name text,
  drive_file_id text,
  status text,
  error_msg text,
  sent_at timestamp with time zone default now(),
  org_id bigint not null default private.current_org_id()
);

create table public.service_memos (
  id bigint generated by default as identity not null,
  memo_number text,
  memo_prefix text not null,
  firm_key text not null,
  memo_date date not null default CURRENT_DATE,
  client_id bigint,
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
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  firm_other text,
  org_id bigint not null default private.current_org_id(),
  vat_serial bigint
);

create table public.service_memo_fee_skips (
  id bigint generated by default as identity not null,
  client_id bigint,
  client_name text not null,
  fy_start_year integer not null,
  kind text not null,
  dismissed_by text,
  created_at timestamp with time zone not null default now(),
  org_id bigint not null default private.current_org_id()
);

create table public.vat_purchases (
  id bigint generated always as identity not null,
  org_id bigint not null default private.current_org_id(),
  firm_key text not null,
  fiscal_year text not null,
  bill_date date not null,
  bill_no text,
  party_name text not null,
  party_pan text,
  tax_free numeric not null default 0,
  taxable numeric not null default 0,
  vat numeric not null default 0,
  nature text not null default 'expenses'::text,
  head text,
  remarks text,
  created_by text,
  updated_by text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create table public.vat_returns (
  id bigint generated always as identity not null,
  org_id bigint not null default private.current_org_id(),
  firm_key text not null,
  fiscal_year text not null,
  period text not null,
  sales_adj_amount numeric not null default 0,
  sales_adj_vat numeric not null default 0,
  sales_adj_note text,
  purchase_adj_amount numeric not null default 0,
  purchase_adj_vat numeric not null default 0,
  purchase_adj_note text,
  opening_credit numeric not null default 0,
  remarks text,
  created_by text,
  updated_by text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create table public.vat_collections (
  id bigint generated always as identity not null,
  org_id bigint not null default private.current_org_id(),
  firm_key text not null,
  fiscal_year text not null,
  service_memo_id bigint,
  client_id bigint,
  client_name text not null,
  client_pan text,
  nature_of_work text,
  amount numeric not null default 0,
  payment_date date not null,
  voucher_name text,
  bank_name text,
  remarks text,
  created_by text,
  updated_by text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create table public.work_done (
  id bigint generated by default as identity not null,
  client_id bigint not null,
  client_name text not null,
  client_pan text,
  fiscal_year text not null,
  recorded_date date not null default CURRENT_DATE,
  items jsonb not null default '[]'::jsonb,
  remarks text,
  created_by text,
  updated_by text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  org_id bigint not null default private.current_org_id()
);

create table public.work_todos (
  id bigint generated by default as identity not null,
  task_date date not null default CURRENT_DATE,
  client_id bigint,
  client_name text,
  client_pan text,
  nature_of_work text not null,
  remarks text,
  status text not null default 'not_started'::text,
  priority text not null default 'normal'::text,
  assigned_to text,
  due_date date,
  completed_at timestamp with time zone,
  created_by text,
  updated_by text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  org_id bigint not null default private.current_org_id()
);

create table public.audit_log (
  id bigint generated by default as identity not null,
  created_at timestamp with time zone not null default now(),
  event_type text not null,
  module text,
  status text not null default 'success'::text,
  user_email text,
  client_name text,
  record_ref bigint,
  detail jsonb not null default '{}'::jsonb,
  org_id bigint not null default private.current_org_id()
);

-- ── Primary keys ────────────────────────────────────────────────────────────
alter table app_users add constraint app_users_pkey PRIMARY KEY (id);
alter table audit_checklists add constraint audit_checklists_pkey PRIMARY KEY (id);
alter table audit_log add constraint audit_log_pkey PRIMARY KEY (id);
alter table audit_report_finalization add constraint audit_report_finalization_pkey PRIMARY KEY (id);
alter table autobooks_adjustments add constraint autobooks_adjustments_pkey PRIMARY KEY (id);
alter table autobooks_books add constraint autobooks_books_pkey PRIMARY KEY (id);
alter table autobooks_entries add constraint autobooks_entries_pkey PRIMARY KEY (id);
alter table autobooks_parties add constraint autobooks_parties_pkey PRIMARY KEY (id);
alter table bank_accounts add constraint bank_accounts_pkey PRIMARY KEY (id);
alter table bank_transactions add constraint bank_transactions_pkey PRIMARY KEY (id);
alter table clients add constraint clients_pkey PRIMARY KEY (id);
alter table depreciation_schedules add constraint depreciation_schedules_pkey PRIMARY KEY (id);
alter table document_register add constraint document_register_pkey PRIMARY KEY (id);
alter table financial_statements add constraint financial_statements_pkey PRIMARY KEY (id);
alter table org_firms add constraint org_firms_pkey PRIMARY KEY (id);
alter table org_invitations add constraint org_invitations_pkey PRIMARY KEY (id);
alter table org_members add constraint org_members_pkey PRIMARY KEY (id);
alter table organizations add constraint organizations_pkey PRIMARY KEY (id);
alter table party_opening_balances add constraint party_opening_balances_pkey PRIMARY KEY (id);
alter table projection_reports add constraint projection_reports_pkey PRIMARY KEY (id);
alter table provisional_statements add constraint provisional_statements_pkey PRIMARY KEY (id);
alter table registrar_companies add constraint registrar_companies_pkey PRIMARY KEY (id);
alter table registrar_shareholders add constraint registrar_shareholders_pkey PRIMARY KEY (id);
alter table saved_documents add constraint saved_documents_pkey PRIMARY KEY (id);
alter table send_logs add constraint send_logs_pkey PRIMARY KEY (id);
alter table service_memo_fee_skips add constraint service_memo_fee_skips_pkey PRIMARY KEY (id);
alter table service_memos add constraint service_memos_pkey PRIMARY KEY (id);
alter table vat_collections add constraint vat_collections_pkey PRIMARY KEY (id);
alter table vat_purchases add constraint vat_purchases_pkey PRIMARY KEY (id);
alter table vat_returns add constraint vat_returns_pkey PRIMARY KEY (id);
alter table work_done add constraint work_done_pkey PRIMARY KEY (id);
alter table work_todos add constraint work_todos_pkey PRIMARY KEY (id);

-- ── Unique constraints ──────────────────────────────────────────────────────
alter table app_users add constraint app_users_email_key UNIQUE (email);
alter table audit_checklists add constraint audit_checklists_client_fy_uniq UNIQUE (client_id, fiscal_year);
alter table audit_report_finalization add constraint audit_report_finalization_client_fy_type_uniq UNIQUE (client_id, fiscal_year, return_type);
alter table autobooks_parties add constraint autobooks_parties_book_id_section_party_key_key UNIQUE (book_id, section, party_key);
alter table depreciation_schedules add constraint depreciation_schedules_client_id_scheme_fiscal_year_key UNIQUE (client_id, scheme, fiscal_year);
alter table org_firms add constraint org_firms_org_key_uniq UNIQUE (org_id, firm_key);
alter table org_invitations add constraint org_invitations_token_hash_key UNIQUE (token_hash);
alter table org_members add constraint org_members_email_key UNIQUE (email);
alter table organizations add constraint organizations_slug_key UNIQUE (slug);
alter table party_opening_balances add constraint party_opening_balances_client_id_firm_key_fiscal_year_key UNIQUE (client_id, firm_key, fiscal_year);
alter table vat_returns add constraint vat_returns_scope_uq UNIQUE (org_id, firm_key, fiscal_year, period);
alter table work_done add constraint work_done_client_fy_uniq UNIQUE (client_id, fiscal_year);

-- ── Check constraints ───────────────────────────────────────────────────────
alter table audit_report_finalization add constraint arf_estimate_submission_no_check CHECK (((estimate_submission_no IS NULL) OR (estimate_submission_no ~ '^[0-9]{12}$'::text)));
alter table audit_report_finalization add constraint arf_it_return_type_check CHECK (((it_return_type IS NULL) OR (it_return_type = ANY (ARRAY['D-2'::text, 'D-3'::text]))));
alter table audit_report_finalization add constraint arf_it_submission_no_check CHECK (((it_submission_no IS NULL) OR (it_submission_no ~ '^[0-9]{12}$'::text)));
alter table audit_report_finalization add constraint arf_return_type_check CHECK ((return_type = ANY (ARRAY['it_return'::text, 'estimate_return'::text, 'tax_clearance'::text])));
alter table autobooks_adjustments add constraint autobooks_adjustments_direction_check CHECK ((direction = ANY (ARRAY['add'::text, 'less'::text])));
alter table autobooks_adjustments add constraint autobooks_adjustments_statement_check CHECK ((statement = ANY (ARRAY['sales'::text, 'purchase'::text, 'vat'::text])));
alter table autobooks_books add constraint autobooks_books_reg_type_check CHECK ((reg_type = ANY (ARRAY['vat'::text, 'pan'::text])));
alter table autobooks_entries add constraint autobooks_entries_bill_type_check CHECK ((bill_type = ANY (ARRAY['sales'::text, 'sales_return'::text, 'purchase'::text, 'purchase_return'::text])));
alter table autobooks_entries add constraint autobooks_entries_fiscal_month_check CHECK (((fiscal_month >= 1) AND (fiscal_month <= 12)));
alter table autobooks_entries add constraint autobooks_entries_kind_check CHECK ((kind = ANY (ARRAY['regular'::text, 'omitted'::text])));
alter table autobooks_entries add constraint autobooks_entries_section_check CHECK ((section = ANY (ARRAY['sales'::text, 'purchase'::text])));
alter table autobooks_entries add constraint autobooks_entries_source_check CHECK ((source = ANY (ARRAY['import'::text, 'manual'::text])));
alter table autobooks_parties add constraint autobooks_parties_section_check CHECK ((section = ANY (ARRAY['sales'::text, 'purchase'::text])));
alter table bank_transactions add constraint bank_transactions_amount_check CHECK ((amount > (0)::numeric));
alter table bank_transactions add constraint bank_transactions_particular_check CHECK ((particular = ANY (ARRAY['fee_receipt'::text, 'for_tax'::text, 'expenses'::text, 'tax_payment'::text, 'sapati'::text, 'inter_bank_transfer'::text])));
alter table bank_transactions add constraint bank_transactions_txn_type_check CHECK ((txn_type = ANY (ARRAY['receipt'::text, 'payment'::text])));
alter table clients add constraint clients_vat_status_check CHECK ((vat_status = ANY (ARRAY['active'::text, 'inactive'::text, 'not_registered'::text])));
alter table depreciation_schedules add constraint depreciation_schedules_scheme_check CHECK ((scheme = ANY (ARRAY['normal'::text, 'special'::text, 'slm'::text])));
alter table document_register add constraint document_register_mode_received_check CHECK ((mode_received = ANY (ARRAY['online'::text, 'physical'::text])));
alter table document_register add constraint document_register_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'partial'::text, 'returned'::text])));
alter table financial_statements add constraint financial_statements_basis_check CHECK ((basis = ANY (ARRAY['provisional'::text, 'audited'::text])));
alter table org_invitations add constraint org_invitations_email_lower CHECK ((email = lower(email)));
alter table org_invitations add constraint org_invitations_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'admin'::text, 'staff'::text])));
alter table org_members add constraint org_members_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'admin'::text, 'staff'::text])));
alter table org_members add constraint org_members_status_check CHECK ((status = ANY (ARRAY['active'::text, 'inactive'::text])));
alter table organizations add constraint organizations_status_check CHECK ((status = ANY (ARRAY['active'::text, 'suspended'::text])));
alter table projection_reports add constraint projection_reports_years_check CHECK (((years >= 1) AND (years <= 10)));
alter table saved_documents add constraint saved_documents_module_check CHECK ((module = ANY (ARRAY['report'::text, 'notesToAccounts'::text, 'auditEngagement'::text, 'bmAgmMinutes'::text, 'companySecretary'::text, 'auditorChange'::text, 'companyRegistration'::text])));
alter table service_memo_fee_skips add constraint service_memo_fee_skips_kind_check CHECK ((kind = ANY (ARRAY['audit'::text, 'projection'::text])));
alter table vat_purchases add constraint vat_purchases_nature_chk CHECK ((nature = ANY (ARRAY['expenses'::text, 'assets'::text])));
alter table vat_returns add constraint vat_returns_period_chk CHECK ((period = ANY (ARRAY['T1'::text, 'T2'::text, 'T3'::text])));
alter table work_todos add constraint work_todos_completed_chk CHECK (((status = 'done'::text) = (completed_at IS NOT NULL)));
alter table work_todos add constraint work_todos_priority_chk CHECK ((priority = ANY (ARRAY['low'::text, 'normal'::text, 'high'::text])));
alter table work_todos add constraint work_todos_status_chk CHECK ((status = ANY (ARRAY['not_started'::text, 'in_progress'::text, 'done'::text])));

-- ── Foreign keys ────────────────────────────────────────────────────────────
alter table audit_checklists add constraint audit_checklists_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE RESTRICT;
alter table audit_checklists add constraint audit_checklists_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE RESTRICT;
alter table audit_log add constraint audit_log_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE RESTRICT;
alter table audit_report_finalization add constraint audit_report_finalization_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE RESTRICT;
alter table audit_report_finalization add constraint audit_report_finalization_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE RESTRICT;
alter table autobooks_adjustments add constraint autobooks_adjustments_book_id_fkey FOREIGN KEY (book_id) REFERENCES autobooks_books(id) ON DELETE CASCADE;
alter table autobooks_adjustments add constraint autobooks_adjustments_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE RESTRICT;
alter table autobooks_books add constraint autobooks_books_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL;
alter table autobooks_books add constraint autobooks_books_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE RESTRICT;
alter table autobooks_entries add constraint autobooks_entries_book_id_fkey FOREIGN KEY (book_id) REFERENCES autobooks_books(id) ON DELETE CASCADE;
alter table autobooks_entries add constraint autobooks_entries_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE RESTRICT;
alter table autobooks_parties add constraint autobooks_parties_book_id_fkey FOREIGN KEY (book_id) REFERENCES autobooks_books(id) ON DELETE CASCADE;
alter table autobooks_parties add constraint autobooks_parties_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE RESTRICT;
alter table bank_accounts add constraint bank_accounts_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE RESTRICT;
alter table bank_transactions add constraint bank_transactions_account_id_fkey FOREIGN KEY (account_id) REFERENCES bank_accounts(id) ON DELETE RESTRICT;
alter table bank_transactions add constraint bank_transactions_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL;
alter table bank_transactions add constraint bank_transactions_counterparty_account_id_fkey FOREIGN KEY (counterparty_account_id) REFERENCES bank_accounts(id) ON DELETE SET NULL;
alter table bank_transactions add constraint bank_transactions_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE RESTRICT;
alter table clients add constraint clients_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE RESTRICT;
alter table depreciation_schedules add constraint depreciation_schedules_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;
alter table depreciation_schedules add constraint depreciation_schedules_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE RESTRICT;
alter table document_register add constraint document_register_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL;
alter table document_register add constraint document_register_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE RESTRICT;
alter table financial_statements add constraint financial_statements_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL;
alter table financial_statements add constraint financial_statements_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE RESTRICT;
alter table org_firms add constraint org_firms_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
alter table org_invitations add constraint org_invitations_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
alter table org_members add constraint org_members_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
alter table party_opening_balances add constraint party_opening_balances_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;
alter table party_opening_balances add constraint party_opening_balances_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE RESTRICT;
alter table projection_reports add constraint projection_reports_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL;
alter table projection_reports add constraint projection_reports_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE RESTRICT;
alter table provisional_statements add constraint provisional_statements_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL;
alter table provisional_statements add constraint provisional_statements_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
alter table registrar_companies add constraint registrar_companies_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE RESTRICT;
alter table registrar_shareholders add constraint registrar_shareholders_company_id_fkey FOREIGN KEY (company_id) REFERENCES registrar_companies(id) ON DELETE CASCADE;
alter table registrar_shareholders add constraint registrar_shareholders_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE RESTRICT;
alter table saved_documents add constraint saved_documents_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL;
alter table saved_documents add constraint saved_documents_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE RESTRICT;
alter table send_logs add constraint send_logs_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE RESTRICT;
alter table service_memo_fee_skips add constraint service_memo_fee_skips_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;
alter table service_memo_fee_skips add constraint service_memo_fee_skips_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE RESTRICT;
alter table service_memos add constraint service_memos_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL;
alter table service_memos add constraint service_memos_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE RESTRICT;
alter table vat_collections add constraint vat_collections_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL;
alter table vat_collections add constraint vat_collections_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
alter table vat_collections add constraint vat_collections_service_memo_id_fkey FOREIGN KEY (service_memo_id) REFERENCES service_memos(id) ON DELETE SET NULL;
alter table vat_purchases add constraint vat_purchases_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
alter table vat_returns add constraint vat_returns_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
alter table work_done add constraint work_done_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE RESTRICT;
alter table work_done add constraint work_done_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE RESTRICT;
alter table work_todos add constraint work_todos_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL;
alter table work_todos add constraint work_todos_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE RESTRICT;

-- ── Indexes (non-constraint) ────────────────────────────────────────────────
CREATE INDEX achk_client_idx ON public.audit_checklists USING btree (client_id);
CREATE INDEX achk_fiscal_year_idx ON public.audit_checklists USING btree (fiscal_year);
CREATE INDEX achk_recorded_date_idx ON public.audit_checklists USING btree (recorded_date DESC);
CREATE INDEX arf_auditor_idx ON public.audit_report_finalization USING btree (auditor);
CREATE INDEX arf_client_idx ON public.audit_report_finalization USING btree (client_id);
CREATE INDEX arf_fiscal_year_idx ON public.audit_report_finalization USING btree (fiscal_year);
CREATE INDEX arf_recorded_date_idx ON public.audit_report_finalization USING btree (recorded_date DESC);
CREATE INDEX arf_return_type_idx ON public.audit_report_finalization USING btree (return_type);
CREATE INDEX audit_checklists_org_idx ON public.audit_checklists USING btree (org_id);
CREATE INDEX audit_log_created_idx ON public.audit_log USING btree (created_at DESC);
CREATE INDEX audit_log_event_created_idx ON public.audit_log USING btree (event_type, created_at DESC);
CREATE INDEX audit_log_org_idx ON public.audit_log USING btree (org_id);
CREATE INDEX audit_log_record_ref_idx ON public.audit_log USING btree (record_ref) WHERE (record_ref IS NOT NULL);
CREATE INDEX audit_report_finalization_org_idx ON public.audit_report_finalization USING btree (org_id);
CREATE INDEX autobooks_adjustments_book_idx ON public.autobooks_adjustments USING btree (book_id, statement, sort_order);
CREATE INDEX autobooks_adjustments_org_idx ON public.autobooks_adjustments USING btree (org_id);
CREATE INDEX autobooks_books_client_idx ON public.autobooks_books USING btree (client_id, fiscal_year);
CREATE UNIQUE INDEX autobooks_books_key_uniq ON public.autobooks_books USING btree (org_id, book_key);
CREATE INDEX autobooks_books_org_idx ON public.autobooks_books USING btree (org_id);
CREATE INDEX autobooks_entries_book_idx ON public.autobooks_entries USING btree (book_id, section, kind, fiscal_month, sort_order);
CREATE INDEX autobooks_entries_org_idx ON public.autobooks_entries USING btree (org_id);
CREATE INDEX autobooks_entries_party_idx ON public.autobooks_entries USING btree (book_id, section, party_key);
CREATE INDEX autobooks_parties_org_idx ON public.autobooks_parties USING btree (org_id);
CREATE INDEX bank_accounts_active_idx ON public.bank_accounts USING btree (is_active);
CREATE INDEX bank_accounts_firm_idx ON public.bank_accounts USING btree (firm_key);
CREATE INDEX bank_accounts_org_idx ON public.bank_accounts USING btree (org_id);
CREATE INDEX bank_accounts_sort_idx ON public.bank_accounts USING btree (sort_order);
CREATE INDEX bank_transactions_account_idx ON public.bank_transactions USING btree (account_id);
CREATE INDEX bank_transactions_client_idx ON public.bank_transactions USING btree (client_id);
CREATE INDEX bank_transactions_counterparty_idx ON public.bank_transactions USING btree (counterparty_account_id);
CREATE INDEX bank_transactions_date_idx ON public.bank_transactions USING btree (txn_date);
CREATE INDEX bank_transactions_fy_idx ON public.bank_transactions USING btree (fiscal_year);
CREATE INDEX bank_transactions_org_idx ON public.bank_transactions USING btree (org_id);
CREATE INDEX bank_transactions_transfer_idx ON public.bank_transactions USING btree (transfer_group_id);
CREATE INDEX bank_transactions_type_idx ON public.bank_transactions USING btree (txn_type);
CREATE INDEX clients_org_idx ON public.clients USING btree (org_id);
CREATE INDEX depreciation_schedules_client_scheme_idx ON public.depreciation_schedules USING btree (client_id, scheme, fiscal_year);
CREATE INDEX depreciation_schedules_org_idx ON public.depreciation_schedules USING btree (org_id);
CREATE INDEX document_register_client_idx ON public.document_register USING btree (client_id);
CREATE INDEX document_register_created_idx ON public.document_register USING btree (created_at DESC);
CREATE INDEX document_register_org_idx ON public.document_register USING btree (org_id);
CREATE INDEX document_register_status_idx ON public.document_register USING btree (status);
CREATE UNIQUE INDEX financial_statements_client_fy_basis_idx ON public.financial_statements USING btree (client_id, fiscal_year, basis) WHERE (client_id IS NOT NULL);
CREATE INDEX financial_statements_created_idx ON public.financial_statements USING btree (created_at DESC);
CREATE INDEX financial_statements_fy_idx ON public.financial_statements USING btree (fiscal_year);
CREATE INDEX financial_statements_org_idx ON public.financial_statements USING btree (org_id);
CREATE INDEX org_firms_org_idx ON public.org_firms USING btree (org_id, sort_order);
CREATE INDEX org_invitations_email_idx ON public.org_invitations USING btree (email);
CREATE INDEX org_invitations_org_idx ON public.org_invitations USING btree (org_id);
CREATE INDEX org_members_org_idx ON public.org_members USING btree (org_id);
CREATE INDEX party_opening_balances_client_idx ON public.party_opening_balances USING btree (client_id);
CREATE INDEX party_opening_balances_firm_idx ON public.party_opening_balances USING btree (firm_key);
CREATE INDEX party_opening_balances_fy_idx ON public.party_opening_balances USING btree (fiscal_year);
CREATE INDEX party_opening_balances_org_idx ON public.party_opening_balances USING btree (org_id);
CREATE INDEX projection_reports_client_idx ON public.projection_reports USING btree (client_id);
CREATE INDEX projection_reports_created_idx ON public.projection_reports USING btree (created_at DESC);
CREATE INDEX projection_reports_fy_idx ON public.projection_reports USING btree (fiscal_year_base);
CREATE INDEX projection_reports_org_idx ON public.projection_reports USING btree (org_id);
CREATE INDEX provisional_statements_client_idx ON public.provisional_statements USING btree (org_id, company_name, fiscal_year);
CREATE INDEX provisional_statements_org_idx ON public.provisional_statements USING btree (org_id);
CREATE INDEX registrar_companies_name_idx ON public.registrar_companies USING btree (org_id, name);
CREATE INDEX registrar_companies_org_idx ON public.registrar_companies USING btree (org_id);
CREATE INDEX registrar_shareholders_company_idx ON public.registrar_shareholders USING btree (company_id, sort_order);
CREATE INDEX registrar_shareholders_org_idx ON public.registrar_shareholders USING btree (org_id);
CREATE INDEX saved_documents_client_idx ON public.saved_documents USING btree (client_id);
CREATE INDEX saved_documents_module_idx ON public.saved_documents USING btree (module, created_at DESC);
CREATE INDEX saved_documents_org_idx ON public.saved_documents USING btree (org_id);
CREATE INDEX send_logs_org_idx ON public.send_logs USING btree (org_id);
CREATE INDEX service_memo_fee_skips_client_idx ON public.service_memo_fee_skips USING btree (client_id);
CREATE INDEX service_memo_fee_skips_lookup_idx ON public.service_memo_fee_skips USING btree (kind, fy_start_year, client_id);
CREATE INDEX service_memo_fee_skips_org_idx ON public.service_memo_fee_skips USING btree (org_id);
CREATE INDEX service_memos_client_idx ON public.service_memos USING btree (client_id);
CREATE INDEX service_memos_created_idx ON public.service_memos USING btree (created_at DESC);
CREATE INDEX service_memos_firm_idx ON public.service_memos USING btree (firm_key);
CREATE INDEX service_memos_org_idx ON public.service_memos USING btree (org_id);
CREATE UNIQUE INDEX service_memos_vat_serial_uidx ON public.service_memos USING btree (org_id, firm_key, vat_serial) WHERE (vat_serial IS NOT NULL);
CREATE INDEX vat_collections_memo_idx ON public.vat_collections USING btree (org_id, service_memo_id);
CREATE INDEX vat_collections_scope_idx ON public.vat_collections USING btree (org_id, firm_key, fiscal_year, payment_date);
CREATE INDEX vat_purchases_party_idx ON public.vat_purchases USING btree (org_id, party_pan);
CREATE INDEX vat_purchases_scope_idx ON public.vat_purchases USING btree (org_id, firm_key, fiscal_year, bill_date);
CREATE INDEX wd_client_idx ON public.work_done USING btree (client_id);
CREATE INDEX wd_fiscal_year_idx ON public.work_done USING btree (fiscal_year);
CREATE INDEX wd_recorded_date_idx ON public.work_done USING btree (recorded_date DESC);
CREATE INDEX work_done_org_idx ON public.work_done USING btree (org_id);
CREATE INDEX work_todos_org_idx ON public.work_todos USING btree (org_id);
CREATE INDEX wt_assigned_to_idx ON public.work_todos USING btree (assigned_to);
CREATE INDEX wt_client_idx ON public.work_todos USING btree (client_id);
CREATE INDEX wt_open_due_idx ON public.work_todos USING btree (status, due_date) WHERE (status <> 'done'::text);
CREATE INDEX wt_task_date_idx ON public.work_todos USING btree (task_date DESC);

-- ── Triggers ────────────────────────────────────────────────────────────────
CREATE TRIGGER autobooks_books_set_updated_at BEFORE UPDATE ON public.autobooks_books FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER autobooks_parties_set_updated_at BEFORE UPDATE ON public.autobooks_parties FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER guard_last_owner_delete BEFORE DELETE ON public.org_members FOR EACH ROW WHEN (((old.role = 'owner'::text) AND (old.status = 'active'::text))) EXECUTE FUNCTION private.guard_last_owner();
CREATE TRIGGER guard_last_owner_update BEFORE UPDATE ON public.org_members FOR EACH ROW WHEN (((old.role = 'owner'::text) AND (old.status = 'active'::text))) EXECUTE FUNCTION private.guard_last_owner();
CREATE TRIGGER set_achk_updated_at BEFORE UPDATE ON public.audit_checklists FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER set_arf_updated_at BEFORE UPDATE ON public.audit_report_finalization FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER set_bank_accounts_updated_at BEFORE UPDATE ON public.bank_accounts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER set_bank_transactions_updated_at BEFORE UPDATE ON public.bank_transactions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER set_depreciation_schedules_updated_at BEFORE UPDATE ON public.depreciation_schedules FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER set_document_register_number AFTER INSERT ON public.document_register FOR EACH ROW EXECUTE FUNCTION set_document_register_number();
CREATE TRIGGER set_document_register_updated_at BEFORE UPDATE ON public.document_register FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER set_financial_statements_updated_at BEFORE UPDATE ON public.financial_statements FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER set_org_firms_updated_at BEFORE UPDATE ON public.org_firms FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER set_org_members_updated_at BEFORE UPDATE ON public.org_members FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER set_organizations_updated_at BEFORE UPDATE ON public.organizations FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER set_party_opening_balances_updated_at BEFORE UPDATE ON public.party_opening_balances FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER set_projection_reports_updated_at BEFORE UPDATE ON public.projection_reports FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER set_provisional_statements_updated_at BEFORE UPDATE ON public.provisional_statements FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER set_registrar_companies_updated_at BEFORE UPDATE ON public.registrar_companies FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER set_saved_documents_updated_at BEFORE UPDATE ON public.saved_documents FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER set_service_memo_number AFTER INSERT ON public.service_memos FOR EACH ROW EXECUTE FUNCTION set_service_memo_number();
CREATE TRIGGER set_service_memos_updated_at BEFORE UPDATE ON public.service_memos FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER set_vat_collections_updated_at BEFORE UPDATE ON public.vat_collections FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER set_vat_purchases_updated_at BEFORE UPDATE ON public.vat_purchases FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER set_vat_returns_updated_at BEFORE UPDATE ON public.vat_returns FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER set_vat_serial BEFORE INSERT OR UPDATE ON public.service_memos FOR EACH ROW WHEN ((new.apply_vat AND (new.vat_serial IS NULL))) EXECUTE FUNCTION set_vat_serial();
CREATE TRIGGER set_wd_updated_at BEFORE UPDATE ON public.work_done FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER set_wt_updated_at BEFORE UPDATE ON public.work_todos FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── RLS: enable on every table ──────────────────────────────────────────────
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
alter table public.clients                   enable row level security;
alter table public.depreciation_schedules    enable row level security;
alter table public.document_register         enable row level security;
alter table public.financial_statements      enable row level security;
alter table public.org_firms                 enable row level security;
alter table public.org_invitations           enable row level security;
alter table public.org_members               enable row level security;
alter table public.organizations             enable row level security;
alter table public.party_opening_balances    enable row level security;
alter table public.projection_reports        enable row level security;
alter table public.provisional_statements    enable row level security;
alter table public.registrar_companies       enable row level security;
alter table public.registrar_shareholders    enable row level security;
alter table public.saved_documents           enable row level security;
alter table public.send_logs                 enable row level security;
alter table public.service_memo_fee_skips    enable row level security;
alter table public.service_memos             enable row level security;
alter table public.vat_collections           enable row level security;
alter table public.vat_purchases             enable row level security;
alter table public.vat_returns               enable row level security;
alter table public.work_done                 enable row level security;
alter table public.work_todos                enable row level security;

-- ── RLS policies (115) — the initplan-wrapped house style throughout ────────
create policy app_users_select_own on public.app_users for select to authenticated using ((lower(email) = ( SELECT private.jwt_email() AS jwt_email)));
create policy achk_delete_member on public.audit_checklists for delete to authenticated using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy achk_insert_member on public.audit_checklists for insert to authenticated with check ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy achk_select_member on public.audit_checklists for select to authenticated using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy achk_update_member on public.audit_checklists for update to authenticated using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id)))) with check ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy audit_log_insert_member on public.audit_log for insert to authenticated with check ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy audit_log_select_member on public.audit_log for select to authenticated using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy arf_delete_member on public.audit_report_finalization for delete to authenticated using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy arf_insert_member on public.audit_report_finalization for insert to authenticated with check ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy arf_select_member on public.audit_report_finalization for select to authenticated using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy arf_update_member on public.audit_report_finalization for update to authenticated using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id)))) with check ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy autobooks_adjustments_delete_member on public.autobooks_adjustments for delete to authenticated using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy autobooks_adjustments_insert_member on public.autobooks_adjustments for insert to authenticated with check ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy autobooks_adjustments_select_member on public.autobooks_adjustments for select to authenticated using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy autobooks_adjustments_update_member on public.autobooks_adjustments for update to authenticated using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id)))) with check ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy autobooks_books_delete_member on public.autobooks_books for delete to authenticated using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy autobooks_books_insert_member on public.autobooks_books for insert to authenticated with check ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy autobooks_books_select_member on public.autobooks_books for select to authenticated using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy autobooks_books_update_member on public.autobooks_books for update to authenticated using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id)))) with check ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy autobooks_entries_delete_member on public.autobooks_entries for delete to authenticated using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy autobooks_entries_insert_member on public.autobooks_entries for insert to authenticated with check ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy autobooks_entries_select_member on public.autobooks_entries for select to authenticated using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy autobooks_entries_update_member on public.autobooks_entries for update to authenticated using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id)))) with check ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy autobooks_parties_delete_member on public.autobooks_parties for delete to authenticated using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy autobooks_parties_insert_member on public.autobooks_parties for insert to authenticated with check ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy autobooks_parties_select_member on public.autobooks_parties for select to authenticated using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy autobooks_parties_update_member on public.autobooks_parties for update to authenticated using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id)))) with check ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy bank_accounts_delete_member on public.bank_accounts for delete to authenticated using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy bank_accounts_insert_member on public.bank_accounts for insert to authenticated with check ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy bank_accounts_select_member on public.bank_accounts for select to authenticated using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy bank_accounts_update_member on public.bank_accounts for update to authenticated using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id)))) with check ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy bank_transactions_delete_member on public.bank_transactions for delete to authenticated using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy bank_transactions_insert_member on public.bank_transactions for insert to authenticated with check ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy bank_transactions_select_member on public.bank_transactions for select to authenticated using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy bank_transactions_update_member on public.bank_transactions for update to authenticated using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id)))) with check ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy clients_delete_admin on public.clients for delete to authenticated using ((( SELECT private.is_admin() AS is_admin) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy clients_insert_admin on public.clients for insert to authenticated with check ((( SELECT private.is_admin() AS is_admin) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy clients_select_member on public.clients for select to authenticated using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy clients_update_member on public.clients for update to authenticated using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id)))) with check ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy depreciation_schedules_delete_member on public.depreciation_schedules for delete to authenticated using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy depreciation_schedules_insert_member on public.depreciation_schedules for insert to authenticated with check ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy depreciation_schedules_select_member on public.depreciation_schedules for select to authenticated using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy depreciation_schedules_update_member on public.depreciation_schedules for update to authenticated using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id)))) with check ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy document_register_delete_member on public.document_register for delete to authenticated using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy document_register_insert_member on public.document_register for insert to authenticated with check ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy document_register_select_member on public.document_register for select to authenticated using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy document_register_update_member on public.document_register for update to authenticated using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id)))) with check ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy financial_statements_delete_member on public.financial_statements for delete to authenticated using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy financial_statements_insert_member on public.financial_statements for insert to authenticated with check ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy financial_statements_select_member on public.financial_statements for select to authenticated using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy financial_statements_update_member on public.financial_statements for update to authenticated using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id)))) with check ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy org_firms_insert_admin on public.org_firms for insert to authenticated with check (((org_id = ( SELECT private.current_org_id() AS current_org_id)) AND ( SELECT private.is_admin() AS is_admin)));
create policy org_firms_select_own on public.org_firms for select to authenticated using ((org_id = ( SELECT private.current_org_id() AS current_org_id)));
create policy org_firms_update_admin on public.org_firms for update to authenticated using (((org_id = ( SELECT private.current_org_id() AS current_org_id)) AND ( SELECT private.is_admin() AS is_admin))) with check ((org_id = ( SELECT private.current_org_id() AS current_org_id)));
create policy org_invitations_delete_admin on public.org_invitations for delete to authenticated using (((org_id = ( SELECT private.current_org_id() AS current_org_id)) AND ( SELECT private.is_admin() AS is_admin)));
create policy org_invitations_select_admin on public.org_invitations for select to authenticated using (((org_id = ( SELECT private.current_org_id() AS current_org_id)) AND ( SELECT private.is_admin() AS is_admin)));
create policy org_invitations_update_admin on public.org_invitations for update to authenticated using (((org_id = ( SELECT private.current_org_id() AS current_org_id)) AND ( SELECT private.is_admin() AS is_admin))) with check ((org_id = ( SELECT private.current_org_id() AS current_org_id)));
create policy org_members_delete_admin on public.org_members for delete to authenticated using (((org_id = ( SELECT private.current_org_id() AS current_org_id)) AND ( SELECT private.is_admin() AS is_admin)));
create policy org_members_select_own on public.org_members for select to authenticated using ((org_id = ( SELECT private.current_org_id() AS current_org_id)));
create policy org_members_update_admin on public.org_members for update to authenticated using (((org_id = ( SELECT private.current_org_id() AS current_org_id)) AND ( SELECT private.is_admin() AS is_admin))) with check ((org_id = ( SELECT private.current_org_id() AS current_org_id)));
create policy organizations_select_own on public.organizations for select to authenticated using ((id = ( SELECT private.current_org_id() AS current_org_id)));
create policy organizations_update_admin on public.organizations for update to authenticated using (((id = ( SELECT private.current_org_id() AS current_org_id)) AND ( SELECT private.is_admin() AS is_admin))) with check ((id = ( SELECT private.current_org_id() AS current_org_id)));
create policy party_opening_balances_delete_member on public.party_opening_balances for delete to authenticated using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy party_opening_balances_insert_member on public.party_opening_balances for insert to authenticated with check ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy party_opening_balances_select_member on public.party_opening_balances for select to authenticated using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy party_opening_balances_update_member on public.party_opening_balances for update to authenticated using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id)))) with check ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy projection_reports_delete_member on public.projection_reports for delete to authenticated using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy projection_reports_insert_member on public.projection_reports for insert to authenticated with check ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy projection_reports_select_member on public.projection_reports for select to authenticated using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy projection_reports_update_member on public.projection_reports for update to authenticated using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id)))) with check ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy provisional_statements_delete_member on public.provisional_statements for delete to public using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy provisional_statements_insert_member on public.provisional_statements for insert to public with check ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy provisional_statements_select_member on public.provisional_statements for select to public using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy provisional_statements_update_member on public.provisional_statements for update to public using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id)))) with check ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy registrar_companies_delete_admin on public.registrar_companies for delete to public using ((( SELECT private.is_admin() AS is_admin) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy registrar_companies_insert_admin on public.registrar_companies for insert to public with check ((( SELECT private.is_admin() AS is_admin) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy registrar_companies_select_member on public.registrar_companies for select to public using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy registrar_companies_update_member on public.registrar_companies for update to public using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id)))) with check ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy registrar_shareholders_delete_member on public.registrar_shareholders for delete to public using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy registrar_shareholders_insert_member on public.registrar_shareholders for insert to public with check ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy registrar_shareholders_select_member on public.registrar_shareholders for select to public using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy registrar_shareholders_update_member on public.registrar_shareholders for update to public using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id)))) with check ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy saved_documents_delete_member on public.saved_documents for delete to authenticated using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy saved_documents_insert_member on public.saved_documents for insert to authenticated with check ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy saved_documents_select_member on public.saved_documents for select to authenticated using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy saved_documents_update_member on public.saved_documents for update to authenticated using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id)))) with check ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy send_logs_insert_member on public.send_logs for insert to authenticated with check ((( SELECT private.is_app_user() AS is_app_user) AND (lower(sent_by) = ( SELECT private.jwt_email() AS jwt_email)) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy send_logs_select_own_or_admin on public.send_logs for select to authenticated using (((( SELECT private.is_admin() AS is_admin) OR (lower(sent_by) = ( SELECT private.jwt_email() AS jwt_email))) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy service_memo_fee_skips_delete_member on public.service_memo_fee_skips for delete to authenticated using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy service_memo_fee_skips_insert_member on public.service_memo_fee_skips for insert to authenticated with check ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy service_memo_fee_skips_select_member on public.service_memo_fee_skips for select to authenticated using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy service_memos_delete_member on public.service_memos for delete to authenticated using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy service_memos_insert_member on public.service_memos for insert to authenticated with check ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy service_memos_select_member on public.service_memos for select to authenticated using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy service_memos_update_member on public.service_memos for update to authenticated using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id)))) with check ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy vat_collections_delete_member on public.vat_collections for delete to public using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy vat_collections_insert_member on public.vat_collections for insert to public with check ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy vat_collections_select_member on public.vat_collections for select to public using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy vat_collections_update_member on public.vat_collections for update to public using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id)))) with check ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy vat_purchases_delete_member on public.vat_purchases for delete to public using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy vat_purchases_insert_member on public.vat_purchases for insert to public with check ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy vat_purchases_select_member on public.vat_purchases for select to public using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy vat_purchases_update_member on public.vat_purchases for update to public using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id)))) with check ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy vat_returns_delete_member on public.vat_returns for delete to public using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy vat_returns_insert_member on public.vat_returns for insert to public with check ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy vat_returns_select_member on public.vat_returns for select to public using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy vat_returns_update_member on public.vat_returns for update to public using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id)))) with check ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy wd_delete_member on public.work_done for delete to authenticated using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy wd_insert_member on public.work_done for insert to authenticated with check ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy wd_select_member on public.work_done for select to authenticated using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy wd_update_member on public.work_done for update to authenticated using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id)))) with check ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy wt_delete_member on public.work_todos for delete to authenticated using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy wt_insert_member on public.work_todos for insert to authenticated with check ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy wt_select_member on public.work_todos for select to authenticated using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
create policy wt_update_member on public.work_todos for update to authenticated using ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id)))) with check ((( SELECT private.is_app_user() AS is_app_user) AND (org_id = ( SELECT private.current_org_id() AS current_org_id))));
