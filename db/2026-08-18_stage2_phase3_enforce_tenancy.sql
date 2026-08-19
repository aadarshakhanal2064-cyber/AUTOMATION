-- ════════════════════════════════════════════════════════════════════════════
--  STAGE 2 · PHASE 3 — enforcement. THIS IS THE ONE THAT CHANGES BEHAVIOUR.
--
--  Part of converting this app from one firm to ~10. Full scope:
--  https://claude.ai/code/artifact/c372d471-8003-4d50-8bd7-92197ee2094c
--
--  Depends on: Phase 1 (scaffold) and Phase 2 (backfill, verified zero NULLs).
--  Running this against a half-filled database is the one genuinely dangerous
--  thing in this project — Phase 2's own gate is what prevents it, and §1 below
--  re-checks anyway rather than trusting that it was run.
--
--  WHAT THIS DOES
--    1. Re-proves zero NULLs, then sets org_id NOT NULL on all 22 tables.
--    2. Re-keys autobooks_books' unique index from (book_key) to
--       (org_id, book_key).
--    3. Rewrites all 82 policies to compare org_id against the caller's own
--       organisation.
--
--  WHY THIS IS SAFE TO SHIP BEFORE ANY SECOND FIRM EXISTS
--    With exactly one organisation, `org_id = private.current_org_id()` is
--    true for every row a member can already see, so the result of every query
--    is IDENTICAL to before. The change is inert today and load-bearing the
--    moment a second organisation is created. That is precisely why it lands
--    now rather than during an onboarding.
--
--  DDL IN POSTGRES IS TRANSACTIONAL. All three sections are one transaction:
--  if any policy fails to rewrite, the NOT NULLs and the index swap roll back
--  with it. There is no half-applied state to clean up.
--
--  ROLLBACK: db/2026-08-18_stage2_phase3_enforce_tenancy_rollback.sql
--  Restores the membership-only policies, the global book_key index, and drops
--  the NOT NULLs. Verified on staging in both directions.
-- ════════════════════════════════════════════════════════════════════════════


-- ── 1. Re-prove the backfill, then enforce it ───────────────────────────────
-- Phase 2 already checked this. It is checked AGAIN here because the two files
-- may be run days apart, by different hands, and the cost of being wrong is a
-- database where every screen looks empty.
do $$
declare
  t         text;
  leftover  bigint;
  offenders text := '';
  tables    text[] := array[
    'clients', 'client_shareholders',
    'send_logs', 'audit_log',
    'service_memos', 'service_memo_fee_skips',
    'depreciation_schedules',
    'bank_accounts', 'bank_transactions',
    'party_opening_balances',
    'financial_statements', 'projection_reports',
    'document_register', 'saved_documents',
    'audit_report_finalization', 'audit_checklists',
    'work_done', 'work_todos',
    'autobooks_books', 'autobooks_entries',
    'autobooks_parties', 'autobooks_adjustments'
  ];
begin
  foreach t in array tables loop
    execute format('select count(*) from public.%I where org_id is null', t) into leftover;
    if leftover > 0 then
      offenders := offenders || format('%s (%s rows), ', t, leftover);
    end if;
  end loop;

  if offenders <> '' then
    raise exception
      'REFUSING to enforce — org_id is still NULL in: %. Run Phase 2 first.',
      rtrim(offenders, ', ');
  end if;

  foreach t in array tables loop
    execute format('alter table public.%I alter column org_id set not null', t);
  end loop;

  raise notice 'org_id is now NOT NULL on % tables.', array_length(tables, 1);
end $$;


-- ── 2. The one colliding unique key ─────────────────────────────────────────
-- autobooks_books.book_key is GENERATED as
--     coalesce('c:'||client_id, 'n:'||btrim(lower(client_name))) || '|' || fiscal_year
-- and was UNIQUE across the entire table. When a book has a client attached the
-- key carries a globally-unique client id and cannot clash. The clash is in the
-- fallback: a WALK-IN book keys on the typed name, so two firms each opening a
-- 2082-83 book for a "Ram Traders" would collide and the second firm's save
-- would be rejected outright.
--
-- Fixed by re-keying the INDEX rather than regenerating the COLUMN, which the
-- original plan assumed would be necessary. Nothing in the app reads or writes
-- book_key — js/salesPurchaseBookLedger.js deliberately does select-then-
-- insert-or-update on (client, fiscal_year) instead of an upsert naming it —
-- so the column's value can stay exactly as it is. This makes what the plan
-- called the project's one-way door into an ordinary reversible index swap.
drop index if exists public.autobooks_books_key_uniq;
create unique index autobooks_books_key_uniq
  on public.autobooks_books using btree (org_id, book_key);


