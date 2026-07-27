-- ============================================================================
--  2026-07-26 (b) — Client master correction pass: VAT/PAN + business_nature fixes
-- ============================================================================
--  WHAT THIS DOES
--    A corrected version of Client_Data_For_App_1_Cleaned.xlsx arrived the same
--    day as the first reload (db/2026-07-26_client_master_reload.sql), adding a
--    new "VAT/PAN" column and fixing 56 business_nature spellings. Same 261
--    PANs as before — zero clients added, zero removed — so this is a targeted
--    UPDATE of the 261 originals (ids 1-262), not a second full import.
--
--  NEW FIELD
--    tax_registration_type ('VAT' or 'PAN') — whether the client itself is
--    registered for VAT or holds a PAN only. NOT the same thing as
--    clients.vat_status, which is whether THE FIRM files that client's
--    monthly VAT returns (a hand-picked subset, see clients_master_reload's
--    §5.2 note). 118 of the 261 are VAT-registered; only ~14 of those are
--    also in the firm's filed-for subset.
--
--  it_return_type: same rule as the first reload (any yellow cell on the row
--    => D1/D2), re-derived from this corrected workbook's fill, giving
--    234 D1/D2 / 27 D-03.
--
--    *** THAT RULE IS WRONG AND WAS CORRECTED ON 2026-07-27. *** The real
--    marking is the S.No cell in column A, giving 39 D1/D2 / 222 D-03. See
--    db/2026-07-27_fix_it_return_type.sql, which supersedes the
--    it_return_type values this migration writes. The VAT/PAN and
--    business_nature corrections below are unaffected and still stand.
--
--  entity_type normalized to the 8-value client-form vocabulary added the
--    same day (js/config.js CLIENT_ENTITY_TYPES): 'NPOs' -> 'NPO',
--    'Cooperatives' -> 'Cooperative Organization'. 'Partnership Firm' (7
--    clients) is deliberately UNCHANGED — it has no equivalent in the new
--    8-value list, and rewriting it would misclassify those 7 clients.
--    Both old and new spellings stay mapped in CLIENT_ENTITY_TO_REP_PROFILE.
--
--  ROWS NOT COMMITTED — see step 2 below.
--  Rollback: db/2026-07-26b_client_tax_registration_rollback.sql
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. New field
-- ---------------------------------------------------------------------------
alter table public.clients add column if not exists tax_registration_type text;

comment on column public.clients.tax_registration_type is
  'Type of tax registration: VAT or PAN. From the client master workbook '
  '(column "VAT/PAN": V/P). Distinct from vat_status, which is whether the '
  'firm files this client''s monthly VAT returns.';

-- ---------------------------------------------------------------------------
-- 2. The corrected workbook, as data — NOT COMMITTED
-- ---------------------------------------------------------------------------
-- Same reasoning as the first reload: this repo is PUBLIC, and the 261 rows
-- are real client names, PANs and addresses. The INSERT lives outside version
-- control:
--
--     db/backups/2026-07-26b_client_master_v2_rows.sql   (gitignored)
--
-- To re-run this correction pass end to end:
--     1. run everything above this note (the DDL),
--     2. run db/backups/2026-07-26b_client_master_v2_rows.sql,
--     3. run everything below this note (guards, update, drop).
--
-- The row file creates and populates a staging table, public.client_master_v2
-- (pan, address, entity_type, business_nature, district, country,
-- it_return_type, tax_registration_type) — 261 rows, PAN-keyed.
create table if not exists public.client_master_v2 (
  pan text primary key, address text, entity_type text, business_nature text,
  district text, country text, it_return_type text, tax_registration_type text
);
alter table public.client_master_v2 enable row level security;

-- Guard: the row file must have populated exactly the 261 rows this
-- correction pass was built for.
do $$
declare n int;
begin
  select count(*) into n from public.client_master_v2;
  if n <> 261 then
    raise exception 'Expected 261 workbook rows in client_master_v2, got %', n;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Apply the correction to the 261 originals only
-- ---------------------------------------------------------------------------
-- Scoped to id <= 262, matching the first reload: never touches the 45
-- Devanagari records (ids 263-307) or the 8 kept clients (ids 314-324), which
-- would collide on PAN with the 37 Devanagari twins otherwise.
update public.clients c
   set address              = m.address,
       entity_type          = m.entity_type,
       business_nature      = m.business_nature,
       district             = m.district,
       country              = m.country,
       it_return_type       = m.it_return_type,
       tax_registration_type = m.tax_registration_type
  from public.client_master_v2 m
 where c.pan = m.pan
   and c.id <= 262;

do $$
declare n int;
begin
  select count(*) into n from public.clients
   where id <= 262 and tax_registration_type is not null;
  if n <> 261 then
    raise exception 'Expected 261 rows with a tax registration type after the update, got %', n;
  end if;
end $$;

-- Align spellings with the client form's 8-value vocabulary. 'Partnership
-- Firm' is deliberately left alone (see header note).
update public.clients set entity_type = 'NPO'
 where entity_type = 'NPOs';
update public.clients set entity_type = 'Cooperative Organization'
 where entity_type = 'Cooperatives';

-- ---------------------------------------------------------------------------
-- 4. Drop the staging table
-- ---------------------------------------------------------------------------
drop table public.client_master_v2;

commit;
