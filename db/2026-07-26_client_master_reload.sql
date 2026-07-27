-- ============================================================================
--  2026-07-26 — Client master reload from Client_Data_For_App_1_Cleaned.xlsx
-- ============================================================================
--  WHAT THIS DOES
--    The directory had grown to 451 rows: the original 261 hand-entered records
--    (ids 1-262), 45 Nepali-language records (ids 263-307), 8 clients added
--    later (ids 314-324), and a PARTIAL re-import of this same workbook
--    (ids 325-461) that duplicated 137 of the originals by PAN.
--
--    The workbook is the authority for the 261 English records. Rather than
--    delete-and-reinsert, this UPDATES the original rows in place, matched on
--    PAN, and deletes only the 137 duplicate rows. That is what keeps every
--    foreign key intact: the originals carry 41 rows of real work
--    (vat_filings, invoices, depreciation_schedules, service_memos,
--    projection_reports, bank_transactions), three of those FKs are ON DELETE
--    RESTRICT and three are ON DELETE CASCADE, so deleting the originals would
--    either be blocked or would silently destroy saved workings.
--
--  DELIBERATELY NOT TOUCHED
--    ids 263-307 — the Nepali-language client records. 37 of them share a PAN
--      with an English row; they are the Devanagari twin used by BM/AGM Minutes
--      and its 55 client_shareholders rows, not duplicates to be merged away.
--    ids 314-324 — 8 clients absent from the workbook, 5 carrying live work
--      (2 VAT filings, 3 service memos, 2 bank transactions). Kept per the
--      user's decision on 2026-07-26.
--
--  RESULT: 451 -> 314 clients (261 workbook + 45 Devanagari + 8 kept), with
--          zero attached work rows destroyed and zero FKs re-pointed.
--
--  it_return_type: the workbook carries this ONLY as a cell fill — the
--    "Tax Type for only D3" and "Type of IT return" columns are blank on 259
--    of the 261 rows.
--
--    *** THE RULE USED HERE IS WRONG AND WAS CORRECTED ON 2026-07-27. ***
--    This pass read "a row with any yellow cell" as D-1/D-2, yielding 233
--    D1/D2 / 28 D-03. The real marking is the S.No cell in column A, giving
--    39 D1/D2 / 222 D-03. See db/2026-07-27_fix_it_return_type.sql, which
--    supersedes the it_return_type values written below. Everything else this
--    migration does (the de-duplication, the other columns) still stands.
--  Rollback: db/2026-07-26_client_master_reload_rollback.sql
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. New fields carried by the workbook
-- ---------------------------------------------------------------------------
alter table public.clients add column if not exists district       text;
alter table public.clients add column if not exists country        text;
alter table public.clients add column if not exists it_return_type text;
alter table public.clients add column if not exists tax_type_d3    text;

comment on column public.clients.district is
  'District from the client master workbook. Used by the Clients dashboard.';
comment on column public.clients.country is
  'Country from the client master workbook; Nepal for every current client.';
comment on column public.clients.it_return_type is
  'Income-tax return type: D1/D2, D-01, D-02 or D-03. Seeded from the '
  'workbook cell fill (see header note); refined per client in the app.';
comment on column public.clients.tax_type_d3 is
  'Workbook column "Tax Type for only D3" — blank in the source file, '
  'filled in per client from the app.';

-- Free text rather than a CHECK: the firm refines D1/D2 into D-01 or D-02
-- per client over time, and a constraint here would mean a migration for
-- every wording change.

-- ---------------------------------------------------------------------------
-- 2. The workbook, as data — ROWS NOT COMMITTED
-- ---------------------------------------------------------------------------
-- A real table, not a temporary one: the rows arrive in a separate step (and,
-- as applied on 2026-07-26, over several connections), and a temp table would
-- not survive that. Dropped at the end of step 6.
create table if not exists public.client_master_import (
  pan text primary key, name text not null, address text, entity_type text,
  business_nature text, district text, country text, it_return_type text
);
alter table public.client_master_import enable row level security;

