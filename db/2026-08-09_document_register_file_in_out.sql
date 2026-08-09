-- ════════════════════════════════════════════════════════════════════
--  DOCUMENT REGISTER — File In Out fields (2026-08-09)
--
--  Backs the module's display rename to "File In Out" (code stays
--  fileManagement.js / fm- / document_register / registry id
--  fileManagement — the Autobooks/Bank Entry label-only precedent,
--  CLAUDE.md §5). Adds the fields the firm's paper register actually
--  carries that the first cut (db/2026-08-01_document_register.sql)
--  didn't: a Financial Year, and Online (email) vs Physical (person)
--  delivery mode captured independently for intake and handover.
--
--  · fiscal_year     dash format ("2081-82"), matching the majority
--                    convention (Bank Entry, Party Ledger, Depreciation,
--                    Financial Statement). Auto-derived in the UI from
--                    date_received via NepaliLocale, editable. Nullable —
--                    the 7 existing rows predate the field.
--  · mode_received   'physical' (default, matches every existing row —
--                    all 7 were logged with a brought_by_name) or
--                    'online'. Physical keeps brought_by_name/phone;
--                    online uses the new email_received instead, so
--                    brought_by_name can no longer be NOT NULL.
--  · mode_returned   same idea for the handover side; null until the
--                    row is actually returned (mirrors date_returned).
--  · doc_types       shape change, no column change (still jsonb): was
--                    a flat array of picklist strings, becomes an array
--                    of {type, qty} so the register can show "Ledger x2"
--                    like the paper form's "No of books" columns. The
--                    7 existing rows are backfilled with qty=1 (the
--                    original form never captured a count).
--
--  Rollback: db/2026-08-09_document_register_file_in_out_rollback.sql
-- ════════════════════════════════════════════════════════════════════

alter table public.document_register
  add column if not exists fiscal_year     text,
  add column if not exists mode_received   text not null default 'physical'
                            check (mode_received in ('online', 'physical')),
  add column if not exists email_received  text,
  add column if not exists mode_returned   text
                            check (mode_returned in ('online', 'physical')),
  add column if not exists email_sent      text;

-- Online intake has no physical "brought by" person, so this can no longer
-- be a blanket NOT NULL — the JS layer enforces name-or-email based on mode.
alter table public.document_register alter column brought_by_name drop not null;

comment on column public.document_register.fiscal_year is
  'Dash format ("2081-82"), auto-derived from date_received in the UI, editable. Null on rows created before 2026-08-09.';
comment on column public.document_register.mode_received is
  'How the documents came in: physical (brought_by_name/phone) or online (email_received).';
comment on column public.document_register.mode_returned is
  'How the documents went back out: physical (returned_to_name/phone) or online (email_sent). Null until returned.';

-- Backfill: old doc_types was ["Ledger","Confirmation",...]; new shape is
-- [{"type":"Ledger","qty":1},...]. Quantity wasn't captured before, so every
-- backfilled entry defaults to qty=1 — staff can correct real counts on edit.
update public.document_register
set doc_types = (
  select jsonb_agg(jsonb_build_object('type', elem, 'qty', 1))
  from jsonb_array_elements_text(doc_types) as elem
)
where jsonb_typeof(doc_types) = 'array'
  and jsonb_array_length(doc_types) > 0
  -- guard against re-running this migration against already-migrated rows
  -- (old shape's elements are strings; new shape's are objects)
  and jsonb_typeof(doc_types -> 0) = 'string';
