// ════════════════════════════════════════════════════════════════════════
//  NEPAL TAX RULES — verification harness
//
//  Proves js/core/nepalTax.js three ways:
//
//   1. THE CA'S OWN SHEET.  Every worked example on the "Tax rule for
//      audited" spec sheet, reproduced exactly. This is the acceptance test:
//      the firm's chartered accountant wrote these figures, and the defaults
//      must produce them.
//
//   2. THE ACT'S PUBLISHED FIGURES.  The turnover-tax tables are published
//      pre-summed ("Rs 27,500 + 0.8% of (Turnover − 50,00,000)") while the
//      engine computes them marginally. Those nine published cumulative
//      figures are asserted against the marginal form, which is what proves
//      the two are the same arithmetic and that the three location tiers have
//      not drifted apart. The individual slab ladder is checked against the
//      published worked illustration (Rs 55,00,000 → Rs 16,60,000 of tax,
//      less the 1% first band that business income does not pay).
//
//   3. STRUCTURE.  Band boundaries are continuous (no cliff at exactly
//      30 lakh, 50 lakh or 1 crore), the ladders are monotonic, both ladders
//      close their 30% and 36% bands at the same income, and the special
//      -industry ladder is exactly two thirds of the normal one on the three
//      bands the concession touches.
//
//  Run:  node tools/taxVerify.mjs
//  Run it BEFORE and AFTER any change to nepalTax.js or to the statement
//  engine's tax block.
// ════════════════════════════════════════════════════════════════════════

import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const T = require(path.join(here, '..', 'js', 'core', 'nepalTax.js'));

let pass = 0, fail = 0;
const money = v => Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function eq(label, got, want, tol) {
  const t = tol == null ? 0.005 : tol;
  if (Math.abs(Number(got) - Number(want)) <= t) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${label}\n          got  ${money(got)}\n          want ${money(want)}`);
}
function ok(label, cond) {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${label}`);
}
function section(t) { console.log(`\n── ${t} ──`); }

const tax = o => T.compute(o).tax;

// ════════════════════════════════════════════════════════════════
//  1.  THE CA'S SPEC SHEET
// ════════════════════════════════════════════════════════════════

section("The CA's spec sheet — D-1 presumptive");

// "If Sales of Firm is 2550000 then Rs. 4000 Tax in case of Municipality,
//  Rs.7500 Tax in case of Metropolitan and Sub Metropolitan"
eq('D-1 · sales 25,50,000 · municipality', tax({ returnType: 'D1', location: 'municipality', turnover: 2550000 }), 4000);
eq('D-1 · sales 25,50,000 · metropolitan', tax({ returnType: 'D1', location: 'metro',        turnover: 2550000 }), 7500);
// Presumptive means presumptive: the charge does not move with turnover.
eq('D-1 · sales 5,00,000 · municipality',  tax({ returnType: 'D1', location: 'municipality', turnover:  500000 }), 4000);
eq('D-1 · sales 29,99,999 · municipality', tax({ returnType: 'D1', location: 'municipality', turnover: 2999999 }), 4000);

section("The CA's spec sheet — D-2 turnover tax");

// "i. lf up to Sales 50 Lakhs → (50-30) Lakhs*1% + 4000 incase of
//  Municipality, 7500 in case of Metropolitan & Sub metropolitan"
eq('D-2 · goods · sales 50,00,000 · municipality',
   tax({ returnType: 'D2', d2Nature: 'goods', location: 'municipality', turnover: 5000000 }),
   (5000000 - 3000000) * 0.01 + 4000);                       // 24,000
eq('D-2 · goods · sales 50,00,000 · metropolitan',
   tax({ returnType: 'D2', d2Nature: 'goods', location: 'metro', turnover: 5000000 }),
   (5000000 - 3000000) * 0.01 + 7500);                       // 27,500

// "ii. lf Sales is above 50 Sales → (sales-50)*0.8% + 20000 + 4000 incase of
//  Municipality, 7500 in case of Metropolitan & Sub metropolitan"
//  (the sheet's "20000" is (50−30) lakh × 1%, i.e. the first band filled)
for (const [locKey, base] of [['municipality', 4000], ['metro', 7500], ['rural', 2500]]) {
  for (const sales of [6000000, 7500000, 10000000]) {
    eq(`D-2 · goods · sales ${T.fmt(sales)} · ${locKey}`,
       tax({ returnType: 'D2', d2Nature: 'goods', location: locKey, turnover: sales }),
       (sales - 5000000) * 0.008 + 20000 + base);
  }
}

