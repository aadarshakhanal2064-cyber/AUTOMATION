-- ════════════════════════════════════════════════════════════════════════════
--  ROLLBACK of db/2026-08-18_stage2_phase3_enforce_tenancy.sql
--
--  Returns the database to the Phase 2 state: columns still present and still
--  populated, but nothing enforced. Membership alone grants access again,
--  exactly as it did before this stage began.
--
--  RUN THIS FIRST if the whole stage is being abandoned — Phase 1's rollback
--  drops private.current_org_id(), which the Phase 3 policies depend on, so it
--  cannot run while they exist.
--
--  THE ONE PRECONDITION: §2 restores a UNIQUE index on book_key alone. If a
--  second organisation has already saved a walk-in book whose client name and
--  fiscal year match one of yours, that index cannot be built and this file
--  will fail — correctly, because the collision it was created to prevent
--  would then be real. §2 reports the clashing keys rather than failing blind.
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. Put the membership-only policies back ────────────────────────────────
-- Strips the ` and org_id = private.current_org_id()` this stage appended,
-- rather than re-typing 82 policies from memory — the original expression is
-- still there, wrapped in parentheses, so it can be recovered exactly.
do $$
declare
  r        record;
  suffix   constant text := ' and org_id = private.current_org_id()';
  old_qual text;
  old_chk  text;
  n        integer := 0;
begin
  -- Each policy is unwrapped from '(<expr>) and org_id = ...' back to
  -- '<expr>' inline below. A policy that does not have that exact shape is
  -- recreated unchanged rather than mangled, so a hand-edited one survives.
  for r in
    select tablename, policyname, cmd, permissive,
           array_to_string(roles, ', ') as role_list, qual, with_check
    from pg_policies
    where schemaname = 'public'
      and tablename not in ('organizations','org_members','org_firms')
      and (coalesce(qual,'')       like '%current_org_id%'
        or coalesce(with_check,'') like '%current_org_id%')
    order by tablename, policyname
  loop
    old_qual := r.qual;
    old_chk  := r.with_check;

    if old_qual is not null and right(old_qual, length(suffix)) = suffix then
      old_qual := left(old_qual, length(old_qual) - length(suffix));
      if left(old_qual,1) = '(' and right(old_qual,1) = ')' then
        old_qual := substring(old_qual from 2 for length(old_qual) - 2);
      end if;
    end if;

    if old_chk is not null and right(old_chk, length(suffix)) = suffix then
      old_chk := left(old_chk, length(old_chk) - length(suffix));
      if left(old_chk,1) = '(' and right(old_chk,1) = ')' then
        old_chk := substring(old_chk from 2 for length(old_chk) - 2);
      end if;
    end if;

    execute format('drop policy %I on public.%I', r.policyname, r.tablename);

    execute format('create policy %I on public.%I as %s for %s to %s %s %s',
      r.policyname, r.tablename,
      case when r.permissive = 'PERMISSIVE' then 'permissive' else 'restrictive' end,
      r.cmd, r.role_list,
      case when old_qual is null then '' else 'using (' || old_qual || ')' end,
      case when old_chk  is null then '' else 'with check (' || old_chk || ')' end
    );

    n := n + 1;
  end loop;

  raise notice 'Reverted % policies to membership-only.', n;
end $$;

-- ── 2. Put the global book_key index back ───────────────────────────────────
do $$
declare clashes text;
begin
  select string_agg(book_key || ' (' || c || ' rows)', ', ')
  into clashes
  from (select book_key, count(*) c from public.autobooks_books
        group by book_key having count(*) > 1) d;

  if clashes is not null then
    raise exception
      'Cannot restore the global book_key index — these keys now exist in more than one organisation: %',
      clashes;
  end if;
end $$;

drop index if exists public.autobooks_books_key_uniq;
create unique index autobooks_books_key_uniq
  on public.autobooks_books using btree (book_key);

-- ── 3. Drop the NOT NULLs ───────────────────────────────────────────────────
-- Values stay; only the constraint goes. This is what makes Phase 2's rollback
-- runnable afterwards.
do $$
declare t text;
begin
  foreach t in array array[
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
  ] loop
    execute format('alter table public.%I alter column org_id drop not null', t);
  end loop;
end $$;

-- ── 4. Verify ───────────────────────────────────────────────────────────────
-- Expect: scoped_policies 6 (the three org tables' own, which stay),
--         not_null_cols 0, book_key_index back on (book_key).
select
  (select count(*) from pg_policies
     where schemaname='public'
       and (coalesce(qual,'')       like '%current_org_id%'
         or coalesce(with_check,'') like '%current_org_id%'))          as scoped_policies,
  (select count(*) from information_schema.columns
     where table_schema='public' and column_name='org_id'
       and is_nullable='NO'
       and table_name not in ('org_members','org_firms'))              as not_null_cols,
  (select indexdef from pg_indexes
     where schemaname='public' and indexname='autobooks_books_key_uniq') as book_key_index;
