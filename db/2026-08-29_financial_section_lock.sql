-- ════════════════════════════════════════════════════════════════════════
--  FINANCIAL MANAGEMENT — PER-MEMBER SECTION LOCK  (2026-08-29)
--
--  User ask: "lock the financial management section so that no one is able
--  to see what's inside it, only a specific person — a personalised lock,
--  only openable with a password, and resettable if the password is
--  forgotten."
--
--  WHY THIS IS IN THE DATABASE AND NOT JUST IN THE UI
--  --------------------------------------------------
--  The app is 100% client-side (CLAUDE.md §2). A password check written in
--  JavaScript is a curtain, not a lock: anyone can flip a flag from the
--  browser console, and — more to the point — every signed-in member could
--  still read service_memos / bank_transactions / the VAT book straight off
--  PostgREST with the publishable key, never touching the UI at all. So the
--  lock lives where the data lives. The UI gate is a convenience on top of
--  it, exactly the way RLS (not the role pill) is what actually protects
--  rows everywhere else in this app (§13).
--
--  THE MODEL — three independent facts per member, all on org_members:
--
--    fin_access         may this member enter Financial Management AT ALL.
--                       Granted/revoked by an owner or admin in Team.
--                       Default FALSE — a new member is locked out until
--                       someone deliberately lets them in.
--
--    fin_password_hash  that member's OWN section password (bcrypt). Null
--                       until they set it on first entry. Personal, not
--                       shared: two granted members have two passwords, and
--                       neither can open the section with the other's.
--
--    fin_unlocked_until how long this member's current unlock lasts. THIS
--                       is what RLS reads. Set by fin_unlock(), cleared by
--                       fin_lock() and by signing out.
--
--  Access to a row therefore requires all three: granted, password known,
--  and currently inside the unlock window. Revoking access wipes the
--  password and the window in the same statement, so a revoked member is
--  shut out instantly rather than at the end of their window.
--
--  THE EIGHT LOCKED TABLES are exactly the tables the five Financial
--  Management modules own, and nothing else reads them — verified by
--  grepping every from('<table>') in js/ before writing this:
--    service_memos, service_memo_fee_skips  (Service Memo, + read by VAT
--                                            Register, Party Ledger and
--                                            Final Account — all in-section)
--    vat_purchases, vat_returns, vat_collections   (VAT Register)
--    party_opening_balances                        (Party Ledger)
--    bank_accounts, bank_transactions              (Bank Entry, + Party
--                                                   Ledger/Final Account)
--  Final Account queries nothing itself — it is a pure view over Party
--  Ledger's state — so locking these eight closes the whole section.
--  Autobooks is a CLIENT's VAT book in different tables and is NOT locked.
--
--  BACKFILL: fin_access is granted to each organisation's OWNER only. That
--  is the requested end state ("only a specific person"), and it cannot
--  lock the person running this migration out of their own data, because
--  they are the owner. Anyone else who should have it is ticked back on in
--  Team → Financial Management access.
--
--  Rollback: db/2026-08-29_financial_section_lock_rollback.sql
-- ════════════════════════════════════════════════════════════════════════


-- ════════════════════════════════════════════════════════════════════════
--  1. Columns
-- ════════════════════════════════════════════════════════════════════════
alter table public.org_members
  add column if not exists fin_access          boolean     not null default false,
  add column if not exists fin_password_hash   text,
  add column if not exists fin_unlocked_until  timestamptz,
  -- Brute-force throttle. A section password is short by nature (people
  -- pick something they can type twenty times a day), and an RPC can be
  -- called in a loop, so five wrong tries costs a fifteen-minute wait.
  add column if not exists fin_failed_attempts integer     not null default 0,
  add column if not exists fin_lockout_until   timestamptz;

comment on column public.org_members.fin_access is
  'May this member open Financial Management at all. Granted by an owner/admin in Team.';
comment on column public.org_members.fin_password_hash is
  'bcrypt of this member''s OWN Financial Management password. Null = not set yet.';
