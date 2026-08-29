-- ════════════════════════════════════════════════════════════════════════════
--  Autobooks — the CA's reference workflow
--  2026-08-30
--
--  The firm supplied its CA's own Sales & Purchase workbook and asked the app
--  to follow it. Three per-party facts that workbook carries have nowhere to
--  live in `autobooks_parties` today:
--
--   1. confirmed_taxfree — the CA's "As per Confirmation Tax Free" column.
--      `confirmed_taxable` already exists; a party's confirmation letter states
--      BOTH figures, and the difference on his Details sheet is
--      (confirmation taxable + confirmation tax free) − (book total). Without
--      this column a client with exempt sales can never reconcile: their
--      tax-free trade would read as an unexplained difference forever.
--
--   2. classify — his "Classify" sheet, which is what drives Annexure-13.
--      Sales: Goods | Service.  Purchase: Goods | Assets | Expenses.
--      `ann13_category` already holds the sales pair, but the purchase side
--      gains two values it was never meant to carry, and overloading a column
--      whose name says "ann13" with what is really a bookkeeping
--      classification would hide the new meaning from the next reader.
--
--   3. classify_note — the sub-classification his sheet asks for beside it:
--      the depreciation class for an Assets row ("Class of Assets as in
--      Depreciation as per SLM"), or the expense head for an Expenses row
--      ("Insurance/Audit fee", "Repair & Maintenances").
--
--  ADDITIVE AND REVERSIBLE. Three nullable columns, no default, no backfill,
--  no policy change: every existing row keeps reading and writing exactly as
--  it does now, and the rollback beside this file drops only what was added.
--  RLS is untouched — `autobooks_parties` already carries its org-scoped
--  member policies and these columns inherit them (CLAUDE.md §6).
--
--  Ship order (CLAUDE.md §15, learned from the Financial Management lock):
--  code first, THEN this migration. The app writes these columns only when
--  they exist — a PostgREST "column not found" is caught, the write is retried
--  without them and the user is told the migration is pending — so deploying
--  the code against a database without this file is a no-op, never an error.
-- ════════════════════════════════════════════════════════════════════════════

alter table public.autobooks_parties
  add column if not exists confirmed_taxfree numeric,
  add column if not exists classify          text,
  add column if not exists classify_note     text;

comment on column public.autobooks_parties.confirmed_taxfree is
  'Tax-free trade as per the party''s signed confirmation letter. Pairs with confirmed_taxable; both come off the letter and neither is ever derived.';
comment on column public.autobooks_parties.classify is
  'Sales: goods | service. Purchase: goods | assets | expenses. Drives the Annexure-13 bucket (goods/expenses -> Others, assets -> Capital).';
comment on column public.autobooks_parties.classify_note is
  'Sub-classification beside `classify`: the SLM depreciation class for an assets row, or the expense head for an expenses row.';
