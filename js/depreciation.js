// ════════════════════════════════════════════
//  DEPRECIATION — Income Tax pool depreciation schedule
//  Reproduces the firm's "Depreciation as per Income Tax" working: the user
//  enters each pool's opening value, additions (split into the three tax
//  timing buckets) and disposals; Total Value, Depreciation Base,
//  Depreciation and closing WDV auto-calculate, and the exact template is
//  generated as an .xlsx (ExcelJS — faithful merges/borders/number formats,
//  which the app's SheetJS import-only build can't write).
//
//  Formulas (verbatim from the reference sheet):
//    Total Value      I = Opening + (Add₁+Add₂+Add₃) − Disposal
//    Depreciation Base J = Opening + Add₁ − Disposal + Add₂·2/3 + Add₃·1/3
//    Depreciation     K = Base × rate      (Pools A–D, reducing balance)
//                       = Base ÷ years     (Software / Leasehold, 5-yr SLM)
//                       = 0                (Land — never depreciated)
//    WDV Amount       L = Total Value − Depreciation   (→ next year's opening)
//
//  Additions absorb per the Income Tax Act timing rule: Shrawan–Poush 100%,
//  Magh–Chaitra ⅔, Baishakh–Ashadh ⅓ (the three "Addition" sub-columns).
// ════════════════════════════════════════════
ModuleRegistry.register({ id: 'depreciation', group: 'main', buttonId: 'nav-depreciation', panelId: 'tab-depreciation-panel' });

const DEP_POOLS = [
  { key:'building',  pool:'A', name:'Building & Structure',                   mode:'wdv', rate:0.05, kw:['building','structure'] },
  { key:'furniture', pool:'B', name:'Furniture, Fixture & Office Equipment',  mode:'wdv', rate:0.25, kw:['furniture','fixture','office equip'] },
  { key:'vehicle',   pool:'C', name:'Vehicles',                              mode:'wdv', rate:0.20, kw:['vehicle'] },
  { key:'plant',     pool:'D', name:'Plant & Machinery & Other Assets',      mode:'wdv', rate:0.15, kw:['plant','machinery','other asset'] },
  { key:'software',  pool:'E', name:'Software (5 years)',                    mode:'slm', years:5,   kw:['software'] },
  { key:'leasehold', pool:'',  name:'Leasehold Assets (5 years)',           mode:'slm', years:5,   kw:['leasehold','leashold'] },
  { key:'land',      pool:'',  name:'Land',                                 mode:'none',           kw:['land'] },
];

const DEP_INPUT_COLS = ['opening', 'add1', 'add2', 'add3', 'disposal'];

function depStatus(html, type) { showStatus(html, type, 'dep-status'); }

function depParse(v) {
  if (v == null) return 0;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? 0 : n;
}

