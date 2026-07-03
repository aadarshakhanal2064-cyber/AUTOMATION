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

// ════════════════════════════════════════════
//  BM/AGM MINUTES — document generation
//  Fills the Unicode/Mangal .docx template (assets/templates) with form
//  values via docxtemplater. Client data is already Unicode Nepali; only
//  numbers and B.S. dates need conversion to Devanagari here.
// ════════════════════════════════════════════
const BM_TEMPLATE_URL = 'assets/templates/bm-agm-minutes.docx';
const BM_NEPALI_MONTHS = ['बैशाख','जेठ','असार','साउन','भदौ','असोज','कार्तिक','मंसिर','पौष','माघ','फागुन','चैत'];

function bmToDevanagari(s) {
  return String(s).replace(/[0-9]/g, d => '०१२३४५६७८९'[d]);
}

// "30,000,000.00" -> "३,००,००,०००" (Nepali lakh/crore grouping, Devanagari, no decimals)
function bmFormatAmount(raw) {
  let s = String(raw || '').split('.')[0].replace(/[^0-9]/g, '').replace(/^0+/, '');
  if (!s) return '';
  let last3 = s.slice(-3), rest = s.slice(0, -3), grouped = last3;
  while (rest.length) { grouped = rest.slice(-2) + ',' + grouped; rest = rest.slice(0, -2); }
  return bmToDevanagari(grouped);
}

// "2079/09/15" -> { year:२०७९, monthName:पौष, day:१५, full:२०७९/०९/१५ }
function bmParseBsDate(str) {
  const parts = String(str || '').trim().split(/[\/\-.]/).map(x => x.trim()).filter(Boolean);
  if (parts.length < 3) return null;
  const [y, m, d] = parts;
  const mNum = parseInt(m, 10);
  if (!(mNum >= 1 && mNum <= 12)) return null;
  return {
    year: bmToDevanagari(y),
    monthName: BM_NEPALI_MONTHS[mNum - 1],
    day: bmToDevanagari(String(parseInt(d, 10))),
    full: bmToDevanagari(y + '/' + String(m).padStart(2, '0') + '/' + String(d).padStart(2, '0')),
  };
}

// "2078-79" -> { fy:"०७८/७९", next:"०७९/८०" }
function bmFiscalParts(fyValue) {
  const m = String(fyValue || '').match(/(\d{4})\D+(\d{2})/);
  if (!m) return { fy: '', next: '' };
  const y1 = parseInt(m[1], 10);
  const fmt = a => String(a).slice(1) + '/' + String(a + 1).slice(-2);
  return { fy: bmToDevanagari(fmt(y1)), next: bmToDevanagari(fmt(y1 + 1)) };
}

function bmStatus(html, type) {
  const el = document.getElementById('bm-status');
  if (el) el.innerHTML = `<div class="status-box status-${type}">${html}</div>`;
}

function bmDownloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function bmBuildData() {
  const $ = id => document.getElementById(id).value.trim();
  const bm = bmParseBsDate($('bm-bmDate'));
  const agm = bmParseBsDate($('bm-agmDate'));
  const fy = bmFiscalParts(document.getElementById('bm-fiscalYear').value);
  return { bm, agm, data: {
    companyName:        $('bm-companyName'),
    registrationNumber: $('bm-regNo'),
    chairmanName:       $('bm-chairmanName'),
    shareholderName:    $('bm-shareholderName'),
    auditorName:        $('bm-newAuditorName'),
    auditFee:           bmFormatAmount($('bm-auditFee')),
    authorizedCapital:  bmFormatAmount($('bm-authCapital')),
    issuedCapital:      bmFormatAmount($('bm-issuedCapital')),
    paidUpCapital:      bmFormatAmount($('bm-paidUpCapital')),
    fiscalYear:         fy.fy,
    nextFiscalYear:     fy.next,
    bmYear:   bm ? bm.year : '', bmMonthName: bm ? bm.monthName : '', bmDay: bm ? bm.day : '',
    agmDateFull: agm ? agm.full : '', agmMonthName: agm ? agm.monthName : '', agmDay: agm ? agm.day : '',
    agmTime:  bmToDevanagari($('bm-agmTime') || '11:00'),
    letterDate: agm ? agm.full : '',
  }};
}

async function generateBmAgmMinutes() {
  const val = id => document.getElementById(id).value.trim();
  if (!val('bm-companyName')) { bmStatus('कृपया पहिले कम्पनी छान्नुहोस् (select a company first).', 'info'); return; }
  if (!val('bm-bmDate') || !val('bm-agmDate')) { bmStatus('बैठक र सभाको मिति भर्नुहोस् (enter the B.S. meeting dates).', 'info'); return; }

  const { bm, agm, data } = bmBuildData();
  if (!bm || !agm) { bmStatus('मिति ढाँचा मिलेन — YYYY/MM/DD प्रयोग गर्नुहोस्।', 'error'); return; }

  try {
    bmStatus('<span class="spinner spinner-navy"></span> कागजात तयार गर्दै (generating)…', 'searching');
    const resp = await fetch(BM_TEMPLATE_URL);
    if (!resp.ok) throw new Error('Template file not found at ' + BM_TEMPLATE_URL);
    const zip = new PizZip(await resp.arrayBuffer());
    const doc = new window.docxtemplater(zip, { delimiters: { start: '{{', end: '}}' }, paragraphLoop: true, linebreaks: true });
    doc.render(data);
    const blob = doc.getZip().generate({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    const fname = ('BM-AGM ' + data.companyName + ' ' + document.getElementById('bm-fiscalYear').value + '.docx').replace(/[\\/:*?"<>|]/g, '_');
    bmDownloadBlob(blob, fname);
    bmStatus('✅ कागजात तयार भयो — डाउनलोड भयो (generated & downloaded).', 'success');
  } catch (err) {
    bmStatus('❌ ' + (err.message || 'Generation failed'), 'error');
  }
}
