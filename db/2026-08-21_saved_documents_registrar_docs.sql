-- ════════════════════════════════════════════
--  saved_documents: allow the remaining three registrar document modules
--  2026-08-21
--
--  Company Secretary Appointment, Auditor Change and Company Registration
--  gain Save-to-database and a searchable saved-documents drawer, the same
--  pair BM/AGM Minutes got earlier today (db/2026-08-21_saved_documents_
--  bmagm.sql) and Generate Report / Notes to Accounts have had since
--  2026-08-02. Per the standing decision that saved documents are ONE table
--  with a `module` discriminator (CLAUDE.md §15), adding builders is values
--  on this CHECK — not new tables, and not more picker drawers.
--
--  All three use the columns the way BM/AGM does, for the same reasons:
--
--    * client_id STAYS NULL. It is FK'd to clients(id), and a registrar
--      company is a registrar_companies row (or, for Company Registration,
--      no row anywhere yet — the company does not exist until the registrar
--      accepts the filing). client_name (NOT NULL) carries the company and
--      is what the picker searches.
--
--    * doc_html STAYS NULL. All three render Word files from tokenised
--      templates — regenerating from `state` reproduces the document
--      exactly, so there is nothing a stored copy would preserve.
-- ════════════════════════════════════════════

alter table public.saved_documents
  drop constraint saved_documents_module_check;

alter table public.saved_documents
  add constraint saved_documents_module_check
  check (module = any (array[
    'report'::text,
    'notesToAccounts'::text,
    'bmAgmMinutes'::text,
    'companySecretary'::text,
    'auditorChange'::text,
    'companyRegistration'::text
  ]));
