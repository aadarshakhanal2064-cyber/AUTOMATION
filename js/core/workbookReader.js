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

  // ── the shared account-head vocabulary ──
  // Every engine that reads this workbook family matches the SAME spellings.
  // It lives here because the alternative has now failed twice in the same
  // way: each parser carried its own regex, and a head one of them learned
  // stayed invisible to the other. Most recently the Provisional module began
  // printing "Proprietors Capital" (an entity's own word for its capital,
  // 2026-08-28) and Projection Report — still matching /share capital/ alone
  // — read a nil capital off a file THIS APP GENERATED and refused the
  // upload. The app must be able to read back everything it writes, so a new
  // head goes in this table, never in a caller.
  //
  // Matched against norm()'d labels: lowercased, whitespace-collapsed. Keep
  // them anchored enough to stay unambiguous within a section — `capital`
  // demands a qualifier ("share"/"proprietors"/"partners"/…) or the bare word
  // alone, so it can never catch "Capital Work in Progress" on the asset side
  // or "Permanent Working Capital Loan" in note 3.8.
  const HEADS = {
    // Assets
    ppe:                /property.*plant|plant and equipment/,
    investments:        /^investment/,
    otherReceivablesNC: /^other receivable/,
    inventories:        /inventor/,
    receivables:        /trade\s*(and|&)\s*other receivable/,
    cash:               /cash\s*(and|&)\s*cash/,
    totalNCA:           /total non-?current assets/,
    totalCA:            /total current assets/,
    totalAssets:        /^total assets/,
    // Equity
    capital:            /\b(share|proprietor'?s?'?|partner'?s?'?|promoter'?s?'?|owner'?s?'?)\s+capital\b|^capital(\s+account)?$/,
    reserves:           /^reserve/,
    totalEquity:        /total equity$/,
    // Liabilities
    loans:              /loans?\s*(and|&)\s*borrowing/,
    payables:           /trade\s*(and|&)\s*other payable/,
    provisions:         /^provision/,
    totalCL:            /total current liabilit/,
    // Equity-movement rows (SOCE / SOCF), which follow the entity's own word
    // the same way the capital line does.
    distribution:       /^drawings?$|^dividend paid$/,
  };

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
  // `label` is the matched text as written. Callers that only want the figure
  // ignore it; the ones that need to know HOW a head was spelled (the entity
  // detector below) would otherwise have to re-walk the grid to find out.
  function labelValue(g, re, labelCol, valCol, from = 0, until = Infinity) {
    for (let r = from; r < Math.min(g.length, until); r++) {
      const row = g[r]; if (!row) continue;
      if (re.test(norm(row[labelCol]))) {
        return { row: r, value: num(row[valCol]), label: String(row[labelCol] == null ? '' : row[labelCol]).trim() };
      }
    }
    return null;
  }

  // What the capital line's WORDING says about the entity. A statement that
  // reads "Proprietors Capital" can only belong to a proprietorship, so the
  // document itself is the most reliable declaration of entity type available
  // to a module reading it — better than a client record that may be blank or
  // spelled unexpectedly.
  //
  // Deliberately ASYMMETRIC: "Share Capital" returns null rather than
  // 'company', because the firm's older template printed that head for every
  // entity, proprietorships included. Only the entity-specific wordings — the
  // ones this app has printed since 2026-08-28 — are treated as declarations.
  // Silence is not evidence.
  function entityFromCapitalLabel(label) {
    const n = norm(label);
    if (!n) return null;
    if (/\bproprietor'?s?'?\b/.test(n)) return 'proprietorship';
    if (/\bpartner'?s?'?\b/.test(n)) return 'partnership';
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

  return { num, norm, grid, findSheet, findRowIdx, findHeader, labelValue, noteSection,
           HEADS, entityFromCapitalLabel };
})();

// Browser: global (matches the app's no-module architecture). Node: export
// for engine verification scripts.
if (typeof module !== 'undefined' && module.exports) module.exports = WorkbookReader;
else window.WorkbookReader = WorkbookReader;