-- ── 3. Rewrite all 82 policies ──────────────────────────────────────────────
-- Generated from pg_policies rather than hand-written. 82 hand-typed policies
-- is 82 chances to omit one table or mistype one clause, and a single missed
-- policy is a live cross-tenant hole that no amount of reading reliably finds.
-- Reading the catalogue means every policy that EXISTS is rewritten, including
-- any added between this file being written and being run.
--
-- The transformation is uniform: whatever the policy already required, it now
-- ALSO requires the row to belong to the caller's organisation. Nothing is
-- relaxed — is_admin() stays is_admin(), send_logs keeps its per-sender rule.
--
-- All 82 are PERMISSIVE and granted to `authenticated`, verified against the
-- catalogue before writing this; the recreate below therefore hardcodes
-- neither and reads both from the row.
do $$
declare
  r        record;
  chk      constant text := 'org_id = private.current_org_id()';
  new_qual text;
  new_chk  text;
  n        integer := 0;
begin
  for r in
    select tablename, policyname, cmd, permissive,
           array_to_string(roles, ', ') as role_list, qual, with_check
    from pg_policies
    where schemaname = 'public'
      and tablename = any (array[
        'clients', 'client_shareholders',
        'send_logs', 'audit_log',
        'service_memos', 'service_memo_fee_skips',
        'depreciation_schedules',
        'bank_accounts', 'bank_transactions',
        'party_opening_balances',
        'financial_statements', 'projection_reports',
        'document_register', 'saved_documents',
        'audit_report_finalization', 'audit_checklists',
        'work_done', 'work_todos',
        'autobooks_books', 'autobooks_entries',
        'autobooks_parties', 'autobooks_adjustments'
      ])
    order by tablename, policyname
  loop
    -- Skip anything already scoped, so this file is idempotent and can be
    -- re-run after a partial recovery without double-wrapping the expression.
    if coalesce(r.qual, '') like '%current_org_id%'
       or coalesce(r.with_check, '') like '%current_org_id%' then
      continue;
    end if;

    new_qual := case when r.qual       is null then null
                     else '(' || r.qual       || ') and ' || chk end;
    new_chk  := case when r.with_check is null then null
                     else '(' || r.with_check || ') and ' || chk end;

    execute format('drop policy %I on public.%I', r.policyname, r.tablename);

    execute format('create policy %I on public.%I as %s for %s to %s %s %s',
      r.policyname,
      r.tablename,
      case when r.permissive = 'PERMISSIVE' then 'permissive' else 'restrictive' end,
      r.cmd,
      r.role_list,
      case when new_qual is null then '' else 'using (' || new_qual || ')' end,
      case when new_chk  is null then '' else 'with check (' || new_chk || ')' end
    );

    n := n + 1;
  end loop;

  raise notice 'Rewrote % policies to be organisation-scoped.', n;

  -- A tenant table that ends up with no org-scoped policy is exactly the hole
  -- this whole stage exists to close, so fail rather than report success.
  if exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = any (array[
        'clients', 'client_shareholders', 'send_logs', 'audit_log',
        'service_memos', 'service_memo_fee_skips', 'depreciation_schedules',
        'bank_accounts', 'bank_transactions', 'party_opening_balances',
        'financial_statements', 'projection_reports', 'document_register',
        'saved_documents', 'audit_report_finalization', 'audit_checklists',
        'work_done', 'work_todos', 'autobooks_books', 'autobooks_entries',
        'autobooks_parties', 'autobooks_adjustments'
      ])
      and coalesce(qual, '')       not like '%current_org_id%'
      and coalesce(with_check, '') not like '%current_org_id%'
  ) then
    raise exception 'A tenant policy was left unscoped. Rolling back.';
  end if;
end $$;


