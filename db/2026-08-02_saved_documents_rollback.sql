-- ════════════════════════════════════════════════════════════════════
--  ROLLBACK — db/2026-08-02_saved_documents.sql
--
--  DESTRUCTIVE: drops the table and every saved Audit Report / Notes to
--  Accounts document with it. Take a backup first if any real documents
--  have been saved.
-- ════════════════════════════════════════════════════════════════════

drop trigger if exists set_saved_documents_updated_at on public.saved_documents;

drop policy if exists saved_documents_select_member on public.saved_documents;
drop policy if exists saved_documents_insert_member on public.saved_documents;
drop policy if exists saved_documents_update_member on public.saved_documents;
drop policy if exists saved_documents_delete_member on public.saved_documents;

drop index if exists public.saved_documents_module_idx;
drop index if exists public.saved_documents_client_idx;

drop table if exists public.saved_documents;
