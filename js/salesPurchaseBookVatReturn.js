// ════════════════════════════════════════════
//  AUTOBOOKS — VAT RETURN IMPORT
//
//  Fills the "As Per VAT Return" side of the Monthly reconciliation from the
//  firm's own VAT Return Detail sheet, instead of twelve months × five boxes
//  being retyped per client.
//
//  THIS DOES NOT BREAK "As Per VAT Return is typed, never derived" (CLAUDE.md
//  §15). That rule exists because filed figures genuinely differ from the book
//  — by millions in the reference file — so they must never be COMPUTED from
//  the book. These figures are still the filed ones; they are read from the
//  document that records them rather than copied by hand off the same
//  document. Nothing here looks at the register.
//
//  THE HARD PART IS THAT THREE COLUMNS ARE ALL HEADED "VAT". The sheet runs
//  Taxable Sales · VAT · Tax Free Sales · Taxable Purchase · VAT · Tax Free
//  Purchase · Taxable Import Purchase · Vat · … — so a VAT column means
//  nothing on its own and everything in relation to the taxable column on its
//  left. They are therefore resolved POSITIONALLY against the nearest anchor,
//  not by their own header text.
// ════════════════════════════════════════════

// Anchor columns, MOST SPECIFIC FIRST — the order is load-bearing for the same
// reason SPB_HEADER_RULES' is: /taxable.*purchase/ would happily swallow
// "Taxable Import Purchase", and /tax free.*purchase/ would swallow "Tax Free
// Import Purchase".
const SPB_VRI_ANCHORS = [
  { re: /tax\s*free\s*import\s*purchase/, section: 'purchase', field: null, label: 'Tax Free Import Purchase' },
  { re: /taxable\s*import\s*purchase/,    section: 'purchase', field: 'imp',    vat: 'impVat', label: 'Taxable Import Purchase' },
  { re: /tax\s*free\s*sales?/,            section: 'sales',    field: 'f',      label: 'Tax Free Sales' },
  { re: /tax\s*free\s*purchase/,          section: 'purchase', field: 'f',      label: 'Tax Free Purchase' },
  { re: /taxable\s*sales?/,               section: 'sales',    field: 't',      vat: 'v', label: 'Taxable Sales' },
  { re: /taxable\s*purchase/,             section: 'purchase', field: 't',      vat: 'v', label: 'Taxable Purchase' },
];

// Columns that exist on the sheet but have no counterpart in the book
// comparison. Named so the summary can say they were seen and skipped rather
// than leaving the user wondering.
const SPB_VRI_IGNORED = /^(s\.?\s*no|month|adjustment|vat\s*paid|difference|total|opening)/;

const SPB_VRI_MONTH_HEADER = /^(months?|महिना|मिति)$/;

function spbVriStatus(html, type) { showStatus(html, type, 'spb-vri-status'); }

// ── Header ──────────────────────────────────────────────────────────────────
// The real sheet carries three title lines above the header, so the header row
// is found by content, not by position.
function spbVriFindHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const r = rows[i] || [];
    const texts = r.map(c => String(c == null ? '' : c).trim().toLowerCase());
    const monthCol = texts.findIndex(t => SPB_VRI_MONTH_HEADER.test(t));
    const hasAnchor = texts.some(t => SPB_VRI_ANCHORS.some(a => a.re.test(t)));
    if (monthCol >= 0 && hasAnchor) return { row: i, monthCol, texts };
  }
  return null;
}

// Walk the header left to right. An anchor claims its own column and, when it
// expects one, the NEXT bare "VAT" column to its right — which is what tells
// sales VAT from purchase VAT from import VAT when all three say "VAT".
function spbVriMapColumns(texts) {
  const map = [];        // [{col, section, field, label}]
  const notes = [];
  let pendingVat = null; // the anchor still waiting for its VAT column

  texts.forEach((t, col) => {
    if (!t) return;
    if (/^vat$/.test(t)) {
      if (pendingVat) {
        map.push({ col, section: pendingVat.section, field: pendingVat.vat, label: pendingVat.label + ' VAT' });
        pendingVat = null;
      } else {
        notes.push(`A "VAT" column (${spbColLetter(col + 1)}) has no taxable column to its left — ignored.`);
      }
      return;
    }
    const anchor = SPB_VRI_ANCHORS.find(a => a.re.test(t));
    if (anchor) {
      // An anchor with no field is a real column of the sheet that the book
      // comparison has no box for (Tax Free Import Purchase). Tracked so a
      // non-zero figure can be reported instead of silently dropped.
      map.push({ col, section: anchor.section, field: anchor.field, label: anchor.label });
      pendingVat = anchor.vat ? anchor : null;
      return;
    }
    if (!SPB_VRI_IGNORED.test(t)) notes.push(`Column "${t}" wasn't recognized and was ignored.`);
  });
  return { map, notes };
}