comment on column public.org_members.fin_unlocked_until is
  'End of the current unlock window. RLS on the eight financial tables reads this.';

-- Owners keep access; everyone else starts locked out.
update public.org_members set fin_access = true where role = 'owner';


-- ════════════════════════════════════════════════════════════════════════
--  2. private.fin_unlocked() — the one place the lock is decided
--
--  Same shape as private.is_app_user(): STABLE + SECURITY DEFINER so a
--  policy calling it cannot recurse, and it depends only on the JWT and the
--  caller's own org_members row — never on the candidate row. That is what
--  makes it safe to wrap in (select ...) in every policy qual, which is
--  this project's house style (§6, db/2026-08-21_rls_initplan_policies.sql):
--  wrapped, it becomes an InitPlan evaluated once per query instead of once
--  per candidate row.
-- ════════════════════════════════════════════════════════════════════════
create or replace function private.fin_unlocked()
returns boolean
language sql
stable security definer
set search_path to ''
as $fn$
  select exists (
    select 1
    from public.org_members m
    where lower(m.email) = private.jwt_email()
      and m.org_id       = private.current_org_id()
      and m.fin_access
      and m.fin_unlocked_until is not null
      and m.fin_unlocked_until > now()
  );
$fn$;

comment on function private.fin_unlocked() is
  'True when the caller is granted Financial Management access AND inside their unlock window.';


-- ════════════════════════════════════════════════════════════════════════
--  3. The RPCs — the app never writes these columns directly
--
--  org_members has no self-UPDATE policy for a member's own row, and it
--  must not get one: a member who could UPDATE their own row could simply
--  set fin_access = true and fin_unlocked_until = 'infinity'. So every
--  transition goes through a SECURITY DEFINER function that decides for
--  itself what is allowed. Each returns json rather than raising, because
--  "wrong password" is an ordinary answer, not an error.
-- ════════════════════════════════════════════════════════════════════════

-- ── 3a. Status — what the UI needs to decide which screen to show ───────
create or replace function public.fin_status()
returns json
language sql
stable security definer
set search_path to ''
as $fn$
  select json_build_object(
    'granted',        coalesce(m.fin_access, false),
    'hasPassword',    m.fin_password_hash is not null,
    'unlocked',       coalesce(m.fin_unlocked_until > now(), false),
    'unlockedUntil',  m.fin_unlocked_until,
    'lockedOut',      coalesce(m.fin_lockout_until > now(), false),
    'lockedOutUntil', m.fin_lockout_until
  )
  from public.org_members m
  where lower(m.email) = private.jwt_email()
    and m.org_id       = private.current_org_id();
$fn$;

-- ── 3b. Set / change the section password ───────────────────────────────
--  A password already set can only be CHANGED by someone who knows it —
--  otherwise an unattended signed-in tab is enough to take the section
--  over. Someone who has forgotten it uses fin_reset_password() instead,
--  which asks for their account password.
create or replace function public.fin_set_password(p_current text, p_new text)
returns json
language plpgsql
volatile security definer
set search_path to ''
as $fn$
declare
  m public.org_members%rowtype;
begin
  select * into m from public.org_members
   where lower(email) = private.jwt_email()
     and org_id       = private.current_org_id();

  if not found or not m.fin_access then
    return json_build_object('ok', false, 'error', 'no_access');
  end if;
  if length(coalesce(p_new, '')) < 4 then
    return json_build_object('ok', false, 'error', 'too_short');
  end if;
  if m.fin_password_hash is not null
     and m.fin_password_hash <> extensions.crypt(coalesce(p_current, ''), m.fin_password_hash) then
    return json_build_object('ok', false, 'error', 'bad_password');
  end if;

  -- Setting a password unlocks immediately: the person just proved who
  -- they are, and making them retype it straight away teaches nothing.
  update public.org_members
     set fin_password_hash   = extensions.crypt(p_new, extensions.gen_salt('bf')),
         fin_unlocked_until  = now() + interval '4 hours',
         fin_failed_attempts = 0,
         fin_lockout_until   = null
   where id = m.id;

  return json_build_object('ok', true);
