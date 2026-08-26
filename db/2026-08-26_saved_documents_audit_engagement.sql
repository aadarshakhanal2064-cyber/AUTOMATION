-- ════════════════════════════════════════════
--  saved_documents: allow the Audit Engagement Letter builder
--  2026-08-26
--
--  js/auditEngagement.js (`ae-` prefix, Automation Hub) is the fourth HTML
--  document builder, alongside Generate Report and Notes to Accounts. Per
--  the standing decision that saved documents are ONE table with a `module`
--  discriminator (CLAUDE.md §15), adding a builder is one value on this
--  CHECK — not a new table, and not a second picker drawer.
--
--  It uses the columns the way `report` and `notesToAccounts` do, not the way
--  the four registrar modules do:
--
--    * client_id is FILLED when the typed name resolves to a `clients` row.
--      The engagement letter is addressed to an audit client, which is a
--      clients row — unlike a registrar filing, whose company lives in
--      registrar_companies and therefore has to leave this NULL.
--
--    * doc_html is STORED. The preview is contenteditable, so the form state
--      alone cannot reproduce a hand-edited letter — and a signed engagement
--      letter is precisely the document that must reprint exactly as issued.
--
--    * fiscal_year holds the FIRST engagement year. A letter can cover
--      several years (the fee table is one row per year, and §5 lists them
--      all); the full list lives in `state`, and this column is the picker's
--      sort/search handle, which is why it is the first year rather than a
--      joined string no other module's column would match.
-- ════════════════════════════════════════════

alter table public.saved_documents
  drop constraint saved_documents_module_check;

alter table public.saved_documents
  add constraint saved_documents_module_check
  check (module = any (array[
    'report'::text,
    'notesToAccounts'::text,
    'auditEngagement'::text,
    'bmAgmMinutes'::text,
    'companySecretary'::text,
    'auditorChange'::text,
    'companyRegistration'::text
  ]));
