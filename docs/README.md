# `docs/` — the on-demand half of the project guide

`CLAUDE.md` is loaded into **every** session, so it holds only what protects work
regardless of which file you open: the hard rules, the coding and git standards,
the engine catalogue, the element-ID collision guard, the fiscal-year format
table, and the full "Deliberate Decisions — Do NOT Fix" list.

Everything here is loaded **only when you open it**. It is the same text that
used to sit in `CLAUDE.md` — moved verbatim on 2026-07-27, not rewritten,
because `CLAUDE.md` had reached ~32,000 tokens and was spending most of that on
module detail irrelevant to whatever the session was actually doing.

**Rule: before editing a feature module, read its doc below.** The index in
`CLAUDE.md` §5 maps every module to its file.

## Reference

| File | Covers | Was |
|---|---|---|
| [`architecture.md`](architecture.md) | Runtime architecture, script load order, CDN pins + SRI, hosting, local dev, the auth lifecycle, Google Drive/Gmail integration, and the three document-generation paths | CLAUDE.md §2, §7, §8, §9.1–9.4 |
| [`database.md`](database.md) | All 18 tables column by column, trigger-owned logic, data conventions, query rules, migration workflow, the full RLS model | CLAUDE.md §6 |
| [`engines.md`](engines.md) | The 12 `js/core/` engines in full — responsibilities, key APIs, and the load-bearing implementation notes | CLAUDE.md §4 |

## Modules

| File | Modules | Code prefixes |
|---|---|---|
| [`modules/clients.md`](modules/clients.md) | Clients Directory — CRUD, import wizard, portfolio dashboard, the client master reloads | `ac-`, `cd-`, `nb-` |
| [`modules/compliance-billing.md`](modules/compliance-billing.md) | Dashboard, VAT Compliance, Billing, Send Logs | `dash-`, `vatc-`, `billing-` |
| [`modules/documents.md`](modules/documents.md) | Send Document, Audit Report Builder, Notes to Accounts, Confirmation Letters | `rep-`, `nta-`, `cl-` |
| [`modules/registrar.md`](modules/registrar.md) | Company Registrar: BM/AGM Minutes, Auditor Change, Company Profile, the four stubs — plus the removed VAT Return OCR module | `bm-`, `ac-`, `cp-` |
| [`modules/financial-management.md`](modules/financial-management.md) | Service Memo, Bank Entry, Party Ledger, Final Account | `sm-`, `bb-`, `pl-`, `fa-` |
| [`modules/depreciation.md`](modules/depreciation.md) | Depreciation — both the Income Tax pool method and the Accounting-Standard SLM method | `dep-`, `dep-slm-` |
| [`modules/autobooks.md`](modules/autobooks.md) | Autobooks (called Sales & Purchase Book everywhere in code) | `spb-` |
| [`modules/projection.md`](modules/projection.md) | Projection Report — the constraint solver, its 10 master rules, and its exports | `pj-` |
| [`modules/financial-statement.md`](modules/financial-statement.md) | Financial Statement — the NFRS statement-set builder | `fs-` |
| [`modules/file-management.md`](modules/file-management.md) | File Management — the physical document custody register | `fm-` |

The four Financial Management modules share one file on purpose: they read each
other's state (`finalAccount.js` calls `partyLedger.js`'s functions, and the
Party Ledger is the join between a Service Memo and a Bank Entry), so working on
one of them usually means needing all four.

## History

[`history/`](history/) holds superseded documents — three session handoffs and
the original README. They are **not** current state; see
[`history/README.md`](history/README.md) for what each is still the sole record
of. `HANDOFF.md` §4–5 is required reading before touching the BM/AGM template.

## Keeping this current

The rule from `CLAUDE.md` §1 is unchanged, only redirected: when a feature ships
or a convention changes, update the relevant doc **in the same commit**. If the
change affects a hard rule, a deliberate decision, an ID prefix or a fiscal-year
format, it belongs in `CLAUDE.md` itself — everything else belongs here.
