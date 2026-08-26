-- Rollback for 2026-08-26_saved_documents_audit_engagement.sql
--
-- Restores the CHECK as it stood after 2026-08-21_saved_documents_registrar_docs.sql.
-- NOTE: re-adding the narrower CHECK fails while any row carries the removed
-- module value — the delete below removes those saved letters (re-creatable
-- from the module's form, but gone is gone; export first if any matter).

delete from public.saved_documents
  where module = 'auditEngagement';

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
