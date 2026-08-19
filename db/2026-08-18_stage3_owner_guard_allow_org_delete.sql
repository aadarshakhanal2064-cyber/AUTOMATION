-- ════════════════════════════════════════════════════════════════════════════
--  FIX — the last-owner guard must not block deleting an ORGANISATION
--
--  Amends private.guard_last_owner() from
--  db/2026-08-18_stage3_invitations.sql.
--
--  THE BUG, found by tools/tenantVerify.mjs rather than by reading:
--  the guard refuses to remove an organisation's last active owner, which is
--  right when someone is tidying up their team — an organisation with no owner
--  cannot be administered by anyone inside it. But it also fired when the
--  ORGANISATION ITSELF was being deleted, where losing the last owner is the
--  entire point. That made an org undeletable: org_members.org_id is
--  ON DELETE CASCADE, the cascade fires this BEFORE DELETE trigger per member
--  row, and the owner's row raised.
--
--  It surfaced as a test harness that could not clean up after itself, and it
--  would have surfaced again in Stage 7, where deleting a tenant is a named
--  requirement.
--
--  THE FIX: allow the delete when the parent organisation is already gone.
--  Postgres deletes the parent row before cascading to children, so inside
--  this trigger "the organisation no longer exists" is a reliable signal that
--  we are inside an org deletion rather than a member being removed.
--
--  The protection itself is unchanged: removing or demoting the last owner of
--  an organisation that continues to exist is still refused.
--
--  ROLLBACK: db/2026-08-18_stage3_owner_guard_allow_org_delete_rollback.sql
-- ════════════════════════════════════════════════════════════════════════════

create or replace function private.guard_last_owner()
returns trigger
language plpgsql security definer set search_path to ''
as $function$
declare
  v_org  bigint := coalesce(old.org_id, new.org_id);
  v_left integer;
begin
  -- The organisation is being deleted and this is the cascade reaching its
  -- members. There is nothing left to administer, so there is nothing to
  -- protect. Deleting a tenant is Stage 7's job and must not be blocked here.
  if tg_op = 'DELETE'
     and not exists (select 1 from public.organizations o where o.id = v_org) then
    return old;
  end if;

  select count(*) into v_left
  from public.org_members m
  where m.org_id = v_org
    and m.role = 'owner'
    and m.status = 'active'
    and m.id <> old.id;

  if v_left = 0
     and (tg_op = 'DELETE'
          or new.role <> 'owner'
          or new.status <> 'active') then
    raise exception 'This is the organisation''s last active owner. Make someone else an owner first.';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$function$;
