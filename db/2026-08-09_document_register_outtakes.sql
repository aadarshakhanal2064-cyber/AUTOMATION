-- ════════════════════════════════════════════════════════════════════
--  DOCUMENT REGISTER — Outtake (partial handover) support (2026-08-09)
--
--  Replaces the single-shot "Hand Over" (pending -> returned in one move)
--  with repeatable OUTTAKE events, because the firm doesn't always give
--  everything back at once — a client's Ledger might go back today and
--  their Confirmation letters a week later. status is now 3-way and
--  DERIVED (js/fileManagement.js fmDeriveStatus) from doc_types (what came
--  in) vs outtakes (what's gone back out), never hand-set, mirroring the
--  Audit Report Finalization "never a stored status column drifting from
--  the raw data" idiom — except here the derived value IS still written to
--  `status` on every change (through fmFlow, same single choke point as
--  before), because the table's own CHECK/filtering already keys off it.
--
--  · outtakes   jsonb array of {date, mode, name, phone, email, remarks,
--               items:[{type,qty}]} — one entry per partial (or full)
--               return event. Summed against doc_types gives what's still
--               remaining per document type.
--  · status     'pending' (no outtakes yet) / 'partial' (some remaining) /
--               'returned' (nothing remaining).
--
--  Dropping the 6 old single-shot handover columns is safe: all 7 existing
--  rows are still 'pending' — none of them are populated.
--
--  Rollback: db/2026-08-09_document_register_outtakes_rollback.sql
-- ════════════════════════════════════════════════════════════════════

alter table public.document_register
  add column if not exists outtakes jsonb not null default '[]'::jsonb;

comment on column public.document_register.outtakes is
  'Array of partial/full return events: {date, mode, name, phone, email, remarks, items:[{type,qty}]}. Summed against doc_types gives what remains with the firm.';

alter table public.document_register
  drop column if exists date_returned,
  drop column if exists returned_to_name,
  drop column if exists returned_to_phone,
  drop column if exists return_remarks,
  drop column if exists mode_returned,
  drop column if exists email_sent;

alter table public.document_register drop constraint if exists document_register_status_check;
alter table public.document_register add constraint document_register_status_check
  check (status in ('pending', 'partial', 'returned'));

comment on column public.document_register.status is
  'Derived (js/fileManagement.js fmDeriveStatus) from doc_types vs outtakes, then written through fmFlow — never hand-set from a fixed button value.';
