-- ════════════════════════════════════════════════════════════════════════
--  VAT REGISTER — the firm's OWN VAT book  (2026-08-22)
--
--  Backs js/vatRegister.js (Financial Management → VAT Register), built from
--  the firm's "VAT Registar.ods" spec sheet. Both audit practices are
--  themselves VAT-registered; this is their own register, NOT a client's
--  (a client's VAT book is Autobooks, js/salesPurchaseBook.js).
--
--  THREE TABLES, and deliberately not four — the spec sheet has four pages
--  but its SALES page stores nothing:
--
--    · Sales Register  — DERIVED from service_memos where apply_vat. The
--      sheet says so in as many words ("If we add Tick VAT in Service memo
--      then this sheet will be auto generated"), and the whole reason the
--      module exists is that the firm currently re-types data the database
--      already holds. Same rule as Work Done's Pending List over
--      document_register and Service Memo's own Pending Memos over
--      audit_report_finalization: read the source, store nothing twice.
--
--    · vat_purchases   — the one page that is genuinely typed.
--    · vat_returns     — ONLY the Masebari figures that cannot be derived
--                        (two adjustments and the opening credit).
--    · vat_collections — VAT actually collected from a client. The sheet is
--                        explicit that this page "has no link with Sales,
--                        Purchase, Maskebari", so it is standalone.
--
--  Rollback: db/2026-08-22_vat_register_rollback.sql
-- ════════════════════════════════════════════════════════════════════════


-- ════════════════════════════════════════════════════════════════════════
--  1. vat_purchases — one row per purchase bill
-- ════════════════════════════════════════════════════════════════════════
--
--  · bill_date is an AD `date`, not B.S. text — deliberately UNLIKE
--    bank_transactions, which stores B.S. The Nepali column the sheet draws
--    is derived for display (NepaliLocale.adToBs) rather than stored. One
--    typed field means the two columns can never disagree, and it matches
--    the direction the sales side already runs: service_memos.memo_date is
--    an AD date and its Nepali column is derived the same way. User decision
--    2026-08-22 ("type English, derive B.S.").
--
--  · NO total column. total = tax_free + taxable + vat, derived at read
--    time — the bank_transactions rule ("no stored balances or numbers").
--    A stored total is a second source of truth for arithmetic the app can
--    always redo.
--
--  · vat is its OWN column and is not computed from taxable. The UI seeds it
--    at 13% and leaves it editable, because a supplier bill rounds its own
--    way and the register has to print the bill, not a recomputation. This
--    is the same reasoning that makes the sales register print each memo's
--    stored vat_amount rather than a blanket 13% (docs/modules/
--    financial-management.md §5.13).
--
--  · nature is CHECK-constrained to two values because it drives which head
--    list the UI offers, and a third value would silently offer neither.
--    `head` itself is FREE TEXT with no CHECK: for an asset it holds a
--    window.DEP_SLM_CLASSES name (so a firm asset and the schedule that
--    depreciates it speak one vocabulary), for an expense it holds a head
--    from a datalist the user can extend — the sheet's own "Option to add
--    expenses". A CHECK would defeat that, the same call work_todos.
--    nature_of_work made.
--
--  · No UNIQUE on (bill_no, party). Two suppliers legitimately issue the
--    same bill number, so duplicate protection is a warn-and-confirm in the
--    UI naming the existing bill, not a constraint — the File In Out /
--    Service Memo rule (CLAUDE.md §15).

create table public.vat_purchases (
  id            bigint generated always as identity primary key,
  org_id        bigint not null default private.current_org_id()
                  references public.organizations (id) on delete cascade,

  -- One of FINAL_ACCOUNT_FIRM_KEYS — the two audit practices. Text with no
  -- FK, exactly like bank_accounts.firm_key / service_memos.firm_key:
  -- org_firms is loaded into config at sign-in and resolved there.
  firm_key      text not null,
  fiscal_year   text not null,                  -- dash format, '2083-84'

  bill_date     date not null,
  bill_no       text,
  party_name    text not null,
  party_pan     text,

  tax_free      numeric not null default 0,
  taxable       numeric not null default 0,
  vat           numeric not null default 0,

  nature        text not null default 'expenses'
                  constraint vat_purchases_nature_chk
                  check (nature in ('expenses', 'assets')),
  head          text,
  remarks       text,

  created_by    text,
  updated_by    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.vat_purchases is
  'The firm''s own VAT purchase register (VAT Register module). One row per purchase bill. bill_date is AD; the Nepali date column is derived, not stored. No total column — total = tax_free + taxable + vat at read time.';

-- The access path every screen uses: a firm's bills for one fiscal year in
-- date order. The Masebari then buckets those rows into T1/T2/T3 in JS.
create index vat_purchases_scope_idx on public.vat_purchases (org_id, firm_key, fiscal_year, bill_date);
create index vat_purchases_party_idx on public.vat_purchases (org_id, party_pan);

create trigger set_vat_purchases_updated_at
  before update on public.vat_purchases
  for each row execute function public.set_updated_at();


-- ════════════════════════════════════════════════════════════════════════
--  2. vat_returns — the Masebari's TYPED figures only
-- ════════════════════════════════════════════════════════════════════════
--
--  One row per (firm, fiscal year, period). The return itself is NOT stored:
--  sales come from service_memos, purchases from vat_purchases, and every
--  total recomputes on every open. Only these five figures have no source to
--  derive them from.
--
--  · opening_credit is TYPED, by user decision (2026-08-22), not carried
--    forward from the previous period's computed result. Deriving it was
--    offered and declined.
--
--  · Each adjustment carries a note. An adjustment with no stated reason is
--    what makes a filed return unauditable a year later.
--
--  · The return is deliberately NOT lockable and carries no filed flag or
--    snapshot (user decision 2026-08-22, "no lock — always live"). It
--    recomputes from current data exactly as the spreadsheet does.
--
--  · period is CHECK-constrained: the firm files trimesterly and only
--    trimesterly. T1 = B.S. months 4–7 (Shrawan–Kartik), T2 = 8–11,
--    T3 = 12,1,2,3. The MONTH is what buckets a bill, never a hardcoded end
--    day — the sheet's own 07.30 / 11.30 / 03.31 misstate any period whose
--    last month runs longer (Ashadh 32).

create table public.vat_returns (
  id                    bigint generated always as identity primary key,
  org_id                bigint not null default private.current_org_id()
                          references public.organizations (id) on delete cascade,

  firm_key              text not null,
  fiscal_year           text not null,          -- dash format, '2083-84'
  period                text not null
                          constraint vat_returns_period_chk
                          check (period in ('T1', 'T2', 'T3')),

  sales_adj_amount      numeric not null default 0,
  sales_adj_vat         numeric not null default 0,
  sales_adj_note        text,

  purchase_adj_amount   numeric not null default 0,
  purchase_adj_vat      numeric not null default 0,
  purchase_adj_note     text,

  -- The credit carried in from the previous period. Entered as a POSITIVE
  -- number and subtracted; the sheet's "Opening if (-)" describes how it
  -- prints, not how it is keyed.
  opening_credit        numeric not null default 0,

  remarks               text,

  created_by            text,
  updated_by            text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  -- One return per firm per period. Unlike vat_purchases there is no honest
  -- second row here: a period has exactly one set of adjustments.
  constraint vat_returns_scope_uq unique (org_id, firm_key, fiscal_year, period)
);

comment on table public.vat_returns is
  'Typed inputs to the firm''s trimester VAT return (Masebari) — the two adjustments and the opening credit. Every other figure on the return is derived from service_memos and vat_purchases on every open; nothing about the computed return is stored, and it is deliberately not lockable.';

create trigger set_vat_returns_updated_at
  before update on public.vat_returns
  for each row execute function public.set_updated_at();


-- ════════════════════════════════════════════════════════════════════════
--  3. vat_collections — VAT actually collected from a client
-- ════════════════════════════════════════════════════════════════════════
--
--  The spec sheet's "VAT_Paid_" page, which states twice that it "has no
--  link with Sales, Purchase, Maskebari" and that its client columns are
--  "auto filled from Service memo". So: the client half is derived from the
--  memo, the receipt half (date, voucher, bank) is typed, and the row is a
--  record that the VAT charged on that memo has now been received.
--
--  · service_memo_id is the link that makes the module's "Outstanding" list
--    work — a VAT memo with no row here has not been collected. ON DELETE
--    SET NULL rather than CASCADE: deleting a memo must not silently erase
--    the record of money that actually came in.
--
--  · client_id is NULLABLE / ON DELETE SET NULL with the name and PAN
--    snapshotted beside it — the work_todos precedent
--    (db/2026-08-17_work_todos.sql). service_memos.client_id is itself
--    nullable, so a typed-only client's memo has no directory row to point
--    at, and refusing the collection would be refusing to record real money.
--
--  · bank_name is free text with a UI datalist seeded from bank_accounts.
--    NOT a FK: the sheet asks for the bank a voucher was deposited at, which
--    need not be one of the firm's own configured accounts, and this page is
--    explicitly unlinked from the rest of the app.

create table public.vat_collections (
  id                bigint generated always as identity primary key,
  org_id            bigint not null default private.current_org_id()
                      references public.organizations (id) on delete cascade,

  firm_key          text not null,
  fiscal_year       text not null,              -- dash format, '2083-84'

  service_memo_id   bigint references public.service_memos (id) on delete set null,
  client_id         bigint references public.clients (id) on delete set null,
  client_name       text not null,              -- snapshot
  client_pan        text,                       -- snapshot
  nature_of_work    text,                       -- snapshot of the memo's nature

  amount            numeric not null default 0,
  payment_date      date not null,
  voucher_name      text,
  bank_name         text,
  remarks           text,

  created_by        text,
  updated_by        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table public.vat_collections is
  'VAT collected from a client against a service memo (VAT Register → VAT Collected). Deliberately standalone — the spec sheet states this page has no link with the sales, purchase or Masebari pages. service_memo_id is what makes the derived "Outstanding" worklist possible.';

create index vat_collections_scope_idx on public.vat_collections (org_id, firm_key, fiscal_year, payment_date);
-- Answers "has this memo been collected?" for the Outstanding list.
create index vat_collections_memo_idx  on public.vat_collections (org_id, service_memo_id);

create trigger set_vat_collections_updated_at
  before update on public.vat_collections
  for each row execute function public.set_updated_at();


-- ════════════════════════════════════════════════════════════════════════
--  RLS — member CRUD, org-scoped, on all three
-- ════════════════════════════════════════════════════════════════════════
--
--  Every qual wraps the private.* helpers in (select …). Bare, they are
--  re-evaluated per candidate row (each call an org_members join); wrapped,
--  Postgres hoists them into an InitPlan evaluated once per query. Identical
--  semantics — the helpers depend only on the JWT, never on the row — but on
--  production the difference measured 200 ms vs 4 ms.
--  See db/2026-08-21_rls_initplan_policies.sql and CLAUDE.md §6.

alter table public.vat_purchases   enable row level security;
alter table public.vat_returns     enable row level security;
alter table public.vat_collections enable row level security;

-- ── vat_purchases ──
create policy vat_purchases_select_member on public.vat_purchases
  for select using ((select private.is_app_user()) and org_id = (select private.current_org_id()));
create policy vat_purchases_insert_member on public.vat_purchases
  for insert with check ((select private.is_app_user()) and org_id = (select private.current_org_id()));
create policy vat_purchases_update_member on public.vat_purchases
  for update using ((select private.is_app_user()) and org_id = (select private.current_org_id()))
          with check ((select private.is_app_user()) and org_id = (select private.current_org_id()));
create policy vat_purchases_delete_member on public.vat_purchases
  for delete using ((select private.is_app_user()) and org_id = (select private.current_org_id()));

-- ── vat_returns ──
create policy vat_returns_select_member on public.vat_returns
  for select using ((select private.is_app_user()) and org_id = (select private.current_org_id()));
create policy vat_returns_insert_member on public.vat_returns
  for insert with check ((select private.is_app_user()) and org_id = (select private.current_org_id()));
create policy vat_returns_update_member on public.vat_returns
  for update using ((select private.is_app_user()) and org_id = (select private.current_org_id()))
          with check ((select private.is_app_user()) and org_id = (select private.current_org_id()));
create policy vat_returns_delete_member on public.vat_returns
  for delete using ((select private.is_app_user()) and org_id = (select private.current_org_id()));

-- ── vat_collections ──
create policy vat_collections_select_member on public.vat_collections
  for select using ((select private.is_app_user()) and org_id = (select private.current_org_id()));
create policy vat_collections_insert_member on public.vat_collections
  for insert with check ((select private.is_app_user()) and org_id = (select private.current_org_id()));
create policy vat_collections_update_member on public.vat_collections
  for update using ((select private.is_app_user()) and org_id = (select private.current_org_id()))
          with check ((select private.is_app_user()) and org_id = (select private.current_org_id()));
create policy vat_collections_delete_member on public.vat_collections
  for delete using ((select private.is_app_user()) and org_id = (select private.current_org_id()));
