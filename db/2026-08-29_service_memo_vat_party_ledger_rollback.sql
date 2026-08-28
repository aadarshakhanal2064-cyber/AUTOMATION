-- ════════════════════════════════════════════════════════════════════════
--  ROLLBACK — Service Memo "VAT to Party Ledger" marker  (2026-08-29)
--
--  Reverses db/2026-08-29_service_memo_vat_party_ledger.sql.
--
--  NOTE: this DOES destroy information — which memos had their VAT marked as
--  borne by the firm. Nothing else depends on it and no money figure moves
--  (the marker was never wired into Party Ledger's arithmetic), but the
--  marks themselves cannot be recovered afterwards. Export them first if the
--  firm has started using the button:
--
--    select id, memo_number, client_name, vat_amount, vat_ledger_at, vat_ledger_by
--      from public.service_memos where vat_ledger_at is not null;
-- ════════════════════════════════════════════════════════════════════════

drop index if exists public.service_memos_vat_ledger_idx;

alter table public.service_memos
  drop column if exists vat_ledger_by,
  drop column if exists vat_ledger_at;

do $verify$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema='public' and table_name='service_memos'
       and column_name in ('vat_ledger_at','vat_ledger_by')) then
    raise exception 'Rollback incomplete — the vat_ledger columns are still present';
  end if;
end
$verify$;
