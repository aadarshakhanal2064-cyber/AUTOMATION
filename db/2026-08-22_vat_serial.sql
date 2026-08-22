-- ════════════════════════════════════════════════════════════════════
--  VAT SERIAL — per-firm sequential identifier for VAT Register sales
--  rows (2026-08-22, user ask: "VAT SA-0001", "VAT DC-0001", 1 2 3 4…)
--
--  The Sales Register's "Bill No." column already prints memo_number
--  (SM-SA-00007 etc.) — the memo's own reference. This is a SEPARATE,
--  additional identifier scoped to VAT alone: the firm wants a plain
--  running count of "how many VAT bills has this firm raised", which
--  memo_number cannot give since it is shared with every non-VAT memo
--  too and would have gaps.
--
--  · vat_serial is assigned ONCE, the first time a memo has
--    apply_vat = true, and never reassigned or reused afterwards —
--    even if VAT is later unticked and re-ticked. A number once shown
--    to the firm must always point at the same bill.
--  · Sequential PER (org_id, firm_key), not globally — Shailesh &
--    Associates and Dallakoti & Company each count from 1, matching
--    the firm's own request ("VAT SA-0001 … VAT DC-0001").
--  · Assigned in JS as 'VAT-' || <short code from memo_prefix> || '-'
--    || lpad(vat_serial, 4, '0') — vrFirmCode()/vrVatSerialLabel() in
--    js/vatRegister.js. No new firm config needed: the short code is
--    derived from org_firms.memo_prefix ('SM-SA' -> 'SA'), which every
--    firm already has.
--  · A BEFORE trigger (not AFTER, unlike set_service_memo_number) —
--    the value is written into NEW directly, no re-fetch needed, and
--    it must also fire on UPDATE for the case a memo is edited to turn
--    VAT on after being saved without it.
--  · Assignment reads MAX(vat_serial)+1 under a plain SELECT, the same
--    lightweight approach the rest of this schema uses (no advisory
--    lock) — accepted as a low-probability race for an 8-user firm.
--    The partial UNIQUE index below turns any actual collision into a
--    loud insert/update error rather than a silently duplicated serial.
--
--  Rollback: db/2026-08-22_vat_serial_rollback.sql
-- ════════════════════════════════════════════════════════════════════

alter table public.service_memos
  add column if not exists vat_serial bigint;

comment on column public.service_memos.vat_serial is
  'Per-(org, firm) sequential VAT Register identifier (1, 2, 3…), assigned once by set_vat_serial() the first time apply_vat is true. Independent of memo_number. Never reassigned or reused.';

-- Backfill existing VAT memos in the same order the Sales Register already
-- sorts by (memo_date, id) — vrSalesMemos() in js/vatRegister.js — so serial
-- 1 really is the chronologically first VAT bill each firm ever raised.
with ranked as (
  select id, row_number() over (partition by org_id, firm_key order by memo_date, id) as rn
  from public.service_memos
  where apply_vat and vat_serial is null
)
update public.service_memos sm
set vat_serial = ranked.rn
from ranked
where sm.id = ranked.id;

create or replace function public.set_vat_serial()
  returns trigger
  language plpgsql
  set search_path to ''
as $function$
begin
  if new.apply_vat and new.vat_serial is null then
    select coalesce(max(vat_serial), 0) + 1 into new.vat_serial
      from public.service_memos
      where org_id = new.org_id and firm_key = new.firm_key;
  end if;
  return new;
end $function$;

drop trigger if exists set_vat_serial on public.service_memos;
create trigger set_vat_serial
  before insert or update on public.service_memos
  for each row
  when (new.apply_vat and new.vat_serial is null)
  execute function public.set_vat_serial();

-- Turns a rare concurrent-save race into a loud constraint error instead of
-- a silently duplicated serial (see header note).
create unique index if not exists service_memos_vat_serial_uidx
  on public.service_memos (org_id, firm_key, vat_serial)
  where vat_serial is not null;
