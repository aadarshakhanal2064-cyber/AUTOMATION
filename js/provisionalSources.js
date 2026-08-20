// ════════════════════════════════════════════════════════════════════════
//  PROVISIONAL STATEMENT — SOURCE RESOLVERS  (`psrc`)
//
//  Five of the figures the Provisional Statement asks a preparer to type are
//  already in this database for that client and year: revenue, purchases, the
//  debtor/creditor detail and the VAT position all live in Autobooks, and the
//  Income-Tax depreciation the tax computation needs lives in the Depreciation
//  module. Typing them again is the duplicate data entry this module exists to
//  remove.
//
//  Every resolver here is READ-ONLY and returns
//      { value, source, detail }   when a source exists
//      null                        when it does not
//  so a client with no saved book simply keeps typing, exactly as before.
//
//  WHY NOT CALL AUTOBOOKS DIRECTLY: `spbLoadBook()` rebuilds that module's
//  global state (spbData, spbOmitted, spbMergeMap, …) against ITS OWN client
//  and fiscal-year selection. Calling it from here would silently replace
//  whatever the user has open on the Autobooks screen. So these read the
//  stored rows instead — which is safe because the rows are already
//  post-correction: merges, overrides and Data Doctor fixes are baked into
//  `party_key`/`party_name` and the amounts before they are saved.
//
//  The three arithmetic rules below are Autobooks' own (docs/modules/autobooks.md
//  and CLAUDE.md §15), and must not drift from it:
//    · Capital Purchase is a SLICE of taxable, never added on top.
//    · Taxable Import is its own box and is never folded into taxable.
//    · An omitted bill whose type ends `_return` carries the OPPOSITE sign —
//      a debit note reduces purchases.
// ════════════════════════════════════════════════════════════════════════

// ── the book row for a client + fiscal year ──
// Matched the way `spbFindBookRow` matches: by client_id when the client is in
// the directory, else by name, because Autobooks accepts walk-in books too.
async function psrcFindBook(clientId, clientName, fy) {
  if (!window.sb || !fy) return null;
  try {
    let q = window.sb.from('autobooks_books')
      .select('id, client_name, fiscal_year, reg_type, vat_return, sections')
      .eq('fiscal_year', fy);
    q = clientId != null ? q.eq('client_id', clientId)
                         : q.ilike('client_name', String(clientName || '').trim());
    const { data, error } = await q.limit(1);
    if (error || !data || !data.length) return null;
    return data[0];
  } catch (e) { return null; }
}

// ── every bill line of a book ──
async function psrcLoadEntries(bookId) {
  try {
    return await sbFetchAll(() => window.sb.from('autobooks_entries')
      .select('section, kind, bill_type, party_name, party_key, pan, tax_free, taxable, vat, taxable_import, import_vat, capital, capital_vat, fiscal_month')
      .eq('book_id', bookId).order('id', { ascending: true }));
  } catch (e) { return []; }
}

const psrcNum = v => { const n = Number(v); return isFinite(n) ? n : 0; };

// A return/debit note reduces the side it sits on. Regular lines are positive;
// only omitted bills carry a bill_type, and only a `_return` flips the sign.
function psrcSign(r) {
  return /_return$/.test(String(r.bill_type || '')) ? -1 : 1;
}

// ── roll a book's rows up into the figures the statements need ──
// One pass, so revenue, purchases, the party detail and the month split all
// come from the same rows and cannot disagree with one another.
function psrcSummarise(rows) {
  const blank = () => ({ taxable: 0, taxFree: 0, vat: 0, imports: 0, importVat: 0, capital: 0, bills: 0, omitted: 0, months: new Array(12).fill(0) });
  const out = { sales: blank(), purchase: blank(), parties: { sales: {}, purchase: {} } };

  for (const r of rows) {
    const sec = r.section === 'sales' ? 'sales' : 'purchase';
    const s = psrcSign(r);
    const b = out[sec];
    const taxable = psrcNum(r.taxable) * s;
    const taxFree = psrcNum(r.tax_free) * s;
    const imports = psrcNum(r.taxable_import) * s;

    b.taxable += taxable;
    b.taxFree += taxFree;
    b.vat += psrcNum(r.vat) * s;
    b.imports += imports;
    b.importVat += psrcNum(r.import_vat) * s;
    b.capital += psrcNum(r.capital) * s;    // memo only — already inside taxable
    b.bills++;
    if (r.kind === 'omitted') b.omitted++;

    const fi = r.fiscal_month != null ? Math.max(0, Math.min(11, r.fiscal_month - 1)) : 0;
    b.months[fi] += taxable + taxFree + imports;

    // Party detail. A PAN can cover several party groups, so these ACCUMULATE
    // — assigning would keep only the last group and drop the rest, which is
    // the bug the Annexure documents (CLAUDE.md §15).
    const key = r.party_key || String(r.party_name || '').trim().toLowerCase();
    if (!key) continue;
    const p = out.parties[sec][key] || (out.parties[sec][key] = { name: r.party_name || '', pan: r.pan || '', amount: 0, bills: 0 });
    p.amount += taxable + taxFree + imports;
    p.bills++;
    // Keep the spelling carrying the most value, not the last one seen — the
    // same weighting the annexure uses to avoid filing under a typo.
    if (!p.pan && r.pan) p.pan = r.pan;
  }
  return out;
}

