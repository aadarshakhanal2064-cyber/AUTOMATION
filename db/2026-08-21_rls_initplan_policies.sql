-- ════════════════════════════════════════════════════════════════════
--  RLS INITPLAN REWRITE — evaluate membership once per QUERY, not per ROW
--  2026-08-21 · Stage 1a of the performance overhaul (user-approved plan)
--
--  WHY. Every tenant policy is written as
--        private.is_app_user() AND org_id = private.current_org_id()
--  Both are STABLE SECURITY DEFINER functions that each run an
--  org_members ⋈ organizations lookup. Written bare in a policy qual,
--  Postgres calls them for EVERY CANDIDATE ROW of every query. Measured
--  on production (EXPLAIN ANALYZE under an emulated authenticated JWT):
--        audit_log  (2,849 rows)  200 ms  with the bare qual
--        audit_log  (same query)  3.7 ms  with no per-row calls
--        clients      (304 rows)   21 ms
--        autobooks_entries (1,000-row page) 190 ms
--  The plan output literally shows  Filter: private.is_app_user()  on the
--  row scan. Wrapping each call in a scalar subquery — (select fn()) —
--  turns it into an InitPlan: evaluated once per query, result reused for
--  every row. Same functions, same logic, same answer for every row a
--  query touches (the functions depend only on the JWT, never the row),
--  so ACCESS SEMANTICS ARE IDENTICAL. This is Supabase's own documented
--  fix for this exact trap.
--
--  HOW. Rather than hand-writing ~97 ALTER POLICY statements, this
--  iterates pg_policies and rewrites each qual / with_check by replacing
--  exactly four tokens:
--        private.is_app_user()    → (select private.is_app_user())
--        private.is_admin()       → (select private.is_admin())
--        private.current_org_id() → (select private.current_org_id())
--        private.jwt_email()      → (select private.jwt_email())
--  (jwt_email has no table lookup but is still a per-row function call in
--  app_users/send_logs quals — wrapped for uniformity.)
--
--  SELF-VERIFYING, same idiom as the Stage 2 Phase 2 backfill: after the
--  rewrite it re-reads pg_policies and RAISES if any bare per-row call
--  remains, so a half-rewritten catalog cannot pass silently.
--
--  IDEMPOTENT: a policy whose stored text already contains the normalized
--  initplan form ("SELECT private.") is skipped, so re-running never
--  double-wraps.
--
--  Rollback: db/2026-08-21_rls_initplan_policies_rollback.sql (unwraps).
-- ════════════════════════════════════════════════════════════════════

do $$
declare
  p        record;
  new_qual  text;
  new_check text;
  changed  int := 0;
  leftover int;
begin
  for p in
    select tablename, policyname, qual, with_check
    from pg_policies
    where schemaname = 'public'
      and (coalesce(qual, '') || ' ' || coalesce(with_check, ''))
          ~ 'private\.(is_app_user|is_admin|current_org_id|jwt_email)\(\)'
  loop
    -- Idempotency: already-rewritten policies store the normalized form
    -- "( SELECT private.fn() AS fn)" — skip them rather than double-wrap.
    if (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) ~* 'SELECT private\.' then
      continue;
    end if;

    new_qual  := p.qual;
    new_check := p.with_check;

    if new_qual is not null then
      new_qual := replace(new_qual, 'private.is_app_user()',    '(select private.is_app_user())');
      new_qual := replace(new_qual, 'private.is_admin()',       '(select private.is_admin())');
      new_qual := replace(new_qual, 'private.current_org_id()', '(select private.current_org_id())');
      new_qual := replace(new_qual, 'private.jwt_email()',      '(select private.jwt_email())');
    end if;
    if new_check is not null then
      new_check := replace(new_check, 'private.is_app_user()',    '(select private.is_app_user())');
      new_check := replace(new_check, 'private.is_admin()',       '(select private.is_admin())');
      new_check := replace(new_check, 'private.current_org_id()', '(select private.current_org_id())');
      new_check := replace(new_check, 'private.jwt_email()',      '(select private.jwt_email())');
    end if;

    execute format(
      'alter policy %I on public.%I%s%s',
      p.policyname, p.tablename,
      case when new_qual  is not null then ' using ('      || new_qual  || ')' else '' end,
      case when new_check is not null then ' with check (' || new_check || ')' else '' end
    );
    changed := changed + 1;
  end loop;

  -- Proof: strip every wrapped occurrence, then look for any private.* call
  -- left standing — that would be a policy still paying the per-row price.
  select count(*) into leftover
  from pg_policies
  where schemaname = 'public'
    and replace(
          replace(coalesce(qual, '') || ' ' || coalesce(with_check, ''),
                  'SELECT private.', ''),
          'select private.', '')
        ~ 'private\.(is_app_user|is_admin|current_org_id|jwt_email)\(\)';

  if leftover > 0 then
    raise exception 'initplan rewrite incomplete: % policies still call private.* per row', leftover;
  end if;

  raise notice 'initplan rewrite: % policies rewritten, none left bare', changed;
end $$;