-- This repo is PUBLIC (see .gitignore). The 261 workbook rows are real client
-- names, PANs and addresses, so the INSERT that populates the staging table
-- lives outside version control, next to the pre-reload snapshot:
--
--     db/backups/2026-07-26_client_master_rows.sql     (gitignored)
--     db/backups/2026-07-26_clients_pre_reload.sql     (gitignored)
--
-- Both were generated from the firm's Client_Data_For_App_1_Cleaned.xlsx.
-- To re-run this migration end to end:
--
--     1. run everything above this note (the DDL),
--     2. run db/backups/2026-07-26_client_master_rows.sql,
--     3. run everything below this note (guards, update, delete, verify).
--
-- The row file is a single INSERT of eight columns, in this order:
--   pan, name, address, entity_type, business_nature, district, country,
--   it_return_type
-- and it_return_type is derived from the workbook's cell fill exactly as the
-- header note above describes. NOTE: that rule is the WRONG one — the row
-- file's it_return_type values are superseded by
-- db/2026-07-27_fix_it_return_type.sql. Run that after this migration.
--
-- If the row file is missing, regenerate it from the workbook rather than
-- hand-typing it — the fill-to-D1/D2 mapping is not recoverable by eye.

-- Guard: the workbook must be exactly the 261 rows this migration was built for.
do $$
declare n int;
begin
  select count(*) into n from public.client_master_import;
  if n <> 261 then
    raise exception 'Expected 261 workbook rows, got %', n;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Update the original records in place (PAN is the join key)
-- ---------------------------------------------------------------------------
update public.clients c
   set name            = m.name,
       address         = m.address,
       entity_type     = m.entity_type,
       business_nature = m.business_nature,
       district        = m.district,
       country         = m.country,
       it_return_type  = m.it_return_type
  from public.client_master_import m
 where c.pan = m.pan
   and c.id <= 262;

do $$
declare n int;
begin
  select count(*) into n
    from public.clients c join public.client_master_import m on m.pan = c.pan
   where c.id <= 262;
  if n <> 261 then
    raise exception 'Expected 261 originals matched by PAN, got %', n;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Drop the duplicate re-import (ids 325-461)
-- ---------------------------------------------------------------------------
-- Verified before deleting: all 137 carry a PAN already held by an original
-- and have zero rows in every table that references clients.
do $$
declare n int;
begin
  select count(*) into n
    from public.clients c
   where c.id between 325 and 461
     and (exists (select 1 from public.vat_filings           t where t.client_id = c.id)
       or exists (select 1 from public.invoices              t where t.client_id = c.id)
       or exists (select 1 from public.invoice_payments      t where t.client_id = c.id)
       or exists (select 1 from public.depreciation_schedules t where t.client_id = c.id)
       or exists (select 1 from public.client_shareholders   t where t.client_id = c.id)
       or exists (select 1 from public.service_memos         t where t.client_id = c.id)
       or exists (select 1 from public.projection_reports    t where t.client_id = c.id)
       or exists (select 1 from public.bank_transactions     t where t.client_id = c.id));
  if n <> 0 then
    raise exception 'Refusing to delete: % duplicate rows carry attached work', n;
  end if;
end $$;

delete from public.clients c
 where c.id between 325 and 461
   and c.pan in (select pan from public.client_master_import);

-- ---------------------------------------------------------------------------
-- 5. Backfill country on the records the workbook does not cover
-- ---------------------------------------------------------------------------
-- The Devanagari records and the 8 kept clients are all Nepal-based; leaving
-- country null would drop them out of the dashboard's country rollup.
update public.clients set country = 'Nepal' where country is null;

-- ---------------------------------------------------------------------------
-- 6. Final shape
-- ---------------------------------------------------------------------------
do $$
declare n int;
begin
  select count(*) into n from public.clients;
  if n <> 314 then
    raise exception 'Expected 314 clients after reload, got %', n;
  end if;
end $$;

-- The staging table has served its purpose; it holds a second copy of the
-- client master and must not be left behind in the schema.
drop table public.client_master_import;

commit;