// ── the public resolver ──
// Returns everything a statement can take from the register, in one round
// trip, or null when this client-year has no saved book.
async function psrcRegister(clientId, clientName, fy) {
  const book = await psrcFindBook(clientId, clientName, fy);
  if (!book) return null;
  const rows = await psrcLoadEntries(book.id);
  if (!rows.length) return null;

  const sum = psrcSummarise(rows);
  const label = `Autobooks ${book.fiscal_year}`;

  // Revenue is the sales side's taxable + tax-free. Sales carry no import box.
  const revenue = sum.sales.taxable + sum.sales.taxFree;
  // Purchases are taxable + tax-free + IMPORT. Capital is already inside
  // taxable and is deliberately not added again.
  const purchases = sum.purchase.taxable + sum.purchase.taxFree + sum.purchase.imports;

  return {
    source: label,
    bookId: book.id,
    regType: book.reg_type,
    revenue: { value: revenue, source: label, detail: `${sum.sales.bills} sales bills${sum.sales.omitted ? `, ${sum.sales.omitted} omitted` : ''}` },
    purchases: { value: purchases, source: label, detail: `${sum.purchase.bills} purchase bills${sum.purchase.omitted ? `, ${sum.purchase.omitted} omitted` : ''}` },
    vat: psrcVatPosition(book, sum, label),
    parties: sum.parties,
    months: { sales: sum.sales.months, purchase: sum.purchase.months },
    totals: sum,
  };
}

// ── VAT position ──
// The register's own VAT is output less input. A PAN-only client has no VAT
// position at all, and a book whose figures are nil gets none either — a nil
// VAT row is a head with no value, which this module drops everywhere.
function psrcVatPosition(book, sum, label) {
  if (book.reg_type !== 'vat') return null;
  const net = sum.sales.vat - (sum.purchase.vat + sum.purchase.importVat);
  if (Math.abs(net) < 0.005) return null;
  return {
    // Positive net = more output VAT collected than input reclaimed = payable.
    payable: net > 0 ? net : 0,
    receivable: net < 0 ? -net : 0,
    source: label,
    detail: `output ${sum.sales.vat.toFixed(2)} less input ${(sum.purchase.vat + sum.purchase.importVat).toFixed(2)}`,
  };
}

// ── Income-Tax depreciation, for the COI bridge ──
// `depreciation_schedules` scheme 'normal'/'special' IS the FA-Dep / DEPIT
// pool schedule the fuller reports carry. Falls back to the most recent
// earlier year for the same reason `depSlmFetchUsefulLives()` does: a
// provisional set is routinely drawn before this year's schedule is saved.
async function psrcItDepreciation(clientId, fy) {
  if (!window.sb || clientId == null || !fy) return null;
  try {
    const base = () => window.sb.from('depreciation_schedules')
      .select('pools, fiscal_year, scheme').eq('client_id', clientId)
      .in('scheme', ['normal', 'special']);
    const { data: cur } = await base().eq('fiscal_year', fy).limit(1);
    let hit = (cur && cur[0]) || null;
    if (!hit) {
      const { data: prev } = await base().lt('fiscal_year', fy)
        .order('fiscal_year', { ascending: false }).limit(1);
      hit = (prev && prev[0]) || null;
    }
    if (!hit || !Array.isArray(hit.pools) || !hit.pools.length) return null;

    // Each pool row carries the year's charge under one of these keys,
    // depending on which version of the module wrote it.
    const charge = hit.pools.reduce((s, p) => {
      for (const k of ['depreciation', '_depreciation', 'charge']) {
        if (p && typeof p[k] === 'number') return s + p[k];
      }
      return s;
    }, 0);
    if (!charge) return null;

    return {
      value: charge,
      source: `Income-Tax depreciation schedule (${hit.fiscal_year}, ${hit.scheme})`,
      fiscalYear: hit.fiscal_year,
      scheme: hit.scheme,
      pools: hit.pools,
      stale: hit.fiscal_year !== fy,
    };
  } catch (e) { return null; }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { psrcSummarise, psrcSign, psrcVatPosition };
}
