-- Rollback for 2026-08-29_registrar_company_name_suffix.sql
--
-- PREFER THE SNAPSHOT: db/backups/2026-08-29_registrar_company_names_pre_suffix.sql
-- restores all 47 affected rows to their exact prior text, including the one
-- row whose "प्रा. लि." short form this migration expanded (that expansion is
-- NOT reversible by logic — the statement below would leave it with no
-- suffix at all rather than restoring the short form).
--
-- The statement below is the logic-only fallback for when that gitignored
-- snapshot is unavailable: it strips the appended suffix, which is correct
-- for the 46 rows that simply had it appended.
update registrar_companies
set name = regexp_replace(name, '\s*प्राईभेट लिमिटेड\s*$', '')
where name ~ 'प्राईभेट लिमिटेड\s*$';
