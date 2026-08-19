-- ════════════════════════════════════════════════════════════════════════════
--  ROLLBACK of db/2026-08-18_stage3_invitations.sql
--
--  Removes the invitation mechanism and the member-management policies,
--  returning account creation to "an admin does it in the Supabase dashboard",
--  which is exactly where it was before Stage 3.
--
--  WHAT IS LOST: outstanding invitations. Anyone who has ALREADY accepted one
--  keeps their org_members row and their access — acceptance creates a real
--  membership, it is not a reference into this table. So rolling back locks
--  nobody out; it only stops new people being invited.
--
--  REMEMBER TO TURN SIGNUP BACK OFF in the Supabase dashboard if this is being
--  rolled back for security reasons. Leaving it on is not itself a hole — an
--  auth account with no org_members row can read and write nothing — but it is
--  pointless surface once nothing consumes it.
-- ════════════════════════════════════════════════════════════════════════════

-- Triggers before the function they call.
drop trigger if exists guard_last_owner_update on public.org_members;
drop trigger if exists guard_last_owner_delete on public.org_members;
drop function if exists private.guard_last_owner();

drop policy if exists org_members_update_admin on public.org_members;
drop policy if exists org_members_delete_admin on public.org_members;

drop function if exists public.accept_invitation(text);
drop function if exists public.create_invitation(text, text, integer);

-- Policies and indexes go with the table.
drop table if exists public.org_invitations;

-- ── Verify ──────────────────────────────────────────────────────────────────
-- Expect every count 0, and member_policies back to 1 (the SELECT policy
-- created in Stage 2 Phase 1, which this rollback does not touch).
select
  (select count(*) from information_schema.tables
     where table_schema='public' and table_name='org_invitations')      as invitations_table,
  (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public'
       and p.proname in ('create_invitation','accept_invitation'))      as rpcs,
  (select count(*) from pg_trigger where tgname like 'guard_last_owner%') as owner_guards,
  (select count(*) from pg_policies
     where schemaname='public' and tablename='org_members')             as member_policies;