// "iii. Proprietorship Firm is Service industries → (Sales-30) Lakhs*2%
//  + 4000 incase of Municipality, 7500 in case of Metropolitan"
for (const [locKey, base] of [['municipality', 4000], ['metro', 7500], ['rural', 2500]]) {
  for (const sales of [4000000, 5000000, 8000000, 10000000]) {
    eq(`D-2 · service · sales ${T.fmt(sales)} · ${locKey}`,
       tax({ returnType: 'D2', d2Nature: 'service', location: locKey, turnover: sales }),
       (sales - 3000000) * 0.02 + base);
  }
}

section("The CA's spec sheet — D-3 flat rates");

// "i. 25% of Taxable Profit, if Company is Special Industries then Tax will
//  be 20% of Taxable income" — and the same sentence again for a partnership.
eq('D-3 · company · 40,00,000 profit',            tax({ returnType: 'D3', entity: 'private',     taxableProfit: 4000000 }), 1000000);
eq('D-3 · company · 40,00,000 · special',         tax({ returnType: 'D3', entity: 'private',     taxableProfit: 4000000, special: true }), 800000);
eq('D-3 · partnership · 40,00,000 profit',        tax({ returnType: 'D3', entity: 'partnership', taxableProfit: 4000000 }), 1000000);
eq('D-3 · partnership · 40,00,000 · special',     tax({ returnType: 'D3', entity: 'partnership', taxableProfit: 4000000, special: true }), 800000);

section("The CA's spec sheet — D-3 proprietorship ladder (couple, the sheet's own table)");

// "Up to 600000 @ 0% · For Next 200,000 @ 10% · For Next 300,000 @ 20% ·
//  For Next 900,000 @ 30% · For Next 30,00,000 @ 36% · For Remaining @39%"
// Each band's top, worked by hand from the sheet.
const P = o => tax(Object.assign({ returnType: 'D3', entity: 'proprietorship', filing: 'couple' }, o));
eq('couple · 6,00,000',   P({ taxableProfit:  600000 }), 0);
eq('couple · 8,00,000',   P({ taxableProfit:  800000 }), 20000);                     //           200000*.10
eq('couple · 11,00,000',  P({ taxableProfit: 1100000 }), 20000 + 60000);             // + 300000*.20
eq('couple · 20,00,000',  P({ taxableProfit: 2000000 }), 80000 + 270000);            // + 900000*.30
eq('couple · 50,00,000',  P({ taxableProfit: 5000000 }), 350000 + 1080000);          // +3000000*.36
eq('couple · 60,00,000',  P({ taxableProfit: 6000000 }), 1430000 + 390000);          // +1000000*.39
// A part-band lands inside, not on, a boundary.
eq('couple · 7,00,000',   P({ taxableProfit:  700000 }), 10000);
eq('couple · 25,00,000',  P({ taxableProfit: 2500000 }), 350000 + 500000 * 0.36);

section("The CA's spec sheet — D-3 proprietorship ladder (special industry)");

// "Up to 600000 @ 0% · Next 200,000 @ 10% · Next 300,000 @ 20% ·
//  Next 900,000 @ 20% · Next 30,00,000 @ 24% · Remaining @26%"
const S = o => tax(Object.assign({ returnType: 'D3', entity: 'proprietorship', filing: 'couple', special: true }, o));
eq('couple · special · 6,00,000',  S({ taxableProfit:  600000 }), 0);
eq('couple · special · 8,00,000',  S({ taxableProfit:  800000 }), 20000);
eq('couple · special · 11,00,000', S({ taxableProfit: 1100000 }), 80000);
eq('couple · special · 20,00,000', S({ taxableProfit: 2000000 }), 80000 + 900000 * 0.20);
eq('couple · special · 50,00,000', S({ taxableProfit: 5000000 }), 260000 + 3000000 * 0.24);
eq('couple · special · 60,00,000', S({ taxableProfit: 6000000 }), 980000 + 1000000 * 0.26);

// ════════════════════════════════════════════════════════════════
//  2.  THE ACT'S PUBLISHED FIGURES
// ════════════════════════════════════════════════════════════════

section("Published turnover-tax table — pre-summed figures reproduced marginally");

