-- ════════════════════════════════════════════════════════════════════
--  ROLLBACK — work_todos  (2026-08-17)
--  Reverses db/2026-08-17_work_todos.sql.
--
--  ⚠️  DESTRUCTIVE. The To-Do List's tasks live nowhere else — they are not
--  derived from document_register the way the Pending List is, and they are
--  not a copy of anything in work_done. Dropping this table deletes every
--  open and completed task outright. Take a backup first if the module has
--  been in real use:
--      supabase db dump --data-only --table public.work_todos
-- ════════════════════════════════════════════════════════════════════

drop policy if exists wt_select_member on public.work_todos;
drop policy if exists wt_insert_member on public.work_todos;
drop policy if exists wt_update_member on public.work_todos;
drop policy if exists wt_delete_member on public.work_todos;

drop trigger if exists set_wt_updated_at on public.work_todos;

-- Indexes and constraints go with the table; listed here only so the reverse
-- of the migration is readable at a glance.
drop table if exists public.work_todos;
