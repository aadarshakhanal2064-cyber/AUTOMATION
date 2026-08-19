-- ════════════════════════════════════════════════════════════════════════════
--  ROLLBACK of db/2026-08-19_invitation_info.sql
--
--  Drops the helper. The join screen then has no way to know which address an
--  invitation was issued to, and reverts to asking the person to type it —
--  which is what produced the mismatch this was added to prevent. Only roll
--  back if the function itself is causing a problem.
-- ════════════════════════════════════════════════════════════════════════════

drop function if exists public.invitation_info(text);
