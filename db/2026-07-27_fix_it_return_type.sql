-- ============================================================================
--  2026-07-27 — FIX: it_return_type was derived from the wrong cell
-- ============================================================================
--  WHAT WENT WRONG
--    Both earlier passes (db/2026-07-26_client_master_reload.sql and
--    db/2026-07-26b_client_tax_registration.sql) read "any yellow cell on the
--    row" as D1/D2. That produced 233-234 D1/D2 against 27-28 D-03 — exactly
--    backwards. The firm's clients are overwhelmingly D-3.
--
--  HOW THE WORKBOOK SETTLES IT
--    Only two of the 261 rows carry a TYPED value in the "Type of IT return"
--    column, and they disagree with the old rule:
--
--      row 2  typed "D-03"
--             -> its data block (name/VAT-PAN/address/entity/nature/district/
--                country) is ENTIRELY YELLOW, but its S.No cell in column A
--                is not.
--      row 5  typed "D1/D2"
--             -> its S.No cell in column A IS yellow.
--
--    So the yellow washing across the data columns is formatting, and the
--    actual marking is the S.No cell (column A). Both typed rows agree with
--    the column-A rule; the old rule got row 2 exactly wrong, and that
--    mismatch was visible in the analysis output at the time.
--
--  RESULT
--    39 D1/D2, 222 D-03 (was 234/27). The 39 are almost entirely kirana
--    shops, restaurants, small farms and single-proprietor firms — the
--    profile that actually files D-1/D-2 presumptive returns in Nepal, which
--    is an independent sanity check on the rule.
--
--  SCOPE
--    ids <= 262 only — the 261 workbook clients. The 45 Devanagari records
--    and the 8 kept clients keep it_return_type NULL exactly as before, and
--    no other column is touched.
--
--  Rollback: db/2026-07-27_fix_it_return_type_rollback.sql
-- ============================================================================

begin;

-- The 39 rows whose S.No cell (column A) is yellow in the workbook.
--
-- PANS NOT COMMITTED — this repo is PUBLIC and PANs are client data, same
-- policy as the client-master row files. The INSERT lives in:
--
--     db/backups/2026-07-27_it_return_type_pans.sql   (gitignored)
--
-- Run that file at the point marked below, between this CREATE and the
-- UPDATE statements that follow.
create temporary table _d12_pan (pan text primary key) on commit drop;

-- >>> run db/backups/2026-07-27_it_return_type_pans.sql here <<<

do $$
declare n int;
begin
  select count(*) into n from _d12_pan;
  if n <> 39 then raise exception 'Expected 39 D1/D2 PANs, got %', n; end if;
end $$;

-- Default every workbook client to D-03, then mark the 39.
update public.clients
   set it_return_type = 'D-03'
 where id <= 262;

update public.clients c
   set it_return_type = 'D1/D2'
  from _d12_pan d
 where c.pan = d.pan
   and c.id <= 262;

do $$
declare a int; b int; c int;
begin
  select count(*) into a from public.clients where id <= 262 and it_return_type = 'D1/D2';
  select count(*) into b from public.clients where id <= 262 and it_return_type = 'D-03';
  select count(*) into c from public.clients where id > 262 and it_return_type is not null;
  if a <> 39  then raise exception 'Expected 39 D1/D2, got %', a; end if;
  if b <> 222 then raise exception 'Expected 222 D-03, got %', b; end if;
  if c <> 0   then raise exception 'Non-workbook clients should have no IT return type, got %', c; end if;
end $$;

commit;
