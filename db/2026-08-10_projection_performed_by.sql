-- Projection Report: add a "performed by" staff field so the UI can show
-- who generated or last updated a saved projection (New Task / Updation
-- flow, js/projection.js). Deliberately NOT rendered anywhere in the
-- Excel/PDF/print report output (js/projectionExport.js) — internal
-- tracking only, same posture as work_done.items[].staff.
--
-- Nullable: pre-existing saved projections have no staff attached, and that
-- is a valid state (they predate this feature), not an error.
alter table public.projection_reports
  add column if not exists performed_by text null;

comment on column public.projection_reports.performed_by is
  'Staff member who generated or updated this projection (UI-only — never printed in the exported report). Free text; same "Other" convention as ARF_STAFF elsewhere.';
