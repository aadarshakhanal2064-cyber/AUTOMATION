// ════════════════════════════════════════════
//  MODULE REGISTRY
//  Central place every tab/sub-tab registers into, so navigation code
//  (tabs.js) reads a list instead of hardcoding module ids — adding a new
//  module means calling register() once, not editing tabs.js/index.html's
//  switching logic.
// ════════════════════════════════════════════
window.ModuleRegistry = (function () {
  const modules = [];

  function register(mod) {
    modules.push(mod);
  }

  function getGroup(group) {
    return modules.filter(m => m.group === group);
  }

  return { register, getGroup };
})();

// ── Modules that predate the registry ──
// New modules should call ModuleRegistry.register({...}) from their own
// file instead of adding to this list.
ModuleRegistry.register({ id: 'send',    group: 'main', buttonId: 'nav-send',    panelId: 'tab-send' });
ModuleRegistry.register({ id: 'report',  group: 'main', buttonId: 'nav-report',  panelId: 'tab-report-panel' });
ModuleRegistry.register({ id: 'regd',    group: 'main', buttonId: 'topbar-regd-trigger', panelId: 'tab-regd-panel' });
ModuleRegistry.register({ id: 'clients', group: 'main', buttonId: 'nav-clients', panelId: 'tab-clients-panel' });
ModuleRegistry.register({ id: 'logs',    group: 'main', buttonId: 'nav-logs',    panelId: 'tab-logs-panel' });

ModuleRegistry.register({ id: 'shareTransfer',       group: 'regd', buttonId: 'subtab-shareTransfer',       panelId: 'regd-shareTransfer-panel' });
ModuleRegistry.register({ id: 'increaseCapital',     group: 'regd', buttonId: 'subtab-increaseCapital',     panelId: 'regd-increaseCapital-panel' });
ModuleRegistry.register({ id: 'companyRegistration', group: 'regd', buttonId: 'subtab-companyRegistration', panelId: 'regd-companyRegistration-panel' });
ModuleRegistry.register({ id: 'auditorChange',       group: 'regd', buttonId: 'subtab-auditorChange',       panelId: 'regd-auditorChange-panel' });
ModuleRegistry.register({ id: 'pinReset',            group: 'regd', buttonId: 'subtab-pinReset',            panelId: 'regd-pinReset-panel' });
ModuleRegistry.register({ id: 'bmAgmMinutes',        group: 'regd', buttonId: 'subtab-bmAgmMinutes',         panelId: 'regd-bmAgmMinutes-panel' });
ModuleRegistry.register({ id: 'vatReturn',           group: 'regd', buttonId: 'subtab-vatReturn',            panelId: 'regd-vatReturn-panel' });
