// ════════════════════════════════════════════
//  CONFIG — constants, global state, Supabase init
// ════════════════════════════════════════════

// Captured before anything else runs, especially before createClient() below
// — Supabase begins processing (and eventually clearing) a recovery/magic-
// link URL as part of client init, and auth.js's onAuthStateChange
// subscription happens much later (it's deliberately the LAST script, §2), so
// by the time it runs the URL may already be scrubbed. auth.js reads this
// instead of window.location directly, so "was this visit a recovery link"
// survives regardless of exactly when Supabase gets to the URL.
window.AUTH_URL_PARAMS = {
  hash:  new URLSearchParams(window.location.hash.replace(/^#/, '')),
  query: new URLSearchParams(window.location.search),
};

const SUPABASE_URL = 'https://rennqzmwyhkdsizvlqwd.supabase.co';
const SUPABASE_KEY = 'sb_publishable_jatb0tzHNTFzmDrY9HV2tQ_9HAhZ2XW';

// Nepal's standard VAT rate — the one source for the Billing module's
// invoice tax line (and any future consumer), so the figure can't drift.
window.VAT_STANDARD_RATE = 0.13;

// The B.S. fiscal year the firm is currently working through, as the
// START year (2082 = F.Y. 2082/83). Every module's own fiscal-year default
// constant (ARF_FY_DEFAULT, SM_FY_DEFAULT, WD_FY_DEFAULT, PJ_BASE_FY_DEFAULT,
// SPB_FY_DEFAULT, ACHK_FY_DEFAULT, CD_NF_FY, the "selected" option in the
// Report Builder / Notes to Accounts / Auditor Change / BM-AGM fiscal-year
// selects) reads THIS one value, so a year rollover is a single-line change.
// Per-module FORMATS stay deliberately different (CLAUDE.md §8) — this only
// unifies the year. Bump this on Shrawan 1 of the next B.S. year.
window.FY_DEFAULT_START = 2082;

// The local PaddleOCR service (ocr_service/). It runs on each staff member's own
// machine — GitHub Pages can't host Python — so this is loopback, not a server.
// Changing the port means updating ocr_service/config.py and the CSP
// connect-src in index.html to match, or the browser blocks the call.
window.OCR_SERVICE_URL = localStorage.getItem('ocrServiceUrl') || 'http://127.0.0.1:8000';

// ── Shared DataCache keys for the ledger tables ──
// Bank Entry, Party Ledger and Final Account read the same rows; caching them
// under shared keys is what stops three consecutive tab opens from downloading
// bank_transactions three times.
//
// A key spells out the ORDER BY, not just the table, and that is load-bearing:
// Bank Entry sorts bank_accounts by (sort_order, account_name) while Party
// Ledger uses (sort_order, id), and Final Account renders that array in order —
// one shared key would silently reorder its bank list. bank_accounts is a
// handful of rows, so two keys cost nothing; bank_transactions is the big one
// and its query is byte-identical in both modules, so it genuinely shares.
//
// These live here rather than in a module because they are cross-module by
// definition, and config.js loads before every feature file.
window.LEDGER_KEYS = {
  txns:        'bank_transactions@txn_date,id',        // Bank Entry + Party Ledger
  accountsBb:  'bank_accounts@sort_order,account_name',// Bank Entry
  accountsPl:  'bank_accounts@sort_order,id',          // Party Ledger + Final Account
  memosPl:     'service_memos@memo_date,id',           // Party Ledger + Final Account
  memosSm:     'service_memos@created_at_desc+clients',// Service Memo (joins clients)
  openings:    'party_opening_balances@id',
};

// ── Mutable app state (window.* for global access) ──
window.currentUser      = null;   // { email, role }
window.clientsList      = [];     // loaded from Supabase
window.editingClientId  = null;

// ── Supabase client ──
const { createClient } = supabase;
window.sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Import state ──
window.IMPORT_FIELDS = [
  { key:'name',            label:'Client Name *', required:true,  keywords:['client name','party name','name','entity name','customer'] },
  { key:'email',           label:'Email',         required:false, keywords:['email','e-mail','mail'] },
  { key:'pan',             label:'PAN Number',    required:false, keywords:['pan no','pan number','pan'] },
  { key:'phone',           label:'Phone',         required:false, keywords:['phone','mobile','contact no','contact number','tel'] },
  { key:'entity_type',     label:'Entity Type',   required:false, keywords:['entity type','entitry type','type','category'] },
  { key:'business_nature', label:'Nature of Business', required:false, keywords:['nature of bussiness','nature of business','business','industry'] },
  { key:'registration_number', label:'Registration Number', required:false, keywords:['registration number','regd no','regd number','reg no','reg number','registration no','company registration number','company reg','company reg.','company reg no','regn no','regn number'] },
  { key:'chairman_name',       label:'Chairman Name',       required:false, keywords:['chairman name','chairman','chairperson'] },
  { key:'shareholder_name',    label:'Shareholder Name',    required:false, keywords:['shareholder name','shareholder','shareholders'] },
  { key:'authorized_capital',  label:'Authorized Capital',  required:false, keywords:['authorized capital','authorised capital','authorized share capital','auth capital','auth. capital'] },
  { key:'issued_capital',      label:'Issued Capital',      required:false, keywords:['issued capital','issue capital'] },
  { key:'paid_up_capital',     label:'Paid-up Capital',     required:false, keywords:['paid up capital','paid-up capital','paidup capital','paid capital'] },
  { key:'address',         label:'Address',       required:false, keywords:['address','location'] },
  { key:'district',        label:'District',      required:false, keywords:['district','zilla'] },
  { key:'country',         label:'Country',       required:false, keywords:['country'] },
  { key:'it_return_type',  label:'IT Return Type', required:false, keywords:['type of it return','it return','income tax return type','return type'] },
  { key:'tax_type_d3',     label:'Tax Type (D-3)', required:false, keywords:['tax type for only d3','tax type for d3','tax type'] },
  { key:'tax_registration_type', label:'Tax Registration (VAT/PAN)', required:false, keywords:['vat/pan','vat / pan','tax registration','type of tax registration','vat or pan'] },
];

// The income-tax return types the firm files. D1/D2 is a real single value,
// not a placeholder: the client master marks a client as "D-1 and D-2 — it can
// be both", and it is narrowed to one of the two only when that is known.
window.CLIENT_IT_RETURN_TYPES = ['D1/D2', 'D-01', 'D-02', 'D-03'];

// Whether the client is registered for VAT or holds a PAN only. From the
// client master's "VAT/PAN" column (V/P). NOT the same thing as
// clients.vat_status, which is whether the firm files that client's monthly
// VAT returns — a hand-picked subset (§5.2). A client can be VAT-registered
// without the firm filing for it.
window.CLIENT_TAX_REGISTRATION_TYPES = ['VAT', 'PAN'];

// The entity types the client form offers. Reduced to these eight on
// 2026-07-26 at the user's request.
window.CLIENT_ENTITY_TYPES = [
  'Private Limited Company',
  'Public Limited Company',
  'Proprietorship Firm',
  'NPO',
  'NGO',
  'Cooperative Organization',
  'Individual',
  'Others',
];

// ── Nature of Business → parent category ──
// Derived from the 261 client-master values on 2026-07-26; every one of them
// matches a rule, so nothing lands in a junk bucket. ORDER IS LOAD-BEARING:
// the first match wins, so specific sectors are tested before the broad
// Trading/Manufacturing verbs — "Manufacturing of Feed of birds" is Poultry,
// not Manufacturing, and "Trading of Medicines" is Health, not Trading.
window.NATURE_CATEGORY_RULES = [
  ['Poultry',                    /poultry|feed\s+(of|for)\s+birds|bird breeding|hatchery/i],
  // Grocery beats the vegetable rule below: "Trading of Grocery,Vegetables"
  // is a kirana shop, not a farm.
  ['Trading',                    /grocery|khadhyanna|kirana/i],
  ['Agriculture & Livestock',    /agricultur|cattle|fish farming|krishi|dairy|milk product|vegetable/i],
  ['Hotel & Restaurant',         /hotel|restaurant|resort|khaja/i],
  ['Health',                     /health|medicine|medical|pharmac|polyclinic|dental|clinic/i],
  ['Education & Consultancy',    /education|consultan|migration|visa|montessori|academy|study cent/i],
  ['Transport & Freight',        /freight|dhuwani|logistic|transport/i],
  ['Construction & Engineering', /construction|engineering|nirman|builder/i],
  ['Investment & Finance',       /investment|saving|credit|co ?operativ/i],
  ['Real Estate',                /real ?estate|housing/i],
  ['Mining',                     /mining/i],
  ['Manufacturing',              /manufactur|manufacture|udhyog|industr|mill\b/i],
  ['Import & Distribution',      /^import\b/i],
  ['Trading',                    /trading|trade|supplier|stores|distribut/i],
  ['Other Services',             /service|saloon|cinema|software|labour/i],
];

// Display-only canonicalisation of the sub-type shown in the drill-down. The
// stored business_nature is never rewritten — this only stops the list showing
// "Trading Hardware items", "Trading of Hardware Items" and "Trading of
// Hardware items" as three separate things.
window.NATURE_CANON_RULES = [
  [/hardware/i,                         'Trading of Hardware Items'],
  [/stationery/i,                       'Trading of Stationery Items & Books'],
  [/motors? parts/i,                    'Trading of Motor Parts'],
  [/^trading of grocery/i,              'Trading of Grocery'],
  [/house ?hold/i,                      'Trading of Household Items'],
  [/^trading of (cosmetics|closet)/i,   'Trading of Cosmetics'],
  [/^trading of medicines?$/i,          'Trading of Medicines'],
  [/manufacturing of rice/i,            'Manufacturing of Rice & Oil'],
  [/feed\s+(of|for)\s+(birds|cattle)/i, 'Manufacturing of Feed'],
];

window.importHeaders     = [];   // raw header strings from the file
window.importDataRows    = [];   // raw row arrays (excludes header row)
window.importFieldMap    = {};   // { fieldKey: headerIndex | -1 }
window.importPreviewRows = [];   // processed rows ready for review

// ── Report generator data ──
window.REP_FIRMS = {
  shailesh: {
    name: "Shailesh & Associates", title: "Chartered Accountants",
    address: "Khairahani-01, Chitwan", email: "shailesh.2214@gmail.com",
    phone: "9855062760, 056-562760", regNo: "619", mNo: "954",
    pan: "604101019", copNo: "714",
    signatoryName: "Shailesh Dallakoti, CA", signatoryTitle: "Proprietor",
    logo: "assets/logo-lockup.png", // full lockup (icon + firm name + "Chartered Accountants"), transparent bg — no equivalent asset for other firms
    nameNp: "शैलेश एण्ड एसोसिएट्स", auditorNameNp: "शैलेश डल्लाकोटी", titleNp: "सीए"
  },
  dallakoti: {
    name: "Dallakoti & Company", title: "Registered Auditor",
    address: "Ratnanagar-02, Chitwan", email: "dac.audit@gmail.com",
    phone: "9855060014, 056-562760", regNo: '"B" 2716', mNo: "3105",
    pan: "300336179", copNo: "148",
    signatoryName: "Devi Prasad Dallakoti, RA", signatoryTitle: "Proprietor",
    nameNp: "डल्लाकोटी एण्ड कम्पनी", auditorNameNp: "देवी प्रसाद डल्लाकोटी", titleNp: "आर.ए."
  }
};

// Devanagari-display view of REP_FIRMS, for the "known firm" quick-fill
// pickers on BM/AGM Minutes and Auditor Change — one shared source instead
// of each module hardcoding its own copy of the same two firms/names.
window.REGD_AUDIT_FIRMS = Object.values(window.REP_FIRMS).map(f => ({
  firmName: f.nameNp, auditorName: f.auditorNameNp, title: f.titleNp
}));

// ── Service Memo module data ──
// Four selectable firms (the two audit firms + two sister concerns from the
// firm's "Work Performed" sheet). This is the ONE source for both the memo's
// firm dropdown and its PDF letterhead, so a new firm needs no DB migration —
// the memo-number trigger is driven by `prefix` sent from the app.
//   · shailesh/dallakoti reference REP_FIRMS for full letterhead (address/PAN/
//     signatory); resolved via `ref`.
//   · rosp/rtc carry their own name; address/PAN are left blank for the firm to
//     fill in here later (the PDF prints "—" until then).
//   · `other` is the sheet's "other--Specify" row: the name is typed per memo
//     (service_memos.firm_other) rather than configured. `typed: true` is what
//     the UI keys the extra input off, so adding another typed firm needs no
//     code change.
window.SERVICE_MEMO_FIRMS = {
  shailesh:  { key: 'shailesh',  name: window.REP_FIRMS.shailesh.name,  prefix: 'SM-SA',   ref: 'shailesh' },
  dallakoti: { key: 'dallakoti', name: window.REP_FIRMS.dallakoti.name, prefix: 'SM-DC',   ref: 'dallakoti' },
  rosp:      { key: 'rosp',      name: 'Ratnanagar Offset Screen Print', prefix: 'SM-ROSP', address: '', pan: '', phone: '', email: '' },
  rtc:       { key: 'rtc',       name: 'Ratnanagar Tax Consultancy',     prefix: 'SM-RTC',  address: '', pan: '', phone: '', email: '' },
  other:     { key: 'other',     name: 'Other — specify',                prefix: 'SM-OT',   typed: true, address: '', pan: '', phone: '', email: '' },
};

// The two audit firms are the only ones the Final Account statements are drawn
// for (the workbook's Balance Sheet has exactly these two columns) — the sister
// concerns and "other" can still raise memos and hold bank accounts.
window.FINAL_ACCOUNT_FIRM_KEYS = ['shailesh', 'dallakoti'];

// Nature-of-task category → sub-category tree, seeded from the firm's "Work
// Performed" sheet (typos fixed: "Business", "Income Tax Filing"; "OCR"
// relabeled "Company Registrar (OCR)" and the "OCR-" sub-category prefixes
// dropped). Every category ends in "Others" (free text when chosen). Easily
// extensible — add a category object or a sub-category string.
window.SERVICE_MEMO_TASKS = [
  { category: 'Audit',                   subs: ['Statutory Audit', 'Internal Audit', 'Others'] },
  { category: 'IRD Related',             subs: ['VAT Filing', 'Income Tax Filing', 'Tax Clearance', 'Full Audit', 'Others'] },
  { category: 'Company Registrar (OCR)', subs: ['Annual Return', 'Share Transfer', 'Capital Increase', 'Company Registration', 'Company Deregistration', 'Others'] },
  { category: 'Consultancy',             subs: ['Book Keeping', 'Others'] },
  { category: 'Bank Loan Related',       subs: ['Provisional/Projected', 'Business Plan', 'Stock Verification', 'Others'] },
  { category: 'Certification',           subs: ['CA Report', 'Valuation', 'Others'] },
  { category: 'Others',                  subs: ['Others'] },
];

// ── Bank Book module data ──
// Receipt / payment "particular" types (js/bankBook.js). `party` labels the
// contextual counterparty field in the entry drawer. The bank/holder list is
// NOT config — it's user-managed data in the bank_accounts table (unlike the
// fixed SERVICE_MEMO_FIRMS list), because staff add/edit their own accounts.
// inter_bank_transfer is entered once and stored as two paired legs (payment
// out + receipt in) sharing a transfer_group_id — see bankBook.js.
window.BANK_RECEIPT_TYPES = [
  { key: 'fee_receipt',         label: 'Fee Receipt',         party: 'Name of Client' },
  { key: 'for_tax',             label: 'For Tax',             party: 'Name of Client' },
  { key: 'sapati',              label: 'Sapati',              party: 'Name of Person' },
  { key: 'inter_bank_transfer', label: 'Inter-bank Transfer', party: 'From / To Account' },
];
window.BANK_PAYMENT_TYPES = [
  { key: 'expenses',            label: 'Expenses',            party: 'Name of Expenses' },
  { key: 'tax_payment',         label: 'Tax Payment',         party: 'Name of Client' },
  { key: 'sapati',              label: 'Sapati',              party: 'Name of Person' },
  { key: 'inter_bank_transfer', label: 'Inter-bank Transfer', party: 'From / To Account' },
];

// Particulars whose counterparty is a directory client (autocomplete + a real
// client_id link) rather than free text. All three land in the Party Ledger:
// fee_receipt/for_tax reduce what the client owes, tax_payment increases it.
window.BANK_CLIENT_PARTICULARS = ['fee_receipt', 'for_tax', 'tax_payment'];

// ── File In Out (Document Register — display renamed 2026-08-09, code kept
// as-is: js/fileManagement.js, fm-, document_register. Same label-only
// precedent as Autobooks/Bank Entry, CLAUDE.md §5) module data ──
// Document kinds a client physically hands over, matching the firm's paper
// register. One intake can carry several, each with its own quantity (the
// register's "No of books"/"no PAD"/"no" columns) — stored as a jsonb array
// of {type, qty} in document_register.doc_types. `unit` is display-only
// (the label next to the quantity input / table cell). Adding a kind here
// needs no migration. A manually-typed "Others" row (own name + qty) is
// handled separately in js/fileManagement.js, not part of this picklist.
// Bank Statement and Bank Loan/Interest Certificate are placed at an even
// index on purpose — the intake drawer renders this in a 2-column grid, so
// the two bank-related items land in the same row, side by side. Cheque
// Book/Vouchers and Tax Documents were removed 2026-08-09 (unused by the
// firm's actual register; the free-typed "Others" row covers them if
// ever needed).
window.FM_DOC_TYPES = [
  { key: 'sales_register',      label: 'Sales Register',                unit: 'Books' },
  { key: 'purchase_register',   label: 'Purchase Register',             unit: 'Books' },
  { key: 'sales_bill',          label: 'Sales Bill',                    unit: 'Pads' },
  { key: 'purchase_bill',       label: 'Purchase Bill',                 unit: 'Pads' },
  { key: 'stock_book',          label: 'Stock Book',                    unit: 'Books' },
  { key: 'ledger',              label: 'Ledger',                        unit: 'Books' },
  { key: 'bank_statement',      label: 'Bank Statement',                unit: 'No.' },
  { key: 'bank_loan_interest',  label: 'Bank Loan / Interest Certificate', unit: 'No.' },
  { key: 'confirmation',        label: 'Confirmation',                  unit: 'No.' },
];

// ── Audit Report Finalization module data ──
// The auditor a record is signed under. The first and third entries are the
// two FIRM names (matching REP_FIRMS above), not partner names — renamed
// 2026-08-09. 'Other' reveals a free-text box and the typed name replaces it
// in the saved row, so audit_report_finalization.auditor is deliberately
// free text with NO check constraint.
window.ARF_AUDITORS = [
  'Shailesh & Associates',
  'Non-Sign',
  'Dallakoti & Company',
  'Lila Adhikari',
  'Surya Poudel',
  'Other',
];

// A record tracks exactly ONE of these; the form reveals only that track's
// fields, and one client+fiscal year may hold one record of each type.
// CHECK-constrained identically in audit_report_finalization.return_type.
window.ARF_RETURN_TYPES = [
  { key: 'it_return',       label: 'IT Return' },
  { key: 'estimate_return', label: 'Estimate Return' },
  { key: 'tax_clearance',   label: 'Tax Clearance' },
];

// Which income-tax return form the IT-return record is for.
window.ARF_IT_RETURN_TYPES = ['D-2', 'D-3'];

// Staff selectable as "Entered By" / "Checked By" on both tracks. 'Other'
// reveals a free-text name box; the typed name REPLACES 'Other' in the saved
// row — none of the staff columns has a separate *_other column.
window.ARF_STAFF = ['Aadarsha', 'Kesav', 'Dipendra', 'Other'];

// ── Audit Checklist module data ──
// "Checked by" list for the QC checklist — the two FIRM names (matching
// REP_FIRMS) plus individual staff, per the CA's own note on the paper form
// ("Check by Staff list also include Shailesh Dallakoti Name and others").
// 'Other' reveals a free-text box and the typed name REPLACES 'Other' in the
// saved row, same convention as ARF_AUDITORS — no separate *_other column.
window.AQC_STAFF = ['Shailesh & Associates', 'Dallakoti & Company', 'Aadarsha', 'Kesav', 'Dipendra', 'Other'];

// The fixed checklist template, in display order. A new record seeds
// items[] from this list (see js/auditChecklist.js), every item unchecked.
// Every client gets all 9 — an earlier version gated the two VAT items on
// clients.vat_status, which meant most clients (VAT-active is a small
// hand-picked subset) never saw them at all; the CA asked for them on every
// checklist regardless. Add a row here (no migration needed — items is
// jsonb) when the firm's checklist grows.
window.AQC_CHECKLIST_ITEMS = [
  { key: 'py_fig',              label: 'P.Y Fig' },
  { key: 'sales_purchase_vat',  label: 'Sales/Purchase with VAT Return' },
  { key: 'bank_balances',       label: 'Bank Balances' },
  { key: 'bank_loan_interest',  label: 'Bank Loan Interest' },
  { key: 'py_vat_adjustment',   label: 'P.Y VAT Adjustment' },
  { key: 'fs_overall_check',    label: 'Overall F.S Check' },
  { key: 'ann_1_2',             label: 'Ann-1/2' },
  { key: 'ann_10',              label: 'Ann-10' },
  { key: 'ann_13',              label: 'Ann-13' },
];

// ── Work Done module data ──
// The firm's work-type sheet, in display order, `group` driving the headings
// the entry form renders them under. A new record seeds items[] from this
// list (see js/workDone.js), every row 'not_started'. Adding a work type here
// needs no migration — work_done.items is jsonb.
//
// `fileLabels` lists the document_register doc-type labels that imply this
// work, and marks the ONLY rows that can appear in the Pending List — as the
// firm's own sheet specifies ("If file is received and work is not done"
// against Sales Register / Purchase Register / Stock Book, and "Do not show
// in Pending list" against every other row). These are matched against
// doc_types[].type, which stores the label TEXT, not the key.
//
// It is a LIST, not a single string, for two reasons found in the live data
// (2026-08-10): the firm's real register uses "Purchase & Sales Files" as ONE
// combined item covering both registers, and every row written before the
// 2026-08-09 File In Out picklist rework carries that older vocabulary. A
// single-label mapping matched none of it and the Pending List came up empty.
// Add a spelling here rather than editing history when the vocabulary shifts.
//
// 'Other Specify' from the paper sheet is deliberately absent — ad-hoc work
// uses unlimited custom rows instead (the auditChecklist.js mechanism).
window.WD_WORK_TYPES = [
  { key: 'sales_register',      label: 'Sales Register',        group: 'Books & Records',      fileLabels: ['Sales Register', 'Purchase & Sales Files', 'Sales Book'] },
  { key: 'purchase_register',   label: 'Purchase Register',     group: 'Books & Records',      fileLabels: ['Purchase Register', 'Purchase & Sales Files', 'Purchase Book', 'Purchase File'] },
  { key: 'stock_book',          label: 'Stock Book',            group: 'Books & Records',      fileLabels: ['Stock Book'] },
  { key: 'sp_as_per_vat',       label: 'S/P as per VAT Return', group: 'VAT & Reconciliation' },
  { key: 'vat_reco',            label: 'VAT Reco',              group: 'VAT & Reconciliation' },
  { key: 'ann_13',              label: 'Ann-13',                group: 'VAT & Reconciliation' },
  { key: 'confirmation',        label: 'Confirmation',          group: 'VAT & Reconciliation' },
  { key: 'financial_statement', label: 'Financial Statement',   group: 'Financial Statements' },
  { key: 'projected',           label: 'Projected',             group: 'Financial Statements' },
  { key: 'provisional',         label: 'Provisional',           group: 'Financial Statements' },
  { key: 'vat_return',          label: 'VAT Return',            group: 'Returns & Filing' },
  { key: 'etds_return',         label: 'ETDS Return',           group: 'Returns & Filing' },
  { key: 'excise_return',       label: 'Excise Return',         group: 'Returns & Filing' },
  { key: 'ird_submission',      label: 'IRD Submission',        group: 'Returns & Filing' },
  { key: 'ledger_scrutiny',     label: 'Ledger Scrutiny',       group: 'Review & Advisory' },
  { key: 'consulting',          label: 'Consulting',            group: 'Review & Advisory' },
];

// Three states per work row, not a plain done-tick: "In Progress" is what
// stops two staff starting the same job, which is half the reason the module
// exists. Record status and the Pending List both derive from these.
window.WD_STATES = [
  { key: 'not_started', label: 'Not Started', icon: '⬜', badgeClass: 'badge-neutral' },
  { key: 'in_progress', label: 'In Progress', icon: '🟡', badgeClass: 'badge-amber' },
  { key: 'done',        label: 'Done',        icon: '✅', badgeClass: 'badge-sent' },
];

// Work Done's "Name of Staff" reuses window.ARF_STAFF above — same humans as
// Audit Report Finalization, so adding a staff member stays ONE config edit
// for both modules. Deliberately not copied into a WD_STAFF constant.

// ── Work Done → To-Do List (js/workDoneTodo.js, table work_todos) ──
// Priority is the ONE axis the to-do list adds that no other module has, and
// it is deliberately three values rather than five: the sections already sort
// by how late a task is, so priority only has to break ties within a day.
// The keys are CHECK-constrained in the database — add a value here and the
// constraint needs the same edit (db/2026-08-17_work_todos.sql).
//
// The to-do list reuses window.WD_STATES for status (same three keys, so all
// three Work Done views read one vocabulary) and window.ARF_STAFF for who it
// is assigned to — neither is copied here.
window.WD_TODO_PRIORITIES = [
  { key: 'high',   label: 'High',   icon: '🔴' },
  { key: 'normal', label: 'Normal', icon: '🔵' },
  { key: 'low',    label: 'Low',    icon: '⚪' },
];

// ── Activity Log vocabulary (Work Done → Activity Log, js/workDone.js) ──
// audit_log stores the raw ModuleRegistry id in `module` and a snake_case
// verb in `event_type`. Both are developer vocabulary; these two maps are
// what turn them into the words the firm actually uses, so the Activity Log
// reads like a work diary rather than a debug feed.
//
// The keys are the DISPLAY names of §5's modules, including the three that
// were renamed display-only (Autobooks / Bank Entry / File In Out keep their
// original code ids — CLAUDE.md §5). An unmapped module or event falls back
// to its raw value rather than being hidden: a new module's events must show
// up in the log the day it ships, before anyone remembers to add it here.
window.MODULE_LABELS = {
  auditChecklist: 'Audit Checklist',
  auditorChange: 'Auditor Change',
  auditReportFinalization: 'Audit Report Finalization',
  bankBook: 'Bank Entry',
  billing: 'Billing',
  bmAgmMinutes: 'BM/AGM Minutes',
  clients: 'Clients',
  companyProfile: 'Company Profile',
  confirmationLetters: 'Confirmation Letters',
  dashboard: 'Dashboard',
  depreciation: 'Depreciation',
  fileManagement: 'File In Out',
  finalAccount: 'Final Account',
  finStatement: 'Financial Statement',
  notesToAccounts: 'Notes to Accounts',
  ocrExtract: 'OCR Extract',
  partyLedger: 'Party Ledger',
  projection: 'Projection Report',
  report: 'Generate Report',
  salesPurchaseBook: 'Autobooks',
  serviceMemo: 'Service Memo',
  // Removed modules (VAT Return 2026-07-14, VAT Compliance 2026-08-10). Kept
  // because their audit_log rows survive the module — dropping the label would
  // print a raw code id in the Activity Log for work the firm really did.
  vatCompliance: 'VAT Compliance',
  vatReturn: 'VAT Return',
  workDone: 'Work Done',
};

// Modules whose Activity Log entries are restricted to events that actually
// WROTE TO THE DATABASE (user decision, 2026-08-10). Generating, printing or
// downloading a depreciation schedule or an audit report is a step on the way
// to the work, not the work — and both modules emit one event per export, so
// they dominated the log with attempts rather than results.
//
// Listing a module here means "only these event types count for it". A module
// that is ABSENT is unrestricted, so the default for anything new is still to
// show everything.
//
// Deletes are kept deliberately: a delete is a database write, and hiding it
// would leave the log asserting a schedule exists after it was removed.
window.ACTIVITY_SAVED_ONLY = {
  depreciation: ['depreciation_saved', 'depreciation_deleted'],
  report: ['audit_report_saved'],
};

// The Activity Log is scoped to the seven modules that make up the firm's
// per-client work history (user decision, 2026-08-15) — everything else
// (Bank Entry, Billing, Clients, ...) still writes to audit_log as before,
// it's just not part of what THIS view answers. This is what keeps a bank
// account name ("Dallakoti & Company(current)") or an expense particular
// ("Bank Charges") out of the Client filter — those only ever come from
// bankBook, which isn't in the list.
window.ACTIVITY_MODULES = ['finStatement', 'projection', 'confirmationLetters',
  'salesPurchaseBook', 'fileManagement', 'auditReportFinalization', 'auditChecklist'];

// event_type → what a person would call it. Grouped by the module that
// emits it; see the AuditLog.record() calls across js/.
window.ACTIVITY_EVENT_LABELS = {
  achk_created: 'Checklist created', achk_updated: 'Checklist updated',
  achk_deleted: 'Checklist deleted', achk_printed: 'Checklist printed',
  arf_created: 'Finalization record created', arf_updated: 'Finalization record updated',
  arf_deleted: 'Finalization record deleted', arf_printed: 'Finalization printed',
  audit_report_saved: 'Audit report saved',
  bank_account_created: 'Bank account created', bank_account_updated: 'Bank account updated',
  bank_account_deactivated: 'Bank account deactivated', bank_account_deleted: 'Bank account deleted',
  bank_transfer_created: 'Bank transfer recorded', bank_transfer_updated: 'Bank transfer updated',
  bank_transfer_deleted: 'Bank transfer deleted',
  bank_txn_created: 'Bank entry recorded', bank_txn_updated: 'Bank entry updated',
  bank_txn_deleted: 'Bank entry deleted',
  clients_nonfilers_printed: 'Non-filers list printed',
  company_profile_saved: 'Company profile saved',
  depreciation_saved: 'Depreciation schedule saved', depreciation_deleted: 'Depreciation schedule deleted',
  depreciation_printed: 'Depreciation printed',
  document_generated: 'Document generated',
  document_register_created: 'File intake recorded', document_register_updated: 'File intake updated',
  document_register_deleted: 'File intake deleted', document_register_printed: 'Register printed',
  document_register_status_change: 'Outtake / status change',
  final_account_printed: 'Final account printed',
  finstatement_generated: 'Financial statement generated', finstatement_saved: 'Financial statement saved',
  finstatement_printed: 'Financial statement printed', finstatement_py_parsed: 'Prior-year statement parsed',
  firm_bank_details_updated: 'Firm bank details updated',
  invoice_created: 'Invoice created', invoice_deleted: 'Invoice deleted',
  invoice_payment_recorded: 'Invoice payment recorded', invoice_status_change: 'Invoice status change',
  notes_to_accounts_saved: 'Notes to Accounts saved',
  ocr_extract_run: 'OCR extraction run',
  party_opening_saved: 'Party opening balance saved',
  projection_generated: 'Projection generated', projection_saved: 'Projection saved',
  projection_printed: 'Projection printed', projection_statement_parsed: 'Statement parsed',
  service_memo_created: 'Service memo created', service_memo_updated: 'Service memo updated',
  service_memo_deleted: 'Service memo deleted',
  spb_correction: 'Autobooks correction', spb_autofix: 'Autobooks auto-correction',
  spb_book_saved: 'Autobooks book saved', spb_register_printed: 'Register printed',
  spb_omitted_added: 'Omitted bill added', spb_omitted_updated: 'Omitted bill updated',
  spb_omitted_deleted: 'Omitted bill deleted', spb_omitted_printed: 'Omitted bills printed',
  spb_vat_return_imported: 'VAT return figures imported',
  spb_confirmation_printed: 'Confirmation reconciliation printed',
  spb_openings_carried: 'Opening balances carried forward',
  spb_openings_imported: 'Opening balances imported',
  spb_ann13_printed: 'Annexure-13 printed',
  spb_reco_printed: 'Reconciliation statements printed',
  spb_reco_suggested: 'Reconciliation lines suggested',
  // Historical only — the VAT Compliance module that emitted these was removed
  // 2026-08-10; its audit_log rows remain.
  vat_client_change: 'VAT client change', vat_filing_update: 'VAT filing updated',
  vat_status_change: 'VAT status change',
  wd_created: 'Work record created', wd_updated: 'Work record updated',
  wd_deleted: 'Work record deleted', wd_printed: 'Work record printed',
  // To-Do List. Only these three are logged — a to-do autosaves on every
  // field edit, and logging each one would add hundreds of rows a week to a
  // table that already only grows. Created / completed / deleted is what a
  // history of the list actually needs.
  wd_todo_created: 'To-do added', wd_todo_completed: 'To-do completed',
  wd_todo_deleted: 'To-do deleted',
};

window.REP_FY_DATES = {
  "2078-79": { bs: "32nd Ashadh, 2079", ad: "16th July, 2022" },
  "2079-80": { bs: "31st Ashadh, 2080", ad: "16th July, 2023" },
  "2080-81": { bs: "31st Ashadh, 2081", ad: "15th July, 2024" },
  "2081-82": { bs: "32nd Ashadh, 2082", ad: "16th July, 2025" },
  "2082-83": { bs: "32nd Ashadh, 2083", ad: "16th July, 2026" }
};

window.REP_ENTITY_PROFILES = {
  // citeSpecificAct: only Private Company names its governing act by title in
  // the report ("Companies Act, 2063") — every other entity type instead says
  // the generic "the applicable law" (see report.js's Report on Other Legal
  // and Regulatory Requirements paragraph).
  private_company: { label:"Private Company", salutationTo:"the Shareholders of the", governingBodyShort:"board of directors (owners as the case may be)", entityNoun:"company", entityNounCap:"Company", act:"Companies Act, 2063", citeSpecificAct:true, statusLine:"is the Private Company in Nepal" },
  public_company:  { label:"Public Company", salutationTo:"the Shareholders of the", governingBodyShort:"board of directors (owners as the case may be)", entityNoun:"company", entityNounCap:"Company", act:"Companies Act, 2063", statusLine:"is the Public Company in Nepal" },
  proprietorship:  { label:"Proprietorship", salutationTo:"the Proprietor of the", governingBodyShort:"proprietor", entityNoun:"firm", entityNounCap:"Firm", act:"Private Firm Registration Act, 2034", statusLine:"is a Proprietorship Firm in Nepal" },
  partnership:     { label:"Partnership Firm", salutationTo:"the Partners of the", governingBodyShort:"partner", entityNoun:"firm", entityNounCap:"Firm", act:"Partnership Act, 2020", statusLine:"is a Partnership Firm in Nepal" },
  ngo:             { label:"NGO", salutationTo:"the Board of Members of", governingBodyShort:"board of member", entityNoun:"organization", entityNounCap:"Organization", act:"Association Registration Act, 2034", statusLine:"is a Non-Governmental Organization registered in Nepal" },
  npo:             { label:"NPO / Association", salutationTo:"the Board of Members of", governingBodyShort:"board of member", entityNoun:"organization", entityNounCap:"Organization", act:"Association Registration Act, 2034", statusLine:"is a Non-Profit Organization registered in Nepal" },
  cooperative:     { label:"Cooperative", salutationTo:"the Members of the", governingBodyShort:"board of directors", entityNoun:"cooperative", entityNounCap:"Cooperative", act:"Cooperatives Act, 2074", statusLine:"is a Cooperative registered in Nepal" }
};

// ── Notes to Accounts data ──
// Accounting-standard wording that fills the "Statement of Compliance" (2.1.1)
// and "Critical Accounting Estimates" (2.1.3) paragraphs. `full` is the first
// mention (spelled out + abbreviation), `short` the abbreviation reused after.
window.NTA_ACCOUNTING_STANDARDS = {
  micro:    { label: "NAS for Micro Entities", full: "Nepal Accounting Standard for Micro Entities (NAS for MEs)", short: "NAS for MEs" },
  sme:      { label: "NFRS for SMEs",          full: "Nepal Financial Reporting Standard for Small & Medium-Sized Entities (NFRS for SMEs)", short: "NFRS for SMEs" },
  existing: { label: "Existing NAS",           full: "Nepal Accounting Standards (NAS)", short: "NAS" }
};

window.NTA_DEPRECIATION_METHODS = {
  slm: { label: "SLM (Straight Line Method)", name: "SLM Method" },
  wdv: { label: "WDV (Written Down Value)",   name: "WDV Method" }
};

// Default Property, Plant & Equipment useful-life rows — pre-filled but fully
// editable (rows add/removable) in the Notes to Accounts depreciation section.
window.NTA_PPE_DEFAULTS = [
  { type: "Building",               life: "49 years" },
  { type: "Office Equipments",      life: "4 years" },
  { type: "Furniture and Fixtures", life: "4 years" },
  { type: "Vehicles",               life: "14 years" },
  { type: "Plant and Machinery",    life: "10 years" }
];

// Standard PPE asset classes for the accounting-standard (SLM) depreciation
// method (§5.8, "Dep as Books" / 3.1 PPE note). These are BOTH the row-groups
// of the schedule and the columns of the PPE note, so the two always line up.
// `life` = default useful life in years (editable per asset in the grid),
// mirroring NTA_PPE_DEFAULTS where a class matches; Land is never depreciated.
// `kw` drives Excel-import row→class matching (same tolerant approach as the
// Income-Tax pools). Order here is the display + PPE-note column order.
// `itPool` is the DEP_POOL_DEFS key this class lands in when an SLM addition
// line is copied across to the Income-Tax addition helper (depreciation.js
// `depSyncAdditionsFromSlm`). It is a SUGGESTION the user can change, but not a
// guess: each Income-Tax pool's own name states the classes it covers — Pool B
// is "Furniture, Fixture & Office Equipment" and Pool D is "Plant & Machinery &
// Other Assets", which is why both `office` and `furniture` map to B, and
// `machine` to D.
window.DEP_SLM_CLASSES = [
  { key: 'land',      name: 'Land',                   depreciable: false, life: 0,  itPool: 'land',      kw: ['land'] },
  { key: 'building',  name: 'Building & Structures',  depreciable: true,  life: 49, itPool: 'building',  kw: ['building', 'structure'] },
  { key: 'machine',   name: 'Machine & Other Assets', depreciable: true,  life: 10, itPool: 'plant',     kw: ['machine', 'plant', 'other asset'] },
  { key: 'vehicle',   name: 'Vehicles',               depreciable: true,  life: 14, itPool: 'vehicle',   kw: ['vehicle'] },
  { key: 'office',    name: 'Office Equipment',       depreciable: true,  life: 4,  itPool: 'furniture', kw: ['office equip', 'equipment'] },
  { key: 'furniture', name: 'Furniture & Fixtures',   depreciable: true,  life: 4,  itPool: 'furniture', kw: ['furniture', 'fixture'] },
  { key: 'software',  name: 'Software',               depreciable: true,  life: 5,  itPool: 'software',  kw: ['software'] },
  { key: 'leasehold', name: 'Leasehold Assets',       depreciable: true,  life: 5,  itPool: 'leasehold', kw: ['leasehold', 'leashold'] },
];

window.CLIENT_ENTITY_TO_REP_PROFILE = {
  'pvt. ltd. company': 'private_company',
  'private limited company': 'private_company',
  'private company': 'private_company',
  'public ltd. company': 'public_company',
  'public limited company': 'public_company',
  'public company': 'public_company',
  'npos': 'npo',
  'npo': 'npo',
  'ngo': 'ngo',
  'individuals': 'proprietorship',
  'individual': 'proprietorship',
  'proprietorship': 'proprietorship',
  // The 2026-07-26 client master spells these two out in full. Without these
  // keys 155 of the 261 reloaded clients would silently fail to auto-fill the
  // entity profile in Audit Report, Notes to Accounts and Projection Report.
  'proprietorship firm': 'proprietorship',
  'partnership firm': 'partnership',
  'firms': 'proprietorship',
  'firm': 'proprietorship',
  'partnership': 'partnership',
  'cooperatives': 'cooperative',
  'cooperative': 'cooperative',
  // The 2026-07-26 form vocabulary. 'Others' is deliberately unmapped — it
  // carries no entity profile, so the report modules leave the field for the
  // user rather than guessing one.
  'cooperative organization': 'cooperative',
};
