// ════════════════════════════════════════════════════════════════════════
//  TRIAL BALANCE  (`tbs-`)
//
//  Automation Hub → Trial Balance. Type the firm's own trial balance and the
//  balance sheet and income statement draw themselves off it — and typing on
//  either statement writes back to the ledger.
//
//  ── WHY THIS IS NOT ANOTHER STATEMENT MODULE ──────────────────────────
//
//  Audited Statement and Provisional Statement take a year APART: last year
//  from the prior-year workbook, this year figure by figure, a solver plugging
//  whatever is left. This screen does the opposite and much smaller thing —
//  there is one set of numbers, the trial balance, and the statements are a
//  second view of it. Nothing is solved, nothing is plugged, and nothing on
//  the statements is a figure the ledger does not carry.
//
//  That is what makes the binding work both ways. `js/core/trialBalanceModel.js`
//  owns the whole model (and the reasoning behind it — read its header before
//  changing anything here); this file is the screen.
//
//  ── THE TWO EDITING RULES, AND WHY THEY DIFFER ────────────────────────
//
//  · A LEDGER amount commits on `input` and only PATCHES the derived cells.
//    Typing into a ledger box can never change the shape of anything, so a
//    re-render would throw away the caret for no reason — the same rule
//    Autobooks' confirmation grid and the To-Do list already follow.
//
//  · A STATEMENT amount commits on `change` and re-renders everything. It has
//    to: typing into an aggregated row ADDS a line to the trial balance, so
//    the left-hand pane genuinely changes shape. Committing on blur means the
//    caret has already left.
//
//  Every write-back says in words what it did — an adjustment line that
//  appears without being announced is the thing the design exists to avoid.
//
//  Run:  node tools/tbsVerify.mjs   — before and after touching this file or
//        the engine under it.
// ════════════════════════════════════════════════════════════════════════

ModuleRegistry.register({ id: 'trialBalance', group: 'main', buttonId: null, panelId: 'tab-trialBalance-panel' });

let tbsState = TrialBalanceModel.blank();
let tbsSelectedClient = null;
let tbsSavedId = null;          // trial_balances row id once saved/loaded
let tbsDerived = null;          // last TrialBalanceModel.derive() output
let tbsReport = null;           // { meta, sheets } for preview / print / Excel
let tbsSheetKey = 'SFP';        // which preview page is showing
let tbsPane = 'SFP';            // which statement the right-hand pane shows
let tbsLastNote = '';           // what the last write-back did, shown to the user

function tbsStatus(html, type) { showStatus(html, type, 'tbs-status-area'); }
function tbsEl(id) { return document.getElementById(id); }
function tbsVal(id) { const e = tbsEl(id); return e ? e.value : ''; }

