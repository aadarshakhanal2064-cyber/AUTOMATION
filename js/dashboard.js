// ════════════════════════════════════════════
//  DASHBOARD
//  Self-registers with ModuleRegistry instead of being added to
//  moduleRegistry.js's own list — the first module built after the
//  registry existed, and the intended pattern for every module after it:
//  one register() call from the module's own file, no edits to tabs.js.
// ════════════════════════════════════════════
ModuleRegistry.register({ id: 'dashboard', group: 'main', buttonId: 'nav-dashboard', panelId: 'tab-dashboard-panel' });

let dashModuleChart = null;

function dashModuleLabel(m) {
  return m === 'bmAgmMinutes' ? 'BM/AGM Minutes' : m === 'vatReturn' ? 'VAT Return' : (m || 'Other');
}

async function loadDashboard() {
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('dash-stat-clients', (window.clientsList || []).length);

  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);
  const sinceIso = startOfMonth.toISOString();

  const [docsThisMonth, ocrThisMonth, recent] = await Promise.all([
    AuditLog.countSince('document_generated', sinceIso),
    AuditLog.countSince('ocr_extraction', sinceIso),
    AuditLog.recent(10),
  ]);

  set('dash-stat-docs-month', docsThisMonth);
  set('dash-stat-ocr-month', ocrThisMonth);

  renderDashActivity(recent);
  renderDashModuleChart(recent);
}

function renderDashActivity(events) {
  const el = document.getElementById('dash-activity-list');
  if (!el) return;
  if (!events.length) { el.innerHTML = '<div class="log-empty">No activity yet.</div>'; return; }

  el.innerHTML = events.map(e => {
    const d = new Date(e.created_at);
    const timeStr = isNaN(d) ? '—' : d.toLocaleString();
    const badgeClass = e.status === 'error' ? 'badge-error' : 'badge-sent';
    const badgeText = e.status === 'error' ? '❌ Error' : '✅ Success';
    const eventLabel = e.event_type === 'document_generated' ? 'Document generated'
      : e.event_type === 'ocr_extraction' ? 'OCR extraction' : e.event_type;
    return `
      <div class="log-item">
        <span class="log-badge ${badgeClass}">${badgeText}</span>
        <div class="log-details">
          <div class="log-client">${escHtml(eventLabel)} — ${escHtml(dashModuleLabel(e.module))}</div>
          <div class="log-sub">${escHtml(e.client_name || '—')}</div>
        </div>
        <div class="log-time">${timeStr}</div>
      </div>
    `;
  }).join('');
}

function renderDashModuleChart(events) {
  const canvas = document.getElementById('dash-module-chart');
  if (!canvas || !window.Chart) return;

  const counts = {};
  events.filter(e => e.event_type === 'document_generated').forEach(e => {
    const label = dashModuleLabel(e.module);
    counts[label] = (counts[label] || 0) + 1;
  });

  if (dashModuleChart) { dashModuleChart.destroy(); dashModuleChart = null; }

  const hasData = Object.keys(counts).length > 0;
  dashModuleChart = new Chart(canvas.getContext('2d'), {
    type: 'doughnut',
    data: {
      labels: hasData ? Object.keys(counts) : ['No data yet'],
      datasets: [{
        data: hasData ? Object.values(counts) : [1],
        backgroundColor: ['#205493', '#10b981', '#f59e0b', '#6d40c9'],
      }],
    },
    options: { plugins: { legend: { position: 'bottom' } } },
  });
}
