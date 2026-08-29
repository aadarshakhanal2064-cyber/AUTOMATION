// ════════════════════════════════════════════════════════════════════════
//  NEPAL TAX — the income-tax rule a statement's tax charge is computed by
//
//  One place that answers "what tax does this client owe on these figures",
//  for the three IT return types the firm files: D-1 (presumptive, sec 4(4)),
//  D-2 (turnover, sec 4(4Ka)) and D-3 (profit — sec 4(2)/Schedule 1).
//
//  WHY AN ENGINE RATHER THAN A CONSTANT IN THE STATEMENT ENGINE.  The old
//  arrangement was one flat 25% and one hardcoded slab ladder, which answers
//  only the D-3 half of the firm's work and answers it for a company. D-1
//  and D-2 are not a percentage of profit at all — they are a figure read off
//  turnover and the client's municipality — so the rule cannot live inside an
//  expression that has only `taxableProfit` in scope. Keeping the whole rule
//  set as DATA here means a Finance Act change is an edit to a table with a
//  citation beside it, not a hunt through arithmetic, and it means the same
//  vocabulary is available to any other module that later has to state a tax
//  figure. This is the `WorkbookReader.HEADS` idea applied to tax rates.
//
//  SOURCE.  The rule set was supplied by the firm's chartered accountant as a
//  spec sheet ("Tax rule for audited"), and every line of it was then checked
//  against the Income Tax Act 2058 and a published Nepal tax summary for
//  FY 2082-83. Where the sheet and the Act differ the difference is named in
//  a comment at the rule concerned — the sheet is the firm's practice and is
//  reproduced exactly by the DEFAULTS, while the statutory cases it does not
//  cover are added as further options rather than silently substituted.
//
//  No DOM: stays loadable in Node, so tools/taxVerify.mjs can prove the
//  tables against the Act's own published figures.
//
//  Run:  node tools/taxVerify.mjs   — before and after touching this file.
// ════════════════════════════════════════════════════════════════════════

