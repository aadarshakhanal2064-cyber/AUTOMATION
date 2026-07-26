// ════════════════════════════════════════════
//  REPORT EXPORT
//  One tabular report model → on-screen HTML, PDF (PDF-Lib) and Excel
//  (ExcelJS). Built when Party Ledger (4 views) and Final Account (2
//  statements) would otherwise have needed six near-identical copies of the
//  drawing code that already exists twice in bankBook.js; the "generalise
//  after two consumers" rule the other engines followed.
//
//  It deliberately does NOT know about ledgers, firms or fiscal years — a
//  caller hands it a finished grid of already-computed cells. All business
//  logic stays in the feature module.
//
//  MODEL
//    {
//      title:        'Party Ledger',
//      subtitleLines: ['Shailesh & Associates', 'From 2083.04.01 to 2083.09.30'],
//      columns: [ { label, align:'l'|'r', num:true, w:<relative width> }, ... ],
//      rows:    [ { cells:[...], style } ],   // style: undefined | 'section' | 'subtle' | 'total' | 'grand'
//      landscape: false,
//      note:    'optional footer line',
//    }
//
//  Row styles: `section` is a heading spanning the row (only cells[0] prints),
//  `subtle` is an indented detail line, `total` a ruled subtotal, `grand` the
//  filled navy figure. A null/undefined cell prints as the accounting dash.
// ════════════════════════════════════════════
window.ReportExport = (function () {
  const MONEY = '#,##0.00;(#,##0.00);"–"';
  const NAVY_HEX = 'FF0B1F3D';
  const DASH = '–';

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  // A cell is money only where the column says so; text in a numeric column
  // (e.g. an empty subtotal slot) still prints as text.
  function cellText(v, col) {
    if (v == null || v === '') return col && col.num ? DASH : '';
    return isNum(v) ? fmtAmount(v) : String(v);
  }

  // ── On-screen HTML (.client-table, the app's standard look) ──
  function toHtml(model) {
    const cols = model.columns;
    const head = `<tr>${cols.map(c => `<th style="text-align:${c.align === 'r' ? 'right' : 'left'};">${escHtml(c.label || '')}</th>`).join('')}</tr>`;
    const body = model.rows.map(r => {
      if (r.style === 'section') {
        return `<tr><td colspan="${cols.length}" style="font-weight:700; color:var(--brand-navy); background:var(--bg-page-alt);">${escHtml(r.cells[0] || '')}</td></tr>`;
      }
      const weight = (r.style === 'total' || r.style === 'grand') ? 'font-weight:700;' : '';
      const bg = r.style === 'grand' ? 'background:var(--bg-page-alt);' : '';
      const color = r.style === 'grand' ? 'color:var(--brand-navy);' : '';
      const rule = r.style === 'total' ? 'border-top:1px solid var(--border);' : '';
      const pad = r.style === 'subtle' ? 'padding-left:22px;' : '';
      return `<tr style="${weight}${bg}${color}${rule}">` + cols.map((c, i) => {
        const v = r.cells[i];
        const custom = (r.colors && r.colors[i]) ? `color:${r.colors[i]};` : '';
        return `<td style="text-align:${c.align === 'r' ? 'right' : 'left'};${i === 0 ? pad : ''}${custom}">${escHtml(cellText(v, c))}</td>`;
      }).join('') + '</tr>';
    }).join('');

    const heading = `
      <div style="margin:6px 0 14px;">
        <div style="font-size:16px; font-weight:700; color:var(--brand-navy);">${escHtml(model.title || '')}</div>
        ${(model.subtitleLines || []).map(l => `<div style="font-size:12.5px; color:var(--text-muted);">${escHtml(l)}</div>`).join('')}
      </div>`;
    const note = model.note ? `<p style="font-size:12px; color:var(--text-muted); margin:10px 0 0;">${escHtml(model.note)}</p>` : '';
    return heading + `<div style="overflow-x:auto;"><table class="client-table"><thead>${head}</thead><tbody>${body || `<tr><td colspan="${cols.length}" style="text-align:center; color:var(--text-muted);">Nothing to show for this selection.</td></tr>`}</tbody></table></div>` + note;
  }

  // PDF-Lib's standard fonts are WinAnsi-encoded and THROW on any code point
  // they can't encode — a true minus sign (U+2212) in a note, a curly quote
  // pasted into a client name, or Devanagari in an address is enough to kill
  // the whole export. Fold the typographic characters we actually emit down to
  // their ASCII equivalents and replace anything else outside Latin-1. (Same
  // limitation the Projection PDF documents: standard fonts are English-only.)
  const PDF_FOLD = {
    '−': '-', '–': '-', '—': '-', '‘': "'", '’': "'",
    '“': '"', '”': '"', '…': '...', ' ': ' ',
    '≥': '>=', '≤': '<=', '×': 'x',
  };
  function pdfSafe(s) {
    return String(s == null ? '' : s)
      .replace(/[−–—‘’“”… ≥≤×]/g, ch => PDF_FOLD[ch])
      .replace(/[^\x20-\x7E¡-ÿ]/g, '?');
  }

  // ── PDF (PDF-Lib) ──
  async function toPdf(model) {
    const doc = await PDFLib.PDFDocument.create();
    const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
    const bold = await doc.embedFont(PDFLib.StandardFonts.HelveticaBold);
    const navy = PDFLib.rgb(0.043, 0.122, 0.239);
    const muted = PDFLib.rgb(0.392, 0.455, 0.545);
    const black = PDFLib.rgb(0.1, 0.12, 0.16);
    const ruleC = PDFLib.rgb(0.85, 0.87, 0.92);
    const fillC = PDFLib.rgb(0.95, 0.96, 0.98);

    const size = model.landscape ? [842, 595] : [595, 842];
    const [pw, ph] = size;
    const margin = 40;
    const avail = pw - margin * 2;
    const cols = model.columns;
    const totalW = cols.reduce((s, c) => s + (c.w || 1), 0);
    // Resolve relative widths into absolute x/width pairs once.
    let x = margin;
    const geo = cols.map(c => { const w = avail * (c.w || 1) / totalW; const g = { x, w, align: c.align, num: c.num }; x += w; return g; });

    let page, y;
    const drawText = (s, px, py, sz, f, color) => page.drawText(pdfSafe(s), { x: px, y: py, size: sz, font: f || font, color: color || black });
    // Clip rather than wrap: report cells are short, and a wrapped row would
    // break the fixed row pitch the page-break maths depends on.
    const drawCell = (text, g, sz, f, color) => {
      let s = pdfSafe(text);
      const ff = f || font;
      while (s && ff.widthOfTextAtSize(s, sz) > g.w - 6) s = s.slice(0, -1);
      const tw = ff.widthOfTextAtSize(s, sz);
      drawText(s, g.align === 'r' ? g.x + g.w - tw - 3 : g.x + 3, y, sz, ff, color);
    };

    const newPage = () => {
      page = doc.addPage(size);
      y = ph - margin;
      drawText(model.title || '', margin, y, 15, bold, navy); y -= 15;
      (model.subtitleLines || []).forEach(l => { drawText(l, margin, y, 9, font, muted); y -= 11; });
      y -= 6;
      page.drawRectangle({ x: margin, y: y - 4, width: avail, height: 15, color: fillC });
      geo.forEach((g, i) => drawCell(cols[i].label || '', g, 8.5, bold, navy));
      y -= 17;
    };
    newPage();

    const rowH = 13.5;
    model.rows.forEach(r => {
      if (y < margin + 24) newPage();
      if (r.style === 'section') {
        y -= 3;
        drawText(r.cells[0] || '', margin + 2, y, 9.5, bold, navy);
        y -= rowH;
        return;
      }
      const isTotal = r.style === 'total', isGrand = r.style === 'grand';
      if (isGrand) page.drawRectangle({ x: margin, y: y - 4, width: avail, height: 15, color: fillC });
      if (isTotal) page.drawLine({ start: { x: margin, y: y + 11 }, end: { x: margin + avail, y: y + 11 }, thickness: 0.6, color: ruleC });
      const f = (isTotal || isGrand) ? bold : font;
      const baseColor = isGrand ? navy : (r.style === 'subtle' ? muted : black);
      geo.forEach((g, i) => {
        const custom = r.pdfColors && r.pdfColors[i];
        drawCell(cellText(r.cells[i], cols[i]), g, 8.5, f, custom || baseColor);
      });
      y -= rowH;
    });

    if (model.note) {
      y -= 6;
      // The note is the one long prose string here, so it wraps rather than clips.
      const words = pdfSafe(model.note).split(/\s+/);
      let line = '';
      const flush = () => { if (!line) return; if (y < margin + 14) newPage(); drawText(line, margin, y, 8, font, muted); y -= 10; line = ''; };
      words.forEach(w => {
        const test = line ? line + ' ' + w : w;
        if (font.widthOfTextAtSize(test, 8) > avail && line) flush(), line = w;
        else line = test;
      });
      flush();
    }

    const bytes = await doc.save();
    return new Blob([bytes], { type: 'application/pdf' });
  }

  // ── Excel (ExcelJS — same styling idiom as bankBook / depreciation) ──
  async function toExcel(model, sheetName) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet((sheetName || model.title || 'Report').slice(0, 31));
    const cols = model.columns;
    const thin = { style: 'thin', color: { argb: 'FF000000' } };
    const allBorders = { top: thin, left: thin, bottom: thin, right: thin };
    const colLetter = i => String.fromCharCode(65 + i);
    const last = colLetter(cols.length - 1);

    ws.columns = cols.map(c => ({ width: c.xw || (c.num ? 16 : 26) }));

    let r = 1;
    ws.mergeCells(`A${r}:${last}${r}`);
    ws.getCell(`A${r}`).value = model.title || '';
    ws.getCell(`A${r}`).font = { bold: true, size: 13, color: { argb: NAVY_HEX } };
    ws.getCell(`A${r}`).alignment = { horizontal: 'center' };
    r++;
    (model.subtitleLines || []).forEach(l => {
      ws.mergeCells(`A${r}:${last}${r}`);
      ws.getCell(`A${r}`).value = l;
      ws.getCell(`A${r}`).font = { size: 10.5, color: { argb: 'FF64748B' } };
      ws.getCell(`A${r}`).alignment = { horizontal: 'center' };
      r++;
    });
    r++;                                     // blank spacer row

    const H = r;
    cols.forEach((c, i) => {
      const cell = ws.getCell(`${colLetter(i)}${H}`);
      cell.value = c.label || '';
      cell.font = { bold: true, size: 10, color: { argb: NAVY_HEX } };
      cell.alignment = { horizontal: c.align === 'r' ? 'right' : 'left', vertical: 'middle', wrapText: true };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F5FB' } };
      cell.border = allBorders;
    });
    r++;

    model.rows.forEach(row => {
      if (row.style === 'section') {
        ws.mergeCells(`A${r}:${last}${r}`);
        const cell = ws.getCell(`A${r}`);
        cell.value = row.cells[0] || '';
        cell.font = { bold: true, color: { argb: NAVY_HEX } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F5FB' } };
        for (let i = 0; i < cols.length; i++) ws.getCell(`${colLetter(i)}${r}`).border = allBorders;
        r++;
        return;
      }
      const isTotal = row.style === 'total', isGrand = row.style === 'grand';
      cols.forEach((c, i) => {
        const cell = ws.getCell(`${colLetter(i)}${r}`);
        const v = row.cells[i];
        if (isNum(v)) { cell.value = v; cell.numFmt = MONEY; }
        else if (v != null && v !== '') cell.value = String(v);
        else if (c.num) cell.numFmt = MONEY;   // blank money cell shows the dash
        cell.alignment = { horizontal: c.align === 'r' ? 'right' : 'left', indent: (i === 0 && row.style === 'subtle') ? 1 : 0 };
        if (isTotal || isGrand) cell.font = { bold: true, color: { argb: isGrand ? NAVY_HEX : 'FF1A202C' } };
        if (isGrand) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF1FA' } };
        cell.border = allBorders;
      });
      r++;
    });

    if (model.note) {
      r++;
      ws.mergeCells(`A${r}:${last}${r}`);
      ws.getCell(`A${r}`).value = model.note;
      ws.getCell(`A${r}`).font = { italic: true, size: 9.5, color: { argb: 'FF64748B' } };
    }

    const buf = await wb.xlsx.writeBuffer();
    return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  // Convenience: build + download in one call, logging through DocumentEngine.
  async function download(model, kind, filename, meta) {
    const blob = kind === 'pdf' ? await toPdf(model) : await toExcel(model, meta && meta.sheetName);
    DocumentEngine.downloadBlob(blob, filename.replace(/[\\/:*?"<>|]/g, '_'), meta);
  }

  return { toHtml, toPdf, toExcel, download, MONEY };
})();
