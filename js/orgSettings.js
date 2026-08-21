// ════════════════════════════════════════════
//  FIRM SETUP — the organisation's own identity
//
//  Until now a new firm's letterhead could only be created by someone running
//  tools/orgAdmin.mjs, and its details could not be edited at all. That made
//  the app unusable by anyone else in the way that matters: an audit report
//  needs the firm's registration number, the auditor's name, membership number
//  and COP number, and a second firm had nowhere to put any of them. Their
//  reports would have printed blanks.
//
//  Everything on this screen is read straight back by the document builders
//  through window.REP_FIRMS / SERVICE_MEMO_FIRMS (js/core/orgIdentity.js), so
//  a change here shows up on the next Audit Report, Notes to Accounts, Service
//  Memo PDF, Party Ledger letterhead and BM/AGM minute without any further
//  wiring.
//
//  WHY A FIRM IS NOT AN ORGANISATION. One organisation can trade under several
//  letterheads — Shailesh & Associates and Dallakoti & Company are one practice
//  with one shared client list. So this screen edits the organisation once, and
//  then each of its firms separately.
//
//  Admin-only, and only for the caller's own organisation. Both are enforced
//  in Postgres by the org_firms / organizations policies; the UI simply does
//  not offer what would be refused.
// ════════════════════════════════════════════

ModuleRegistry.register({
  id: 'orgSettings',
  group: 'main',
  buttonId: null,               // opened from the topbar user menu
  panelId: 'tab-orgSettings-panel',
});

let osFirms = [];

function osStatus(msg, type) { showStatus(msg, type, 'os-status'); }
function osIsAdmin() {
  const r = (window.currentUser || {}).role;
  return r === 'admin' || r === 'owner';
}

async function osInit() {
  const admin = osIsAdmin();
  document.getElementById('os-readonly-note').style.display = admin ? 'none' : 'block';

  const org = window.currentOrg || {};
  document.getElementById('os-org-name').value = org.name || '';
  document.getElementById('os-staff').value = ((org.staff_names || []).filter(s => s !== 'Other')).join('\n');
  document.getElementById('os-org-save').disabled = !admin;
  document.getElementById('os-add-firm').style.display = admin ? 'inline-flex' : 'none';

  await osLoadFirms();
}

async function osLoadFirms() {
  const { data, error } = await window.sb
    .from('org_firms').select('*').order('sort_order');
  if (error) { osStatus('❌ ' + escHtml(friendlyDbError(error)), 'error'); return; }
  osFirms = data || [];
  osRenderFirms();
}

// Every field org_firms carries, in the order it appears on a letterhead.
// `key` is the column; `label` is what an accountant calls it.
const OS_FIELDS = [
  { key: 'name',            label: 'Firm name',                 ph: 'Shailesh & Associates' },
  { key: 'title',           label: 'Designation',               ph: 'Chartered Accountants' },
  { key: 'signatory_name',  label: 'Signing partner / CA name', ph: 'Shailesh Dallakoti, CA' },
  { key: 'signatory_title', label: 'Signatory title',           ph: 'Proprietor' },
  { key: 'address',         label: 'Address',                   ph: 'Khairahani-01, Chitwan' },
  { key: 'phone',           label: 'Phone',                     ph: '9855062760, 056-562760' },
  { key: 'email',           label: 'Email',                     ph: 'firm@example.com' },
  { key: 'reg_no',          label: 'Firm registration no.',     ph: '619' },
  { key: 'm_no',            label: 'Membership no. (M.No.)',    ph: '954' },
  { key: 'cop_no',          label: 'COP no.',                   ph: '714' },
  { key: 'pan',             label: 'PAN / VAT no.',             ph: '604101019' },
  { key: 'memo_prefix',     label: 'Service memo prefix',       ph: 'SM-SA' },
  { key: 'name_np',         label: 'Firm name (Devanagari)',    ph: 'शैलेश एण्ड एसोसिएट्स' },
  { key: 'auditor_name_np', label: 'Auditor name (Devanagari)', ph: 'शैलेश डल्लाकोटी' },
  { key: 'title_np',        label: 'Title (Devanagari)',        ph: 'सीए' },
];

function osRenderFirms() {
  const host = document.getElementById('os-firms');
  if (!host) return;
  const admin = osIsAdmin();

  if (!osFirms.length) {
    host.innerHTML = `<div class="card" style="padding:28px; text-align:center; color:var(--text-muted);">
      No letterheads yet. Add one so your reports can be signed.</div>`;
    return;
  }

  host.innerHTML = osFirms.map(f => `
    <div class="card os-firm" data-id="${f.id}" style="margin-bottom:18px;">
      <div class="card-header" style="display:flex; align-items:center; justify-content:space-between; gap:12px;">
        <h3 style="margin:0;">${escHtml(f.name || 'Untitled firm')}</h3>
        <span class="log-badge ${f.is_active ? 'badge-green' : ''}">${f.is_active ? 'in use' : 'hidden'}</span>
      </div>
      <div style="padding:20px 24px;">
        <div class="form-grid" style="grid-template-columns:repeat(auto-fit,minmax(240px,1fr));">
          ${OS_FIELDS.map(fl => `
            <div class="form-group">
              <label for="os-${f.id}-${fl.key}">${escHtml(fl.label)}</label>
              <input id="os-${f.id}-${fl.key}" data-k="${fl.key}"
                     value="${escHtml(f[fl.key] || '')}" placeholder="${escHtml(fl.ph)}"
                     ${admin ? '' : 'readonly'} />
            </div>`).join('')}
        </div>
        <div style="display:flex; gap:18px; align-items:center; flex-wrap:wrap; margin-top:6px;">
          <label style="display:flex; align-items:center; gap:8px; font-size:13px;">
            <input type="checkbox" id="os-${f.id}-fa" ${f.for_final_account ? 'checked' : ''} ${admin ? '' : 'disabled'} style="width:auto;">
            Include in Final Account statements
          </label>
          <label style="display:flex; align-items:center; gap:8px; font-size:13px;">
            <input type="checkbox" id="os-${f.id}-active" ${f.is_active ? 'checked' : ''} ${admin ? '' : 'disabled'} style="width:auto;">
            Offer this firm in dropdowns
          </label>
          ${admin ? `<button class="btn btn-primary" style="margin-left:auto;" onclick="osSaveFirm(${f.id})">Save ${escHtml(f.firm_key)}</button>` : ''}
        </div>
      </div>
    </div>`).join('');
}

