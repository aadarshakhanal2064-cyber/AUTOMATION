# Dashboard, VAT Compliance, Billing & Send Logs

> Loaded on demand, not in every session. The always-loaded index is **CLAUDE.md §5**;
> this file holds the detail for the Dashboard, the VAT filing tracker, client invoicing and the send audit trail.
> Moved verbatim out of CLAUDE.md on 2026-07-27 — see `docs/README.md`.

---

### 5.1 Dashboard (`js/dashboard.js`)
Stat cards (client count, documents this month, OCR jobs this month — the OCR card only reflects historical `audit_log` rows now that the VAT Return module is removed), recent-activity feed, Chart.js doughnut of documents by module — all fed by `AuditLog.recent()/countSince()`. Not the default landing tab (deliberate — Send Document stays default). First self-registering module; the pattern model.

### 5.2 VAT Compliance (`js/vatCompliance.js`, table `vat_filings`)
Portfolio-wide tracker of monthly VAT filing status per client. `VAT_MONTH_ORDER` (fiscal-order month names, index 1 = Shrawan) lives at the top of this file.
- **VAT clients are a hand-picked subset** of the directory (`clients.vat_status = 'active'`), managed via the "Manage VAT Clients" picker. Never bulk-activate the directory — most of the ~309 clients do not file VAT with the firm.
- **Rows are lazy**: no `vat_filings` row = "Not Started". Upsert on the `(client_id, fiscal_year, month)` unique constraint; never pre-create months.
- Statuses: `not_started → waiting_docs → ocr_processing → under_review → ready_to_file → filed / filed_adjustments`, plus `on_hold`, `not_required`. Every change goes through `vatcFlow.transition()` (WorkflowEngine.createStatusFlow) which persists + writes the audit entry with `record_ref` = filing id. Auto-progress (`vatcAutoProgress`) only moves **forward** and never touches filed/on_hold/not_required. **Filed is always manual.**
- Deadline = 25th of the following B.S. month; **overdue is derived at render time, never stored**.
- Fiscal year format here is **slash**: `2083/84` (`vatcFyLabel`).

### 5.3 Billing (`js/billing.js`, tables `invoices`/`invoice_items`/`invoice_payments`/`firm_bank_details`)
Tracks money clients owe **the firm** for services. Invoice PDF built with PDF-Lib (firm bank details + payment QR), optionally emailed via Integrations/Gmail, reconciled against recorded payments.
- **Status is DB-trigger-derived** (§6.2): app code only sets `draft→sent` and `→void` via `billingFlow`; never write `paid`/`partially_paid` from JS.
- Invoice numbers `SA-00001`/`DC-00001` assigned by an AFTER INSERT trigger — re-fetch the row, never trust INSERT's RETURNING.
- Bank QR is a **static uploaded image** (`firm_bank_details.qr_image`, starts NULL); the PDF draws a dashed placeholder until uploaded. Never seed a fake QR that looks scannable.
- `firm_bank_details` upserts must always re-send `invoice_prefix` (NOT-NULL is validated before ON CONFLICT resolution — omitting it 400s).
- Fiscal year format here is **dash**: `2082-83`.

### 5.10 Send Logs (`js/logs.js`)
Audit trail of sent documents from `send_logs`. Staff see only their own sends; admins see all with a staff filter. Client name/email are snapshots, intentionally not FK'd.

