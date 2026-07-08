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
//  COMPANY REGISTRAR — picked from a topbar dropdown (Xero-style: choose a
//  module from the menu, then it opens directly) instead of an in-page row
//  of sub-tab buttons.
// ════════════════════════════════════════════
function switchRegdSub(sub) {
  switchModuleGroup('regd', sub);
}

function toggleRegdMenu(event) {
  event.stopPropagation();
  document.getElementById('topbar-regd-menu').classList.toggle('open');
  document.getElementById('topbar-regd-trigger').classList.toggle('menu-open');
}

function closeRegdMenu() {
  document.getElementById('topbar-regd-menu').classList.remove('open');
  document.getElementById('topbar-regd-trigger').classList.remove('menu-open');
}

function openRegdModule(sub, label) {
  switchTab('regd');
  switchRegdSub(sub);
  document.getElementById('regd-module-crumb').textContent = label;
  closeRegdMenu();
}

document.addEventListener('click', (e) => {
  const menu = document.getElementById('topbar-regd-menu');
  if (menu && menu.classList.contains('open') && !e.target.closest('.app-tag-dropdown')) {
    closeRegdMenu();
  }
});