end;
$fn$;

-- ── 3c. Unlock ──────────────────────────────────────────────────────────
create or replace function public.fin_unlock(p_password text)
returns json
language plpgsql
volatile security definer
set search_path to ''
as $fn$
declare
  m public.org_members%rowtype;
begin
  select * into m from public.org_members
   where lower(email) = private.jwt_email()
     and org_id       = private.current_org_id();

  if not found or not m.fin_access then
    return json_build_object('ok', false, 'error', 'no_access');
  end if;
  if m.fin_lockout_until is not null and m.fin_lockout_until > now() then
    return json_build_object('ok', false, 'error', 'locked_out',
                             'until', m.fin_lockout_until);
  end if;
  if m.fin_password_hash is null then
    return json_build_object('ok', false, 'error', 'no_password');
  end if;

  if m.fin_password_hash <> extensions.crypt(p_password, m.fin_password_hash) then
    update public.org_members
       set fin_failed_attempts = m.fin_failed_attempts + 1,
           fin_lockout_until   = case when m.fin_failed_attempts + 1 >= 5
                                      then now() + interval '15 minutes' end
     where id = m.id;
    return json_build_object('ok', false, 'error', 'bad_password',
                             'attemptsLeft', greatest(0, 5 - (m.fin_failed_attempts + 1)));
  end if;

  update public.org_members
     set fin_unlocked_until  = now() + interval '4 hours',
         fin_failed_attempts = 0,
         fin_lockout_until   = null
   where id = m.id;

  return json_build_object('ok', true, 'unlockedUntil', now() + interval '4 hours');
end;
$fn$;

-- ── 3d. Lock now ────────────────────────────────────────────────────────
--  Called by the Lock button and by signOut(). Deliberately takes no
--  password: locking is never the dangerous direction.
create or replace function public.fin_lock()
returns json
language plpgsql
volatile security definer
set search_path to ''
as $fn$
begin
  update public.org_members
     set fin_unlocked_until = null
   where lower(email) = private.jwt_email()
     and org_id       = private.current_org_id();
  return json_build_object('ok', true);
end;
$fn$;

-- ── 3e. Forgot the section password ─────────────────────────────────────
--  Recovery is by the caller's OWN Supabase account password, checked here
--  against auth.users rather than by re-signing-in from the browser (which
--  would churn the session token on every reset). User decision 2026-08-29:
--  self-reset, so a sole owner can never be locked out of their own data
--  and no one else can trigger a reset on their behalf.
--
--  Supabase stores account passwords as bcrypt in encrypted_password, so
--  crypt(candidate, stored) = stored is the check. An account carrying some
--  other hash algorithm returns 'bad_account_password' rather than a wrong
--  answer — it fails closed.
create or replace function public.fin_reset_password(p_account_password text, p_new text)
returns json
language plpgsql
volatile security definer
set search_path to ''
as $fn$
declare
  m    public.org_members%rowtype;
  v_ok boolean;
begin
  select * into m from public.org_members
   where lower(email) = private.jwt_email()
     and org_id       = private.current_org_id();

  if not found or not m.fin_access then
    return json_build_object('ok', false, 'error', 'no_access');
  end if;
  if length(coalesce(p_new, '')) < 4 then
    return json_build_object('ok', false, 'error', 'too_short');
  end if;

  select exists (
    select 1 from auth.users u
     where lower(u.email) = private.jwt_email()
       and u.encrypted_password is not null
       and u.encrypted_password = extensions.crypt(p_account_password, u.encrypted_password)
  ) into v_ok;

  if not v_ok then
    return json_build_object('ok', false, 'error', 'bad_account_password');
  end if;

  update public.org_members
     set fin_password_hash   = extensions.crypt(p_new, extensions.gen_salt('bf')),
         fin_unlocked_until  = now() + interval '4 hours',
         fin_failed_attempts = 0,
         fin_lockout_until   = null   -- a proven account password clears the throttle
   where id = m.id;

  return json_build_object('ok', true);