// Zero (or empty) renders as an en-dash — "no such asset for this company".
function depFmt(n) {
  if (!n) return '–';
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function depRateLabel(p) {
  if (p.mode === 'wdv') return (p.rate * 100) + '%';
  if (p.mode === 'slm') return p.years + ' yrs';
  return '–';
}

function depCompute(p, inp) {
  const active = !!(inp.opening || inp.add1 || inp.add2 || inp.add3 || inp.disposal);
  if (!active) return { active: false };
  const total = inp.opening + (inp.add1 + inp.add2 + inp.add3) - inp.disposal;
  const base  = inp.opening + inp.add1 - inp.disposal + inp.add2 / 3 * 2 + inp.add3 / 3;
  let dep = 0;
  if (p.mode === 'wdv') dep = base * p.rate;
  else if (p.mode === 'slm') dep = base / p.years;
  const wdv = total - dep;
  return { active: true, total, base, dep, wdv };
}

// ── Build the editable grid ──
function depInit() {
  const tbody = document.getElementById('dep-tbody');
  if (!tbody || tbody.dataset.built) return;
  tbody.innerHTML = DEP_POOLS.map(p => {
    const inCell = f => `<td><input class="dep-in" id="dep-${p.key}-${f}" inputmode="decimal" placeholder="–" oninput="depRecalc()"></td>`;
    return `<tr>
      <td class="dep-pool">${p.pool || '—'}</td>
      <td class="dep-particular">${escHtml(p.name)}</td>
      <td class="dep-rate">${depRateLabel(p)}</td>
      ${inCell('opening')}
      ${inCell('add1')}${inCell('add2')}${inCell('add3')}
      ${inCell('disposal')}
      <td class="dep-calc" id="dep-${p.key}-total">–</td>
      <td class="dep-calc" id="dep-${p.key}-base">–</td>
      <td class="dep-calc" id="dep-${p.key}-dep">–</td>
      <td class="dep-calc" id="dep-${p.key}-wdv">–</td>
    </tr>`;
  }).join('');
  tbody.dataset.built = '1';
  depRecalc();
}

function depRecalc() {
  const T = { opening:0, add1:0, add2:0, add3:0, disposal:0, total:0, base:0, dep:0, wdv:0 };
  DEP_POOLS.forEach(p => {
    const g = f => depParse(document.getElementById('dep-' + p.key + '-' + f).value);
    const inp = { opening:g('opening'), add1:g('add1'), add2:g('add2'), add3:g('add3'), disposal:g('disposal') };
    const c = depCompute(p, inp);
    const set = (f, v) => { document.getElementById('dep-' + p.key + '-' + f).textContent = v; };
    if (c.active) {
      set('total', depFmt(c.total)); set('base', depFmt(c.base)); set('dep', depFmt(c.dep)); set('wdv', depFmt(c.wdv));
      T.total += c.total; T.base += c.base; T.dep += c.dep; T.wdv += c.wdv;
    } else {
      ['total','base','dep','wdv'].forEach(f => set(f, '–'));
    }
    DEP_INPUT_COLS.forEach(f => { T[f] += inp[f]; });
    p._inp = inp; p._c = c;
  });
  ['opening','add1','add2','add3','disposal','total','base','dep','wdv']
    .forEach(f => { document.getElementById('dep-tot-' + f).textContent = depFmt(T[f]); });
  window._depTotals = T;
}

function depReset() {
  DEP_POOLS.forEach(p => DEP_INPUT_COLS.forEach(f => { document.getElementById('dep-' + p.key + '-' + f).value = ''; }));
  document.getElementById('dep-add-tbody').innerHTML = '';
  depRecalc();
  depStatus('', 'info');
}

// ════════════════════════════════════════════
//  ADDITION DETAILS — itemize each purchase; auto-bucket into the three tax
//  timing columns by its B.S. date, the classification the user does by hand.
// ════════════════════════════════════════════
function depBsMonth(dateStr) {
  const parts = String(dateStr || '').split(/[\/\-.]/).map(s => parseInt(s, 10)).filter(n => !isNaN(n));
  const m = parts.length >= 2 ? parts[1] : null;
  return (m >= 1 && m <= 12) ? m : null;
}

function depAddLine() {
  const tbody = document.getElementById('dep-add-tbody');
  const opts = DEP_POOLS.map(p => `<option value="${p.key}">${(p.pool ? p.pool + ' — ' : '') + escHtml(p.name)}</option>`).join('');
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input class="dep-in dep-add-date" placeholder="e.g. 2081/09/15" /></td>
    <td><select class="dep-add-pool">${opts}</select></td>
    <td><input class="dep-in dep-add-particular" placeholder="Asset description" style="text-align:left;" /></td>
    <td><input class="dep-in dep-add-amount" inputmode="decimal" placeholder="0" /></td>
    <td><button class="btn btn-danger btn-sm" onclick="this.closest('tr').remove()">Remove</button></td>`;
  tbody.appendChild(tr);
}

function depApplyAdditions() {
  const buckets = {};
  let skipped = 0;
  document.querySelectorAll('#dep-add-tbody tr').forEach(tr => {
    const date = tr.querySelector('.dep-add-date').value;
    const key  = tr.querySelector('.dep-add-pool').value;
    const amt  = depParse(tr.querySelector('.dep-add-amount').value);
    if (!amt) return;
    const m = depBsMonth(date);
    if (!m) { skipped++; return; }
    const b = (m >= 4 && m <= 9) ? 'add1' : (m >= 10) ? 'add2' : 'add3';
    (buckets[key] = buckets[key] || { add1:0, add2:0, add3:0 })[b] += amt;
  });
  DEP_POOLS.forEach(p => {
    const b = buckets[p.key];
    if (!b) return;
    ['add1','add2','add3'].forEach(f => { document.getElementById('dep-' + p.key + '-' + f).value = b[f] || ''; });
  });
  depRecalc();
  depStatus(
    (Object.keys(buckets).length ? '✅ Additions bucketed by date and applied to the schedule.' : '⚠️ No additions with an amount to apply.')
    + (skipped ? ` (${skipped} line(s) skipped — missing or invalid B.S. date.)` : ''),
    Object.keys(buckets).length ? 'success' : 'info'
  );
}

// ════════════════════════════════════════════
//  IMPORT — pre-fill the schedule from an uploaded template (.xlsx/.ods),
//  matching each pool by its Particular text (any row order tolerated).
// ════════════════════════════════════════════
function depImportExcel(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const wb = XLSX.read(e.target.result, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
      let matched = 0;
      DEP_POOLS.forEach(p => {
        const row = rows.find(r => {
          const txt = (String(r[1] || '') + ' ' + String(r[0] || '')).toLowerCase();
          return p.kw.some(k => txt.includes(k));
        });
        if (!row) return;
        matched++;
        const put = (f, colIdx) => {
          const n = depParse(row[colIdx]);
          document.getElementById('dep-' + p.key + '-' + f).value = n ? n : '';
        };
        put('opening', 3); put('add1', 4); put('add2', 5); put('add3', 6); put('disposal', 7);
      });
      depRecalc();
      depStatus(matched
        ? `✅ Imported ${matched} pool(s) from ${escHtml(file.name)}. Review the values, then generate.`
        : `⚠️ Couldn't recognize any depreciation pools in ${escHtml(file.name)}. Check it matches the standard template.`,
        matched ? 'success' : 'info');
    } catch (err) {
      depStatus('❌ Could not read that file: ' + escHtml(err.message), 'error');
    }
    input.value = '';
  };
  reader.readAsArrayBuffer(file);
}

