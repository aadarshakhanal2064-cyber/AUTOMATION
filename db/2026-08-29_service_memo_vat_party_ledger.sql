-- ════════════════════════════════════════════════════════════════════════
--  SERVICE MEMO — "VAT to Party Ledger" marker  (2026-08-29)
--
--  User ask: on VAT Register → VAT Collected, the outstanding list offers
--  "Record collection" for a memo's VAT. A second route is needed beside it,
--  because there are two ways a memo's VAT stops being outstanding:
--
--    · the client pays the VAT to the firm      → Record collection
--    · the FIRM pays the client's VAT for them  → this marker
--
--  ("sometimes client pays the vat themselves and sometimes i pay for them
--   which i already include in my fee")
--
--  WHY A MARKER ON THE MEMO AND NOT A NEW TABLE
--  --------------------------------------------
--  Which of those two happened is a fact ABOUT that memo's VAT, not a new
--  business record. vat_collections exists because a collection has its own
--  date, voucher, bank and amount; "the firm bore this VAT" has none of
--  those — it is one bit plus a trail. A table would also give the outstanding
--  list a second thing to LEFT JOIN for no gain.
--
--  Presence of vat_ledger_at IS the flag; there is deliberately no separate
--  boolean, so the two can never disagree about whether it is set.
--
--  DELIBERATELY NOT WIRED INTO PARTY LEDGER YET (user: "we will add features
--  later where to connect and all"). The arithmetic is genuinely ambiguous
--  and getting a receivable's sign wrong is worse than leaving it unposted:
--  plBuildParties() already pushes each memo's total_amount — which INCLUDES
--  vat_amount — onto the party's services, so the client is currently charged
--  that VAT in the ledger already. Whether "the firm pays it for them"
--  should therefore RAISE the balance (a tax paid on their behalf, the
--  existing p.taxes bucket) or LEAVE IT ALONE (the fee already covered it, so
--  the service line is correct as it stands) is a question about the firm's
--  own billing, not something to infer. Until that is answered this column
--  only records what happened. See docs/modules/financial-management.md.
--
--  Rollback: db/2026-08-29_service_memo_vat_party_ledger_rollback.sql
-- ════════════════════════════════════════════════════════════════════════

alter table public.service_memos
  add column if not exists vat_ledger_at timestamptz,
  add column if not exists vat_ledger_by text;

comment on column public.service_memos.vat_ledger_at is
  'Set when this memo''s VAT was marked as borne by the firm and carried to the client''s party ledger. NULL = not marked; presence IS the flag.';
comment on column public.service_memos.vat_ledger_by is
  'Email of the staff member who marked it. Cleared together with vat_ledger_at on undo.';

-- Every read is "the marked ones for this firm and year", and the column is
-- null for almost every row, so a partial index costs nothing and keeps the
-- outstanding list's filter off a sequential scan as memos accumulate.
create index if not exists service_memos_vat_ledger_idx
  on public.service_memos (firm_key, vat_ledger_at)
  where vat_ledger_at is not null;

-- No RLS change: these are columns on an existing table, already covered by
-- service_memos' own member policies (and, from the section-lock migration
-- onward, by private.fin_unlocked() as well).

do $verify$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema='public' and table_name='service_memos'
       and column_name in ('vat_ledger_at','vat_ledger_by')
     having count(*) = 2) then
    raise exception 'vat_ledger_at / vat_ledger_by were not both created';
  end if;
end
$verify$;
