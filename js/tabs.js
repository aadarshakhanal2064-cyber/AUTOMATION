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
//  choose a module from the menu, then it opens directly). Two menus use
//  it: Company Registrar ('regd') and Accounting ('acct'). Opening one
//  closes the other.
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
function switchRegdSub(sub) {
  switchModuleGroup('regd', sub);
}

function openRegdModule(sub, label) {
  switchTab('regd');
  switchRegdSub(sub);
  document.getElementById('regd-module-crumb').textContent = label;
  closeTopbarMenus();
}

// ── Accounting — Sales & Purchase Book and Confirmation Letters are
//  ordinary 'main'-group tabs (each a full panel of its own), just launched
//  from the topbar menu instead of sidebar buttons. ──
const ACCT_INITS = { salesPurchaseBook: () => spbInit(), confirmationLetters: () => clInit(), depreciation: () => depInit(), bankBook: () => bbInit() };

function openAcctModule(tab) {
  switchTab(tab);
  if (ACCT_INITS[tab]) ACCT_INITS[tab]();
  closeTopbarMenus();
}