// Schedule 1 sec 17, as published: the second band stated as a fixed amount
// plus a rate on the excess over 50 lakh. The engine computes it marginally
// from the location base, so these nine figures are the proof the two forms
// agree.  goods:      27,500 / 24,000 / 22,500
//         commission: 12,500 /  9,000 /  7,500
const PUBLISHED_50L = {
  goods:      { metro: 27500, municipality: 24000, rural: 22500 },
  commission: { metro: 12500, municipality:  9000, rural:  7500 },
};
for (const nature of Object.keys(PUBLISHED_50L)) {
  for (const loc of Object.keys(PUBLISHED_50L[nature])) {
    // At exactly 50 lakh the second band is empty, so the charge IS the
    // published fixed amount.
    eq(`published · ${nature} · ${loc} · at 50 lakh`,
       tax({ returnType: 'D2', d2Nature: nature, location: loc, turnover: 5000000 }),
       PUBLISHED_50L[nature][loc]);
    // And above it, the published fixed amount plus the published rate.
    const rate = nature === 'goods' ? 0.008 : 0.003;
    eq(`published · ${nature} · ${loc} · at 80 lakh`,
       tax({ returnType: 'D2', d2Nature: nature, location: loc, turnover: 8000000 }),
       PUBLISHED_50L[nature][loc] + 3000000 * rate);
  }
}

// The first band, likewise published as "base + rate × (turnover − 30 lakh)".
for (const [loc, base] of [['metro', 7500], ['municipality', 4000], ['rural', 2500]]) {
  eq(`published · commission · ${loc} · at 40 lakh`,
     tax({ returnType: 'D2', d2Nature: 'commission', location: loc, turnover: 4000000 }),
     base + 1000000 * 0.0025);
}

section('Published slab illustration — individual ladder');

// The published worked example takes taxable income of Rs 55,00,000 to a tax
// of Rs 16,60,000 on the EMPLOYMENT column, whose first Rs 5,00,000 carries
// the 1% social security tax. Business income does not pay that 1%
// (Schedule 1 sec 1(4)), so the proprietorship figure is that illustration
// less Rs 5,000 — which is exactly what the engine must produce.
eq('individual · 55,00,000 (published 16,60,000 less the 1% first band)',
   tax({ returnType: 'D3', entity: 'proprietorship', filing: 'individual', taxableProfit: 5500000 }),
   1660000 - 5000);

// The individual ladder band by band.
const I = o => tax(Object.assign({ returnType: 'D3', entity: 'proprietorship', filing: 'individual' }, o));
eq('individual · 5,00,000',  I({ taxableProfit:  500000 }), 0);
eq('individual · 7,00,000',  I({ taxableProfit:  700000 }), 20000);
eq('individual · 10,00,000', I({ taxableProfit: 1000000 }), 80000);
eq('individual · 20,00,000', I({ taxableProfit: 2000000 }), 80000 + 1000000 * 0.30);
eq('individual · 50,00,000', I({ taxableProfit: 5000000 }), 380000 + 3000000 * 0.36);
eq('individual · 60,00,000', I({ taxableProfit: 6000000 }), 1460000 + 1000000 * 0.39);

section('Published presumptive table — three location tiers');
eq('presumptive · metro',        tax({ returnType: 'D1', location: 'metro',        turnover: 1000000 }), 7500);
eq('presumptive · municipality', tax({ returnType: 'D1', location: 'municipality', turnover: 1000000 }), 4000);
eq('presumptive · rural',        tax({ returnType: 'D1', location: 'rural',        turnover: 1000000 }), 2500);

// ════════════════════════════════════════════════════════════════
//  3.  STRUCTURE
// ════════════════════════════════════════════════════════════════

section('Structure — band boundaries are continuous');

// A rupee more of turnover must never cost more than a rupee more of tax at
// a band edge. A cliff here would mean a client is better off with LESS
// turnover, which is how a mis-stacked band shows itself.
for (const nature of ['goods', 'commission', 'service']) {
  for (const edge of [3000000, 5000000, 10000000]) {
    const lo = tax({ returnType: 'D2', d2Nature: nature, location: 'municipality', turnover: edge });
    const hi = tax({ returnType: 'D2', d2Nature: nature, location: 'municipality', turnover: edge + 1 });
    ok(`continuous · ${nature} at ${T.fmt(edge)} (${lo} → ${hi})`, hi >= lo && hi - lo <= 1);
  }
}
// And D-1 into D-2 at the 30-lakh handover: the presumptive charge is exactly
// the D-2 charge at the floor, which is what makes the base a base.
for (const loc of ['metro', 'municipality', 'rural']) {
  eq(`handover · D-1 = D-2 at 30 lakh · ${loc}`,
     tax({ returnType: 'D1', location: loc, turnover: 3000000 }),
     tax({ returnType: 'D2', d2Nature: 'goods', location: loc, turnover: 3000000 }));
}

