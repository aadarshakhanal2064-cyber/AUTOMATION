-- ════════════════════════════════════════════════════════════════════════════
--  ROLLBACK of db/2026-08-18_stage3_owner_guard_allow_org_delete.sql
--
--  Restores the original guard from db/2026-08-18_stage3_invitations.sql, which
--  refuses to remove an organisation's last active owner in ALL cases —
--  including when the organisation itself is being deleted, which makes an
--  organisation undeletable. Only roll back if the amended version is causing
--  a problem worse than that.
-- ════════════════════════════════════════════════════════════════════════════

create or replace function private.guard_last_owner()
returns trigger
language plpgsql security definer set search_path to ''
as $function$
declare
  v_org  bigint := coalesce(old.org_id, new.org_id);
  v_left integer;
begin
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
