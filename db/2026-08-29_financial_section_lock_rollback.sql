-- ════════════════════════════════════════════════════════════════════════
--  ROLLBACK — FINANCIAL MANAGEMENT SECTION LOCK  (2026-08-29)
--
--  Reverses db/2026-08-29_financial_section_lock.sql: every member can see
--  Financial Management again, exactly as before the lock existed.
--
--  Run this whole file in one transaction. Step 1 is what actually restores
--  access; steps 2–4 are cleanup and are safe to run separately if you only
--  want to unlock temporarily while keeping the plumbing in place.
--
--  Nothing here destroys business data — the eight financial tables are not
--  touched. The only thing lost is each member's section password, which is
--  a hash nobody can read anyway and is re-set on next use.
-- ════════════════════════════════════════════════════════════════════════


-- ════════════════════════════════════════════════════════════════════════
--  1. Strip the lock out of all 31 policies
--
--  Rebuilds each policy's qual/with_check by removing the ' AND (select
--  private.fin_unlocked())' conjunct the migration appended, leaving the
--  original org-scoped membership test untouched. Idempotent: a policy that
--  never got the conjunct is skipped.
-- ════════════════════════════════════════════════════════════════════════
do $rb$
declare
  r       record;
  tbls    text[] := array[
            'service_memos', 'service_memo_fee_skips',
            'vat_purchases', 'vat_returns', 'vat_collections',
            'party_opening_balances',
            'bank_accounts', 'bank_transactions'];
  -- The standard org-scoped member test every one of these policies had
  -- before the lock, in the (select ...) InitPlan form that is this
  -- project's house style (db/2026-08-21_rls_initplan_policies.sql).
  base constant text :=
    '((select private.is_app_user()) and (org_id = (select private.current_org_id())))';
  -- Read the catalog once before rewriting it — see the note in the
  -- forward migration; this loop alters the rows its own scan is reading.
  plans   jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
           't', tablename, 'p', policyname, 'q', qual, 'w', with_check)), '[]'::jsonb)
    into plans
    from pg_policies
   where schemaname = 'public'
     and tablename = any(tbls)
     and (coalesce(qual, '') like '%fin_unlocked%'
          or coalesce(with_check, '') like '%fin_unlocked%');

  for r in select * from jsonb_to_recordset(plans) as x(t text, p text, q text, w text)
  loop
    if r.q is not null and r.w is not null then
      execute format('alter policy %I on public.%I using (%s) with check (%s)', r.p, r.t, base, base);
    elsif r.q is not null then
      execute format('alter policy %I on public.%I using (%s)', r.p, r.t, base);
    else
      execute format('alter policy %I on public.%I with check (%s)', r.p, r.t, base);
    end if;
  end loop;
end
$rb$;


-- ════════════════════════════════════════════════════════════════════════
--  1b. Restore the table-wide UPDATE grant on org_members
--
--  The migration narrowed it to (role, status) so the fin_* columns could
--  only be written through the RPCs (§6 there). Revoke the column grants
--  first, then re-issue the table-wide one Supabase ships by default.
-- ════════════════════════════════════════════════════════════════════════
revoke update on public.org_members from authenticated, anon;
grant  update on public.org_members to   authenticated, anon;


-- ════════════════════════════════════════════════════════════════════════
--  2. Drop the RPCs
-- ════════════════════════════════════════════════════════════════════════
drop function if exists public.fin_set_access(text, boolean);
drop function if exists public.fin_reset_password(text, text);
drop function if exists public.fin_lock();
drop function if exists public.fin_unlock(text);
drop function if exists public.fin_set_password(text, text);
drop function if exists public.fin_status();


-- ════════════════════════════════════════════════════════════════════════
--  3. Drop the helper
-- ════════════════════════════════════════════════════════════════════════
drop function if exists private.fin_unlocked();


-- ════════════════════════════════════════════════════════════════════════
--  4. Drop the columns
--
--  Do this LAST: private.fin_unlocked() and every policy above read them.
-- ════════════════════════════════════════════════════════════════════════
alter table public.org_members
  drop column if exists fin_lockout_until,
  drop column if exists fin_failed_attempts,
  drop column if exists fin_unlocked_until,
  drop column if exists fin_password_hash,
  drop column if exists fin_access;


-- ════════════════════════════════════════════════════════════════════════
--  5. Prove the lock is gone
-- ════════════════════════════════════════════════════════════════════════
do $verify$
declare
  v_left integer;
begin
  select count(*) into v_left
    from pg_policies
   where schemaname = 'public'
     and (coalesce(qual, '') like '%fin_unlocked%'
          or coalesce(with_check, '') like '%fin_unlocked%');

  if v_left > 0 then
    raise exception 'Rollback incomplete — % policies still reference fin_unlocked', v_left;
  end if;
end
$verify$;