section('Structure — the ladders');

for (const filing of ['couple', 'individual']) {
  for (const special of [false, true]) {
    let prev = -1, prevRate = -1;
    for (let inc = 0; inc <= 7000000; inc += 25000) {
      const t = tax({ returnType: 'D3', entity: 'proprietorship', filing, special, taxableProfit: inc });
      if (t < prev - 0.005) { fail++; console.log(`  FAIL  ${filing}/${special} not monotonic at ${inc}`); prev = t; continue; }
      prev = t;
    }
    pass++;
    // Marginal rate never falls as income rises.
    let bad = 0;
    for (let inc = 25000; inc <= 7000000; inc += 25000) {
      const a = tax({ returnType: 'D3', entity: 'proprietorship', filing, special, taxableProfit: inc });
      const b = tax({ returnType: 'D3', entity: 'proprietorship', filing, special, taxableProfit: inc - 25000 });
      const r = (a - b) / 25000;
      if (r < prevRate - 1e-9) bad++;
      prevRate = Math.max(prevRate, r);
    }
    ok(`${filing}${special ? '/special' : ''} · marginal rate never falls`, bad === 0);
  }
}

// Both ladders must close the 30% band at 20,00,000 and the 36% band at
// 50,00,000 — that is the only thing that ties them together, and the widths
// differ precisely so that it holds.
for (const filing of ['couple', 'individual']) {
  const cum = T.LADDERS[filing].bands.reduce((acc, b) => {
    acc.push((acc[acc.length - 1] || 0) + b.width); return acc;
  }, []);
  eq(`${filing} · 30% band closes at 20,00,000`, cum[3], 2000000);
  eq(`${filing} · 36% band closes at 50,00,000`, cum[4], 5000000);
}

// The special-industry concession replaces the 30% base rate with 20%; the
// two surcharged bands above it must scale by the same two thirds.
for (const filing of ['couple', 'individual']) {
  const b = T.LADDERS[filing].bands;
  for (const i of [3, 4, 5]) {
    eq(`${filing} · band ${i} special = 2/3 of normal`, b[i].special, b[i].normal * 2 / 3, 1e-9);
  }
  for (const i of [0, 1, 2]) {
    eq(`${filing} · band ${i} untouched by the concession`, b[i].special, b[i].normal, 1e-9);
  }
}

section('Structure — warnings fire where rule and figures disagree');

ok('D-1 above the 30-lakh ceiling warns',
   T.compute({ returnType: 'D1', location: 'metro', turnover: 3500000 }).warnings.length > 0);
ok('D-2 below the 30-lakh floor warns',
   T.compute({ returnType: 'D2', d2Nature: 'goods', location: 'metro', turnover: 2000000 }).warnings.length > 0);
ok('D-2 above the 1-crore ceiling warns',
   T.compute({ returnType: 'D2', d2Nature: 'goods', location: 'metro', turnover: 12000000 }).warnings.length > 0);
ok('D-2 above the 10-lakh income ceiling warns',
   T.compute({ returnType: 'D2', d2Nature: 'goods', location: 'metro', turnover: 6000000, taxableProfit: 1500000 })
    .warnings.some(w => /taxable income/.test(w)));
ok('D-2 service names the excluded professions',
   T.compute({ returnType: 'D2', d2Nature: 'service', location: 'metro', turnover: 6000000 })
    .warnings.some(w => /auditor/.test(w)));
ok('D-3 inside the turnover range notes the D-2 election',
   T.compute({ returnType: 'D3', entity: 'proprietorship', turnover: 6000000, taxableProfit: 900000 })
    .warnings.some(w => /elect turnover tax/.test(w)));
ok('a clean D-3 company raises nothing',
   T.compute({ returnType: 'D3', entity: 'private', turnover: 60000000, taxableProfit: 4000000 }).warnings.length === 0);

