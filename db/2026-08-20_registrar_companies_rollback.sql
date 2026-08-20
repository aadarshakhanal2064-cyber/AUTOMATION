-- ════════════════════════════════════════════════════════════════════
--  ROLLBACK — put the registrar companies back into `clients`
--  Undoes db/2026-08-20_registrar_companies.sql                (2026-08-20)
--
--  Moves every registrar_companies row back into `clients`, rebuilds
--  client_shareholders from registrar_shareholders, then drops both new
--  tables. One transaction, verified the same way the forward migration is.
--
--  WHAT THIS CANNOT RESTORE: the original `clients.id` values. The rows come
--  back with new ids. That is harmless HERE and only here — the forward
--  migration measured that no row in any other table referenced any of the 45,
--  which is the whole reason the move was safe. If that ever stops being true,
--  this rollback stops being lossless, and the row-level backup in
--  db/backups/2026-08-20_backup is the path to use instead.
--
--  Also note: any company ADDED through Company Profile after the migration
--  comes back as a client row too, since by then it is indistinguishable from
--  the original 45 — same shape, same purpose. Nothing is dropped on the floor.
-- ════════════════════════════════════════════════════════════════════

begin;

-- ── 1. Rebuild client_shareholders exactly as it was ─────────────────
-- Same columns, same defaults, same two policies it actually had (SELECT for
-- members, INSERT for admins — it never had UPDATE or DELETE).
create table public.client_shareholders (
  id         bigint generated always as identity primary key,
  client_id  bigint not null references public.clients(id) on delete cascade,
  name       text not null,
  sort_order integer default 0,
  org_id     bigint not null default private.current_org_id()
               references public.organizations(id) on delete restrict
);

create index client_shareholders_org_idx on public.client_shareholders (org_id);

alter table public.client_shareholders enable row level security;

create policy client_shareholders_select_member on public.client_shareholders
  for select using (private.is_app_user() and org_id = private.current_org_id());
create policy client_shareholders_insert_admin on public.client_shareholders
  for insert with check (private.is_admin() and org_id = private.current_org_id());

-- ── 2. Move the companies back, shareholders with them ───────────────
-- Row by row for the same reason the forward migration is: each company's
-- shareholders attach to the client id Postgres generates for it here.
do $$
declare r record; new_id bigint;
begin
  for r in select * from public.registrar_companies order by id loop
    insert into public.clients (
      org_id, name, registration_number, pan, address, country,
      chairman_name, shareholder_name,
      authorized_capital, issued_capital, paid_up_capital, created_at
    ) values (
      r.org_id, r.name, r.registration_number, r.pan, r.address, r.country,
      r.chairman_name, r.shareholder_name,
      r.authorized_capital, r.issued_capital, r.paid_up_capital, r.created_at
    ) returning id into new_id;

    insert into public.client_shareholders (org_id, client_id, name, sort_order)
    select rs.org_id, new_id, rs.name, rs.sort_order
      from public.registrar_shareholders rs
     where rs.company_id = r.id
     order by rs.sort_order, rs.id;
  end loop;
end $$;

-- ── 3. Prove it before dropping anything ─────────────────────────────
do $$
declare want_c int; got_c int; want_s int; got_s int;
begin
  select count(*) into want_c from public.registrar_companies;
  select count(*) into want_s from public.registrar_shareholders;
  select count(*) into got_c  from public.clients where registration_number is not null;
  select count(*) into got_s  from public.client_shareholders;

  if got_c <> want_c then
    raise exception 'Restore incomplete: % companies expected in clients, % found.', want_c, got_c;
  end if;
  if got_s <> want_s then
    raise exception 'Restore incomplete: % shareholders expected, % found.', want_s, got_s;
  end if;
  raise notice 'Restored % companies and % shareholders into clients.', got_c, got_s;
end $$;

-- ── 4. Drop the registrar tables ─────────────────────────────────────
-- registrar_shareholders first: it FKs the companies table.
drop table public.registrar_shareholders;
drop table public.registrar_companies;

commit;

-- ── After running this ───────────────────────────────────────────────
-- The app code must be reverted too, or Company Registrar will query two
-- tables that no longer exist. Revert the commit that shipped
-- js/registrarCompanies.js and the changes to js/companyProfile.js,
-- js/bmAgmMinutes.js, js/auditorChange.js, js/companySecretary.js and
-- js/clients.js alongside this script.
