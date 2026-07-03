// ════════════════════════════════════════════
//  TAB SWITCHING
// ════════════════════════════════════════════
function switchTab(tab) {
  const tabs = ['send','report','regd','clients','logs'];
  const panelIdFor = (t) => t === 'send' ? 'tab-send' : t === 'report' ? 'tab-report-panel' : 'tab-' + t + '-panel';
  tabs.forEach(t => {
    document.getElementById(panelIdFor(t)).classList.toggle('active', t === tab);
  });
  document.querySelectorAll('.tab-btn').forEach((btn, i) => {
    btn.classList.toggle('active', tabs[i] === tab);
  });
}

// ════════════════════════════════════════════
//  COMPANY REGISTRAR — SUB-TAB SWITCHING (UI shell only, logic TBD)
// ════════════════════════════════════════════
function switchRegdSub(sub) {
  const subs = ['shareTransfer','increaseCapital','companyRegistration','auditorChange','pinReset','bmAgmMinutes','vatReturn'];
  subs.forEach(s => {
    document.getElementById('regd-' + s + '-panel').classList.toggle('active', s === sub);
    document.getElementById('subtab-' + s).classList.toggle('active', s === sub);
  });
}
