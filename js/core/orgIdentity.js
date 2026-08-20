// ════════════════════════════════════════════
//  ORG IDENTITY ENGINE
//
//  Fills in who the signed-in user's firm actually IS. Until 2026-08-18 the
//  firm's names, PANs, registration numbers, signatories and staff lists were
//  written into js/config.js, which is correct for one firm and impossible for
//  ten — every organisation would print the same letterhead. They now live in
//  the `org_firms` / `organizations` tables and are loaded here after sign-in.
//
//  ── THE ONE RULE THAT MAKES THIS SAFE: MUTATE, NEVER REASSIGN ──
//  config.js still declares window.REP_FIRMS, window.SERVICE_MEMO_FIRMS,
//  window.REGD_AUDIT_FIRMS, window.ARF_STAFF, window.AQC_STAFF and
//  window.FINAL_ACCOUNT_FIRM_KEYS — now empty rather than populated. This file
//  fills those SAME objects and arrays in place.
//
//  That is not a style preference. js/bmAgmMinutes.js does
//      const BM_AUDIT_FIRMS = window.REGD_AUDIT_FIRMS;
//  at FILE LOAD, long before anyone signs in. Reassigning
//  window.REGD_AUDIT_FIRMS to a fresh array would leave that constant pointing
//  at the original empty one for the life of the page, and the BM/AGM firm
//  picker would silently offer nothing. Mutating in place keeps every existing
//  reference — including that one — valid.
//
//  Because of that, all ~34 places across 8 files that read these globals need
//  NO changes at all. They keep reading the same names; only the source of the
//  values moved.
//
//  Loaded from js/auth.js's boot sequence, after the membership check and
//  before any module can open. RLS scopes both tables to the caller's own
//  organisation, so this cannot return another firm's letterhead.
// ════════════════════════════════════════════

