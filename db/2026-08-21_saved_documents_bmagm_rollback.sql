-- ════════════════════════════════════════════
--  ROLLBACK — saved_documents: remove module = 'bmAgmMinutes'
--  2026-08-21
--
--  Narrows the CHECK back to the two original modules. This DELETES nothing
--  on its own, but a saved BM/AGM record would then violate the constraint,
--  so the constraint could not be re-added while any exists.
--
--  Run the guard first. If it raises, decide deliberately whether those
--  records are disposable — re-saving one is only a matter of reopening the
--  form and pressing Save again, but the row itself is not recoverable once
--  deleted.
-- ════════════════════════════════════════════

do $$
declare n integer;
begin
  select count(*) into n from public.saved_documents where module = 'bmAgmMinutes';
  if n > 0 then
    raise exception
      'refusing to roll back: % saved BM/AGM minute(s) exist. Delete them first if that is really intended.', n;
  end if;
end $$;

alter table public.saved_documents
  drop constraint saved_documents_module_check;

alter table public.saved_documents
  add constraint saved_documents_module_check
  check (module = any (array['report'::text, 'notesToAccounts'::text]));
