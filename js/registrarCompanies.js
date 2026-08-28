// ════════════════════════════════════════════
//  REGISTRAR COMPANY DIRECTORY
//
//  The firm's register of Nepalese companies — the records the five Company
//  Registrar screens are built on. This is a SEPARATE directory from
//  window.clientsList, and that separation is the entire point of the file.
//
//  WHY IT EXISTS (2026-08-20, user decision)
//  These 45 records used to be rows in `clients`. Every module in the app that
//  offers a client picker reads window.clientsList, so a Devanagari company
//  name surfaced in Bank Entry, Service Memo, Work Done, Autobooks — every
//  screen — when the only place that can do anything with one is Company
//  Registrar. The alternative fix was a flag column plus a filter in each
//  picker, and it was rejected: a filter is a rule twenty-odd existing modules
//  and every future one must remember, whereas a separate list simply cannot
//  be reached by accident. Leaking now requires opting IN.
//
//  So: NOTHING outside a Company Registrar module may read
//  window.registrarCompanies, and no registrar module reads window.clientsList.
//  If a screen needs both, it wants two pickers, not one merged list.
//
//  Shareholders are loaded WITH their company and hang off the record as
//  `.shareholders`. BM/AGM Minutes and Company Secretary each used to fire
//  their own `client_shareholders` query on selection — the same query, twice,
//  awaited inside an otherwise synchronous form fill. 55 rows across 45
//  companies is not worth a round trip per click.
// ════════════════════════════════════════════

// Empty until sign-in completes — read it inside a function that runs on
// demand, never at file load. Same contract as window.clientsList and the
// OrgIdentity-filled config objects (CLAUDE.md §6).
window.registrarCompanies = [];

// Loaded alongside loadClients() from the boot sequence in js/auth.js.
async function loadRegistrarCompanies() {
  let companies, shareholders;
  try {
    // sbFetchAll, not a bare .select() — PostgREST caps one select at 1000
    // rows (CLAUDE.md §6). 45 companies today, but this is the firm's growing
    // register and a truncated read would fail silently rather than error.
    [companies, shareholders] = await Promise.all([
      sbFetchAll(() => window.sb.from('registrar_companies').select('*').order('name')),
      sbFetchAll(() => window.sb.from('registrar_shareholders').select('*').order('company_id').order('sort_order')),
    ]);
  } catch (e) {
    console.error('Failed to load registrar companies:', e.message);
    window.registrarCompanies = [];
    return;
  }

  const byCompany = new Map();
  (shareholders || []).forEach(s => {
    if (!byCompany.has(s.company_id)) byCompany.set(s.company_id, []);
    byCompany.get(s.company_id).push(s);
  });

  window.registrarCompanies = (companies || []).map(c => ({
    ...c,
    shareholders: byCompany.get(c.id) || [],
  }));

  // Any registrar screen already on screen redraws itself. Company Profile
  // registers the only listener today; a future sub-module registers its own
  // rather than this file learning about it.
  RC_LISTENERS.forEach(fn => { try { fn(); } catch (e) { console.error(e); } });
}

const RC_LISTENERS = [];

window.RegistrarDirectory = {
  // ── Reading ──
  list() { return window.registrarCompanies || []; },

  byId(id) {
    return (window.registrarCompanies || []).find(c => String(c.id) === String(id)) || null;
  },

  // Always an array, never null — callers render it directly.
  shareholders(id) {
    const c = this.byId(id);
    return c ? (c.shareholders || []) : [];
  },

  // Every attendee/director name a company can supply, in the order the
  // registrar documents print them: the fixed shareholder field first (it is
  // shareholder #2 after the chairman), then the extra rows.
  //
  // The chairman IS one of the company's shareholders and the list sometimes
  // names them again — left in, the attendee list prints the same person twice
  // (once as अध्यक्ष, once as संचालक). Dropped here rather than at each call
  // site, which is where this rule used to live in duplicate.
  attendeeNames(id) {
    const c = this.byId(id);
    if (!c) return [];
    const chairman = String(c.chairman_name || '').trim();
    const names = [String(c.shareholder_name || '').trim()]
      .concat((c.shareholders || []).map(s => String(s.name || '').trim()));
    return names.filter(n => n && n !== chairman);
  },

  async reload() { await loadRegistrarCompanies(); },

  onChange(fn) { if (typeof fn === 'function') RC_LISTENERS.push(fn); },

  // ── The one company picker ──
  // Every registrar screen searches the same way: by registration number, PAN
  // or name, digit-agnostically. Registration numbers and PANs are stored in
  // Devanagari numerals but people type English digits on a keyboard, so both
  // the query and the stored value are normalized before comparing — that rule
  // was copy-pasted into four files, each with its own private
  // xxToEnglishDigits() wrapper around the same NepaliLocale call.
  //
  // Callers override `keys`, `renderItem` and `minChars` where their screen
  // genuinely differs (BM/AGM and Company Secretary search a registration-number
  // field and show the number first; Auditor Change and Company Profile search a
  // name field and show the name first).
  attachCompanyPicker(inputEl, listEl, opts) {
    if (!inputEl || !listEl) return;
    const o = opts || {};
    SearchEngine.attachAutocomplete(inputEl, listEl, {
      getList: () => window.registrarCompanies || [],
      // name_english added 2026-08-28 (user ask — search a company by its
      // English name too, not just registration number/PAN/Devanagari
      // name). Every caller that overrides `keys` (BM/AGM, Company
      // Secretary, Auditor Change) lists it explicitly rather than relying
      // on this default, so add it there too if this default ever changes.
      keys: o.keys || ['name', 'registration_number', 'pan', 'name_english'],
      minChars: o.minChars,
      normalizeQuery: q => NepaliLocale.toEnglishDigits(q),
      normalizeItem: c => ({
        name: c.name,
        name_english: c.name_english || '',
        registration_number: NepaliLocale.toEnglishDigits(c.registration_number || ''),
        pan: NepaliLocale.toEnglishDigits(c.pan || ''),
      }),
      renderItem: o.renderItem || (c => `
        <div class="ac-name">${escHtml(c.name)}${c.name_english ? ' — ' + escHtml(c.name_english) : ''}</div>
        <div class="ac-email">${escHtml(c.registration_number ? 'Regd. ' + c.registration_number : (c.pan ? 'PAN ' + c.pan : 'No registration on file'))}</div>
      `),
      onSelect: o.onSelect,
    });
  },
};