end;
$fn$;

-- ── 3f. Grant / revoke a member's access (owner or admin, own org only) ──
create or replace function public.fin_set_access(p_email text, p_grant boolean)
returns json
language plpgsql
volatile security definer
set search_path to ''
as $fn$
declare
  v_org bigint := private.current_org_id();
  v_n   integer;
begin
  if not private.is_admin() then
    return json_build_object('ok', false, 'error', 'not_admin');
  end if;

  update public.org_members
     set fin_access          = p_grant,
         -- Revoking wipes the password and the open window in the same
         -- statement: a revoked member is shut out now, not in four hours,
         -- and cannot walk back in on a password nobody remembers giving.
         fin_password_hash   = case when p_grant then fin_password_hash end,
         fin_unlocked_until  = case when p_grant then fin_unlocked_until end,
         fin_failed_attempts = 0,
         fin_lockout_until   = null
   where org_id = v_org
     and lower(email) = lower(p_email);

  get diagnostics v_n = row_count;
  if v_n = 0 then
    return json_build_object('ok', false, 'error', 'not_found');
  end if;
  return json_build_object('ok', true);
end;
$fn$;

-- ── 3g. Execution rights ────────────────────────────────────────────────
--  CREATE FUNCTION grants EXECUTE to PUBLIC by default, which would put
--  every one of these in anon's reach. Revoke first, then grant narrowly.
revoke execute on function public.fin_status()                     from public, anon;
revoke execute on function public.fin_set_password(text, text)     from public, anon;
revoke execute on function public.fin_unlock(text)                 from public, anon;
revoke execute on function public.fin_lock()                       from public, anon;
revoke execute on function public.fin_reset_password(text, text)   from public, anon;
revoke execute on function public.fin_set_access(text, boolean)    from public, anon;

grant execute on function public.fin_status()                      to authenticated;
grant execute on function public.fin_set_password(text, text)      to authenticated;
grant execute on function public.fin_unlock(text)                  to authenticated;
grant execute on function public.fin_lock()                        to authenticated;
grant execute on function public.fin_reset_password(text, text)    to authenticated;
grant execute on function public.fin_set_access(text, boolean)     to authenticated;


-- ════════════════════════════════════════════════════════════════════════
--  4. Add the lock to all 31 policies on the eight tables
--
--  Done as a loop over pg_policies rather than 31 hand-written ALTERs so
--  that each policy keeps its EXISTING qual, its role and its command
--  exactly as they are and only gains the new conjunct. Hand-retyping them
--  is how a policy silently loses its org_id test.
--
--  Idempotent: a policy already carrying fin_unlocked is skipped.
-- ════════════════════════════════════════════════════════════════════════
do $mig$
declare
  r      record;
  tbls   text[] := array[
           'service_memos', 'service_memo_fee_skips',
           'vat_purchases', 'vat_returns', 'vat_collections',
           'party_opening_balances',
           'bank_accounts', 'bank_transactions'];
  clause constant text := '(select private.fin_unlocked())';
  -- Read the catalog ONCE into an array before altering anything. A
  -- PL/pgSQL FOR-over-query is a lazily-fetched cursor, and this loop
  -- rewrites the very catalog rows that cursor is scanning.
  plans  jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
           't', tablename, 'p', policyname, 'q', qual, 'w', with_check)), '[]'::jsonb)
    into plans
    from pg_policies
   where schemaname = 'public'
     and tablename = any(tbls)
     and coalesce(qual, '')       not like '%fin_unlocked%'
     and coalesce(with_check, '') not like '%fin_unlocked%';

  for r in select * from jsonb_to_recordset(plans) as x(t text, p text, q text, w text)
  loop
    if r.q is not null and r.w is not null then
      execute format('alter policy %I on public.%I using (%s and %s) with check (%s and %s)',
                     r.p, r.t, r.q, clause, r.w, clause);
    elsif r.q is not null then
      execute format('alter policy %I on public.%I using (%s and %s)',
                     r.p, r.t, r.q, clause);
    else
      execute format('alter policy %I on public.%I with check (%s and %s)',
                     r.p, r.t, r.w, clause);
    end if;
  end loop;
