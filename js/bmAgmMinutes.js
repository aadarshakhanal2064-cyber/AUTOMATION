// ════════════════════════════════════════════
//  BM/AGM MINUTES — Company Registration Number search
//  Reuses window.clientsList (already loaded by clients.js) — no
//  extra Supabase queries. Mirrors report.js's PAN-search pattern
//  (search by an alternate identifier, not the primary name field)
//  combined with clients.js's keyboard navigation, since report.js's
//  own PAN search doesn't have keyboard nav to copy directly.
// ════════════════════════════════════════════
function handleBmRegNoSearch(val) {
  window.bmSelectedIdx = -1;
  const list = document.getElementById('bm-regNo-autocomplete-list');
  if (!val || val.length < 2 || !Array.isArray(window.clientsList)) { list.style.display = 'none'; return; }

  const v = val.toLowerCase();
  const matches = window.clientsList.filter(c => (c.registration_number || '').toLowerCase().includes(v)).slice(0, 8);

  if (matches.length === 0) { list.style.display = 'none'; return; }

  list.innerHTML = matches.map((c, i) => `
    <div class="autocomplete-item" data-idx="${i}" onmousedown="selectBmClient('${c.id}')">
      <div class="ac-name">${escHtml(c.registration_number)}</div>
      <div class="ac-email">${escHtml(c.name)}${c.entity_type ? ' · ' + escHtml(c.entity_type) : ''}</div>
    </div>
  `).join('');
  list.style.display = 'block';
}

function handleBmRegNoKey(e) {
  const list = document.getElementById('bm-regNo-autocomplete-list');
  const items = list.querySelectorAll('.autocomplete-item');
  if (!items.length || list.style.display === 'none') return;

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    window.bmSelectedIdx = Math.min(window.bmSelectedIdx + 1, items.length - 1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    window.bmSelectedIdx = Math.max(window.bmSelectedIdx - 1, 0);
  } else if (e.key === 'Enter' && window.bmSelectedIdx >= 0) {
    e.preventDefault();
    items[window.bmSelectedIdx].dispatchEvent(new Event('mousedown'));
    return;
  } else if (e.key === 'Escape') {
    list.style.display = 'none'; return;
  }
  items.forEach((el, i) => el.classList.toggle('selected', i === window.bmSelectedIdx));
}

function selectBmClient(id) {
  const c = window.clientsList.find(x => String(x.id) === String(id));
  if (!c) return;
  document.getElementById('bm-regNo').value           = c.registration_number || '';
  document.getElementById('bm-companyName').value     = c.name || '';
  document.getElementById('bm-pan').value              = c.pan || '';
  document.getElementById('bm-address').value          = c.address || '';
  document.getElementById('bm-chairmanName').value     = c.chairman_name || '';
  document.getElementById('bm-shareholderName').value  = c.shareholder_name || '';
  document.getElementById('bm-authCapital').value      = c.authorized_capital || '';
  document.getElementById('bm-issuedCapital').value    = c.issued_capital || '';
  document.getElementById('bm-paidUpCapital').value    = c.paid_up_capital || '';
  document.getElementById('bm-regNo-autocomplete-list').style.display = 'none';
}

// Close autocomplete on outside click — mirrors report.js's PAN-search listener
document.addEventListener('click', function (e) {
  const list = document.getElementById('bm-regNo-autocomplete-list');
  if (list && !e.target.closest('#bm-regNo') && e.target.id !== 'bm-regNo') {
    list.style.display = 'none';
  }
});
