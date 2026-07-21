// ════════════════════════════════════════════
//  CONFIG — constants, global state, Supabase init
// ════════════════════════════════════════════

const SUPABASE_URL = 'https://rennqzmwyhkdsizvlqwd.supabase.co';
const SUPABASE_KEY = 'sb_publishable_jatb0tzHNTFzmDrY9HV2tQ_9HAhZ2XW';
const SCOPES = 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/gmail.send email profile';

// Nepal's standard VAT rate — the one source for the Billing module's
// invoice tax line (and any future consumer), so the figure can't drift.
window.VAT_STANDARD_RATE = 0.13;

// ── Mutable app state (window.* for global access) ──
window.CLIENT_ID        = localStorage.getItem('gClientId') || '';
window.tokenClient      = undefined;
window.accessToken      = null;
window.foundFile        = null;
window.currentUser      = null;   // { email, role }
window.clientsList      = [];     // loaded from Supabase
window.allLogs          = [];     // loaded from Supabase
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
window.SERVICE_MEMO_FIRMS = {
  shailesh:  { key: 'shailesh',  name: window.REP_FIRMS.shailesh.name,  prefix: 'SM-SA',   ref: 'shailesh' },
  dallakoti: { key: 'dallakoti', name: window.REP_FIRMS.dallakoti.name, prefix: 'SM-DC',   ref: 'dallakoti' },
  rosp:      { key: 'rosp',      name: 'Ratnanagar Offset Screen Print', prefix: 'SM-ROSP', address: '', pan: '', phone: '', email: '' },
  rtc:       { key: 'rtc',       name: 'Ratnanagar Tax Consultancy',     prefix: 'SM-RTC',  address: '', pan: '', phone: '', email: '' },
};

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
  { key: 'sapati',              label: 'Sapati',              party: 'Name of Person' },
  { key: 'inter_bank_transfer', label: 'Inter-bank Transfer', party: 'From / To Account' },
];
window.BANK_PAYMENT_TYPES = [
  { key: 'expenses',            label: 'Expenses',            party: 'Nature of Expense' },
  { key: 'sapati',              label: 'Sapati',              party: 'Name of Person' },
  { key: 'inter_bank_transfer', label: 'Inter-bank Transfer', party: 'From / To Account' },
];

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
window.DEP_SLM_CLASSES = [
  { key: 'land',      name: 'Land',                   depreciable: false, life: 0,  kw: ['land'] },
  { key: 'building',  name: 'Building & Structures',  depreciable: true,  life: 49, kw: ['building', 'structure'] },
  { key: 'machine',   name: 'Machine & Other Assets', depreciable: true,  life: 10, kw: ['machine', 'plant', 'other asset'] },
  { key: 'vehicle',   name: 'Vehicles',               depreciable: true,  life: 14, kw: ['vehicle'] },
  { key: 'office',    name: 'Office Equipment',       depreciable: true,  life: 4,  kw: ['office equip', 'equipment'] },
  { key: 'furniture', name: 'Furniture & Fixtures',   depreciable: true,  life: 4,  kw: ['furniture', 'fixture'] },
  { key: 'software',  name: 'Software',               depreciable: true,  life: 5,  kw: ['software'] },
  { key: 'leasehold', name: 'Leasehold Assets',       depreciable: true,  life: 5,  kw: ['leasehold', 'leashold'] },
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
  'firms': 'proprietorship',
  'firm': 'proprietorship',
  'partnership': 'partnership',
  'cooperatives': 'cooperative',
  'cooperative': 'cooperative',
};
