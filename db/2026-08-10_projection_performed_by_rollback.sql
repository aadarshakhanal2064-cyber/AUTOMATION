-- Rollback for 2026-08-10_projection_performed_by.sql
alter table public.projection_reports
  drop column if exists performed_by;
