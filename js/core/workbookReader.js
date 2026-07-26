// ── WorkbookReader — locating figures inside the firm's Excel statements ──
// The firm's NFRS workbooks (SFP, SOI, SOCE, SOCF, 3.1 PPE, Sch-BS, Sch-PL,
// COI) are hand-maintained, so nothing about their geometry is dependable: the
// same logical sheet appears as "Sch-PL", "Sch PL" or "Schedule-PL", and each
// sheet puts its value column somewhere different (SFP→F, SOI→F, Sch-PL→D,
// Sch-BS→H). Everything here is therefore label-driven — find the text, then
// read across from it — and never positional.
//
// Extracted from projectionEngine.js (2026-07-26) when the Financial Statement
// module needed the same locators; both engines now share this one copy.
//
// No DOM, no vendor imports: the SheetJS namespace is passed in so the file
// stays loadable in Node for engine verification against real sample files.

const WorkbookReader = (() => {

  // Excel cells hold "1,234.56" as often as 1234.56; anything unparseable
  // (including a cached '#VALUE!' from a formula over placeholder text) is 0.
  const num = (v) => {
    if (typeof v === 'number' && isFinite(v)) return v;
    if (typeof v === 'string') {
      const n = parseFloat(v.replace(/,/g, ''));
      if (isFinite(n)) return n;
    }
    return 0;
  };

  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();

  // Convert a SheetJS worksheet into a dense 2D array of cell values
  // (computed/cached values — SheetJS resolves formula caches into .v).
  function grid(ws, XLSX) {
    if (!ws || !ws['!ref']) return [];
    const range = XLSX.utils.decode_range(ws['!ref']);
    const rows = [];
    for (let r = range.s.r; r <= range.e.r; r++) {
      const row = [];
      for (let c = range.s.c; c <= range.e.c; c++) {
        const cell = ws[XLSX.utils.encode_cell({ r, c })];
        row[c] = cell ? cell.v : undefined;
      }
      rows[r] = row;
    }
    return rows;
  }

  // Tolerant sheet-name lookup: exact (case/space-insensitive) first, then
  // substring — real client files vary ("Sch-PL" vs "Sch PL" vs "Schedule-PL").
  function findSheet(wb, keys) {
    const names = wb.SheetNames;
    for (const key of keys) {
      const k = norm(key);
      let hit = names.find(n => norm(n) === k);
      if (!hit) hit = names.find(n => norm(n).includes(k));
      if (hit) return wb.Sheets[hit];
    }
    return null;
  }

  // Find the row index whose label-column cell matches `re` (searching every
  // column when labelCol is null). Search starts at `from`.
  function findRowIdx(g, re, from = 0, labelCol = null) {
    for (let r = from; r < g.length; r++) {
      const row = g[r]; if (!row) continue;
      if (labelCol != null) {
        if (re.test(norm(row[labelCol]))) return r;
      } else {
        for (let c = 0; c < row.length; c++) if (re.test(norm(row[c]))) return r;
      }
    }
    return -1;
  }

  // Locate a statement header: the row containing "Particulars", the column
  // it sits in (label column), the first non-empty column to its right (the
  // current-year value column) and the second (the prior-year/comparative
  // column). Each sheet in the firm template uses a DIFFERENT value column, so
  // this must be detected per section, never hardcoded.
  function findHeader(g, from = 0) {
    for (let r = from; r < g.length; r++) {
      const row = g[r]; if (!row) continue;
      for (let c = 0; c < row.length; c++) {
        if (norm(row[c]) === 'particulars') {
          let valCol = -1, prevCol = -1;
          for (let cc = c + 1; cc < row.length; cc++) {
            if (row[cc] !== undefined && norm(row[cc]) !== '' && norm(row[cc]) !== 'notes') {
              if (valCol === -1) valCol = cc;
              else { prevCol = cc; break; }
            }
          }
          if (valCol !== -1) return { row: r, labelCol: c, valCol, prevCol };
        }
      }
    }
    return null;
  }

  // Read the value on the first row at/after `from` whose label matches `re`.
  function labelValue(g, re, labelCol, valCol, from = 0, until = Infinity) {
    for (let r = from; r < Math.min(g.length, until); r++) {
      const row = g[r]; if (!row) continue;
      if (re.test(norm(row[labelCol]))) return { row: r, value: num(row[valCol]) };
    }
    return null;
  }

  // A numbered note ("3.12 Material Consumed Expenses") as a bounded window:
  // its own header row/columns, plus the row where it ends. The schedule sheets
  // stack many notes with their own Particulars headers, so every read has to
  // be fenced to one note or a label like "Total" matches the wrong section.
  //
  // The fence is the CLOSER of the note's own Total row and the next numbered
  // note, because not every note has a Total: Sch-BS 3.2 Investment ends at
  // "Current portion", so a Total-only fence ran past 3.3 and 3.4 and read
  // their figures as its own. Falls back to a 30-row window when neither is
  // found.
  function noteSection(g, titleRe, endRe = /^total$/) {
    const t = findRowIdx(g, titleRe);
    if (t === -1) return null;
    const h = findHeader(g, t);
    if (!h) return null;
    const total = findRowIdx(g, endRe, h.row + 1, h.labelCol);
    const next = findRowIdx(g, /^3\.\d+\b/, h.row + 1, h.labelCol);
    const ends = [total, next].filter(x => x !== -1);
    return { ...h, titleRow: t, endRow: ends.length ? Math.min(...ends) : h.row + 30 };
  }

  return { num, norm, grid, findSheet, findRowIdx, findHeader, labelValue, noteSection };
})();

// Browser: global (matches the app's no-module architecture). Node: export
// for engine verification scripts.
if (typeof module !== 'undefined' && module.exports) module.exports = WorkbookReader;
else window.WorkbookReader = WorkbookReader;
