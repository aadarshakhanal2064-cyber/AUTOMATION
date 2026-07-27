// ════════════════════════════════════════════
//  COMPANY PROFILE  (Company Registrar → Company Profile)
//
//  The statutory registration details of a Nepalese company: registration
//  number, chairman, shareholder, and the three capitals. These used to sit on
//  the general Add/Edit Client form, where they were noise for the ~150
//  proprietorship firms that have none of them.
//
//  They live on the `clients` row exactly as before — this module only moves
//  WHERE they are edited. BM/AGM Minutes and Auditor Change read the same
//  columns straight off window.clientsList, so nothing downstream changes.
//
//  Prefix: cp-   (see CLAUDE.md §10.2)
// ════════════════════════════════════════════

ModuleRegistry.register({
  id: 'companyProfile', group: 'regd',
  buttonId: 'subtab-companyProfile', panelId: 'regd-companyProfile-panel',
});

// The fields this module owns, in form order. One list drives the form build,
// the load, the save payload and the completeness summary, so they cannot
// drift apart.
const CP_FIELDS = [
  { key: 'registration_number', id: 'cp-registration-number', label: 'Registration Number', ph: 'e.g. 123456/078/079' },
  { key: 'chairman_name',       id: 'cp-chairman-name',       label: 'Chairman Name',       ph: 'Optional' },
  { key: 'shareholder_name',    id: 'cp-shareholder-name',    label: 'Shareholder Name',    ph: 'Optional' },
  { key: 'authorized_capital',  id: 'cp-authorized-capital',  label: 'Authorized Capital',  ph: 'e.g. 25,00,000' },
  { key: 'issued_capital',      id: 'cp-issued-capital',      label: 'Issued Capital',      ph: 'e.g. 25,00,000' },
  { key: 'paid_up_capital',     id: 'cp-paidup-capital',      label: 'Paid-up Capital',     ph: 'e.g. 25,00,000' },
  { key: 'vat_status',          id: 'cp-vat-status',          label: 'VAT Status',          select: true },
];

window.cpSelectedClient = null;

function cpStatus(msg, type) { showStatus(msg, type, 'cp-status'); }

// ── Client picker ──
// Search by registration number and PAN as well as name: this screen is
// reached FROM a registrar document, where the registration number is what the
// user is holding. Digit-agnostic, because both may be in Devanagari.
SearchEngine.attachAutocomplete(
  document.getElementById('cp-client-search'),
  document.getElementById('cp-client-list'),
  {
    getList: () => window.clientsList || [],
    keys: ['name', 'registration_number', 'pan'],
    normalizeQuery: q => NepaliLocale.toEnglishDigits(q),
    normalizeItem: c => ({
      name: c.name,
      registration_number: NepaliLocale.toEnglishDigits(c.registration_number || ''),
      pan: NepaliLocale.toEnglishDigits(c.pan || ''),
    }),
    renderItem: c => `
      <div class="ac-name">${escHtml(c.name)}</div>
      <div class="ac-email">${escHtml(c.registration_number ? 'Regd. ' + c.registration_number : (c.pan ? 'PAN ' + c.pan : 'No registration on file'))}${c.entity_type ? ' · ' + escHtml(c.entity_type) : ''}</div>
    `,
    onSelect: c => cpLoadClient(c.id),
  }
);

function cpLoadClient(id) {
  const c = (window.clientsList || []).find(x => String(x.id) === String(id));
  if (!c) return;
  window.cpSelectedClient = c;

  document.getElementById('cp-client-search').value = c.name;
  document.getElementById('cp-empty').style.display = 'none';
  document.getElementById('cp-form').style.display = '';

  document.getElementById('cp-ident-name').textContent = c.name;
  document.getElementById('cp-ident-meta').textContent =
    [c.entity_type, c.pan ? 'PAN ' + c.pan : '', c.district].filter(Boolean).join(' · ') || '—';

  CP_FIELDS.forEach(f => {
    const el = document.getElementById(f.id);
    if (el) el.value = c[f.key] || (f.key === 'vat_status' ? 'not_registered' : '');
  });
  cpRenderCompleteness();
  cpStatus('', 'info');
}

function cpClear() {
  window.cpSelectedClient = null;
  document.getElementById('cp-client-search').value = '';
  document.getElementById('cp-form').style.display = 'none';
  document.getElementById('cp-empty').style.display = '';
  cpStatus('', 'info');
}

// A small on-screen count of how much of the registrar record is filled in —
// these documents can't be generated from a half-empty profile.
function cpRenderCompleteness() {
  const el = document.getElementById('cp-completeness');
  if (!el) return;
  const c = window.cpSelectedClient;
  if (!c) { el.innerHTML = ''; return; }
  const checked = CP_FIELDS.filter(f => f.key !== 'vat_status');
  const filled = checked.filter(f => {
    const v = (document.getElementById(f.id) || {}).value;
    return v && String(v).trim() !== '';
  }).length;
  const pct = Math.round(filled / checked.length * 100);
  const tone = pct === 100 ? 'good' : pct >= 50 ? 'mid' : 'low';
  el.innerHTML = `
    <div class="cd-meter-row">
      <div class="cd-meter-label">Profile</div>
      <div class="cd-meter-track"><div class="cd-meter-fill ${tone}" style="width:${pct}%"></div></div>
      <div class="cd-meter-val">${filled}/${checked.length}</div>
    </div>`;
}

async function cpSave() {
  const c = window.cpSelectedClient;
  if (!c) { cpStatus('Select a client first.', 'error'); return; }

  const payload = {};
  CP_FIELDS.forEach(f => {
    const el = document.getElementById(f.id);
    if (!el) return;
    const v = String(el.value || '').trim();
    // vat_status is NOT NULL with a default; the others are nullable.
    payload[f.key] = f.key === 'vat_status' ? (v || 'not_registered') : (v || null);
  });

  cpStatus('Saving…', 'searching');
  const { error } = await window.sb.from('clients').update(payload).eq('id', c.id);
  if (error) { cpStatus('Failed to save: ' + error.message, 'error'); return; }

  // Keep the in-memory directory in step so BM/AGM Minutes and Auditor Change
  // see the new values without a page reload.
  Object.assign(c, payload);

  AuditLog.record('company_profile_saved', {
    module: 'companyProfile', client_name: c.name, record_ref: c.id,
    detail: { fields: Object.keys(payload).filter(k => payload[k]) },
  });

  cpRenderCompleteness();
  cpStatus('Saved.', 'success');
  if (typeof applyClientFilters === 'function') applyClientFilters();
}

// Recompute the meter as the user types, so the header reflects the form
// rather than the last save.
document.addEventListener('input', e => {
  if (e.target && String(e.target.id || '').startsWith('cp-')) cpRenderCompleteness();
});
