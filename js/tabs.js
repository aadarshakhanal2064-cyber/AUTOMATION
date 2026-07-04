// ════════════════════════════════════════════
//  TAB SWITCHING
//  Reads module/panel/button ids from ModuleRegistry (js/core/moduleRegistry.js)
//  instead of a hardcoded list — adding a new tab or sub-tab means registering
//  it there, not editing this file.
// ════════════════════════════════════════════
function switchModuleGroup(group, activeId) {
  ModuleRegistry.getGroup(group).forEach(m => {
    document.getElementById(m.panelId).classList.toggle('active', m.id === activeId);
    document.getElementById(m.buttonId).classList.toggle('active', m.id === activeId);
  });
}

function switchTab(tab) {
  switchModuleGroup('main', tab);
}

// ════════════════════════════════════════════
//  COMPANY REGISTRAR — SUB-TAB SWITCHING (UI shell only, logic TBD)
// ════════════════════════════════════════════
function switchRegdSub(sub) {
  switchModuleGroup('regd', sub);
}