// ── Read ────────────────────────────────────────────────────────────────────
function spbVriParse(rows, header) {
  const { map, notes } = spbVriMapColumns(header.texts);
  const months = {};              // fi -> { 'sales|t': number, ... }
  const unmapped = [];            // non-zero figures with nowhere to go
  let monthRows = 0;
  let totalRow = null;

  for (let i = header.row + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const raw = String(r[header.monthCol] == null ? '' : r[header.monthCol]).trim();
    if (!raw) continue;
    // "Total" and "Opening" are real rows on this sheet and are not months.
    // Checked explicitly rather than trusting the month matcher to decline
    // them — spbFuzzyMonthMatch exists precisely because it is willing to
    // guess, and here a guess would corrupt a month.
    if (/^(total|opening|grand\s*total)/i.test(raw)) {
      if (/^total/i.test(raw)) totalRow = r;
      continue;
    }
    const mon = spbMonthFromText(raw);
    if (mon == null) { notes.push(`Row ${i + 1}: "${raw}" isn't a B.S. month — skipped.`); continue; }
    const fi = SPB_BS_MONTHS.indexOf(mon);
    if (fi < 0) continue;
    monthRows++;
    const bucket = months[fi] || (months[fi] = {});
    map.forEach(m => {
      const n = spbNum(r[m.col]);
      if (!m.field) { if (n) unmapped.push({ month: SPB_MONTH_NAMES[fi], label: m.label, value: n }); return; }
      bucket[m.section + '|' + m.field] = n;
    });
  }
  return { map, months, notes, unmapped, monthRows, totalRow };
}

// The sheet totals itself. Comparing that against the sum of the twelve months
// is the same checksum idea the raw-book importer uses on its embedded
// subtotals: a mismatch means the uploaded file is internally inconsistent, and
// it is the file's own arithmetic saying so, not ours.
function spbVriChecksum(parsed) {
  if (!parsed.totalRow) return [];
  const out = [];
  parsed.map.forEach(m => {
    if (!m.field) return;
    const stated = spbNum(parsed.totalRow[m.col]);
    let sum = 0;
    Object.keys(parsed.months).forEach(fi => { sum += parsed.months[fi][m.section + '|' + m.field] || 0; });
    if (Math.abs(stated - sum) > 0.5) out.push({ label: m.label, stated, sum, diff: sum - stated });
  });
  return out;
}

// ── Apply ───────────────────────────────────────────────────────────────────
function spbVriApply(parsed) {
  const stats = { filled: 0, same: 0, changed: [] };
  Object.keys(parsed.months).forEach(fiKey => {
    const fi = Number(fiKey);
    const bucket = parsed.months[fi];
    Object.keys(bucket).forEach(k => {
      const [section, field] = k.split('|');
      if (!spbVr[section] || !spbVr[section][fi]) return;
      const incoming = bucket[k];
      const existing = String(spbVr[section][fi][field] == null ? '' : spbVr[section][fi][field]).trim();
      // Whatever was there is replaced — the filed return is the authority for
      // these boxes. But a typed figure that DISAGREED with the file is
      // reported by month and column, never quietly overwritten.
      if (existing === '') stats.filled++;
      else if (Math.abs(spbNum(existing) - incoming) < 0.005) stats.same++;
      else stats.changed.push({ month: SPB_MONTH_NAMES[fi], section, field, from: spbNum(existing), to: incoming });
      spbVr[section][fi][field] = incoming === 0 ? '0' : String(incoming);
    });
  });
  return stats;
}

// ── Cross-checks against the selected client and year ───────────────────────
// The sheet names both in its title block. Getting either wrong writes one
// client's filed figures onto another's reconciliation, so a disagreement is
// surfaced loudly — but never blocks, because the firm's file naming is not
// something this app gets to rule on.
function spbVriCrossCheck(rows) {
  const notes = [];
  const head = rows.slice(0, 6).map(r => (r || []).map(c => String(c == null ? '' : c)).join(' ')).join(' ');
  const fyStart = spbFyStartYear();
  const guessed = spbGuessFyFromText(head);
  if (fyStart && guessed && guessed !== fyStart) {
    notes.push(`⚠ This sheet looks like F.Y. ${guessed}-${String((guessed + 1) % 100).padStart(2, '0')}, but F.Y. ${spbVal('spb-fy')} is selected above.`);
  }
  const company = spbVal('spb-company');
  if (company) {
    const a = spbFuzzyKey(company), b = spbFuzzyKey(head);
    const firstLine = spbFuzzyKey(String((rows[0] || [])[0] || ''));
    if (firstLine && !b.includes(a) && stringSimilarity(a, firstLine) < 0.75) {
      notes.push(`⚠ The sheet is headed "${String((rows[0] || [])[0] || '').trim()}", but "${company}" is selected above.`);
    }
  }
  return notes;
}

