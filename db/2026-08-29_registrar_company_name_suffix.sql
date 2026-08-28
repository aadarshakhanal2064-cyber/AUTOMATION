-- ════════════════════════════════════════════
--  One-time normalisation: every registrar company's Devanagari name ends
--  in "प्राईभेट लिमिटेड"
--
--  2026-08-29, user ask. The register's `name` column is what the four
--  registrar document builders actually PRINT on a filing, and none of the
--  49 rows carried the company-type suffix — the firm was adding it by hand
--  on every generated document. Two shapes needed fixing:
--
--    * no suffix at all  -> append " प्राईभेट लिमिटेड"
--    * the short form    -> "… प्रा. लि." becomes "… प्राईभेट लिमिटेड"
--      (also matches "प्रा.लि.", "प्रा लि", "प्रा.लि" — the regex tolerates
--      the optional dots and the optional space the firm types either way)
--
--  A row that ALREADY ends in the full form is left untouched (the WHERE
--  clause), which also makes this file idempotent: running it twice changes
--  nothing the second time.
--
--  DELIBERATELY NOT TOUCHED: rows whose name is pure ASCII. Two test rows
--  ("Avc" and one other) were sitting in the register, and appending a
--  Devanagari suffix to a Latin placeholder produces nonsense rather than a
--  company name. They are reported to the user instead.
--
--  Names are real client data, so the pre-change snapshot lives in the
--  gitignored db/backups/2026-08-29_registrar_company_names_pre_suffix.sql
--  rather than in this file (CLAUDE.md §1 rule 7 — this repo is PUBLIC).
--  That snapshot is the true rollback; the _rollback.sql beside this file
--  reverses the transformation by logic alone for the append case.
-- ════════════════════════════════════════════

update registrar_companies
set name = regexp_replace(btrim(name), '\s*प्रा\.?\s*लि\.?\s*$', '') || ' प्राईभेट लिमिटेड'
where name !~ 'प्राईभेट लिमिटेड'      -- already correct: leave alone
  and name !~ '^[\x20-\x7E]+$';       -- ASCII-only placeholder rows: skip
