-- ════════════════════════════════════════════════════════════════════
--  ROLLBACK — document_register (2026-08-01)
--  Reverses db/2026-08-01_document_register.sql. Dropping the table takes
--  its policies, indexes and triggers with it via CASCADE. The register-
--  number trigger function is dropped explicitly (it is used by nothing
--  else); the shared public.set_updated_at() function is left in place
--  (other tables use it).
-- ════════════════════════════════════════════════════════════════════

drop table if exists public.document_register cascade;
drop function if exists public.set_document_register_number();
