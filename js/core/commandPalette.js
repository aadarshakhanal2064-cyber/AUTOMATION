// ════════════════════════════════════════════
//  COMMAND PALETTE — Ctrl/Cmd+K (Stage 6, 2026-08-21)
//
//  25+ modules live behind a short sidebar and three topbar dropdowns;
//  typing four letters beats hunting through menus. The palette searches
//  three groups, listed separately on purpose:
//
//  · Modules — every tab and registrar sub-panel, same labels as the nav.
//    The go() actions mirror the nav buttons' own onclick exactly (same
//    init calls), so opening from the palette IS opening from the menu.
//  · Clients — window.clientsList; choosing one opens the Clients tab with
//    the directory filtered to that name.
//  · Registrar companies — via RegistrarDirectory.list(), the sanctioned
//    accessor, and ALWAYS as their own labeled group (§15: the two
//    directories never merge into one list); choosing one opens Company
//    Profile filtered to it.
//
//  Plain lowercase substring matching with a starts-with boost — a palette
//  query is a prefix nine times out of ten, and Fuse's typo tolerance is
//  the wrong trade for module names this short.
//
//  DOM is built once on first open, inside its own .cmdk-overlay following
//  the Stage 5 overlay convention (visibility+opacity, never display).
// ════════════════════════════════════════════
window.CommandPalette = (function () {
  // Labels and hints mirror the sidebar/topbar exactly (index.html nav).
  const MODULES = [
    { label: 'Dashboard',                  hint: 'Sidebar',               go: () => { switchTab('dashboard'); loadDashboard(); } },
    { label: 'Clients',                    hint: 'Sidebar',               go: () => switchTab('clients') },
    { label: 'File In Out',                hint: 'Sidebar',               go: () => { switchTab('fileManagement'); fmInit(); } },
    { label: 'Audit Report Finalization',  hint: 'Sidebar',               go: () => { switchTab('auditReportFinalization'); arfInit(); } },
    { label: 'Audit Checklist',            hint: 'Sidebar',               go: () => { switchTab('auditChecklist'); achkInit(); } },
    { label: 'Work Done',                  hint: 'Sidebar',               go: () => { switchTab('workDone'); wdInit(); } },
    { label: 'Service Memo',               hint: 'Financial Management',  go: () => openModule('serviceMemo') },
    { label: 'Party Ledger',               hint: 'Financial Management',  go: () => openModule('partyLedger') },
    { label: 'Bank Entry',                 hint: 'Financial Management',  go: () => openModule('bankBook') },
    { label: 'Final Account',              hint: 'Financial Management',  go: () => openModule('finalAccount') },
    { label: 'Audited Statement',          hint: 'Automation Hub',        go: () => openModule('finStatement') },
    { label: 'Provisional Statement',      hint: 'Automation Hub',        go: () => openModule('provisionalStatement') },
    { label: 'Projection Report',          hint: 'Automation Hub',        go: () => openModule('projection') },
    { label: 'Depreciation',               hint: 'Automation Hub',        go: () => openModule('depreciation') },
    { label: 'Confirmation Letters',       hint: 'Automation Hub',        go: () => openModule('confirmationLetters') },
    { label: 'Generate Report',            hint: 'Automation Hub',        go: () => openModule('report') },
    { label: 'Notes to Accounts',          hint: 'Automation Hub',        go: () => openModule('notesToAccounts') },
    { label: 'Autobooks',                  hint: 'Automation Hub',        go: () => openModule('salesPurchaseBook') },
    { label: 'Company Profile',            hint: 'Company Registrar',     go: () => { openModule('regd'); switchRegdSub('companyProfile'); } },
    { label: 'Company Registration',       hint: 'Company Registrar',     go: () => { openModule('regd'); switchRegdSub('companyRegistration'); } },
    { label: 'Auditor Change',             hint: 'Company Registrar',     go: () => { openModule('regd'); switchRegdSub('auditorChange'); } },
    { label: 'Company Secretary Appointment', hint: 'Company Registrar',  go: () => { openModule('regd'); switchRegdSub('companySecretary'); } },
    { label: 'BM/AGM Minutes',             hint: 'Company Registrar',     go: () => { openModule('regd'); switchRegdSub('bmAgmMinutes'); } },
    { label: 'Firm Setup',                 hint: 'Settings',              go: () => openModule('orgSettings') },
    { label: 'Team',                       hint: 'Settings',              go: () => openModule('orgMembers') },
  ];

  let overlay = null, input = null, listEl = null;
  let results = [];
  let selected = 0;

  function build() {
    overlay = document.createElement('div');
    overlay.className = 'cmdk-overlay';
    overlay.innerHTML = `
      <div class="cmdk-box">
        <input type="text" id="cmdk-input" placeholder="Jump to a module, client or company…" autocomplete="off" spellcheck="false" />
        <div class="cmdk-list" id="cmdk-list"></div>
        <div class="cmdk-foot"><span>↑↓ navigate</span><span>Enter open</span><span>Esc close</span></div>
      </div>`;
    document.body.appendChild(overlay);
    input = overlay.querySelector('#cmdk-input');
    listEl = overlay.querySelector('#cmdk-list');

    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    input.addEventListener('input', () => query(input.value));
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { close(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); choose(selected); }
    });
  }

  function score(label, q) {
    const l = label.toLowerCase();
    if (l.startsWith(q)) return 0;
    const idx = l.indexOf(q);
    if (idx >= 0) return 1;
    // every word-start match ("aud fin" → Audit Report Finalization)
    const words = q.split(/\s+/).filter(Boolean);
    if (words.length > 1 && words.every(w => l.includes(w))) return 2;
    return -1;
  }

  function query(raw) {
    const q = String(raw || '').trim().toLowerCase();
    const out = [];

    const mods = MODULES
      .map(m => ({ ...m, group: 'Modules', s: q ? score(m.label, q) : 1 }))
      .filter(m => m.s >= 0)
      .sort((a, b) => a.s - b.s);
    out.push(...(q ? mods.slice(0, 8) : mods));

    if (q.length >= 2) {
      const clients = (window.clientsList || [])
        .map(c => ({ c, s: score(String(c.name || ''), q) }))
        .filter(x => x.s >= 0 || (x.c.pan && String(x.c.pan).includes(q)))
        .sort((a, b) => a.s - b.s)
        .slice(0, 6)
        .map(x => ({
          label: x.c.name, hint: 'PAN ' + (x.c.pan || '—'), group: 'Clients',
          go: () => {
            switchTab('clients');
            const sb = document.getElementById('client-search-bar');
            if (sb) { sb.value = x.c.name; clientSearchChanged(); }
          },
        }));
      out.push(...clients);

      const companies = (typeof RegistrarDirectory !== 'undefined' ? RegistrarDirectory.list() : [])
        .map(c => ({ c, s: score(String(c.name || ''), q) }))
        .filter(x => x.s >= 0)
        .sort((a, b) => a.s - b.s)
        .slice(0, 4)
        .map(x => ({
          label: x.c.name, hint: 'Company register', group: 'Registrar companies',
          go: () => {
            openModule('regd'); switchRegdSub('companyProfile');
            const sb = document.getElementById('cp-search');
            if (sb) { sb.value = x.c.name; cpSearchChanged(); }
          },
        }));
      out.push(...companies);
    }

    results = out;
    selected = 0;
    renderList();
  }

  function renderList() {
    if (!results.length) {
      listEl.innerHTML = '<div class="cmdk-empty">Nothing matches — try fewer letters.</div>';
      return;
    }
    let html = '', lastGroup = null;
    results.forEach((r, i) => {
      if (r.group !== lastGroup) { html += `<div class="cmdk-group">${escHtml(r.group)}</div>`; lastGroup = r.group; }
      html += `<div class="cmdk-item${i === selected ? ' selected' : ''}" data-i="${i}">
        <span class="cmdk-label">${escHtml(r.label)}</span><span class="cmdk-hint">${escHtml(r.hint || '')}</span></div>`;
    });
    listEl.innerHTML = html;
    listEl.querySelectorAll('.cmdk-item').forEach(el => {
      el.addEventListener('mousedown', (e) => { e.preventDefault(); choose(parseInt(el.dataset.i, 10)); });
    });
  }

  function move(d) {
    if (!results.length) return;
    selected = (selected + d + results.length) % results.length;
    renderList();
    const el = listEl.querySelector('.cmdk-item.selected');
    if (el) el.scrollIntoView({ block: 'nearest' });
  }

  function choose(i) {
    const r = results[i];
    if (!r) return;
    close();
    r.go();
  }

  function open() {
    if (!window.currentUser) return;       // nothing to jump to before sign-in
    if (!overlay) build();
    overlay.classList.add('open');
    input.value = '';
    query('');
    input.focus();
  }
  function close() { if (overlay) overlay.classList.remove('open'); }
  function isOpen() { return !!(overlay && overlay.classList.contains('open')); }

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      isOpen() ? close() : open();
    }
  });

  return { open, close, isOpen };
})();