end
$mig$;


-- ════════════════════════════════════════════════════════════════════════
--  5. Prove it, in the same transaction
--
--  The failure that matters here is not a loud error — it is ONE policy
--  quietly missing the new conjunct, which reads as "the section is locked"
--  while that table stays wide open. Same reasoning as the Phase 2 backfill
--  proof (db/2026-08-18_stage2_phase2_backfill_org_id.sql).
-- ════════════════════════════════════════════════════════════════════════
do $verify$
declare
  v_missing text;
  v_count   integer;
begin
  select string_agg(tablename || '.' || policyname, ', '), count(*)
    into v_missing, v_count
    from pg_policies
   where schemaname = 'public'
     and tablename = any(array[
           'service_memos', 'service_memo_fee_skips',
           'vat_purchases', 'vat_returns', 'vat_collections',
           'party_opening_balances', 'bank_accounts', 'bank_transactions'])
     and coalesce(qual, '')       not like '%fin_unlocked%'
     and coalesce(with_check, '') not like '%fin_unlocked%';

  if v_count > 0 then
    raise exception 'Financial lock NOT applied to % policies: %', v_count, v_missing;
  end if;

  if not exists (select 1 from public.org_members where fin_access) then
    raise exception 'No member was granted fin_access — this would lock everyone out.';
  end if;
end
$verify$;


-- ════════════════════════════════════════════════════════════════════════
--  6. Close the back door: the five fin_* columns are not writable from the
--     app at all, only through the RPCs above
--
--  Found while verifying section 4, and it would have made the whole lock
--  decorative for exactly the people most able to notice: org_members
--  carries policy org_members_update_admin (db/2026-08-18_stage3_
--  invitations.sql), which lets ANY admin or owner UPDATE any member row in
--  their organisation. That policy is right for what it was written for —
--  Team's role and status controls — but it means an admin could have run
--
--      update org_members set fin_access = true,
--             fin_unlocked_until = now() + interval '99 years' where ...
--
--  straight over PostgREST with the publishable key and read the whole
--  section without ever knowing the password. RLS was gating the rows and
--  nothing was gating the gate.
--
--  The fix is a privilege, not another policy, because a policy decides
--  WHICH ROWS and the problem here is WHICH COLUMNS. Postgres has no way to
--  subtract one column from a table-wide UPDATE grant, so the grant is
--  withdrawn and re-issued for the two columns Team actually writes
--  (js/orgMembers.js updates `role` and `status`, and nothing else in js/
--  or tools/ updates this table at all).
--
--  The RPCs are unaffected: they are SECURITY DEFINER and execute as their
--  owner, for whom no column restriction applies. So the ONLY route to
--  these five columns from a browser is fin_unlock() / fin_set_password() /
--  fin_reset_password() / fin_set_access() — each of which checks something
--  before it writes.
--
--  updated_at is deliberately absent from the new grant: set_updated_at()
--  assigns it in a BEFORE trigger, and column privileges are checked
--  against the columns named in the statement, not ones a trigger fills in.
-- ════════════════════════════════════════════════════════════════════════
revoke update on public.org_members from authenticated, anon;
grant  update (role, status) on public.org_members to authenticated;

do $verify$
declare
  v_bad text;
begin
  select string_agg(distinct column_name, ', ')
    into v_bad
    from information_schema.column_privileges
   where table_schema = 'public'
     and table_name   = 'org_members'
     and grantee      in ('authenticated', 'anon')
     and privilege_type = 'UPDATE'
     and column_name like 'fin\_%';

  if v_bad is not null then
    raise exception 'The app can still write these columns directly: %', v_bad;
  end if;
end
$verify$;