-- ── 3b. app_users — the one table that cannot be org-scoped ─────────────────
-- Found by the staging rehearsal, not by design: after §3 rewrote the 82,
-- exactly one policy on a non-org table was still membership-only, and it was
-- this one. app_users has no org_id on purpose (org_members supersedes it),
-- so it CANNOT be scoped the same way — and left alone it means any member of
-- any firm can read every other firm's staff email addresses. That is a real
-- cross-tenant leak, small but exactly the kind this stage exists to close.
--
-- Restricting it to the caller's own row is safe because js/auth.js is the
-- only reader in the entire codebase (verified: one `.from('app_users')` call)
-- and it already fetches just its own row —
--     .select('email, role').ilike('email', email).maybeSingle()
-- private.is_app_user() and private.is_admin() are SECURITY DEFINER and so
-- bypass RLS here, which is why tightening this does not break authorization
-- anywhere else.
--
-- jwt_email() lowercases, so compare against lower(email) — the same rule that
-- makes auth.js use .ilike() rather than .eq() (CLAUDE.md §7).
drop policy if exists app_users_select_member on public.app_users;
create policy app_users_select_own on public.app_users
  for select to authenticated
  using (lower(email) = private.jwt_email());


-- ── 3c. Membership moves to org_members ────────────────────────────────────
-- NOT optional, and not a tidy-up. The staging rehearsal seeded a second
-- organisation and found that its user could see NOTHING AT ALL — not even
-- their own rows. Every rewritten policy reads
--     private.is_app_user() and org_id = private.current_org_id()
-- and while current_org_id() reads org_members, is_app_user() still read
-- app_users, which only ever contained the original firm's three staff. A
-- newly onboarded firm therefore failed the first half of every policy.
--
-- So the two halves must consult the same register. This is the cutover the
-- plan listed as a decision; the test turned it into a prerequisite. Keeping
-- both tables live would mean two answers to "who is allowed in", and a
-- disagreement between them is precisely the bug class this stage exists to
-- remove.
--
-- Both helpers now also require the member AND the organisation to be active,
-- matching current_org_id() exactly — so suspending a firm revokes access
-- through every path at once rather than only through the tenancy check.
--
-- 'owner' is treated as admin: org_members has a role app_users never had, and
-- the person who owns the organisation must not have fewer rights than an
-- admin inside it.
--
-- app_users is deliberately left in place, populated and untouched. Nothing
-- reads it after this except js/auth.js's own-row lookup, and it is the
-- rollback path if this cutover misbehaves.
create or replace function private.is_app_user()
returns boolean
language sql stable security definer set search_path to ''
as $function$
  select exists (
    select 1
    from public.org_members m
    join public.organizations o on o.id = m.org_id
    where lower(m.email) = private.jwt_email()
      and m.status = 'active'
      and o.status = 'active'
  );
$function$;

create or replace function private.is_admin()
returns boolean
language sql stable security definer set search_path to ''
as $function$
  select exists (
    select 1
    from public.org_members m
    join public.organizations o on o.id = m.org_id
    where lower(m.email) = private.jwt_email()
      and m.role in ('owner','admin')
      and m.status = 'active'
      and o.status = 'active'
  );
$function$;

-- Guard: every app_users row must have an org_members counterpart before this
-- takes effect, or that person is locked out the moment it does.
do $$
declare orphans text;
begin
  select string_agg(u.email, ', ') into orphans
  from public.app_users u
  where not exists (
    select 1 from public.org_members m where lower(m.email) = lower(u.email)
  );
  if orphans is not null then
    raise exception
      'REFUSING to cut membership over — these app_users have no org_members row and would be locked out: %',
      orphans;
  end if;
end $$;


-- ── 4. Verify ───────────────────────────────────────────────────────────────
-- Expect: not_null_cols 22 · unscoped_policies 0 · scoped_policies 88
--         book_key_index "CREATE UNIQUE INDEX ... (org_id, book_key)"
--
-- scoped_policies counts 88, not 82: the 82 rewritten here PLUS the 6 created
-- org-scoped from birth on the three new tables in Phase 1.
--
-- unscoped_policies excludes app_users, which is scoped by §3b to the caller's
-- own row rather than by organisation — it is the single table that legitimately
-- has no org_id. Anything else appearing here is a hole.
select
  (select count(*) from information_schema.columns
     where table_schema='public' and column_name='org_id'
       and is_nullable='NO'
       and table_name <> 'org_members' and table_name <> 'org_firms')  as not_null_cols,
  (select count(*) from pg_policies
     where schemaname='public'
       and tablename not in ('organizations','org_members','org_firms','app_users')
       and coalesce(qual,'')       not like '%current_org_id%'
       and coalesce(with_check,'') not like '%current_org_id%')        as unscoped_policies,
  (select count(*) from pg_policies
     where schemaname='public'
       and (coalesce(qual,'')       like '%current_org_id%'
         or coalesce(with_check,'') like '%current_org_id%'))          as scoped_policies,
  (select indexdef from pg_indexes
     where schemaname='public' and indexname='autobooks_books_key_uniq') as book_key_index;
