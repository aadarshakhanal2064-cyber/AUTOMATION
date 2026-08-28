-- ════════════════════════════════════════════
--  One-time backfill: registrar_companies.name_english from clients.name
--  2026-08-28, user ask ("there are companies already saved as a client in
--  English... I don't wanna manually add them, add it for me").
--
--  Matches by PAN, normalized (Devanagari digits -> ASCII, non-digits
--  stripped), scoped to the same org. Only fills rows where name_english
--  IS NULL, and only where the PAN match is UNAMBIGUOUS (exactly one
--  distinct client name for that PAN) — an ambiguous PAN is left alone for
--  manual review via the PAN-match hint in the Company Profile editor
--  (cpCheckPanMatch()/cpImportClientName(), js/companyProfile.js).
--
--  Already applied via the Supabase MCP on 2026-08-28: 37 of 49 companies
--  matched unambiguously and were filled; the other 12 had no PAN or no
--  matching client and were left for manual entry. This file is the record
--  of what ran, not something that needs re-running — it is naturally
--  idempotent (WHERE name_english IS NULL) if it ever is.
-- ════════════════════════════════════════════

with cnorm as (
  select org_id, name,
         regexp_replace(translate(coalesce(pan,''), '०१२३४५६७८९', '0123456789'), '[^0-9]', '', 'g') as pan_clean
  from clients
),
norm as (
  select id, org_id,
         regexp_replace(translate(coalesce(pan,''), '०१२३४५६७८९', '0123456789'), '[^0-9]', '', 'g') as pan_clean
  from registrar_companies
  where name_english is null
),
matched as (
  select n.id as company_id, c.name
  from norm n
  join cnorm c on c.pan_clean = n.pan_clean and c.org_id = n.org_id and n.pan_clean <> ''
),
to_update as (
  select company_id, min(name) as client_name
  from matched
  group by company_id
  having count(distinct name) = 1
)
update registrar_companies rc
set name_english = tu.client_name
from to_update tu
where rc.id = tu.company_id
returning rc.id, rc.name, rc.name_english;