// ════════════════════════════════════════════
//  EXCEL GENERATION — reproduces the reference template exactly (merged
//  headers, thin borders, accounting number format, live formulas). Land's
//  Total-Value formula is written correctly here (the source sheet had it
//  pointing at the Leasehold row — a genuine error, not replicated).
// ════════════════════════════════════════════
async function depGenerateExcel() {
  if (!window.ExcelJS) { depStatus('❌ Excel engine not loaded — reload the page and try again.', 'error'); return; }
  depRecalc();

  const company = document.getElementById('dep-company').value.trim();
  const fy = document.getElementById('dep-fy').value.trim();

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Depreciation');
  const MONEY = '#,##0.00;(#,##0.00);"–"';
  const thin = { style: 'thin', color: { argb: 'FF000000' } };
  const allBorders = { top: thin, left: thin, bottom: thin, right: thin };
  const NAVY = 'FF0B1F3D';

  ws.columns = [
    { width: 6 }, { width: 34 }, { width: 12 }, { width: 15 },
    { width: 14 }, { width: 14 }, { width: 14 }, { width: 13 },
    { width: 16 }, { width: 17 }, { width: 15 }, { width: 15 },
  ];

  // Title block
  ws.mergeCells('A1:L1');
  ws.getCell('A1').value = company || 'Depreciation Schedule';
  ws.getCell('A1').font = { bold: true, size: 14, color: { argb: NAVY } };
  ws.getCell('A1').alignment = { horizontal: 'center' };
  ws.mergeCells('A2:L2');
  ws.getCell('A2').value = 'Depreciation as per Income Tax' + (fy ? '   |   F.Y. ' + fy : '');
  ws.getCell('A2').font = { size: 11, color: { argb: 'FF64748B' } };
  ws.getCell('A2').alignment = { horizontal: 'center' };
  ws.getRow(1).height = 20;

  // Header rows (4 & 5)
  const H = 4, SUB = 5;
  const setHead = (cell, text) => {
    const c = ws.getCell(cell);
    c.value = text;
    c.font = { bold: true, size: 10, color: { argb: NAVY } };
    c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F5FB' } };
    c.border = allBorders;
  };
  [['A','Pool'],['B','Particular'],['C','Depreciation Rate'],['D','Opening Value'],
   ['H','Disposal'],['I','Total Value'],['J','Depreciation Base'],['K','Depreciation'],['L','WDV Amount']]
    .forEach(([col, txt]) => { ws.mergeCells(`${col}${H}:${col}${SUB}`); setHead(`${col}${H}`, txt); });
  ws.mergeCells(`E${H}:G${H}`); setHead(`E${H}`, 'Addition');
  setHead(`E${SUB}`, 'Up to Paush'); setHead(`F${SUB}`, 'Magh–Chaitra'); setHead(`G${SUB}`, 'Baishakh–Ashadh');

  // Pool rows
  const first = 6;
  DEP_POOLS.forEach((p, i) => {
    const r = first + i;
    const inp = p._inp || { opening:0, add1:0, add2:0, add3:0, disposal:0 };
    ws.getCell(`A${r}`).value = p.pool || '';
    ws.getCell(`B${r}`).value = p.name;
    // Rate cell — percentage for reducing-balance pools, "n yrs" for SLM
    const rc = ws.getCell(`C${r}`);
    if (p.mode === 'wdv') { rc.value = p.rate; rc.numFmt = '0%'; }
    else if (p.mode === 'slm') { rc.value = p.years; rc.numFmt = '0" yrs"'; }
    rc.alignment = { horizontal: 'center' };
    // Inputs (0 shows as dash via the accounting format)
    [['D', inp.opening], ['E', inp.add1], ['F', inp.add2], ['G', inp.add3], ['H', inp.disposal]]
      .forEach(([col, v]) => { const c = ws.getCell(`${col}${r}`); c.value = v; c.numFmt = MONEY; });
    // Computed columns — live formulas matching the reference sheet
    const c = p._c && p._c.active ? p._c : depCompute(p, inp);
    const setF = (col, formula, result) => {
      const cell = ws.getCell(`${col}${r}`);
      cell.value = { formula, result: result || 0 };
      cell.numFmt = MONEY;
    };
    setF('I', `D${r}+SUM(E${r}:G${r})-H${r}`, c.total);
    setF('J', `D${r}+E${r}-H${r}+F${r}/3*2+G${r}/3`, c.base);
    if (p.mode === 'wdv') setF('K', `J${r}*C${r}`, c.dep);
    else if (p.mode === 'slm') setF('K', `J${r}/C${r}`, c.dep);
    else { ws.getCell(`K${r}`).value = 0; ws.getCell(`K${r}`).numFmt = MONEY; }
    setF('L', `I${r}-K${r}`, c.wdv);
    ws.getCell(`B${r}`).alignment = { horizontal: 'left' };
  });

  // Total row
  const totR = first + DEP_POOLS.length;
  ws.getCell(`B${totR}`).value = 'Total';
  ['D','E','F','G','H','I','J','K','L'].forEach(col => {
    const cell = ws.getCell(`${col}${totR}`);
    cell.value = { formula: `SUM(${col}${first}:${col}${totR - 1})` };
    cell.numFmt = MONEY;
  });

  // Borders + fonts across the whole grid
  for (let r = H; r <= totR; r++) {
    for (let col = 1; col <= 12; col++) {
      const cell = ws.getRow(r).getCell(col);
      cell.border = allBorders;
      if (r === totR) cell.font = { bold: true, color: { argb: NAVY } };
      if (r >= first && r < totR && col >= 3) cell.alignment = cell.alignment || { horizontal: 'right' };
    }
  }
  ws.getRow(totR).eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF1FA' } }; });

  // Optional Addition-details block (only if the helper table has lines)
  const addLines = [];
  document.querySelectorAll('#dep-add-tbody tr').forEach(tr => {
    const amt = depParse(tr.querySelector('.dep-add-amount').value);
    if (!amt) return;
    const key = tr.querySelector('.dep-add-pool').value;
    const p = DEP_POOLS.find(x => x.key === key);
    addLines.push({
      date: tr.querySelector('.dep-add-date').value.trim(),
      pool: p ? (p.pool || p.name) : '',
      particular: tr.querySelector('.dep-add-particular').value.trim(),
      amount: amt,
    });
  });
  if (addLines.length) {
    let r = totR + 2;
    ws.mergeCells(`B${r}:E${r}`);
    ws.getCell(`B${r}`).value = 'Addition';
    ws.getCell(`B${r}`).font = { bold: true, color: { argb: NAVY } };
    r++;
    ['Date', 'Pool', 'Particular', 'Amount'].forEach((t, i) => {
      const cell = ws.getRow(r).getCell(2 + i);
      cell.value = t; cell.font = { bold: true }; cell.border = allBorders;
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F5FB' } };
    });
    addLines.forEach(l => {
      r++;
      const cells = [l.date, l.pool, l.particular, l.amount];
      cells.forEach((v, i) => {
        const cell = ws.getRow(r).getCell(2 + i);
        cell.value = v; cell.border = allBorders;
        if (i === 3) cell.numFmt = MONEY;
      });
    });
  }

  try {
    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const fname = ('Depreciation as per Income Tax ' + (company ? company + ' ' : '') + (fy || '')).trim() + '.xlsx';
    DocumentEngine.downloadBlob(blob, fname, { module: 'depreciation', clientName: company || null });
    depStatus('✅ Excel generated and downloaded.', 'success');
  } catch (err) {
    depStatus('❌ Could not generate the file: ' + escHtml(err.message), 'error');
  }
}
