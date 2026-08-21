-- ════════════════════════════════════════════════════════════════════
--  ROLLBACK for 2026-08-21_rls_initplan_policies.sql
--
--  Unwraps every "( SELECT private.fn() AS fn)" scalar subquery in a
--  policy qual / with_check back to the bare per-row call "private.fn()".
--  Restores the exact pre-migration semantics AND the pre-migration
--  performance profile (i.e. the per-row slowness — this rollback exists
--  for safety, not because the bare form is ever preferable).
--
--  Postgres stores rewritten quals in normalized form, e.g.
--     ( SELECT private.is_app_user() AS is_app_user)
--  so the unwrap is a regexp over that shape. Self-verifying: raises if
--  any wrapped call remains afterwards.
-- ════════════════════════════════════════════════════════════════════

do $$
declare
  p        record;
  new_qual  text;
  new_check text;
  changed  int := 0;
  leftover int;
  -- "( SELECT private.fn() AS alias)" — with flexible whitespace and an
  -- optional alias — captured so the bare call survives as \1.
  pat constant text :=
    '\(\s*SELECT\s+(private\.(?:is_app_user|is_admin|current_org_id|jwt_email)\(\))(?:\s+AS\s+\w+)?\s*\)';
begin
  for p in
    select tablename, policyname, qual, with_check
    from pg_policies
    where schemaname = 'public'
      and (coalesce(qual, '') || ' ' || coalesce(with_check, '')) ~* 'SELECT\s+private\.'
  loop
    new_qual  := case when p.qual       is not null
                      then regexp_replace(p.qual,       pat, '\1', 'gi') end;
    new_check := case when p.with_check is not null
                      then regexp_replace(p.with_check, pat, '\1', 'gi') end;

    execute format(
      'alter policy %I on public.%I%s%s',
      p.policyname, p.tablename,
      case when new_qual  is not null then ' using ('      || new_qual  || ')' else '' end,
      case when new_check is not null then ' with check (' || new_check || ')' else '' end
    );
    changed := changed + 1;
  end loop;

  select count(*) into leftover
  from pg_policies
  where schemaname = 'public'
    and (coalesce(qual, '') || ' ' || coalesce(with_check, '')) ~* 'SELECT\s+private\.';

  if leftover > 0 then
    raise exception 'rollback incomplete: % policies still carry wrapped calls', leftover;
  end if;

  raise notice 'initplan rollback: % policies restored to bare per-row form', changed;
end $$;
