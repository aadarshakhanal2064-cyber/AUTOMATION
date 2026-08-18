# Dashboard

> Loaded on demand, not in every session. The always-loaded index is **CLAUDE.md §5**;
> this file holds the detail for the Dashboard, plus the removed Billing,
> VAT Compliance and Send Logs modules.
> Moved verbatim out of CLAUDE.md on 2026-07-27 — see `docs/README.md`.

---

### 5.1 Dashboard (`js/dashboard.js`)
Stat cards (client count, documents this month), recent-activity feed, Chart.js doughnut of documents by module — all fed by `AuditLog.recent()/countSince()`. **The default landing tab since 2026-08-01**, when Send Document was removed — which is why `afterSupabaseSignIn()` calls `loadDashboard()` directly; the nav button's `onclick` never fires for the tab you land on. First self-registering module; the pattern model.

### 5.2 VAT Compliance — REMOVED 2026-08-10
Was a portfolio-wide tracker of monthly VAT filing status per client (`js/vatCompliance.js`, table `vat_filings`). Removed by user decision — the firm stopped tracking clients' monthly VAT filing status in this app. Took with it the sidebar tab, two modals, `.vatc-*` CSS, and the `vat_filings` table itself (`db/2026-08-10_drop_vat_filings.sql` — the table was dropped, not kept; 15 rows / 13 clients at removal time, all FY 2082/83, and that data is gone). `clients.vat_status` was **not** removed — it's a client property, still edited via Company Registrar → Company Profile (§5.11d), and is distinct from `clients.tax_registration_type` (CLAUDE.md §15). Historical `audit_log` rows with `module: 'vatCompliance'` remain valid; `js/config.js`'s `MODULE_LABELS`/`ACTIVITY_EVENT_LABELS` keep their display text so the Work Done Activity Log still renders them in words. Recoverable from git history if ever needed again.

### 5.3 Billing — REMOVED 2026-08-18

> **Removed module** (2026-08-18, user decision — "billing is going to get removed
> its no use for me"). Service Memo already records the work and the fee, and Bank
> Entry records the money actually received; Billing sat between them recording
> neither. Three invoices were ever raised, all void by the end.
>
> The removal took `js/billing.js` (718 lines), the tab panel, the invoice drawer
> and both modals in `index.html`, the `.billing-*` CSS, the `MODULE_INITS` entry,
> and four tables — `invoices`, `invoice_items`, `invoice_payments`,
> `firm_bank_details` — with their 12 policies, 7 indexes, 3 triggers, the two
> trigger functions (`set_invoice_number`, `sync_invoice_payment_totals`) and the
> two RPCs (`get_billing_stats`, `get_monthly_income`).
> `db/2026-08-18_drop_billing.sql`; the rollback beside it restores **structure
> only**, and the rows live in the gitignored
> `db/backups/2026-08-18_billing_export.json`.
>
> **What did NOT go:** `public.set_updated_at()` (shared with 14 other triggers);
> `window.VAT_STANDARD_RATE`, now read only by Service Memo; the `firm_key` text
> columns on `bank_accounts` / `party_opening_balances` / `service_memos`, which
> never had a foreign key to `firm_bank_details`; and the 17 `audit_log` rows with
> `module: 'billing'`, whose display labels `js/config.js` still carries so the
> Activity Log renders them in words. Recoverable from git history. Don't restore
> it without an explicit ask.

The record of what it was, since the mechanics still describe how the surviving
PDF path (Service Memo) works:

Tracked money clients owed **the firm** for services. Invoice PDF built with PDF-Lib (firm bank details + payment QR), downloaded for the staff member to attach to their own email, reconciled against recorded payments.
- **There is no in-app emailing** (since 2026-08-01). `billingEmailInvoice()` was the app's last Gmail caller and went with Google auth; marking a draft "sent" now downloads the PDF via the pre-existing `billingDownloadInvoice()` and says so in the status line. Don't re-add a send button without first re-reading `docs/architecture.md` §7.
- **Status is DB-trigger-derived** (§6.2): app code only sets `draft→sent` and `→void` via `billingFlow`; never write `paid`/`partially_paid` from JS.
- Invoice numbers `SA-00001`/`DC-00001` assigned by an AFTER INSERT trigger — re-fetch the row, never trust INSERT's RETURNING.
- Bank QR is a **static uploaded image** (`firm_bank_details.qr_image`, starts NULL); the PDF draws a dashed placeholder until uploaded. Never seed a fake QR that looks scannable.
- `firm_bank_details` upserts must always re-send `invoice_prefix` (NOT-NULL is validated before ON CONFLICT resolution — omitting it 400s).
- Fiscal year format here is **dash**: `2082-83`.

### 5.10 Send Logs — REMOVED 2026-08-01
Deleted with Send Document (`docs/modules/documents.md` 5.4), which was its only writer —
keeping the viewer would have meant a tab that could never gain a row. The `send_logs`
table itself was kept; read it via the Supabase dashboard if the history is ever needed.