// A ledger figure on screen. Nil prints as an en-dash rather than 0.00, the
// way every statement in this app does — a nil balance and an untyped one look
// the same on paper and both are "nothing there".
function tbsFmt(v) {
  const n = Number(v);
  if (!isFinite(n) || Math.abs(n) < 0.005) return '–';
  return n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
// Always signed and always printed, including nil — this is the one figure on
// the screen whose zero is the whole point.
function tbsFmtDiff(v) {
  const n = Number(v) || 0;
  return n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
const tbsNum = TrialBalanceModel.num;

// ════════════════════════════════════════════════════════════════
//  INIT
// ════════════════════════════════════════════════════════════════

function tbsInit() {
  tbsPopulateFy();
  if (!tbsEl('tbs-client-search').dataset.wired) {
    SearchEngine.attachAutocomplete(tbsEl('tbs-client-search'), tbsEl('tbs-client-autocomplete'), {
      getList: () => window.clientsList,
      keys: ['name', 'pan'],
      renderItem: c => `<div class="ac-name">${escHtml(c.name)}</div><div class="ac-email">PAN ${escHtml(c.pan || '—')}</div>`,
      onSelect: it => tbsScope.select(it),
    });
    // Typing over the picked name detaches the screen from that client record,
    // so a later Save cannot attach to it — the Projection rule.
    tbsEl('tbs-client-search').addEventListener('input', () => { tbsScope.invalidate(); tbsSelectedClient = null; });
    tbsEl('tbs-client-search').dataset.wired = '1';
  }
  tbsRecalc(true);
}

// Read through the shared default so every module rolls over together on
// Shrawan 1 (§15 — FY_DEFAULT_START).
function tbsPopulateFy() {
  const sel = tbsEl('tbs-fy');
  if (!sel || sel.options.length) return;
  const base = window.FY_DEFAULT_START || 2082;
  for (let y = base - 3; y <= base + 3; y++) {
    const o = document.createElement('option');
    o.value = `${y}-${String(y + 1).slice(2)}`;
    o.textContent = o.value;
    if (y === base) o.selected = true;
    sel.appendChild(o);
  }
}

// A saved sheet may carry a fiscal year the select no longer offers —
// `sel.value = fy` on a missing option silently loads a DIFFERENT year than
// the one clicked (the depSetFyOption lesson).
function tbsSetFyOption(fy) {
  const sel = tbsEl('tbs-fy');
  if (!sel || !fy) return;
  if (![...sel.options].some(o => o.value === fy)) {
    const o = document.createElement('option');
    o.value = o.textContent = fy;
    sel.appendChild(o);
  }
  sel.value = fy;
}

// Client switching goes through a scope, so `clear()` runs unconditionally
// before every `load()` and no path can leak the previous client's ledger onto
// this one's statements (§9).
const tbsScope = WorkflowEngine.createClientScope({
  clear(reason) {
    if (reason === 'client') {
      tbsSelectedClient = null;
      ['tbs-company', 'tbs-pan', 'tbs-address'].forEach(id => { const e = tbsEl(id); if (e) e.value = ''; });
    }
    const had = !TrialBalanceModel.totals(tbsState).foots
      || Math.abs(TrialBalanceModel.totals(tbsState).debits) > 0.005;
    tbsState = TrialBalanceModel.blank();
    tbsSavedId = null;
    tbsDerived = null; tbsReport = null; tbsLastNote = '';
    tbsPane = 'SFP'; tbsSheetKey = 'SFP';
    const ad = tbsEl('tbs-ad-date'); if (ad) ad.value = '';
    tbsRecalc(true);
    tbsStatus(had
      ? "Cleared the previous client's trial balance — this client starts on a blank sheet."
      : '', 'info');
  },
  load(it) {
    tbsSelectedClient = it;
    tbsEl('tbs-company').value = it.name || '';
    tbsEl('tbs-pan').value = NepaliLocale.toEnglishDigits(it.pan || '');
    tbsEl('tbs-address').value = it.address || '';
    tbsEl('tbs-client-search').value = it.name || '';
    // entity_type is free text; the shared map is the one authority (§16).
    // ASSIGN unconditionally — an `if (mapped)` leaves the previous client's
    // profile standing when this one has none on file (§9).
    const profile = (window.CLIENT_ENTITY_TO_REP_PROFILE || {})[String(it.entity_type || '').toLowerCase().trim()];
    tbsEl('tbs-entity').value = profile === 'proprietorship' ? 'proprietorship'
      : profile === 'partnership' ? 'partnership' : 'private';
    tbsRecalc(true);
    // A sheet already saved for this client-year is the one they mean — the
    // Autobooks / Projection "adopt, never duplicate" rule, done at selection
    // time so the duplicate can never be created in the first place.
    tbsTryLoadExisting();
  },
});

// ════════════════════════════════════════════════════════════════
//  ENTITY TERMS
//
//  The capital head follows the entity, on the ledger AND the balance sheet
//  (§15): a proprietorship's books say "Proprietors Capital" and its balance
//  sheet has to agree. There is deliberately no separate setting — the two can
//  never be made to disagree.
// ════════════════════════════════════════════════════════════════

function tbsEntity() { return tbsVal('tbs-entity') || 'private'; }
function tbsCapitalLabel() {
  const e = tbsEntity();
  return e === 'proprietorship' ? 'Proprietors Capital'
    : e === 'partnership' ? 'Partners Capital' : 'Share Capital';
}

// The A.D. equivalent the firm prints in brackets ("(16th July 2026)").
// TYPED rather than computed: NepaliLocale carries adToBs and no reverse
// table, and inventing a conversion would put a wrong date on a signed
// statement (the auditedStatement rule).
function tbsAdSuffix() {
  const v = (tbsVal('tbs-ad-date') || '').trim();
  return v ? ` (${v})` : '';
}

function tbsMeta() {
  const fy = tbsVal('tbs-fy');
  const startY = parseInt(String(fy).slice(0, 4), 10);
  const cyEnd = isFinite(startY) ? startY + 1 : null;
  const asAt = y => {
    if (!y) return '';
    const end = NepaliLocale.fyEndBs(y - 1);
    const d = (end && end.day) || 31;
    const sfx = (d % 10 === 1 && d !== 11) ? 'st' : (d % 10 === 2 && d !== 12) ? 'nd' : (d % 10 === 3 && d !== 13) ? 'rd' : 'th';
    return `${d}${sfx} Ashadh ${y}`;
  };
  return {
    company: { name: tbsVal('tbs-company'), address: tbsVal('tbs-address'), pan: tbsVal('tbs-pan') },
    fy,
    capitalLabel: tbsCapitalLabel(),
    asAtCy: asAt(cyEnd), yearEndedCy: asAt(cyEnd), asAtPy: '',
    asAtLine: `As at ${asAt(cyEnd)}${tbsAdSuffix()}`,
    forYearLine: `For the year ended ${asAt(cyEnd)}${tbsAdSuffix()}`,
    titles: { sfp: 'Statement of Financial Position', soi: 'Statement of Income' },
    place: 'Chitwan',
  };
}

// ════════════════════════════════════════════════════════════════
//  RECALCULATE
//
//  `structural` means the shape changed (a line added, a statement figure
//  written back, a client loaded) and both panes must be redrawn. Without it
//  only the derived cells are patched, so a caret sitting in a ledger box
//  survives every keystroke.
// ════════════════════════════════════════════════════════════════

function tbsRecalc(structural) {
  const meta = tbsMeta();
  tbsDerived = TrialBalanceModel.derive(tbsState, meta);
  if (structural) {
    tbsRenderLedger();
    tbsRenderStatement();
  } else {
    tbsPatchLedgerTotals();
    tbsPatchStatement();
  }
  tbsRenderBalance();
  tbsBuildReport();
  tbsRenderPreview();
}

// ════════════════════════════════════════════════════════════════
//  THE LEDGER PANE
// ════════════════════════════════════════════════════════════════

function tbsRenderLedger() {
  const host = tbsEl('tbs-ledger');
  if (!host) return;
  const t = tbsDerived.totals;
  const meta = { capitalLabel: tbsCapitalLabel() };
  const out = [];
  for (const blk of TrialBalanceModel.SKELETON) {
    out.push(`<tr class="tbs-blk"><td colspan="4">${escHtml(blk.title)}</td>
      <td class="tbs-n">${tbsFmt(t.blocks[blk.block])}</td></tr>`);
    for (const spec of blk.sections) {
      const sec = tbsState.sections[spec.id];
      const hasLines = sec.lines.length > 0;
      const title = TrialBalanceModel.sectionTitle(spec, meta);
      out.push(`<tr class="tbs-sec">
        <td class="tbs-sec-lab" colspan="2">${escHtml(title)}</td>
        <td class="tbs-sec-act">
          <button type="button" class="tbs-mini" title="Add a detail line"
                  onclick="tbsAddLine('${spec.id}')">+ line</button></td>
        <td class="tbs-n">${hasLines ? '' : `<input type="number" step="0.01" class="tbs-in"
             id="tbs-amt-${spec.id}" value="${sec.amount ? sec.amount : ''}" placeholder="0.00"
             oninput="tbsSetSectionAmount('${spec.id}', this.value)"
             onchange="tbsCommitLedger()" />`}</td>
        <td class="tbs-n tbs-sec-tot" id="tbs-sect-${spec.id}">${tbsFmt(t.sec[spec.id])}</td>
      </tr>`);
      sec.lines.forEach((l, i) => {
        // Names are never interpolated into an onclick (rule 13) — the section
        // id and the index are all a handler ever gets.
        const isLoan = spec.id === 'loans';
        const side = isLoan ? TrialBalanceModel.loanSideOf(tbsState, l) : null;
        out.push(`<tr class="tbs-line${l.adj ? ' tbs-adj' : ''}">
          <td class="tbs-line-lab" colspan="${isLoan ? 1 : 2}">
            <input type="text" class="tbs-in tbs-in-name" value="${escHtml(l.name)}"
                   placeholder="Ledger head"
                   onchange="tbsSetLineName('${spec.id}', ${i}, this.value)" />
          </td>
          ${isLoan ? `<td class="tbs-line-side">
            <select class="tbs-in tbs-in-side" title="Where this facility sits on the balance sheet"
                    onchange="tbsSetLoanSide('${spec.id}', ${i}, this.value)">
              <option value="c"${side === 'c' ? ' selected' : ''}>Current</option>
              <option value="nc"${side === 'nc' ? ' selected' : ''}>Non-current</option>
            </select></td>` : ''}
          <td class="tbs-sec-act">
            <button type="button" class="tbs-mini tbs-mini-del" title="Remove this line"
                    onclick="tbsRemoveLine('${spec.id}', ${i})">×</button></td>
          <td class="tbs-n"><input type="number" step="0.01" class="tbs-in"
                 value="${l.amount ? l.amount : ''}" placeholder="0.00"
                 oninput="tbsSetLineAmount('${spec.id}', ${i}, this.value)"
                 onchange="tbsCommitLedger()" /></td>
          <td class="tbs-n"></td>
        </tr>`);
      });
      if (hasLines) {
        out.push(`<tr class="tbs-subtot"><td colspan="4">Total ${escHtml(title.replace(/^\s*\d+\.\s*/, ''))}</td>
          <td class="tbs-n" id="tbs-sect2-${spec.id}">${tbsFmt(t.sec[spec.id])}</td></tr>`);
      }
      // The income tax charge is NAMED, never guessed — nothing here can tell
      // an income-tax provision from a road tax, and getting it wrong
      // misstates profit before tax on a statement someone signs.
      if (spec.id === 'otherExpenses') out.push(tbsTaxPickerRow());
    }
  }
  out.push(`<tr class="tbs-grand"><td colspan="4">Total of Assets &amp; Expenses</td>
    <td class="tbs-n" id="tbs-grand-dr">${tbsFmt(t.debits)}</td></tr>`);
  out.push(`<tr class="tbs-grand"><td colspan="4">Total of Revenue, Equity &amp; Liabilities</td>
    <td class="tbs-n" id="tbs-grand-cr">${tbsFmt(t.credits)}</td></tr>`);
  out.push(`<tr class="tbs-grand tbs-diff"><td colspan="4">Difference in Trial</td>
    <td class="tbs-n" id="tbs-grand-diff">${tbsFmtDiff(t.difference)}</td></tr>`);

  host.innerHTML = `<table class="tbs-table">
    <thead><tr><th colspan="3">Particulars</th><th class="tbs-n">Detail</th><th class="tbs-n">Total</th></tr></thead>
    <tbody>${out.join('')}</tbody></table>`;
}

function tbsTaxPickerRow() {
  const lines = tbsState.sections.otherExpenses.lines.filter(l => l.name);
  const opts = ['<option value="">— none: the result is shown before tax —</option>']
    .concat(lines.map(l =>
      `<option value="${escHtml(l.name)}"${l.name === tbsState.taxLine ? ' selected' : ''}>${escHtml(l.name)}</option>`));
  return `<tr class="tbs-note-row"><td colspan="5">
    <label class="tbs-inline-lab">Income tax charge is</label>
    <select class="tbs-in tbs-in-tax" onchange="tbsSetTaxLine(this.value)">${opts.join('')}</select>
    <span class="tbs-hint">Lifted out of Other Expenses onto the income statement's own tax row. Profit for the year is unchanged either way.</span>
  </td></tr>`;
}

// Only the derived cells — never the inputs, which is what lets someone type
// straight through without the caret moving.
function tbsPatchLedgerTotals() {
  const t = tbsDerived.totals;
  const put = (id, txt) => { const e = tbsEl(id); if (e) e.textContent = txt; };
  for (const id of TrialBalanceModel.SECTION_IDS) {
    put('tbs-sect-' + id, tbsFmt(t.sec[id]));
    put('tbs-sect2-' + id, tbsFmt(t.sec[id]));
  }
  document.querySelectorAll('#tbs-ledger .tbs-blk').forEach((tr, i) => {
    const blk = TrialBalanceModel.SKELETON[i];
    if (!blk) return;
    const cell = tr.querySelector('.tbs-n');
    if (cell) cell.textContent = tbsFmt(t.blocks[blk.block]);
  });
  put('tbs-grand-dr', tbsFmt(t.debits));
  put('tbs-grand-cr', tbsFmt(t.credits));
  put('tbs-grand-diff', tbsFmtDiff(t.difference));
}

// ── ledger edits ──
// An amount can never change the shape of anything, so it patches. A name, an
// added line or a removed one can, so it re-renders.
function tbsSetSectionAmount(id, v) {
  tbsState.sections[id].amount = TrialBalanceModel.r2(tbsNum(v));
  tbsRecalc(false);
}
function tbsSetLineAmount(id, i, v) {
  const l = tbsState.sections[id].lines[i];
  if (!l) return;
  l.amount = TrialBalanceModel.r2(tbsNum(v));
  tbsRecalc(false);
}
function tbsSetLineName(id, i, v) {
  const l = tbsState.sections[id].lines[i];
  if (!l) return;
  const old = l.name;
  l.name = String(v || '').trim();
  // A renamed line takes its tax nomination and its loan-side override with
  // it, or naming a line "Income Tax" and then correcting the spelling would
  // silently drop the tax charge.
  if (tbsState.taxLine === old) tbsState.taxLine = l.name || null;
  if (tbsState.loanSide[old]) { tbsState.loanSide[l.name] = tbsState.loanSide[old]; delete tbsState.loanSide[old]; }
  tbsRecalc(true);
}
function tbsAddLine(id) {
  const sec = tbsState.sections[id];
  // Turning a bare amount into detail: the amount that was there is a real
  // balance and becomes the first line, rather than being silently dropped
  // the moment a section gains its second figure.
  if (!sec.lines.length && Math.abs(sec.amount) > 0.005) {
    sec.lines.push({ name: TrialBalanceModel.SECTION_SPEC[id].title, amount: sec.amount, adj: false, from: null, side: null });
    sec.amount = 0;
  }
  sec.lines.push({ name: '', amount: 0, adj: false, from: null, side: null });
  tbsRecalc(true);
  // Land the caret in the row that was just created — otherwise every added
  // line costs a click.
  const rows = document.querySelectorAll('#tbs-ledger .tbs-line .tbs-in-name');
  if (rows.length) {
    const inputs = [...rows];
    const last = inputs.filter(el => !el.value).pop();
    if (last) last.focus();
  }
}
function tbsRemoveLine(id, i) {
  const sec = tbsState.sections[id];
  const l = sec.lines[i];
  if (!l) return;
  if (tbsState.taxLine === l.name) tbsState.taxLine = null;
  delete tbsState.loanSide[l.name];
  sec.lines.splice(i, 1);
  // A section left with no lines falls back to its bare amount, which is nil
  // — anything else would resurrect a figure the preparer had broken out.
  if (!sec.lines.length) sec.amount = 0;
  tbsRecalc(true);
}
function tbsSetLoanSide(id, i, side) {
  const l = tbsState.sections[id].lines[i];
  if (!l) return;
  // Stored on the LINE as well as the name map: the line is what the split
  // reads, and the map is what survives the line being renamed.
  l.side = side;
  if (l.name) tbsState.loanSide[l.name] = side;
  tbsRecalc(true);
}
function tbsSetTaxLine(name) {
  tbsState.taxLine = name || null;
  tbsRecalc(true);
}
// A ledger amount's `change` fires on blur. Nothing structural happened, but
// the report and preview are rebuilt so the printed pages never lag the boxes.
function tbsCommitLedger() { tbsRecalc(false); }

// ════════════════════════════════════════════════════════════════
//  THE STATEMENT PANE
// ════════════════════════════════════════════════════════════════

function tbsShowPane(which) {
  tbsPane = which;
  ['SFP', 'SOI'].forEach(k => {
    const b = tbsEl('tbs-pane-' + k);
    if (b) b.classList.toggle('active', k === which);
  });
  tbsRenderStatement();
}

function tbsRenderStatement() {
  const host = tbsEl('tbs-statement');
  if (!host) return;
  const v = tbsDerived.values;
  const showTax = !!tbsDerived.tax.name;
  const spec = tbsPane === 'SOI' ? TrialBalanceModel.SOI_ROWS : TrialBalanceModel.SFP_ROWS;
  const rows = [];
  for (const r of spec) {
    if (r.taxRow && !showTax) continue;
    if (r.kind === 'blank') { rows.push('<tr class="tbs-st-blank"><td colspan="3"></td></tr>'); continue; }
    const label = (r.capital) ? tbsCapitalLabel() : r.label;
    if (!r.k) { rows.push(`<tr class="tbs-st-${r.kind}"><td colspan="3">${escHtml(label)}</td></tr>`); continue; }
    const editable = r.src && r.src.kind !== 'calc';
    const cell = editable
      ? `<input type="number" step="0.01" class="tbs-in tbs-in-st" id="tbs-st-${r.k}"
                value="${Math.abs(v[r.k]) < 0.005 ? '' : v[r.k]}" placeholder="0.00"
                onchange="tbsSetStatementValue('${r.k}', this.value)" />`
      : `<span id="tbs-st-${r.k}">${tbsFmt(v[r.k])}</span>`;
    rows.push(`<tr class="tbs-st-${r.kind}${editable ? '' : ' tbs-st-derived'}">
      <td class="tbs-st-lab">${escHtml(label)}</td>
      <td class="tbs-st-note">${r.note ? escHtml(r.note) : ''}</td>
      <td class="tbs-n">${cell}</td></tr>`);
  }
  const m = tbsMeta();
  host.innerHTML = `
    <div class="tbs-st-head">
      <div class="tbs-st-title">${escHtml(tbsPane === 'SOI' ? m.titles.soi : m.titles.sfp)}</div>
      <div class="tbs-st-sub">${escHtml(tbsPane === 'SOI' ? m.forYearLine : m.asAtLine)}</div>
    </div>
    <table class="tbs-table tbs-st-table">
      <thead><tr><th>Particulars</th><th class="tbs-st-note">Notes</th>
        <th class="tbs-n">${escHtml(m.asAtCy || 'Current Year')}</th></tr></thead>
      <tbody>${rows.join('')}</tbody></table>
    ${tbsLastNote ? `<div class="tbs-writeback">${escHtml(tbsLastNote)}</div>` : ''}
    <div class="tbs-hint tbs-st-hint">Type into any figure above and the trial balance follows.
      A figure that is the sum of several ledger lines gets a named adjustment line rather than
      rewriting what you typed.</div>`;
}

// Patch only — used when a LEDGER box changed, so the caret is over there.
function tbsPatchStatement() {
  const v = tbsDerived.values;
  const spec = tbsPane === 'SOI' ? TrialBalanceModel.SOI_ROWS : TrialBalanceModel.SFP_ROWS;
  let taxChanged = false;
  for (const r of spec) {
    if (!r.k) continue;
    const el = tbsEl('tbs-st-' + r.k);
    if (!el) { if (r.taxRow) taxChanged = true; continue; }
    if (el.tagName === 'INPUT') {
      // Never fight a box someone is typing in.
      if (document.activeElement !== el) el.value = Math.abs(v[r.k]) < 0.005 ? '' : v[r.k];
    } else {
      el.textContent = tbsFmt(v[r.k]);
    }
  }
  // The tax row appears and disappears with the nomination, which patching
  // cannot express — redraw when that happens.
  if (taxChanged && tbsDerived.tax.name) tbsRenderStatement();
}

function tbsSetStatementValue(k, raw) {
  const res = TrialBalanceModel.applyEdit(tbsState, k, tbsNum(raw));
  if (!res.ok) {
    tbsStatus(escHtml(res.message), 'error');
    tbsRecalc(true);
    return;
  }
  tbsState = res.state;
  tbsLastNote = res.changed ? res.message : '';
  tbsRecalc(true);
  if (res.changed) tbsStatus(escHtml(res.message), 'info');
}

// ════════════════════════════════════════════════════════════════
//  THE BALANCE CHIP
//
//  ONE number, said twice. The trial balance's difference and the balance
//  sheet's gap are the same figure rearranged (see the engine's header), so
//  showing two would invite someone to chase a discrepancy that cannot exist.
//  It is SHOWN, never forced — the house rule every proof row in this app
//  already follows.
// ════════════════════════════════════════════════════════════════

function tbsRenderBalance() {
  const host = tbsEl('tbs-balance');
  if (!host) return;
  const t = tbsDerived.totals;
  const v = tbsDerived.values;
  const foots = t.foots;
  host.className = 'tbs-balance ' + (foots ? 'ok' : 'bad');
  host.innerHTML = foots
    ? `<span class="tbs-bal-dot"></span><strong>Balanced.</strong>
       Assets ${tbsFmt(v.totalAssets)} = Equity and Liabilities ${tbsFmt(v.totalEL)}`
    : `<span class="tbs-bal-dot"></span><strong>Out by ${tbsFmtDiff(Math.abs(t.difference))}.</strong>
       ${t.difference > 0 ? 'Assets and expenses exceed' : 'Revenue, equity and liabilities exceed'}
       the other side — the balance sheet is out by the same amount, because they are the same figure.`;

  const issues = tbsEl('tbs-issues');
  if (issues) {
    const list = (tbsDerived.issues || []).filter(i => i.level !== 'info' || (tbsDerived.issues || []).length === 1);
    issues.innerHTML = list.length
      ? `<ul class="tbs-issues">${list.map(i =>
          `<li class="tbs-iss-${escHtml(i.level)}">${escHtml(i.msg)}</li>`).join('')}</ul>`
      : '';
  }
}

// ════════════════════════════════════════════════════════════════
//  REPORT, PREVIEW, PRINT, EXCEL
//
//  Three pages — the balance sheet, the income statement and the trial balance
//  itself, LAST, because it is the working behind the other two. The Trial
//  Balance page is drawn by the export layer's own fsxTbSheet(), the same
//  function Audited Statement uses, and fsxLinkToTb() then writes every
//  statement cell the ledger supplied as a live `='Trial Balance'!E11`
//  reference. That is the audit trail: a reviewer follows it in Excel rather
//  than taking a sentence on trust.
// ════════════════════════════════════════════════════════════════

function tbsBuildReport() {
  const meta = tbsMeta();
  const sheets = TrialBalanceModel.buildSheets(tbsState, meta, FSX_GEOM);
  const tbSheet = fsxTbSheet(TrialBalanceModel.toReport(tbsState, meta), { subtitle: meta.asAtLine });
  sheets.push(tbSheet);
  fsxLinkToTb(sheets, tbSheet.rows);
  tbsReport = { meta, sheets, issues: tbsDerived.issues };
}

function tbsShowSheet(key) { tbsSheetKey = key; tbsRenderPreview(); }

// Built from the report, never hardcoded — a fixed list in the markup is how
// the Audited Statement's COI sheet ended up printable but unopenable (§15).
function tbsRenderSheetTabs() {
  const host = tbsEl('tbs-sheet-tabs');
  if (!host || !tbsReport) return;
  const sheets = tbsReport.sheets;
  if (!sheets.some(s => s.key === tbsSheetKey)) tbsSheetKey = sheets[0].key;
  host.innerHTML = sheets.map(s =>
    `<button class="rep-view-btn${s.key === tbsSheetKey ? ' active' : ''}"
             onclick="tbsShowSheet('${escHtml(s.key)}')">${escHtml(s.name)}</button>`).join('');
}

function tbsRenderPreview() {
  const host = tbsEl('tbs-preview');
  if (!host || !tbsReport) return;
  tbsRenderSheetTabs();
  const sh = tbsReport.sheets.find(s => s.key === tbsSheetKey) || tbsReport.sheets[0];
  host.innerHTML = fsxPreviewHtml(sh, tbsReport.meta);
}

function tbsPrint() {
  if (!tbsReport) { tbsStatus('Nothing to print yet.', 'error'); return; }
  const w = window.open('', '_blank');
  w.document.write(fsxReportHtmlDoc(tbsReport, { title: tbsVal('tbs-company') || 'Trial Balance' }));
  w.document.close();
  w.focus();
}

async function tbsDownloadExcel() {
  if (!tbsReport) { tbsStatus('Nothing to export yet.', 'error'); return; }
  try {
    await LibLoader.ensure('exceljs');
    const wb = fsxWriteWorkbook(tbsReport, ExcelJS);
    const buf = await wb.xlsx.writeBuffer();
    const name = `${(tbsVal('tbs-company') || 'Trial Balance').replace(/[\\/:*?"<>|]/g, '')} ${tbsVal('tbs-fy')} Trial Balance.xlsx`;
    DocumentEngine.downloadBlob(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), name);
    AuditLog.record('trial_balance_excel_generated', {
      module: 'trialBalance', clientName: tbsVal('tbs-company'), status: 'success',
      detail: { fiscalYear: tbsVal('tbs-fy'), sheets: tbsReport.sheets.length },
    });
    tbsStatus('Excel workbook generated — the statements point at the Trial Balance sheet by formula.', 'success');
  } catch (e) {
    tbsStatus('Could not build the workbook: ' + escHtml(e.message), 'error');
  }
}

// ════════════════════════════════════════════════════════════════
//  SAVE / LOAD — trial_balances
//
//  One row per (client, fiscal year), adopted rather than duplicated: the
//  ledger IS the record, so a second row for the same year is always a
//  mistake. `data` carries the typed state whole and the figures are
//  re-derived on load — never read back from a stored total that could have
//  drifted (the Autobooks rule).
// ════════════════════════════════════════════════════════════════

function tbsRowPayload() {
  return {
    client_id: tbsSelectedClient && tbsSelectedClient.id != null ? tbsSelectedClient.id : null,
    company_name: tbsVal('tbs-company').trim(),
    pan: tbsVal('tbs-pan') || null,
    address: tbsVal('tbs-address') || null,
    fiscal_year: tbsVal('tbs-fy'),
    as_at_date: tbsVal('tbs-ad-date') || null,
    entity_type: tbsEntity(),
    data: TrialBalanceModel.normalize(tbsState),
  };
}

async function tbsSaveToDb(btn) {
  const company = tbsVal('tbs-company').trim();
  const fy = tbsVal('tbs-fy');
  if (!company || !fy) { tbsStatus('A company name and fiscal year are needed to save.', 'error'); return; }
  const row = tbsRowPayload();
  await WorkflowEngine.withBusyButton(btn, 'Saving…', async () => {
    try {
      tbsStatus('Saving to the database…', 'searching');
      // Adopt an existing (client, year) row before inserting, so a re-open
      // and save can never create a sibling. By client_id where there is one
      // — an ilike miss on a respelt company name would otherwise collide
      // with the unique index.
      if (!tbsSavedId) {
        let q = window.sb.from('trial_balances').select('id').eq('fiscal_year', fy).limit(1);
        q = row.client_id != null ? q.eq('client_id', row.client_id) : q.ilike('company_name', company);
        const { data, error } = await q;
        if (error) throw error;
        if (data && data.length) tbsSavedId = data[0].id;
      }
      if (tbsSavedId) {
        // An update deliberately does not resend created_by — the projection idiom.
        const { error } = await window.sb.from('trial_balances').update(row).eq('id', tbsSavedId);
        if (error) throw error;
      } else {
        row.created_by = (window.currentUser || {}).email || null;
        const { data, error } = await window.sb.from('trial_balances').insert(row).select('id').single();
        if (error) throw error;
        tbsSavedId = data.id;
      }
      tbsStatus(`Saved trial balance #${tbsSavedId} for ${escHtml(company)} (${escHtml(fy)}). Saving again updates this record.`, 'success');
      showToast(`✅ Trial balance saved for <strong>${escHtml(company)}</strong> (${escHtml(fy)}).`, 'success');
      AuditLog.record('trial_balance_saved', {
        module: 'trialBalance', clientName: company, status: 'success',
        recordRef: tbsSavedId, detail: { fiscalYear: fy, foots: tbsDerived.totals.foots },
      });
    } catch (e) {
      console.error(e);
      tbsStatus('Could not save: ' + escHtml(friendlyDbError(e)), 'error');
    }
  });
}

const TBS_SAVED_COLS = 'id, client_id, company_name, pan, fiscal_year, created_by, created_at, updated_at';

function tbsOpenSavedDrawer() {
  DocumentStore.openPicker({
    label: 'Saved trial balances',
    empty: 'Nothing saved yet. Use <strong>Save to Database</strong> and it will be listed here.',
    fetchRows: async () => {
      const { data, error } = await window.sb.from('trial_balances')
        .select(TBS_SAVED_COLS).order('updated_at', { ascending: false }).limit(200);
      if (error) throw error;
      return data || [];
    },
    describe: r => {
      const when = r.updated_at || r.created_at;
      const d = when ? new Date(when) : null;
      const stamp = d && !isNaN(d)
        ? d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
        : '';
      return {
        title: `${r.company_name || '—'} (F.Y. ${r.fiscal_year || '—'})`,
        meta: (stamp ? `saved ${stamp}` : '') + ` · ${r.created_by || 'not recorded'}`,
      };
    },
    onChoose: id => tbsLoadSaved(id),
    onDelete: async id => {
      const { error } = await window.sb.from('trial_balances').delete().eq('id', id);
      if (error) throw error;
      // Orphan guard: a stale id would make the next Save issue an UPDATE that
      // silently matches nothing.
      if (tbsSavedId === id) tbsSavedId = null;
      AuditLog.record('trial_balance_deleted', {
        module: 'trialBalance', clientName: tbsVal('tbs-company'), status: 'success', recordRef: id,
      });
    },
  });
}

function tbsApplyRow(r) {
  tbsSavedId = r.id;
  tbsEl('tbs-company').value = r.company_name || '';
  tbsEl('tbs-pan').value = r.pan || '';
  tbsEl('tbs-address').value = r.address || '';
  tbsEl('tbs-client-search').value = r.company_name || '';
  tbsEl('tbs-ad-date').value = r.as_at_date || '';
  tbsEl('tbs-entity').value = r.entity_type || 'private';
  tbsSetFyOption(r.fiscal_year);
  tbsState = TrialBalanceModel.normalize(r.data);
  tbsLastNote = '';
  tbsRecalc(true);
}

async function tbsLoadSaved(id) {
  tbsStatus('Loading saved trial balance…', 'searching');
  try {
    const { data, error } = await window.sb.from('trial_balances').select('*').eq('id', id).single();
    if (error) throw error;
    // Setting the identity first and the client LAST — selecting a client
    // clears the screen, so doing it the other way round would wipe the sheet
    // just loaded (the depLoadSaved rule).
    tbsSelectedClient = data.client_id != null
      ? (window.clientsList || []).find(c => c.id === data.client_id) || null
      : null;
    tbsApplyRow(data);
    tbsStatus(`Loaded ${escHtml(data.company_name || '')} (${escHtml(data.fiscal_year || '')}). Saving updates this record.`, 'success');
  } catch (e) {
    tbsStatus('Could not load: ' + escHtml(friendlyDbError(e)), 'error');
  }
}

// Picking a client offers the sheet already saved for them, rather than
// letting a second one be started beside it. Silent when there is none — an
// empty result is the normal case, not a failure.
async function tbsTryLoadExisting() {
  const fy = tbsVal('tbs-fy');
  if (!tbsSelectedClient || tbsSelectedClient.id == null || !fy) return;
  try {
    const { data, error } = await window.sb.from('trial_balances')
      .select('*').eq('client_id', tbsSelectedClient.id).eq('fiscal_year', fy).limit(1);
    if (error || !data || !data.length) return;
    tbsApplyRow(data[0]);
    tbsStatus(`Opened the trial balance already saved for ${escHtml(data[0].company_name || '')} (${escHtml(fy)}).`, 'info');
  } catch (e) { /* a missing saved sheet is the normal case, not an error */ }
}

// Changing the year is changing which sheet this is, so it looks for that
// year's saved record the same way picking a client does.
function tbsOnFyChange() {
  tbsSavedId = null;
  tbsRecalc(true);
  tbsTryLoadExisting();
}

function tbsResetSheet() {
  if (!confirm('Clear every figure on this trial balance and start again?\n\nAnything already saved to the database stays there until you save over it.')) return;
  tbsState = TrialBalanceModel.blank();
  tbsLastNote = '';
  tbsRecalc(true);
  tbsStatus('Sheet cleared.', 'info');
}
