# Automation Platform — Shailesh & Associates / Dallakoti & Company

Internal workflow-automation platform for two affiliated audit firms in Chitwan,
Nepal — **Shailesh & Associates** (Chartered Accountants) and **Dallakoti &
Company** (Registered Auditors). Used by the firms' staff (max 8 users) to
automate document generation, VAT return tracking, client management, the firms'
own books, and Drive/Gmail document delivery.

**Live:** <https://aadarshakhanal2064-cyber.github.io/AUTOMATION/>

## Stack

Static HTML/CSS/vanilla-JS single-page app — no framework, no build step, no
bundler. The browser talks directly to Supabase Postgres and to the Google
Drive/Gmail APIs using the signed-in staff member's own OAuth token. There is no
server-side code; GitHub Pages serves the files.

Third-party libraries are CDN `<script>` tags, version-pinned with Subresource
Integrity. Twelve reusable engines in `js/core/` sit under one file per feature
module in `js/`.

## What it does

Audit reports and Notes to Accounts · NFRS financial statement sets ·
multi-year bank projections · depreciation schedules (Income Tax and SLM) ·
sales/purchase book automation · confirmation letters · statutory Company
Registrar minutes and filings · VAT filing compliance tracking · client
invoicing · the firms' own ledgers and final accounts · a client directory ·
Drive document lookup and Gmail delivery.

## Repository layout

```
index.html          the entire UI shell — all panels, all script tags
css/styles.css      the entire design system
js/core/            12 reusable engines
js/                 one file per feature module
assets/templates/   Word templates for document generation
db/                 annotated SQL migrations + rollbacks
docs/               engineering documentation
```

## Documentation

- **[CLAUDE.md](CLAUDE.md)** — the engineering guide and the single authority on
  how this project is built: hard rules, conventions, architecture, and the
  deliberate decisions that must not be "fixed". Start here.
- **[docs/](docs/)** — deeper reference loaded as needed: per-module
  documentation, the database schema, the engine layer, and architecture.
- **[docs/history/](docs/history/)** — superseded documents, kept for the few
  things they remain the sole record of. Not current state.

## Note on data

This repository is **public**. It contains no client data: real names, PANs and
addresses are kept out of committed SQL and out of the sample workbooks used as
local test data. See `.gitignore` for what is deliberately excluded and why.
