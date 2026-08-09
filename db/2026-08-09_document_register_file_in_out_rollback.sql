-- ════════════════════════════════════════════════════════════════════
--  ROLLBACK — document_register File In Out fields (2026-08-09)
--  Reverses db/2026-08-09_document_register_file_in_out.sql.
--
--  Restoring brought_by_name NOT NULL will fail if any online-mode intake
--  (brought_by_name null) was saved after this migration ran — that is a
--  real data conflict, not a bug in this script: those rows would need a
--  name filled in by hand before the constraint can come back.
-- ════════════════════════════════════════════════════════════════════

-- Flatten doc_types back to a plain string array (drops the qty captured
-- since this migration — that data has no home in the old shape).
update public.document_register
set doc_types = (
  select jsonb_agg(elem -> 'type')
  from jsonb_array_elements(doc_types) as elem
)
where jsonb_typeof(doc_types) = 'array'
  and jsonb_array_length(doc_types) > 0
  and jsonb_typeof(doc_types -> 0) = 'object';

alter table public.document_register alter column brought_by_name set not null;

alter table public.document_register
  drop column if exists fiscal_year,
  drop column if exists mode_received,
  drop column if exists email_received,
  drop column if exists mode_returned,
  drop column if exists email_sent;
