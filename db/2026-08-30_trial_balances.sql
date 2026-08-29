-- ════════════════════════════════════════════════════════════════════════
--  trial_balances — the Trial Balance module's typed ledgers (2026-08-30)
--
--  Automation Hub → Trial Balance. The preparer types the firm's own trial
--  balance and the balance sheet and income statement are drawn off it; typing
--  on either statement writes back to the ledger. There is one set of numbers,
--  so there is one row.
--
--  ONE ROW PER (client, fiscal year), and that is not a convention here but
--  the point: a second trial balance for the same year is always a mistake.
--  The module adopts an existing row before inserting, and the partial unique
--  index below is what makes that guarantee rather than a habit. It is
--  PARTIAL because client_id is nullable — a sheet is routinely drawn for a
--  name typed free, and NULLs never collide in a unique index anyway, so the
--  predicate says so explicitly rather than relying on that.
--
--  `data` carries the typed state whole (sections, detail lines, the loan
--  current/non-current overrides, the ledger line named as the income tax
--  charge). Every FIGURE is re-derived from it on load and none is stored:
--  a saved total is a total that can drift from the lines under it, which is
--  the rule autobooks_books already follows for the same reason.
--
--  NOT part of Financial Management, so no private.fin_unlocked() conjunct —
--  a client's trial balance is a client's book, the way Autobooks is, and the
--  locked section is the FIRM's own money (db/2026-08-29_financial_section_lock.sql).
-- ════════════════════════════════════════════════════════════════════════

create table public.trial_balances (
  id            bigint generated always as identity primary key,
  org_id        bigint not null default private.current_org_id()
                references public.organizations (id) on delete cascade,
  -- Nullable and SET NULL on delete, like provisional_statements: the sheet
  -- outlives the directory entry, and losing a client record must not destroy
  -- a year's ledger.
  client_id     bigint references public.clients (id) on delete set null,
  company_name  text not null,
  pan           text,
  address       text,
  fiscal_year   text not null,        -- dash format, '2082-83'
  -- The A.D. equivalent printed in brackets on the statements. TEXT and typed,
  -- never computed: NepaliLocale carries no B.S.-to-A.D. table, and inventing
  -- a conversion would put a wrong date on a signed statement.
  as_at_date    text,
  -- private | partnership | proprietorship. Drives the capital head on the
  -- ledger AND the balance sheet, so the two cannot disagree (CLAUDE.md §15).
  -- Free text with no CHECK, the audit_report_finalization.auditor precedent:
  -- a value the UI stops offering must still open.
  entity_type   text,
  data          jsonb not null,
  created_by    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index trial_balances_org_idx     on public.trial_balances (org_id);
create index trial_balances_lookup_idx  on public.trial_balances (org_id, company_name, fiscal_year);

-- The duplicate guard. Scoped by org, like autobooks_books' re-keyed index —
-- two firms may each hold a sheet for their own client with the same id space.
create unique index trial_balances_client_fy_uniq
  on public.trial_balances (org_id, client_id, fiscal_year)
  where client_id is not null;

create trigger set_trial_balances_updated_at
  before update on public.trial_balances
  for each row execute function public.set_updated_at();

-- RLS: member CRUD, org-scoped. The private.* helpers are WRAPPED in
-- (select …) — bare, they are re-evaluated per candidate row, which is the
-- per-row tax db/2026-08-21_rls_initplan_policies.sql removed everywhere else
-- (CLAUDE.md §6). Identical semantics; the functions read only the JWT.
alter table public.trial_balances enable row level security;

create policy trial_balances_select_member on public.trial_balances
  for select using ((select private.is_app_user()) and org_id = (select private.current_org_id()));
create policy trial_balances_insert_member on public.trial_balances
  for insert with check ((select private.is_app_user()) and org_id = (select private.current_org_id()));
create policy trial_balances_update_member on public.trial_balances
  for update using ((select private.is_app_user()) and org_id = (select private.current_org_id()))
          with check ((select private.is_app_user()) and org_id = (select private.current_org_id()));
create policy trial_balances_delete_member on public.trial_balances
  for delete using ((select private.is_app_user()) and org_id = (select private.current_org_id()));
