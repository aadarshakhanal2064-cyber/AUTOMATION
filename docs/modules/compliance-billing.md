# Dashboard & Billing

> Loaded on demand, not in every session. The always-loaded index is **CLAUDE.md §5**;
> this file holds the detail for the Dashboard and client invoicing, plus the removed
> VAT Compliance and Send Logs modules.
> Moved verbatim out of CLAUDE.md on 2026-07-27 — see `docs/README.md`.

---

### 5.1 Dashboard (`js/dashboard.js`)
Stat cards (client count, documents this month, OCR jobs this month — the OCR card only reflects historical `audit_log` rows now that the VAT Return module is removed), recent-activity feed, Chart.js doughnut of documents by module — all fed by `AuditLog.recent()/countSince()`. **The default landing tab since 2026-08-01**, when Send Document was removed — which is why `afterSupabaseSignIn()` calls `loadDashboard()` directly; the nav button's `onclick` never fires for the tab you land on. First self-registering module; the pattern model.

### 5.2 VAT Compliance — REMOVED 2026-08-10
Was a portfolio-wide tracker of monthly VAT filing status per client (`js/vatCompliance.js`, table `vat_filings`). Removed by user decision — the firm stopped tracking clients' monthly VAT filing status in this app. Took with it the sidebar tab, two modals, `.vatc-*` CSS, and the `vat_filings` table itself (`db/2026-08-10_drop_vat_filings.sql` — the table was dropped, not kept; 15 rows / 13 clients at removal time, all FY 2082/83, and that data is gone). `clients.vat_status` was **not** removed — it's a client property, still edited via Company Registrar → Company Profile (§5.11d), and is distinct from `clients.tax_registration_type` (CLAUDE.md §15). Historical `audit_log` rows with `module: 'vatCompliance'` remain valid; `js/config.js`'s `MODULE_LABELS`/`ACTIVITY_EVENT_LABELS` keep their display text so the Work Done Activity Log still renders them in words. Recoverable from git history if ever needed again.

### 5.3 Billing (`js/billing.js`, tables `invoices`/`invoice_items`/`invoice_payments`/`firm_bank_details`)
Tracks money clients owe **the firm** for services. Invoice PDF built with PDF-Lib (firm bank details + payment QR), downloaded for the staff member to attach to their own email, reconciled against recorded payments.
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

