-- Rollback for 2026-08-21_saved_documents_registrar_docs.sql
--
-- Restores the CHECK as it stood after 2026-08-21_saved_documents_bmagm.sql.
-- NOTE: re-adding the narrower CHECK fails while any row carries one of the
-- three removed module values — the delete below removes those saved records
-- (they are re-creatable from the modules' forms, but gone is gone; export
-- first if any matter).

delete from public.saved_documents
  where module in ('companySecretary', 'auditorChange', 'companyRegistration');

alter table public.saved_documents
  drop constraint saved_documents_module_check;

alter table public.saved_documents
  add constraint saved_documents_module_check
  check (module = any (array['report'::text, 'notesToAccounts'::text, 'bmAgmMinutes'::text]));
