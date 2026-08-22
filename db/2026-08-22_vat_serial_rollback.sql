-- Rollback for db/2026-08-22_vat_serial.sql — structure only (drops the
-- assigned serials; service_memos itself is untouched otherwise).
drop trigger if exists set_vat_serial on public.service_memos;
drop function if exists public.set_vat_serial();
drop index if exists public.service_memos_vat_serial_uidx;
alter table public.service_memos drop column if exists vat_serial;
