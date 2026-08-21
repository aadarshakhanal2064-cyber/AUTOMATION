-- ════════════════════════════════════════════
--  saved_documents: allow module = 'bmAgmMinutes'
--  2026-08-21
--
--  BM/AGM Minutes gains Save-to-database and a searchable "Saved minutes"
--  drawer, the same pair Generate Report and Notes to Accounts already
--  have. Per the standing decision that saved documents are ONE table with
--  a `module` discriminator (CLAUDE.md §15), adding a builder is one value
--  on this CHECK — not a new table, and not a second picker drawer.
--
--  Nothing else about the table changes. Two notes on how BM/AGM uses the
--  existing columns, because both differ from the two current callers:
--
--    * client_id STAYS NULL. It is FK'd to clients(id), and a BM/AGM
--      company is a registrar_companies row, not a clients row — the two
--      directories are separate by design (CLAUDE.md §15: "no registrar
--      module reads window.clientsList"). Writing a registrar id into this
--      column would either violate the FK or, worse, silently point at an
--      unrelated client that happens to share the id. client_name (NOT
--      NULL) carries the company, and is what the picker searches.
--
--    * doc_html STAYS NULL. Report and Notes store their rendered HTML
--      because their previews are contenteditable and the hand-edited
--      document IS what the firm issued. BM/AGM renders a Word file from a
--      tokenised template — regenerating from `state` reproduces it
--      exactly, so there is nothing a stored copy would preserve.
-- ════════════════════════════════════════════

alter table public.saved_documents
  drop constraint saved_documents_module_check;

alter table public.saved_documents
  add constraint saved_documents_module_check
  check (module = any (array['report'::text, 'notesToAccounts'::text, 'bmAgmMinutes'::text]));
