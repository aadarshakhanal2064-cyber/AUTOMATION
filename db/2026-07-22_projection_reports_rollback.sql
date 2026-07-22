-- Rollback for db/2026-07-22_projection_reports.sql
-- Drops the Projection Report table and everything attached to it.
-- The shared public.set_updated_at() function is NOT dropped — other
-- tables use it.

drop trigger if exists set_projection_reports_updated_at on public.projection_reports;
drop table if exists public.projection_reports;
