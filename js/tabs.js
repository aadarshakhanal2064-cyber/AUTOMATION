// ════════════════════════════════════════════
//  TAB SWITCHING
//  Reads module/panel/button ids from ModuleRegistry (js/core/moduleRegistry.js)
//  instead of a hardcoded list — adding a new tab or sub-tab means registering
//  it there, not editing this file.
// ════════════════════════════════════════════
function switchModuleGroup(group, activeId) {
  ModuleRegistry.getGroup(group).forEach(m => {
    document.getElementById(m.panelId).classList.toggle('active', m.id === activeId);
    // buttonId is optional here — Company Registrar's sub-modules are picked
    // from the topbar dropdown now, not a per-module button, so there's
    // nothing to highlight for that group.
    const btn = document.getElementById(m.buttonId);
    if (btn) btn.classList.toggle('active', m.id === activeId);
  });
}

function switchTab(tab) {
  switchModuleGroup('main', tab);
}

// ════════════════════════════════════════════
//  TOPBAR DROPDOWN MENUS — one shared open/close mechanic (Xero-style:
//  choose a module from the menu, then it opens directly). Three menus use
//  it: Company Registrar ('regd'), Financial Management ('fin') and
//  Automation Hub ('auto'). Opening one closes the others.
// ════════════════════════════════════════════
function toggleTopbarMenu(event, key) {
  event.stopPropagation();
  const menu = document.getElementById('topbar-' + key + '-menu');
  const wasOpen = menu.classList.contains('open');
  closeTopbarMenus();
  if (!wasOpen) {
    menu.classList.add('open');
    document.getElementById('topbar-' + key + '-trigger').classList.add('menu-open');
  }
}

function closeTopbarMenus() {
  document.querySelectorAll('.topbar-dropdown-menu.open').forEach(m => m.classList.remove('open'));
  document.querySelectorAll('.app-tag.menu-open').forEach(b => b.classList.remove('menu-open'));
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('.app-tag-dropdown')) closeTopbarMenus();
});

// ── Company Registrar — its own sub-module group inside one 'regd' tab ──
//
// Registrar sub-modules that need a render on open, the same idea as
// MODULE_INITS below. Company Profile is a directory that must reflect what
// another session (or the bulk import) has changed since this tab was last
// looked at; a sub-module that's absent from this map simply switches.
//
// The four document-builder sub-modules reset to a blank form on EVERY open
// (2026-08-28, user ask — "there shouldn't be any company data shown by
// default"). These panels never get destroyed, so without this a company
// picked ten minutes ago for a different filing was still sitting there the
// next time the tab was opened — on a real government filing, silently
// reusing another company's data is a correctness bug, not a convenience.
// This is deliberately unconditional (switching sub-tabs mid-task also
// resets): safer than the alternative, since keeping an in-progress draft
// alive across the exact click that shows the module's own "Reset" button
// would be inconsistent — and each builder's own localStorage autosave
// (BM/AGM, Company Secretary, Company Registration) no longer restores on
// boot either, for the same reason (see their DOMContentLoaded handlers).
const REGD_INITS = {
  companyProfile: () => cpInit(),
  bmAgmMinutes: () => bmResetForm(),
  auditorChange: () => acResetForm(),
  companySecretary: () => csResetForm(),
  companyRegistration: () => crResetForm(),
};

function switchRegdSub(sub) {
  switchModuleGroup('regd', sub);
  if (REGD_INITS[sub]) REGD_INITS[sub]();
}

function openRegdModule(sub, label) {
  switchTab('regd');
  switchRegdSub(sub);
  document.getElementById('regd-module-crumb').textContent = label;
  closeTopbarMenus();
}

// ── Financial Management / Automation Hub — every entry is an ordinary
//  'main'-group tab (a full panel of its own), just launched from a topbar
//  menu instead of a sidebar button. The map holds only the modules that
//  need an init/refresh call on open; a tab that's absent simply switches. ──
const MODULE_INITS = {
  serviceMemo:         () => loadServiceMemo(),
  vatRegister:         () => vrInit(),
  bankBook:            () => bbInit(),
  partyLedger:         () => plInit(),
  finalAccount:        () => faInit(),
  projection:          () => pjInit(),
  finStatement:        () => asInit(),
  provisionalStatement:() => psInit(),
  depreciation:        () => depInit(),
  confirmationLetters: () => clInit(),
  salesPurchaseBook:   () => spbInit(),
  orgMembers:          () => omInit(),
  orgSettings:         () => osInit(),
};

// Financial Management's five modules sit behind a per-member password
// (js/core/sectionLock.js). The gate is here rather than in each module
// because this is the one funnel every entry point already goes through —
// the topbar menu, the command palette's go() actions and any future
// caller — so no new screen can reach those panels without passing it.
//
// The gate is a courtesy, not the protection: the eight tables behind the
// section return zero rows to a locked member whatever the browser does
// (db/2026-08-29_financial_section_lock.sql). This just means they see a
// password box instead of five modules rendering empty.
async function openModule(tab) {
  // Close the menu FIRST — the lock overlay covers the screen, and a
  // dropdown left hanging open behind it reads as a frozen click.
  closeTopbarMenus();

  if (typeof SectionLock !== 'undefined' && SectionLock.isLockedModule(tab)) {
    const ok = await SectionLock.require();
    if (!ok) return;
  }

  switchTab(tab);
  if (MODULE_INITS[tab]) MODULE_INITS[tab]();
}
