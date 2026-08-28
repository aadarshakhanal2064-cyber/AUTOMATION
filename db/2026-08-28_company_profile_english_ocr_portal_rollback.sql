-- Rollback for 2026-08-28_company_profile_english_ocr_portal.sql
alter table public.registrar_companies
  drop column if exists name_english,
  drop column if exists ocr_username,
  drop column if exists ocr_password;
