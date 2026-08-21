-- ════════════════════════════════════════════════════════════════════════
--  provisional_statements — saved Provisional Statement workings (2026-08-22)
--
--  The Provisional Statement module was deliberately stateless ("derived per
--  run") until the user asked for a save-to-database option reusing the
--  Projection Report pattern. Same shape as projection_reports: identity
--  snapshot columns for the picker, one `inputs` jsonb carrying EVERYTHING
--  needed to rehydrate the screen (parsed prior year, this year's figures,
--  rules, loans, PPE grid, TDS/stock schedules, UI state), and the module's
--  own engine re-derives the statements on load — figures are never read
--  back from a stored total that could have drifted (the Autobooks rule).
--
--  Saving updates the SAME row for a (company, fiscal year) rather than
--  inserting a sibling — the projection_reports "Updation" semantics without
--  the mode toggle.
-- ════════════════════════════════════════════════════════════════════════

create table public.provisional_statements (
  id            bigint generated always as identity primary key,
  org_id        bigint not null default private.current_org_id()
                references public.organizations (id) on delete cascade,
  -- Directory clients only loosely: a provisional set is routinely drawn for
  -- a name typed free, so the FK is nullable and survives a client delete.
  client_id     bigint references public.clients (id) on delete set null,
  company_name  text not null,
  pan           text,
  fiscal_year   text not null,        -- dash format, '2082-83'
  inputs        jsonb not null,
  created_by    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index provisional_statements_org_idx    on public.provisional_statements (org_id);
create index provisional_statements_client_idx on public.provisional_statements (org_id, company_name, fiscal_year);

create trigger set_provisional_statements_updated_at
  before update on public.provisional_statements
  for each row execute function public.set_updated_at();

-- RLS: member CRUD, org-scoped — the projection_reports matrix verbatim.
alter table public.provisional_statements enable row level security;

create policy provisional_statements_select_member on public.provisional_statements
  for select using (private.is_app_user() and org_id = private.current_org_id());
create policy provisional_statements_insert_member on public.provisional_statements
  for insert with check (private.is_app_user() and org_id = private.current_org_id());
create policy provisional_statements_update_member on public.provisional_statements
  for update using (private.is_app_user() and org_id = private.current_org_id())
          with check (private.is_app_user() and org_id = private.current_org_id());
create policy provisional_statements_delete_member on public.provisional_statements
  for delete using (private.is_app_user() and org_id = private.current_org_id());