const OrgIdentity = (function () {

  // Empties a container without replacing it — see the note above.
  function emptyInPlace(target) {
    if (Array.isArray(target)) target.length = 0;
    else Object.keys(target).forEach(k => { delete target[k]; });
    return target;
  }

  // org_firms is snake_case (SQL); the app's globals are camelCase and have
  // been since the report builder was written. Translate here rather than
  // renaming 34 call sites.
  function toRepFirm(row) {
    return {
      name: row.name || '',
      title: row.title || '',
      address: row.address || '',
      email: row.email || '',
      phone: row.phone || '',
      regNo: row.reg_no || '',
      mNo: row.m_no || '',
      pan: row.pan || '',
      copNo: row.cop_no || '',
      signatoryName: row.signatory_name || '',
      signatoryTitle: row.signatory_title || '',
      logo: row.logo || '',
      nameNp: row.name_np || '',
      auditorNameNp: row.auditor_name_np || '',
      titleNp: row.title_np || '',
    };
  }

  // A firm belongs in REP_FIRMS — the letterhead set — when it can actually
  // sign a report. `signatory_name` is exactly that test and needs no extra
  // column: the two audit firms carry one, the sister concerns and the typed
  // 'Other' entry do not, which reproduces the original split precisely.
  function isLetterheadFirm(row) {
    return !!(row.signatory_name && row.signatory_name.trim());
  }

  // Rebuilds every firm-derived global from a list of org_firms rows.
  // Exported so it can be unit-tested and so a settings screen can re-apply
  // edits without a reload.
  function apply(org, firms) {
    const rows = (firms || []).slice().sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));

    const rep = emptyInPlace(window.REP_FIRMS);
    rows.filter(isLetterheadFirm).forEach(r => { rep[r.firm_key] = toRepFirm(r); });

    // Devanagari view of the letterhead firms, for the BM/AGM and Auditor
    // Change quick-fill pickers. Same shape config.js used to build.
    const regd = emptyInPlace(window.REGD_AUDIT_FIRMS);
    Object.values(rep).forEach(f => {
      regd.push({ firmName: f.nameNp, auditorName: f.auditorNameNp, title: f.titleNp, address: f.address });
    });

    // Every firm can raise a memo or hold a bank account, letterhead or not.
    // `ref` points back into REP_FIRMS for the ones that have full details —
    // serviceMemo.js and partyLedger.js both do `f.ref ? REP_FIRMS[f.ref] : null`.
    const memo = emptyInPlace(window.SERVICE_MEMO_FIRMS);
    rows.forEach(r => {
      memo[r.firm_key] = {
        key: r.firm_key,
        name: r.name,
        prefix: r.memo_prefix || '',
        address: r.address || '',
        pan: r.pan || '',
        phone: r.phone || '',
        email: r.email || '',
        ...(isLetterheadFirm(r) ? { ref: r.firm_key } : {}),
        ...(r.is_typed ? { typed: true } : {}),
      };
    });

    const faKeys = emptyInPlace(window.FINAL_ACCOUNT_FIRM_KEYS);
    rows.filter(r => r.for_final_account).forEach(r => faKeys.push(r.firm_key));

    // Staff picklist for Audit Report Finalization, Work Done, To-Do and
    // Projection. 'Other' is the free-text escape hatch and must stay last.
    const staff = emptyInPlace(window.ARF_STAFF);
    ((org && org.staff_names) || []).forEach(n => { if (n !== 'Other') staff.push(n); });
    staff.push('Other');

    // Audit Checklist's list is the firm NAMES plus the staff — the CA's own
    // note on the paper form asks for both. Derived rather than stored, so it
    // cannot drift from org_firms the way a second hardcoded list would.
    const qc = emptyInPlace(window.AQC_STAFF);
    Object.values(rep).forEach(f => qc.push(f.name));
    staff.filter(s => s !== 'Other').forEach(s => qc.push(s));
    qc.push('Other');

    fillReportFirmSelect();
  }

  // index.html hardcodes the two firm names as <option>s on the report
  // builder's picker. Service Memo's picker is already rebuilt at runtime by
  // smRenderFirmOptions(), but this one was only ever read, never written, so
  // it has to be refreshed here or a second organisation would pick from this
  // firm's names.
  function fillReportFirmSelect() {
    const sel = document.getElementById('rep-firm');
    if (!sel) return;
    const keep = sel.value;
    sel.innerHTML = Object.entries(window.REP_FIRMS)
      .map(([k, f]) => `<option value="${escHtml(k)}">${escHtml(f.name)}</option>`)
      .join('');
    if (keep && window.REP_FIRMS[keep]) sel.value = keep;
  }

  // Reads the caller's own organisation and its firms. Both tables are
  // org-scoped by RLS, so no filter is needed here and none should be added —
  // the database decides which rows exist for this session.
  async function load() {
    const [orgRes, firmRes] = await Promise.all([
      window.sb.from('organizations').select('*').limit(1),
      window.sb.from('org_firms').select('*').eq('is_active', true).order('sort_order'),
    ]);

    if (orgRes.error)  throw orgRes.error;
    if (firmRes.error) throw firmRes.error;

    const org   = (orgRes.data || [])[0] || null;
    const firms = firmRes.data || [];

    // A member with no organisation row is a broken state, not an empty one —
    // say so rather than letting every letterhead silently render blank.
    if (!org) throw new Error('No organisation is visible for this account.');

    window.currentOrg = org;
    apply(org, firms);
    return org;
  }

  // Sign-out must not leave one firm's letterhead in memory for whoever signs
  // in next on a shared office machine — the same reasoning as DataCache.
  function clear() {
    window.currentOrg = null;
    [window.REP_FIRMS, window.SERVICE_MEMO_FIRMS, window.REGD_AUDIT_FIRMS,
     window.FINAL_ACCOUNT_FIRM_KEYS, window.ARF_STAFF, window.AQC_STAFF]
      .forEach(emptyInPlace);
  }

  return { load, apply, clear };
})();

window.OrgIdentity = OrgIdentity;