section('Structure — a loss is never taxed, and never negative');
for (const o of [
  { returnType: 'D3', entity: 'private',         taxableProfit: -500000 },
  { returnType: 'D3', entity: 'partnership',     taxableProfit: -500000 },
  { returnType: 'D3', entity: 'proprietorship',  taxableProfit: -500000 },
]) {
  eq(`loss · ${o.entity}`, tax(o), 0);
  ok(`loss · ${o.entity} warns`, T.compute(o).warnings.length > 0);
}

section("Structure — the client's stored return type resolves");
eq("'D-03' → D3", T.returnTypeFromClient('D-03') === 'D3', true);
eq("'D-02' → D2", T.returnTypeFromClient('D-02') === 'D2', true);
eq("'D-01' → D1", T.returnTypeFromClient('D-01') === 'D1', true);
// 'D1/D2' means "one of the two, the preparer decides" (CLAUDE.md §15) and
// must resolve to nothing rather than to a guess.
ok("'D1/D2' resolves to nothing", T.returnTypeFromClient('D1/D2') === null);
ok('an unset return type resolves to nothing', T.returnTypeFromClient(null) === null);

section('Auto return-type selection — the Act decides from the figures');

// The decision tree is statute, not heuristics: entity, then the 30-lakh
// presumptive ceiling, then the 1-crore / 10-lakh-income turnover-tax gate.
const auto = (entity, turnover, taxableProfit) => T.autoReturnType({ entity, turnover, taxableProfit });
ok('auto · company is always D3',                 auto('private', 2000000, 100000).returnType === 'D3');
ok('auto · partnership is always D3',             auto('partnership', 2000000, 100000).returnType === 'D3');
ok('auto · proprietor at 25 lakh → D1',           auto('proprietorship', 2500000, 200000).returnType === 'D1');
ok('auto · proprietor at exactly 30 lakh → D1',   auto('proprietorship', 3000000, 200000).returnType === 'D1');
ok('auto · proprietor at 30 lakh + 1 → D2',       auto('proprietorship', 3000001, 200000).returnType === 'D2');
ok('auto · proprietor at 80 lakh → D2',           auto('proprietorship', 8000000, 900000).returnType === 'D2');
ok('auto · proprietor at exactly 1 crore → D2',   auto('proprietorship', 10000000, 900000).returnType === 'D2');
ok('auto · proprietor at 1 crore + 1 → D3',       auto('proprietorship', 10000001, 900000).returnType === 'D3');
// The income gate: sec 4(4Ka) is barred above 10 lakh of taxable income,
// so a fat-margin firm inside the turnover range still files D-3.
ok('auto · 80 lakh turnover but 15 lakh income → D3', auto('proprietorship', 8000000, 1500000).returnType === 'D3');
ok('auto · every answer names its reason', ['private','proprietorship'].every(e => [1000000, 5000000, 20000000].every(t => !!auto(e, t, 500000).reason)));
// compute() with no returnType resolves through the same tree and says so.
const autoC = T.compute({ entity: 'proprietorship', location: 'municipality', turnover: 2550000, taxableProfit: 200000 });
ok("compute · unset returnType auto-resolves (25.5 lakh → D1, Rs 4,000)", autoC.returnType === 'D1' && autoC.tax === 4000 && !!autoC.auto);
const manC = T.compute({ returnType: 'D3', entity: 'proprietorship', turnover: 2550000, taxableProfit: 200000 });
ok('compute · an explicit choice is honoured, not auto-overridden', manC.returnType === 'D3' && manC.auto === null);

section('Structure — workings add back to the charge');
for (const o of [
  { returnType: 'D1', location: 'metro', turnover: 2000000 },
  { returnType: 'D2', d2Nature: 'goods',   location: 'rural', turnover: 7250000 },
  { returnType: 'D2', d2Nature: 'service', location: 'metro', turnover: 4400000 },
  { returnType: 'D3', entity: 'private', taxableProfit: 3300000 },
  { returnType: 'D3', entity: 'proprietorship', filing: 'couple',     taxableProfit: 4400000 },
  { returnType: 'D3', entity: 'proprietorship', filing: 'individual', taxableProfit: 4400000, special: true },
]) {
  const r = T.compute(o);
  const sum = r.workings.reduce((s, w) => s + w.amount, 0);
  eq(`workings foot · ${r.label}`, Math.round(sum), r.tax, 0.51);
}

console.log(`\n${fail === 0 ? 'OK' : 'FAILED'} — ${pass} passed, ${fail} failed.\n`);
process.exit(fail === 0 ? 0 : 1);