const NepalTax = (() => {

  // The fiscal year these tables state. The slab ladder and the turnover
  // bands are re-enacted every Finance Act, so a table with no year on it is
  // a table nobody can tell is stale.
  const FISCAL_YEAR = '2082-83';

  const num = v => {
    const n = typeof v === 'number' ? v : parseFloat(String(v == null ? '' : v).replace(/,/g, ''));
    return isFinite(n) ? n : 0;
  };
  // Tax is assessed in whole rupees.
  const rs = v => (v < 0 ? -Math.round(-v) : Math.round(v));

  // ════════════════════════════════════════════════════════════════
  //  LOCATION — Schedule 1, sec 1(7)
  //
  //  The presumptive figure a natural person pays, by where the business is.
  //  It is the whole of the D-1 charge and the BASE of the D-2 charge.
  //
  //  The CA's sheet lists only the first two. The Act has three: a business
  //  in a rural municipality (gaunpalika) pays Rs 2,500, and reading it as
  //  Rs 4,000 overcharges every such client. The third tier is therefore
  //  carried here — it changes nothing for a client in either of the two the
  //  sheet named, and stops the other case being computed wrongly.
  // ════════════════════════════════════════════════════════════════

  const LOCATIONS = [
    { key: 'metro',        label: 'Metropolitan / Sub-Metropolitan City', presumptive: 7500 },
    { key: 'municipality', label: 'Municipality',                         presumptive: 4000 },
    { key: 'rural',        label: 'Rural Municipality (other area)',      presumptive: 2500 },
  ];
  const DEFAULT_LOCATION = 'municipality';

  const location = key => LOCATIONS.find(l => l.key === key) || LOCATIONS.find(l => l.key === DEFAULT_LOCATION);

  // ════════════════════════════════════════════════════════════════
  //  D-1 — presumptive tax, sec 4(4)
  //
  //  A resident natural person whose only income is business income sourced
  //  in Nepal, with turnover up to Rs 30,00,000. The tax is the location
  //  figure flat: turnover moves it not at all, which is the whole point of a
  //  presumptive charge and is why the CA's sheet gives Rs 25,50,000 of sales
  //  as an example producing Rs 4,000 of tax.
  // ════════════════════════════════════════════════════════════════

  const D1_TURNOVER_CEIL = 3000000;

  // ════════════════════════════════════════════════════════════════
  //  D-2 — turnover tax, sec 4(4Ka) / Schedule 1 sec 17
  //
  //  Turnover above Rs 30,00,000 and up to Rs 1,00,00,000. The charge is the
  //  location figure PLUS a percentage of the turnover ABOVE Rs 30,00,000 —
  //  marginal, not on the whole turnover, and the bands stack.
  //
  //  The published tables state the second band pre-summed ("Rs 27,500 +
  //  0.8% of (Turnover − 50,00,000)" for a metropolitan trader). That is the
  //  same arithmetic written the other way round: 7,500 + 20,00,000 × 1% =
  //  27,500, and likewise 24,000 for a municipality and 22,500 for a rural
  //  one. Computing it marginally rather than storing the six pre-summed
  //  figures is what keeps the three locations from drifting apart — and
  //  tools/taxVerify.mjs asserts the marginal form reproduces every published
  //  figure.
  //
  //  `goods` and `service` are the CA's sheet. `commission` is the Act's
  //  third case, which the sheet does not carry: goods sold on a margin of up
  //  to three percent (gas, cigarette), where the rate is a fraction of the
  //  general one because the trader's own margin is.
  // ════════════════════════════════════════════════════════════════

  const D2_TURNOVER_FLOOR = 3000000;
  const D2_TURNOVER_CEIL  = 10000000;
  // Sec 4(4Ka) is also barred above this much taxable income.
  const D2_INCOME_CEIL    = 1000000;

  const D2_NATURES = [
    {
      key: 'goods', label: 'Goods — general trading',
      bands: [
        { upto:  5000000, rate: 0.01  },   // 30–50 lakh @ 1%
        { upto: 10000000, rate: 0.008 },   // 50 lakh–1 crore @ 0.8%
      ],
    },
    {
      key: 'commission', label: 'Goods on up to 3% commission (gas, cigarette)',
      bands: [
        { upto:  5000000, rate: 0.0025 },  // 30–50 lakh @ 0.25%
        { upto: 10000000, rate: 0.003  },  // 50 lakh–1 crore @ 0.3%
      ],
    },
    {
      key: 'service', label: 'Service',
      // One band across the whole range: 2% of everything above 30 lakh.
      bands: [ { upto: 10000000, rate: 0.02 } ],
    },
  ];
  const DEFAULT_D2_NATURE = 'goods';

  const d2Nature = key => D2_NATURES.find(n => n.key === key) || D2_NATURES.find(n => n.key === DEFAULT_D2_NATURE);

  // A natural person supplying consultancy or expert services cannot elect
  // turnover tax at all — the Act names doctor, engineer, auditor, lawyer,
  // sportsperson, artist and consultant. Worth saying out loud on the screen,
  // because "service" reads as though it covers them.
  const D2_SERVICE_EXCLUDED =
    'doctor, engineer, auditor, lawyer, sportsperson, artist or consultant';

  // ════════════════════════════════════════════════════════════════
  //  D-3 — tax on taxable profit
  //
  //  A company or partnership pays a flat rate. A proprietorship above the
  //  D-2 ceiling pays the natural person's progressive ladder.
  // ════════════════════════════════════════════════════════════════

  const ENTITY_RATES = { normal: 0.25, special: 0.20 };

  // Schedule 1, sec 1. Widths, not ceilings, so the two ladders differ in
  // exactly the two places they really differ and nowhere else.
  //
  //  · The first band is 0% and not the 1% social security tax, because that
  //    1% is not levied on business income (Schedule 1 sec 1(4)) — a
  //    proprietorship column in the published slab table reads "–" there.
  //  · `special` is the special-industry ladder: the concession replaces the
  //    30% base rate with 20%, and the two surcharged bands above it (36% =
  //    30% + a fifth, 39% = 30% + three tenths) scale with it to 24% and 26%.
  //
  //  COUPLE vs INDIVIDUAL is a real election, not a formality: a couple must
  //  elect to be assessed jointly and the non-earning spouse must declare it.
  //  The CA's sheet gives the COUPLE ladder (its first band is Rs 6,00,000),
  //  so that is the default and the sheet's table is reproduced exactly; an
  //  unmarried proprietor is assessed on the individual one, whose first band
  //  is Rs 5,00,000 and whose 30% band is correspondingly Rs 1,00,000 wider.
  //  Both ladders close the 30% band at Rs 20,00,000 and the 36% band at
  //  Rs 50,00,000, which is the check that they have not drifted apart.
  // ════════════════════════════════════════════════════════════════

  const LADDERS = {
    couple: {
      label: 'Couple (jointly assessed)',
      bands: [
        { width:  600000, normal: 0,    special: 0    },
        { width:  200000, normal: 0.10, special: 0.10 },
        { width:  300000, normal: 0.20, special: 0.20 },
        { width:  900000, normal: 0.30, special: 0.20 },
        { width: 3000000, normal: 0.36, special: 0.24 },
        { width: Infinity, normal: 0.39, special: 0.26 },
      ],
    },
    individual: {
      label: 'Individual',
      bands: [
        { width:  500000, normal: 0,    special: 0    },
        { width:  200000, normal: 0.10, special: 0.10 },
        { width:  300000, normal: 0.20, special: 0.20 },
        { width: 1000000, normal: 0.30, special: 0.20 },
        { width: 3000000, normal: 0.36, special: 0.24 },
        { width: Infinity, normal: 0.39, special: 0.26 },
      ],
    },
  };
  const DEFAULT_FILING = 'couple';

  const ladder = key => LADDERS[key] || LADDERS[DEFAULT_FILING];

  // The three return types, as data so the picker and the harness read one
  // list. `entityBased` is what tells the caller whether the charge moves
  // with profit at all — a D-1/D-2 figure does not, which is why it exports
  // as a value rather than as a live formula.
  const RETURN_TYPES = [
    { key: 'D1', label: 'D-1 — Presumptive (proprietorship, turnover up to Rs 30 lakh)', base: 'turnover' },
    { key: 'D2', label: 'D-2 — Turnover tax (proprietorship, Rs 30 lakh to Rs 1 crore)', base: 'turnover' },
    { key: 'D3', label: 'D-3 — Tax on taxable profit', base: 'profit' },
  ];
  const DEFAULT_RETURN_TYPE = 'D3';

  // ── automatic return-type selection ──
  //
  //  The Act itself decides which return a client files — nobody sits and
  //  chooses it (user ask 2026-08-29: "choose the d1 d2 d3 automatically
  //  according to the revenue"). The decision tree IS the statute:
  //
  //    not a natural person            → D-3   (sec 4(4)/(4Ka) are open to
  //                                             resident natural persons only)
  //    turnover ≤ 30,00,000            → D-1   (sec 4(4))
  //    turnover ≤ 1,00,00,000
  //      and taxable income ≤ 10,00,000 → D-2  (sec 4(4Ka))
  //    otherwise                       → D-3
  //
  //  The income ceiling matters: a small-turnover firm with a fat margin is
  //  barred from turnover tax by the Act, and an auto-picker that ignored
  //  that would file the wrong return for exactly the clients where the two
  //  charges differ most. `reason` states which threshold decided, so the
  //  screen can show WHY rather than assert a letter.
  function autoReturnType(o) {
    const opt = o || {};
    const t = Math.max(0, num(opt.turnover));
    const p = num(opt.taxableProfit);
    if (opt.entity !== 'proprietorship') {
      return { returnType: 'D3', reason: 'not a proprietorship — sec 4(4)/(4Ka) are open to natural persons only' };
    }
    if (t <= D1_TURNOVER_CEIL) {
      return { returnType: 'D1', reason: `turnover ${fmt(t)} is within the ${fmt(D1_TURNOVER_CEIL)} presumptive ceiling` };
    }
    if (t <= D2_TURNOVER_CEIL && p <= D2_INCOME_CEIL) {
      return { returnType: 'D2', reason: `turnover ${fmt(t)} is between ${fmt(D2_TURNOVER_FLOOR)} and ${fmt(D2_TURNOVER_CEIL)}` };
    }
    if (t <= D2_TURNOVER_CEIL) {
      return { returnType: 'D3', reason: `taxable income ${fmt(p)} is above the ${fmt(D2_INCOME_CEIL)} ceiling sec 4(4Ka) allows, so turnover tax is barred` };
    }
    return { returnType: 'D3', reason: `turnover ${fmt(t)} is above the ${fmt(D2_TURNOVER_CEIL)} turnover-tax ceiling` };
  }

  // A client's stored `it_return_type`, which the firm writes as 'D-01' /
  // 'D-02' / 'D-03' / 'D1/D2'. 'D1/D2' genuinely means "one of the two, the
  // preparer decides" (CLAUDE.md §15) and so resolves to nothing — a picker
  // prefilled with a guess there would be a guess nobody could see.
  function returnTypeFromClient(itReturnType) {
    const s = String(itReturnType || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (s === 'D01' || s === 'D1') return 'D1';
    if (s === 'D02' || s === 'D2') return 'D2';
    if (s === 'D03' || s === 'D3') return 'D3';
    return null;
  }

  // ── the ladder, run marginally ──
  function ladderTax(taxableIncome, filingKey, special) {
    const inc = Math.max(0, num(taxableIncome));
    const bands = ladder(filingKey).bands;
    const workings = [];
    let left = inc, from = 0, tax = 0;
    for (const b of bands) {
      if (left <= 0) break;
      const slice = Math.min(left, b.width);
      const rate = special ? b.special : b.normal;
      const amount = slice * rate;
      tax += amount;
      workings.push({
        label: (b.width === Infinity ? `Remaining (above ${fmt(from)})` : `${from === 0 ? 'Up to' : 'Next'} ${fmt(b.width)}`)
               + ` @ ${(rate * 100).toFixed(0)}%`,
        base: slice, rate, amount,
      });
      left -= slice; from += b.width;
    }
    return { tax, workings };
  }

  // ── the turnover bands, run marginally above the floor ──
  function turnoverTax(turnover, natureKey, locationKey) {
    const t = Math.max(0, num(turnover));
    const nat = d2Nature(natureKey);
    const loc = location(locationKey);
    const workings = [{
      label: `${loc.label} — base charge`, base: null, rate: null, amount: loc.presumptive,
    }];
    let tax = loc.presumptive, from = D2_TURNOVER_FLOOR;
    for (const b of nat.bands) {
      if (t <= from) break;
      const slice = Math.min(t, b.upto) - from;
      if (slice <= 0) { from = b.upto; continue; }
      const amount = slice * b.rate;
      tax += amount;
      workings.push({
        label: `${fmt(from)} to ${t < b.upto ? fmt(t) : fmt(b.upto)} @ ${pct(b.rate)}`,
        base: slice, rate: b.rate, amount,
      });
      from = b.upto;
    }
    return { tax, workings };
  }

  const fmt = v => (v === Infinity ? '—' : 'Rs ' + Math.round(v).toLocaleString('en-IN'));
  const pct = r => (r * 100).toFixed(r * 100 % 1 === 0 ? 0 : 2).replace(/\.00$/, '') + '%';

  // ════════════════════════════════════════════════════════════════
  //  compute — the one entry point
  //
  //    o.returnType    'D1' | 'D2' | 'D3'
  //    o.location      'metro' | 'municipality' | 'rural'   (D1, D2)
  //    o.d2Nature      'goods' | 'commission' | 'service'   (D2)
  //    o.entity        'private' | 'partnership' | 'proprietorship'  (D3)
  //    o.special       true for a special industry           (D3)
  //    o.filing        'couple' | 'individual'   (D3 proprietorship)
  //    o.turnover      revenue from operations
  //    o.taxableProfit the figure D-3 charges on
  //
  //  Returns the charge, a one-line rule label, the workings that produced it
  //  (so a screen can show the arithmetic rather than assert a figure), and
  //  any warnings — a warning is raised where the RULE and the FIGURES
  //  disagree, e.g. a D-2 return on turnover that is over the ceiling. That
  //  is a finding about the inputs and is shown, never silently corrected:
  //  the same rule the statement's own proof rows follow (CLAUDE.md §15).
  // ════════════════════════════════════════════════════════════════

  function compute(o) {
    const opt = o || {};
    const turnover = Math.max(0, num(opt.turnover));
    const taxableProfit = num(opt.taxableProfit);
    // 'auto' (also the default when nothing is passed) resolves the return
    // type from the figures; a named type is the preparer's explicit choice
    // and is honoured even where the Act suggests otherwise — the warnings
    // below say so rather than overruling.
    let rt, auto = null;
    if (RETURN_TYPES.some(r => r.key === opt.returnType)) {
      rt = opt.returnType;
    } else {
      auto = autoReturnType({ entity: opt.entity, turnover, taxableProfit });
      rt = auto.returnType;
    }
    const warnings = [];

    if (rt === 'D1') {
      const loc = location(opt.location);
      if (turnover > D1_TURNOVER_CEIL) {
        warnings.push(`Turnover of ${fmt(turnover)} is above the ${fmt(D1_TURNOVER_CEIL)} ceiling for a D-1 return — sec 4(4Ka) turnover tax (D-2) applies from there.`);
      }
      return {
        returnType: rt, base: 'turnover', rate: null, auto,
        tax: rs(loc.presumptive),
        label: `D-1 presumptive — ${loc.label}`,
        workings: [{ label: `${loc.label} — flat charge`, base: null, rate: null, amount: loc.presumptive }],
        warnings,
      };
    }

    if (rt === 'D2') {
      const nat = d2Nature(opt.d2Nature);
      if (turnover < D2_TURNOVER_FLOOR) {
        warnings.push(`Turnover of ${fmt(turnover)} is below the ${fmt(D2_TURNOVER_FLOOR)} floor for a D-2 return — a D-1 presumptive return applies below that.`);
      }
      if (turnover > D2_TURNOVER_CEIL) {
        warnings.push(`Turnover of ${fmt(turnover)} is above the ${fmt(D2_TURNOVER_CEIL)} ceiling for a D-2 return — tax is charged on taxable profit (D-3) from there.`);
      }
      if (taxableProfit > D2_INCOME_CEIL) {
        warnings.push(`Sec 4(4Ka) is also barred above ${fmt(D2_INCOME_CEIL)} of taxable income, and the accounts show ${fmt(taxableProfit)}.`);
      }
      if (nat.key === 'service') {
        warnings.push(`Turnover tax is not open to a natural person supplying consultancy or expert services (${D2_SERVICE_EXCLUDED}).`);
      }
      const r = turnoverTax(turnover, nat.key, opt.location);
      return {
        returnType: rt, base: 'turnover', rate: null, auto,
        tax: rs(r.tax),
        label: `D-2 turnover tax — ${nat.label}, ${location(opt.location).label}`,
        workings: r.workings, warnings,
      };
    }

    // ── D-3 ──
    const special = !!opt.special;
    const entity = opt.entity === 'proprietorship' ? 'proprietorship'
                 : opt.entity === 'partnership' ? 'partnership' : 'private';
    const charged = Math.max(0, taxableProfit);
    if (taxableProfit < 0) {
      warnings.push('Taxable profit is negative, so no tax has been provided.');
    }

    if (entity === 'proprietorship') {
      if (turnover > 0 && turnover <= D2_TURNOVER_CEIL) {
        warnings.push(`Turnover of ${fmt(turnover)} is within the sec 4(4Ka) range, so this proprietor may instead elect turnover tax (D-2). D-3 is being applied as selected.`);
      }
      const lad = ladder(opt.filing);
      const r = ladderTax(charged, opt.filing, special);
      return {
        returnType: rt, base: 'profit', rate: null, auto,
        tax: rs(r.tax),
        label: `D-3 proprietorship — ${lad.label} slabs${special ? ', special industry' : ''}`,
        workings: r.workings, warnings,
      };
    }

    const rate = special ? ENTITY_RATES.special : ENTITY_RATES.normal;
    return {
      returnType: rt, base: 'profit', rate, auto,
      tax: rs(charged * rate),
      label: `D-3 ${entity === 'partnership' ? 'partnership firm' : 'company'} — ${pct(rate)} of taxable profit`
             + (special ? ' (special industry)' : ''),
      workings: [{ label: `Taxable profit @ ${pct(rate)}`, base: charged, rate, amount: charged * rate }],
      warnings,
    };
  }

  return {
    FISCAL_YEAR, LOCATIONS, RETURN_TYPES, D2_NATURES, LADDERS, ENTITY_RATES,
    D1_TURNOVER_CEIL, D2_TURNOVER_FLOOR, D2_TURNOVER_CEIL, D2_INCOME_CEIL,
    DEFAULT_RETURN_TYPE, DEFAULT_LOCATION, DEFAULT_D2_NATURE, DEFAULT_FILING,
    compute, ladderTax, turnoverTax, autoReturnType, returnTypeFromClient, fmt, pct,
  };
})();

// Browser: global (matches the app's no-module architecture). Node: export
// so tools/taxVerify.mjs can prove the tables against the Act's own figures.
if (typeof module !== 'undefined' && module.exports) module.exports = NepalTax;
else window.NepalTax = NepalTax;
