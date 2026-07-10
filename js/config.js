// ════════════════════════════════════════════
//  CONFIG — constants, global state, Supabase init
// ════════════════════════════════════════════

const SUPABASE_URL = 'https://rennqzmwyhkdsizvlqwd.supabase.co';
const SUPABASE_KEY = 'sb_publishable_jatb0tzHNTFzmDrY9HV2tQ_9HAhZ2XW';
const SCOPES = 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/gmail.send email profile';

// Nepal's standard VAT rate — shared by vatReturn.js's OCR checksum and the
// Billing module's invoice tax line, so the one figure can't drift between them.
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
    logo: "assets/logo-lockup.png" // full lockup (icon + firm name + "Chartered Accountants"), transparent bg — no equivalent asset for other firms
  },
  dallakoti: {
    name: "Dallakoti & Company", title: "Registered Auditor",
    address: "Ratnanagar-02, Chitwan", email: "dac.audit@gmail.com",
    phone: "9855060014, 056-562760", regNo: '"B" 2716', mNo: "3105",
    pan: "300336179", copNo: "148",
    signatoryName: "Devi Prasad Dallakoti, RA", signatoryTitle: "Proprietor"
  }
};

window.REP_FY_DATES = {
  "2078-79": { bs: "32nd Ashadh, 2079", ad: "16th July, 2022" },
  "2079-80": { bs: "31st Ashadh, 2080", ad: "16th July, 2023" },
  "2080-81": { bs: "31st Ashadh, 2081", ad: "15th July, 2024" },
  "2081-82": { bs: "32nd Ashadh, 2082", ad: "16th July, 2025" },
  "2082-83": { bs: "32nd Ashadh, 2083", ad: "16th July, 2026" }
};

window.REP_ENTITY_PROFILES = {
  private_company: { label:"Private Company", salutationTo:"the Shareholders of the", governingBodyShort:"board of directors (owners as the case may be)", entityNoun:"company", entityNounCap:"Company", act:"Companies Act, 2063", statusLine:"is the Private Company in Nepal" },
  public_company:  { label:"Public Company", salutationTo:"the Shareholders of the", governingBodyShort:"board of directors (owners as the case may be)", entityNoun:"company", entityNounCap:"Company", act:"Companies Act, 2063", statusLine:"is the Public Company in Nepal" },
  proprietorship:  { label:"Proprietorship", salutationTo:"the Proprietor of the", governingBodyShort:"proprietor", entityNoun:"firm", entityNounCap:"Firm", act:"Private Firm Registration Act, 2034", statusLine:"is a Proprietorship Firm in Nepal" },
  partnership:     { label:"Partnership Firm", salutationTo:"the Partners of the", governingBodyShort:"partner", entityNoun:"firm", entityNounCap:"Firm", act:"Partnership Act, 2020", statusLine:"is a Partnership Firm in Nepal" },
  ngo:             { label:"NGO", salutationTo:"the Board of Members of", governingBodyShort:"board of member", entityNoun:"organization", entityNounCap:"Organization", act:"Association Registration Act, 2034", statusLine:"is a Non-Governmental Organization registered in Nepal" },
  npo:             { label:"NPO / Association", salutationTo:"the Board of Members of", governingBodyShort:"board of member", entityNoun:"organization", entityNounCap:"Organization", act:"Association Registration Act, 2034", statusLine:"is a Non-Profit Organization registered in Nepal" },
  cooperative:     { label:"Cooperative", salutationTo:"the Members of the", governingBodyShort:"board of directors", entityNoun:"cooperative", entityNounCap:"Cooperative", act:"Cooperatives Act, 2074", statusLine:"is a Cooperative registered in Nepal" }
};

window.REP_NAS_LABEL = {
  mes: "Nepal Accounting Standard for Micro Entities (NAS for MEs)",
  sme: "Nepal Accounting Standard for Small and Medium Entities (NAS for SMEs)"
};

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
