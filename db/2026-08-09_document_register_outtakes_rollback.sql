-- ════════════════════════════════════════════════════════════════════
--  ROLLBACK — document_register outtakes (2026-08-09)
--  Reverses db/2026-08-09_document_register_outtakes.sql.
--
--  The 6 restored columns come back NULL — the original per-event data
--  (who collected which partial batch, and when) has no home in the old
--  single-shot shape and cannot be reconstructed from `outtakes`. Any row
--  that reached 'partial' or 'returned' under the outtake model will land
--  back on this schema as an untouched 'pending' row with real work
--  invisible to it; that data loss is inherent to rolling back this
--  migration, not a bug in this script.
-- ════════════════════════════════════════════════════════════════════

alter table public.document_register drop constraint if exists document_register_status_check;
alter table public.document_register add constraint document_register_status_check
  check (status in ('pending', 'returned'));

update public.document_register set status = 'pending' where status = 'partial';

alter table public.document_register
  add column if not exists date_returned      date,
  add column if not exists returned_to_name   text,
  add column if not exists returned_to_phone  text,
  add column if not exists return_remarks     text,
  add column if not exists mode_returned      text check (mode_returned in ('online', 'physical')),
  add column if not exists email_sent         text;

alter table public.document_register drop column if exists outtakes;
