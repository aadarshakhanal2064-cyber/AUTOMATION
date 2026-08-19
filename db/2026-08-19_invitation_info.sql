-- ════════════════════════════════════════════════════════════════════════════
--  invitation_info(token) — let the join screen say WHO the invite is for
--
--  THE BUG THIS FIXES, found in the first real test:
--  the Join screen had no way to know which address an invitation was issued
--  to, so it prefilled the email of whoever happened to be signed in. The
--  owner created an invite for ...2064 while signed in as ...2063, opened the
--  link, and was shown ...2063 — an address the invitation was not for.
--  accept_invitation() correctly refuses a mismatch (that check is what stops
--  a leaked link being used by anyone else), so the join simply failed, and
--  the invitation was still sitting unaccepted afterwards.
--
--  The screen could not read org_invitations directly, and must not be able
--  to: its policies are admin-only, and the person joining is by definition
--  not a member of anything yet.
--
--  WHY THIS IS SAFE TO EXPOSE TO ANON
--  The token IS the secret — 32 random bytes, and only its SHA-256 hash is
--  stored. Anyone holding it was sent the link. Telling them which address it
--  was issued to, and which organisation, reveals nothing they were not
--  already trusted with, and it converts a silent failure into a screen that
--  states what to do. It deliberately returns NOTHING for an unknown token, so
--  it cannot be used to test whether a token exists beyond a yes/no that
--  brute force cannot reach.
--
--  anon can call it because the invitee usually has no account yet — that is
--  the entire situation the invitation exists to resolve.
--
--  ROLLBACK: db/2026-08-19_invitation_info_rollback.sql
-- ════════════════════════════════════════════════════════════════════════════

create or replace function public.invitation_info(p_token text)
returns table (email text, role text, org_name text, status text)
language plpgsql security definer set search_path to ''
as $function$
declare
  v_inv public.org_invitations%rowtype;
begin
  select * into v_inv
  from public.org_invitations
  where token_hash = encode(sha256(btrim(p_token)::bytea), 'hex');

  -- No row at all: return nothing. The caller shows "this link is not valid"
  -- without learning anything about which tokens exist.
  if v_inv.id is null then
    return;
  end if;

  return query
  select
    v_inv.email,
    v_inv.role,
    o.name,
    case
      when v_inv.revoked_at  is not null then 'revoked'
      when v_inv.accepted_at is not null then 'accepted'
      when v_inv.expires_at   <  now()   then 'expired'
      else 'pending'
    end
  from public.organizations o
  where o.id = v_inv.org_id;
end;
$function$;

revoke all on function public.invitation_info(text) from public;
grant execute on function public.invitation_info(text) to anon, authenticated;
