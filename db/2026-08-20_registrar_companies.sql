-- ════════════════════════════════════════════════════════════════════
--  REGISTRAR COMPANIES — the Nepali company register moves out of
--  `clients` and into its own pair of tables            (2026-08-20)
--
--  WHY THIS EXISTS
--  The firm's 45 Nepalese company-registration records have been living as
--  rows in `clients` since the client master was first loaded. They are not
--  audit clients. Every module in the app that offers a client picker reads
--  one shared array (window.clientsList), so those 45 Devanagari-named rows
--  surfaced in Bank Entry, Service Memo, Work Done, Autobooks — everywhere —
--  when the only screens that can do anything with them are the five under
--  Company Registrar. The user asked for that leak closed.
--
--  THE EVIDENCE THIS IS A CLEAN SPLIT (measured on production, 2026-08-20):
--    · 350 client rows: 45 Devanagari-named, 305 Latin-named.
--    · All 45 Devanagari rows carry a registration_number, a chairman, a
--      shareholder and all three capitals. NONE of the 305 carry any of them.
--      The two ways of asking "is this a registrar company?" — how the name is
--      spelled, and whether statutory details are on file — select exactly the
--      same 45 rows. This migration asserts that rather than trusting it.
--    · Those 45 rows carry NO email, phone, district, entity_type,
--      business_nature, it_return_type or tax_registration_type. Not one.
--      They were never used as clients because they cannot be.
--    · All 55 client_shareholders rows belong to those 45. Zero belong to a
--      real client.
--    · ZERO rows in audit_report_finalization, work_done, work_todos,
--      audit_checklists, document_register, service_memos, autobooks_books,
--      bank_transactions, depreciation_schedules, financial_statements,
--      projection_reports, party_opening_balances, saved_documents or
--      service_memo_fee_skips reference any of the 45. Nothing depends on them
--      staying in `clients`, which is why this can be a MOVE and not a copy.
--
--  WHY A SEPARATE TABLE AND NOT A FLAG COLUMN ON `clients`
--  A flag means every client picker written from now on must remember to
--  filter. Twenty-odd modules read window.clientsList today and the next one
--  will be written by someone who never read this file. A separate table
--  cannot be reached by accident: leaking requires opting IN. It also lets the
--  record carry exactly the columns a company register needs, instead of the
--  seven audit-client columns these rows will never fill.
--
--  This does NOT contradict CLAUDE.md §15's "the 45 Devanagari records are kept
--  alongside their English twins — never de-duplicate the directory on PAN
--  alone". That decision protects the records from being DELETED as duplicates
--  of their English twins, because BM/AGM Minutes and client_shareholders read
--  them. Both halves still hold: every record survives, the English twins are
--  untouched, and the registrar documents still read them — from here.
--
--  SAFETY
--  Copy, then PROVE the copy, then delete — one transaction. The verification
--  block raises rather than warns, so a partial move cannot commit. This is the
--  same idiom as db/2026-08-18_stage2_phase2_backfill_org_id.sql, and for the
--  same reason: the failure that matters is not a loud error, it is a silent
--  half-move that looks exactly like data loss.
--  A full backup was taken first: db/backups/2026-08-20_backup (gitignored).
-- ════════════════════════════════════════════════════════════════════

begin;