// ── Entry point ─────────────────────────────────────────────────────────────
function spbHandleVatReturnFile(input) {
  const file = (input.files || [])[0];
  if (!file) return;
  input.value = '';
  if (!spbVr || !spbData || !SPB_SECTIONS.some(s => spbData[s.key])) {
    spbVriStatus('❌ Import or open a book first — these figures are filled in beside it.', 'error');
    return;
  }
  spbVriStatus('⏳ Reading ' + escHtml(file.name) + '…', 'searching');
  const reader = new FileReader();
  reader.onerror = () => spbVriStatus('❌ The browser could not read that file.', 'error');
  reader.onload = async e => {
    try {
      await LibLoader.ensure('xlsx');
      const wb = XLSX.read(e.target.result, { type: 'array' });
      let best = null;
      wb.SheetNames.forEach(sn => {
        if (best) return;
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: true, defval: null });
        const header = spbVriFindHeader(rows);
        if (header) best = { sn, rows, header };
      });
      if (!best) {
        spbVriStatus('❌ No VAT-return table found in "' + escHtml(file.name) + '". The sheet needs a header row with a <strong>Month</strong> column and at least one <strong>Taxable&nbsp;…</strong> column.', 'error');
        return;
      }
      const parsed = spbVriParse(best.rows, best.header);
      if (!parsed.monthRows) {
        spbVriStatus('❌ The header was found but no month rows were readable underneath it.', 'error');
        return;
      }
      const stats = spbVriApply(parsed);
      const checks = spbVriChecksum(parsed);
      const cross = spbVriCrossCheck(best.rows);

      spbRenderVrGrid();
      spbRecalcVr();
      spbVrScheduleDraft();
      if (typeof spbLedgerAfterReparse === 'function' && spbBookId) spbLedgerAfterReparse();
      AuditLog.record('spb_vat_return_imported', {
        module: 'salesPurchaseBook', clientName: spbVal('spb-company'), recordRef: spbBookId,
        detail: { fiscalYear: spbVal('spb-fy'), months: parsed.monthRows, filled: stats.filled, changed: stats.changed.length },
      });
      spbVriRenderSummary(file.name, best, parsed, stats, checks, cross);
    } catch (err) {
      console.error('[Autobooks] VAT return import failed', err);
      spbVriStatus('❌ Could not read that file: ' + escHtml(friendlyDbError(err)), 'error');
    }
  };
  reader.readAsArrayBuffer(file);
}

function spbVriRenderSummary(fileName, best, parsed, stats, checks, cross) {
  const cols = parsed.map.filter(m => m.field).map(m => m.label);
  const bad = checks.length || cross.length || parsed.unmapped.length || parsed.notes.length;
  let html = `✅ Read <strong>${escHtml(fileName)}</strong> — ${parsed.monthRows} month${parsed.monthRows === 1 ? '' : 's'} filled in from ` +
    `${escHtml(cols.length + ' column' + (cols.length === 1 ? '' : 's'))}: ${escHtml(cols.join(' · '))}.`;
  html += `<div style="margin-top:8px;">${stats.filled} figure${stats.filled === 1 ? '' : 's'} added` +
    (stats.same ? ` · ${stats.same} already matched` : '') +
    (stats.changed.length ? ` · <strong style="color:var(--amber-dk);">${stats.changed.length} replaced a different typed figure</strong>` : '') + '.</div>';

  if (stats.changed.length) {
    // Overwriting someone's typed figure is exactly the kind of thing that must
    // never happen quietly.
    html += `<div style="margin-top:8px;"><strong>Replaced:</strong><ul style="margin:6px 0 0 18px;">` +
      stats.changed.slice(0, 12).map(c =>
        `<li>${escHtml(c.month)} — ${escHtml(c.section)} ${escHtml(c.field)}: ${spbFmt(c.from)} → ${spbFmt(c.to)}</li>`).join('') +
      (stats.changed.length > 12 ? `<li>…and ${stats.changed.length - 12} more.</li>` : '') + `</ul></div>`;
  }
  if (checks.length) {
    html += `<div style="margin-top:8px; color:var(--red-dk);"><strong>The file does not add up to its own Total row:</strong><ul style="margin:6px 0 0 18px;">` +
      checks.map(c => `<li>${escHtml(c.label)}: months sum to ${spbFmt(c.sum)}, the Total row says ${spbFmt(c.stated)} (out by ${spbFmt(c.diff)})</li>`).join('') +
      `</ul>The month figures were still used — check the sheet.</div>`;
  }
  if (parsed.unmapped.length) {
    html += `<div style="margin-top:8px;">These figures have no box in the reconciliation and were not used: ` +
      escHtml(parsed.unmapped.slice(0, 6).map(u => `${u.label} ${spbFmt(u.value)} (${u.month})`).join(' · ')) +
      (parsed.unmapped.length > 6 ? ` …and ${parsed.unmapped.length - 6} more.` : '') + `</div>`;
  }
  cross.forEach(n => { html += `<div style="margin-top:8px; color:var(--amber-dk);">${escHtml(n)}</div>`; });
  if (parsed.notes.length) {
    html += `<div style="margin-top:8px; color:var(--text-muted);">${escHtml(parsed.notes.slice(0, 6).join(' '))}</div>`;
  }
  spbVriStatus(html, bad ? 'info' : 'success');
}