async function osSaveFirm(id) {
  const card = document.querySelector(`.os-firm[data-id="${id}"]`);
  if (!card) return;

  const payload = {};
  card.querySelectorAll('input[data-k]').forEach(el => {
    payload[el.dataset.k] = el.value.trim() || null;
  });
  payload.for_final_account = document.getElementById(`os-${id}-fa`).checked;
  payload.is_active         = document.getElementById(`os-${id}-active`).checked;

  if (!payload.name) return osStatus('A firm needs a name — it prints on every document.', 'info');

  osStatus('<span class="spinner spinner-navy"></span> Saving…', 'searching');
  const { error } = await window.sb.from('org_firms').update(payload).eq('id', id);
  if (error) return osStatus('❌ ' + escHtml(friendlyDbError(error)), 'error');

  // Reload the identity globals so the change reaches the document builders
  // immediately, rather than only after the next sign-in.
  await OrgIdentity.load();
  await osLoadFirms();
  osStatus('✅ Saved. New documents will use these details.', 'success');
}

async function osAddFirm() {
  const name = (prompt('Name of the firm or letterhead to add:') || '').trim();
  if (!name) return;

  // firm_key is what the ledger tables store, so it must be stable and
  // URL-ish. Derived from the name once, at creation, and never edited
  // afterwards — changing it would orphan existing memos and bank accounts.
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 12) || 'firm';
  let key = base, n = 2;
  while (osFirms.some(f => f.firm_key === key)) key = base + (n++);

  const { error } = await window.sb.from('org_firms').insert({
    org_id: (window.currentOrg || {}).id,
    firm_key: key,
    name,
    memo_prefix: 'SM-' + key.slice(0, 4).toUpperCase(),
    sort_order: osFirms.length + 1,
  });
  if (error) return osStatus('❌ ' + escHtml(friendlyDbError(error)), 'error');

  await OrgIdentity.load();
  await osLoadFirms();
  osStatus('✅ Added. Fill in its registration and signatory details below.', 'success');
}

async function osSaveOrg() {
  const name = document.getElementById('os-org-name').value.trim();
  if (!name) return osStatus('Your practice needs a name.', 'info');

  // One name per line — the staff picker on Audit Report Finalization, Work
  // Done, the To-Do list and Projection all read this list. 'Other' is added
  // automatically and must not be stored.
  const staff = document.getElementById('os-staff').value
    .split('\n').map(s => s.trim()).filter(s => s && s !== 'Other');

  osStatus('<span class="spinner spinner-navy"></span> Saving…', 'searching');
  const { error } = await window.sb.from('organizations')
    .update({ name, staff_names: staff })
    .eq('id', (window.currentOrg || {}).id);
  if (error) return osStatus('❌ ' + escHtml(friendlyDbError(error)), 'error');

  await OrgIdentity.load();
  osApplyBranding();
  osStatus('✅ Saved.', 'success');
}

// ── Branding ────────────────────────────────────────────────────────────────
// index.html ships this firm's own logo and registration number baked into the
// shell — a second firm would otherwise see "Firm Registration No. 619" and
// another practice's mark on their own screen. Replaced at runtime with
// whatever the signed-in organisation actually is.
//
// No logo upload: nothing a user uploads is stored anywhere in this app
// (CLAUDE.md §15), so a firm without an image asset gets its NAME set in the
// brand's place, which is what a letterhead does anyway.
function osApplyBranding() {
  const org  = window.currentOrg || {};
  const firm = Object.values(window.REP_FIRMS || {})[0] || {};

  document.querySelectorAll('.brand img, #loading-screen img').forEach(img => {
    if (firm.logo) { img.src = firm.logo; img.style.display = ''; return; }
    // logoFallback() already renders a text mark when an image fails; reuse it
    // rather than inventing a second treatment.
    if (typeof logoFallback === 'function') logoFallback(img, 26);
  });

  const reg = document.querySelector('.loading-reg');
  if (reg) {
    const bits = [];
    if (firm.regNo) bits.push('Firm Registration No. ' + firm.regNo);
    if (firm.pan)   bits.push('VAT - ' + firm.pan);
    reg.textContent = bits.join('  |  ') || (org.name || '');
  }

  document.title = (org.name || 'Audit') + ' — Workflow';
}