-- ── 1. The company register ──────────────────────────────────────────
-- Columns are exactly what the 45 rows actually carry, plus `notes`. There is
-- deliberately no email/phone/district/entity_type/it_return_type here: those
-- are audit-client properties, and a registrar record that offered them would
-- invite someone to fill them in, which is how the two record types grew into
-- one table in the first place.
--
-- The three capitals are TEXT, not numeric — CLAUDE.md §15. This preserves the
-- firm's own comma grouping ("25,00,000") exactly as typed, and these values go
-- straight into a Word document rather than into arithmetic.
create table public.registrar_companies (
  id                  bigint generated always as identity primary key,
  org_id              bigint not null default private.current_org_id()
                        references public.organizations(id) on delete restrict,
  name                text not null,
  registration_number text,
  pan                 text,
  address             text,
  country             text,
  chairman_name       text,
  shareholder_name    text,
  authorized_capital  text,
  issued_capital      text,
  paid_up_capital     text,
  notes               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index registrar_companies_org_idx  on public.registrar_companies (org_id);
create index registrar_companies_name_idx on public.registrar_companies (org_id, name);

create trigger set_registrar_companies_updated_at
  before update on public.registrar_companies
  for each row execute function public.set_updated_at();

-- ── 2. Their shareholders / directors ────────────────────────────────
-- Replaces client_shareholders, which is dropped at the end of this file: all
-- 55 of its rows belong to companies moving out, so leaving it behind would
-- leave an empty table that js/clients.js's import still writes to — exactly
-- the kind of drift that reopens this leak later.
--
-- ON DELETE CASCADE matches what client_shareholders did: a shareholder list
-- has no meaning without its company.
create table public.registrar_shareholders (
  id         bigint generated always as identity primary key,
  org_id     bigint not null default private.current_org_id()
               references public.organizations(id) on delete restrict,
  company_id bigint not null references public.registrar_companies(id) on delete cascade,
  name       text not null,
  sort_order integer not null default 0
);

create index registrar_shareholders_company_idx on public.registrar_shareholders (company_id, sort_order);
create index registrar_shareholders_org_idx     on public.registrar_shareholders (org_id);

-- ── 3. RLS — enabled from birth, org-scoped (CLAUDE.md §6, §13) ───────
-- registrar_companies mirrors `clients`: admins add and delete, every member
-- reads and edits. registrar_shareholders is member-writable throughout,
-- because a shareholder list is a DETAIL of a company a member may already
-- edit — client_shareholders had no UPDATE and no DELETE policy at all, which
-- is why a shareholder could be added but never corrected or removed.
alter table public.registrar_companies    enable row level security;
alter table public.registrar_shareholders enable row level security;

create policy registrar_companies_select_member on public.registrar_companies
  for select using (private.is_app_user() and org_id = private.current_org_id());
create policy registrar_companies_insert_admin on public.registrar_companies
  for insert with check (private.is_admin() and org_id = private.current_org_id());
create policy registrar_companies_update_member on public.registrar_companies
  for update using (private.is_app_user() and org_id = private.current_org_id())
          with check (private.is_app_user() and org_id = private.current_org_id());
create policy registrar_companies_delete_admin on public.registrar_companies
  for delete using (private.is_admin() and org_id = private.current_org_id());

create policy registrar_shareholders_select_member on public.registrar_shareholders
  for select using (private.is_app_user() and org_id = private.current_org_id());
create policy registrar_shareholders_insert_member on public.registrar_shareholders
  for insert with check (private.is_app_user() and org_id = private.current_org_id());
create policy registrar_shareholders_update_member on public.registrar_shareholders
  for update using (private.is_app_user() and org_id = private.current_org_id())
          with check (private.is_app_user() and org_id = private.current_org_id());
create policy registrar_shareholders_delete_member on public.registrar_shareholders
  for delete using (private.is_app_user() and org_id = private.current_org_id());

-- ── 4. Pre-flight: the two definitions of "registrar company" must agree ──
-- If a row is Devanagari-named but carries no registration number, or carries
-- one under a Latin name, this migration does not know what to do with it and
-- must not guess. Fail loudly here rather than move the wrong 44 rows.
do $$
declare regno_rows int; deva_rows int; both_rows int;
begin
  select count(*) into regno_rows from public.clients where registration_number is not null;
  select count(*) into deva_rows  from public.clients where name ~ '[ऀ-ॿ]';
  select count(*) into both_rows  from public.clients
    where registration_number is not null and name ~ '[ऀ-ॿ]';

  if regno_rows <> deva_rows or regno_rows <> both_rows then
    raise exception
      'Registrar-company selection is ambiguous: % rows have a registration number, % are Devanagari-named, % are both. Resolve by hand before migrating.',
      regno_rows, deva_rows, both_rows;
  end if;
  raise notice 'Pre-flight OK: % rows selected as registrar companies.', regno_rows;
end $$;

-- ── 5. The move ──────────────────────────────────────────────────────
-- Row by row rather than one INSERT..SELECT, so each company's shareholders can
-- be attached to the id Postgres just generated. 45 iterations; the alternative
-- is matching the copies back to their sources on registration_number, which
-- silently mis-attaches shareholders the day two companies share one.
--
-- org_id is copied EXPLICITLY, never left to its default — a migration applied
-- over the MCP runs without a JWT, so private.current_org_id() is NULL here and
-- the default would violate NOT NULL (or worse, on a future multi-org database,
-- file every firm's companies under whoever ran it).
do $$
declare r record; new_id bigint;
begin
  for r in select * from public.clients where registration_number is not null order by id loop
    insert into public.registrar_companies (
      org_id, name, registration_number, pan, address, country,
      chairman_name, shareholder_name,
      authorized_capital, issued_capital, paid_up_capital, created_at
    ) values (
      r.org_id, r.name, r.registration_number, r.pan, r.address, r.country,
      r.chairman_name, r.shareholder_name,
      r.authorized_capital, r.issued_capital, r.paid_up_capital, coalesce(r.created_at, now())
    ) returning id into new_id;

    insert into public.registrar_shareholders (org_id, company_id, name, sort_order)
    select cs.org_id, new_id, cs.name, cs.sort_order
      from public.client_shareholders cs
     where cs.client_id = r.id
     order by cs.sort_order, cs.id;
  end loop;
end $$;

-- ── 6. Prove the copy BEFORE anything is deleted ─────────────────────
do $$
declare
  src_companies int; new_companies int;
  src_shares    int; new_shares    int;
  orphan_shares int; lost_fields   int;
begin
  select count(*) into src_companies from public.clients where registration_number is not null;
  select count(*) into new_companies from public.registrar_companies;
  select count(*) into src_shares    from public.client_shareholders;
  select count(*) into new_shares    from public.registrar_shareholders;

  -- Any shareholder row NOT belonging to a company being moved would be
  -- destroyed by the drop in step 8. Measured as zero today; asserted anyway.
  select count(*) into orphan_shares from public.client_shareholders cs
    left join public.clients c on c.id = cs.client_id
   where c.id is null or c.registration_number is null;

  -- Every company must arrive with every field the registrar documents print,
  -- intact and character-for-character. `is not distinct from` so a NULL on one
  -- side matches a NULL on the other rather than comparing as unknown.
  select count(*) into lost_fields from public.clients c
   where c.registration_number is not null
     and not exists (
       select 1 from public.registrar_companies rc
        where rc.name = c.name
          and rc.registration_number is not distinct from c.registration_number
          and rc.authorized_capital  is not distinct from c.authorized_capital
          and rc.issued_capital      is not distinct from c.issued_capital
          and rc.paid_up_capital     is not distinct from c.paid_up_capital
          and rc.chairman_name       is not distinct from c.chairman_name
          and rc.shareholder_name    is not distinct from c.shareholder_name
          and rc.pan                 is not distinct from c.pan
          and rc.address             is not distinct from c.address
          and rc.country             is not distinct from c.country);

  if new_companies <> src_companies then
    raise exception 'Company copy incomplete: % source rows, % copied.', src_companies, new_companies;
  end if;
  if new_shares <> src_shares then
    raise exception 'Shareholder copy incomplete: % source rows, % copied.', src_shares, new_shares;
  end if;
  if orphan_shares <> 0 then
    raise exception '% shareholder row(s) belong to a client that is NOT moving; dropping client_shareholders would destroy them.', orphan_shares;
  end if;
  if lost_fields <> 0 then
    raise exception '% company/companies did not copy field-for-field.', lost_fields;
  end if;

  raise notice 'Verified: % companies and % shareholders copied field-for-field.', new_companies, new_shares;
end $$;

-- ── 7. Remove them from the client directory ─────────────────────────
-- Safe only because step 6 passed and because nothing outside
-- client_shareholders references these rows (measured; see header). The three
-- ON DELETE RESTRICT foreign keys (audit_report_finalization, work_done,
-- audit_checklists) would abort this statement rather than silently orphan a
-- record, which is the backstop if that measurement were ever wrong.
delete from public.clients where registration_number is not null;

-- ── 8. Retire client_shareholders ────────────────────────────────────
-- Now provably empty of anything not copied. Kept as a table, it would be dead
-- weight that js/clients.js's import still wrote to.
drop table public.client_shareholders;

do $$
declare left_over int;
begin
  select count(*) into left_over from public.clients
   where registration_number is not null or name ~ '[ऀ-ॿ]';
  if left_over <> 0 then
    raise exception '% registrar row(s) still in clients after the move.', left_over;
  end if;
  raise notice 'clients now holds % audit clients, none of them registrar records.',
    (select count(*) from public.clients);
end $$;

commit;
