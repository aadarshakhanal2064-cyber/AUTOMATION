-- ════════════════════════════════════════════
--  Company Profile: English name + OCR portal credentials
--
--  2026-08-28, user ask (Company Registrar → Company Profile):
--    1. Every company gets an English-name field alongside the existing
--       Devanagari `name` column — used to import a name from the Clients
--       directory when the two share a PAN (js/companyProfile.js, a narrow
--       read-only exception to "no registrar module reads window.clientsList",
--       CLAUDE.md §15).
--    2. The firm does its Company Registration filings through the Office of
--       Company Registrar (OCR) website, and every company has its own
--       login there. Storing it here means any staff member can find it
--       without asking around — same visibility/edit rule as every other
--       registrar_companies column (member write, admin-only add/delete).
--
--  No RLS changes: registrar_companies' existing policies already cover
--  every column on the row, so these three need nothing new.
-- ════════════════════════════════════════════

alter table public.registrar_companies
  add column if not exists name_english   text,
  add column if not exists ocr_username   text,
  add column if not exists ocr_password   text;

comment on column public.registrar_companies.name_english is
  'English-script company name, distinct from the Devanagari `name` column. Optionally imported from a clients row sharing the same PAN (js/companyProfile.js cpImportClientName()).';
comment on column public.registrar_companies.ocr_username is
  'Login username for this company on the Office of Company Registrar (OCR) website. Visible/editable to every org member, same as the rest of this table.';
comment on column public.registrar_companies.ocr_password is
  'Login password for this company on the Office of Company Registrar (OCR) website. Stored in plain text (no app-level secret store exists) and gated only by this table''s existing RLS — every org member can read and write it, by design (shared staff access).';
