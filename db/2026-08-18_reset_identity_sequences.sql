-- ════════════════════════════════════════════════════════════════════════════
--  reset_identity_sequences() — the missing last step of a restore
--
--  THE BUG THIS FIXES, found by rehearsing Stage 7 on the restored staging
--  database rather than by reading:
--
--  tools/dbRestore.mjs replays rows WITH THEIR ORIGINAL ids, which is
--  necessary — every foreign key in the backup points at those ids. But
--  inserting an explicit id does not advance the table's identity counter, so
--  after a restore the counter still sits wherever it was when the database
--  was created. The next ordinary insert then reuses an id that already
--  exists and fails with a duplicate key.
--
--  Measured on staging after its "successful" restore: ELEVEN tables were
--  already past their counter — audit_log 2648 vs max id 2766, service_memos
--  40 vs 51, autobooks_entries 5640 vs 5695, and eight more. Row counts
--  matched perfectly, which is exactly why the restore verification did not
--  notice: the data was all there, and the database was nonetheless unable to
--  accept a single new record.
--
--  In a real disaster recovery that means the restore looks fine, everyone
--  signs in, and the first person to save anything gets an error.
--
--  SECURITY: SECURITY DEFINER but granted to service_role ONLY. That role can
--  already do anything in this database — the backup scripts use it — so this
--  hands out no new power. It is explicitly revoked from anon and
--  authenticated, so nothing the browser can reach may call it.
--
--  ROLLBACK: db/2026-08-18_reset_identity_sequences_rollback.sql
-- ════════════════════════════════════════════════════════════════════════════

create or replace function public.reset_identity_sequences()
returns table (table_name text, was bigint, now_at bigint)
language plpgsql security definer set search_path to ''
as $function$
declare
  r   record;
  seq text;
  mx  bigint;
  cur bigint;
begin
  for r in
    select c.relname::text as tbl
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
    order by c.relname
  loop
    seq := pg_get_serial_sequence('public.' || quote_ident(r.tbl), 'id');
    continue when seq is null;

    execute format('select coalesce(max(id), 0) from public.%I', r.tbl) into mx;
    execute format('select last_value from %s', seq) into cur;

    -- setval(..., is_called => true) so the NEXT value is mx + 1. Using
    -- greatest() means a counter that is already ahead is left alone rather
    -- than wound backwards, which would reintroduce the very collision this
    -- exists to prevent.
    if mx > 0 then
      perform setval(seq, greatest(mx, cur), true);
    end if;

    table_name := r.tbl; was := cur; now_at := greatest(mx, cur);
    return next;
  end loop;
end;
$function$;

revoke all on function public.reset_identity_sequences() from public, anon, authenticated;
grant execute on function public.reset_identity_sequences() to service_role;

-- ── Verify ──────────────────────────────────────────────────────────────────
-- Every row where `was` < `now_at` is a table that would have failed on its
-- next insert. On a database that was never restored, expect none.
select * from public.reset_identity_sequences() where was < now_at;
