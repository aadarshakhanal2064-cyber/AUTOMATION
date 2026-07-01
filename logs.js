// ════════════════════════════════════════════
//  SUPABASE: LOAD + RENDER LOGS
// ════════════════════════════════════════════
async function loadLogs() {
  const isAdmin = window.currentUser?.role === 'admin';
  let query = window.sb.from('send_logs').select('*').order('sent_at', { ascending: false }).limit(200);

  // Staff see only their own sends
  if (!isAdmin) query = query.eq('sent_by', window.currentUser.email);

  const { data, error } = await query;
  if (error) {
    document.getElementById('logs-list').innerHTML =
      '<div class="log-empty" style="color:var(--red);">Failed to load logs. Check your Supabase table and RLS policies.</div>';
    return;
  }

  window.allLogs = data || [];

  // Populate staff filter for admin
  if (isAdmin && window.allLogs.length > 0) {
    const senders = [...new Set(window.allLogs.map(l => l.sent_by))].sort();
    const sel = document.getElementById('log-filter-sender');
    const cur = sel.value;
    sel.innerHTML = '<option value="">All staff</option>' +
      senders.map(s => `<option value="${escHtml(s)}" ${s===cur?'selected':''}>${escHtml(s)}</option>`).join('');
  }

  applyLogFilters();
}

function applyLogFilters() {
  const clientFilter = document.getElementById('log-filter-client').value.toLowerCase();
  const statusFilter = document.getElementById('log-filter-status').value;
  const senderFilter = document.getElementById('log-filter-sender').value;

  let filtered = window.allLogs.filter(l => {
    if (clientFilter && !(l.client_name || '').toLowerCase().includes(clientFilter)) return false;
    if (statusFilter && l.status !== statusFilter) return false;
    if (senderFilter && l.sent_by !== senderFilter) return false;
    return true;
  });

  renderLogs(filtered);
}

function renderLogs(logs) {
  const el = document.getElementById('logs-list');
  if (!logs.length) {
    el.innerHTML = '<div class="log-empty">No log entries match your filters.</div>';
    return;
  }
  const isAdmin = window.currentUser?.role === 'admin';
  el.innerHTML = logs.map(l => {
    const d = new Date(l.sent_at);
    const timeStr = isNaN(d) ? '—' : d.toLocaleString();
    return `
      <div class="log-item">
        <span class="log-badge ${l.status === 'sent' ? 'badge-sent' : 'badge-error'}">
          ${l.status === 'sent' ? '✅ Sent' : '❌ Error'}
        </span>
        <div class="log-details">
          <div class="log-client">${escHtml(l.client_name || '—')} — ${escHtml(l.doc_type || '—')}${l.fiscal_year ? ' (' + escHtml(l.fiscal_year) + ')' : ''}</div>
          <div class="log-sub">
            To: ${escHtml(l.client_email || '—')} · ${escHtml(l.file_name || '—')}
            ${isAdmin ? `<br>By: ${escHtml(l.sent_by || '—')}` : ''}
            ${l.error_msg ? `<br><span style="color:var(--red);">Error: ${escHtml(l.error_msg)}</span>` : ''}
          </div>
        </div>
        <div class="log-time">${timeStr}</div>
      </div>
    `;
  }).join('');
}
