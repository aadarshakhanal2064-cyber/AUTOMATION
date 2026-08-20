// ════════════════════════════════════════════════════════════════════════
//  PROVISIONAL STATEMENT — RECONCILIATION  (`psrec`)
//
//  A statement set that says "difference: 27,65,951.95" and stops is not much
//  better than no check at all — the preparer still has to go and find it.
//  Every check here therefore returns a WHERE as well as a WHAT: which
//  section moved, which note disagrees with its face figure, which party is
//  out, which month the register and the statement part company.
//
//  Two rules carried from the rest of this codebase (CLAUDE.md §15):
//
//    · A residual is SHOWN, never forced. Final Account's Net Difference and
//      Financial Statement's three proof rows follow the same rule — a
//      non-zero figure is a finding about the inputs, not a rendering bug.
//    · Anything needing accounting judgement is FLAGGED for CA review rather
//      than resolved automatically. The engine can say two figures disagree;
//      it cannot say which one is right.
//
//  Node-loadable, so tools/psVerify.mjs can assert every identity.
// ════════════════════════════════════════════════════════════════════════

const ProvisionalReconcile = (() => {

  const TOL = 0.5;                       // rupees; below this is float dust
  const n = v => (isFinite(Number(v)) ? Number(v) : 0);
  const abs = v => Math.abs(n(v));
  const fmt = v => n(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // One check's result. `level` is 'ok' | 'warn' | 'review':
  //   warn   — the arithmetic disagrees and the engine can name where
  //   review — needs a person; the engine deliberately does not choose
  const mk = (id, label, diff, opts) => Object.assign({
    id, label,
    diff: n(diff),
    ok: abs(diff) < TOL,
    level: abs(diff) < TOL ? 'ok' : (opts && opts.review ? 'review' : 'warn'),
    where: [],
  }, opts || {});

  // ════════════════════════════════════════════════════════════════
  //  run(result, context) → { checks, failing, reviewing }
  //  `result`  is ProvisionalStatementEngine.derive() output
  //  `context` carries what the engine cannot see: the prior year, the
  //            register the figures could be checked against, the schedules
  // ════════════════════════════════════════════════════════════════
  function run(result, context) {
    const r = result || {};
    const ctx = context || {};
    const bal = r.balance || {};
    const inc = r.income || {};
    const cf = r.cashflow || {};
    const checks = [];

    // ── 1. Assets = Equity + Liabilities ──
    // With the receivables plug on this is nil by construction, so a gap here
    // means the plug is off and something genuinely does not add up.
    const bs = mk('balance', 'Assets = Equity + Liabilities', bal.balanceGap);
    if (!bs.ok) {
      bs.where.push(`Total assets ${fmt(bal.totalAssets)} against equity and liabilities ${fmt(bal.totalEquityLiab)}.`);
      bs.where.push(bal.plugReceivables
        ? 'Trade Receivables is absorbing the balance, so a gap here should be impossible — check the figures feeding it.'
        : 'The receivables plug is off, so the difference is being reported rather than absorbed. Turn it on, or find the missing figure.');
      const parts = [
        ['Non-current assets', bal.totalNCA], ['Current assets', bal.totalCA],
        ['Equity', bal.totalEquity], ['Non-current liabilities', bal.totalNCL],
        ['Current liabilities', bal.totalCL],
      ];
      bs.where.push('Sections: ' + parts.map(([k, v]) => `${k} ${fmt(v)}`).join(' · '));
    }
    checks.push(bs);

    // ── 2. Opening cash + movement = closing cash ──
    const cash = mk('cash', 'Opening cash + net movement = closing cash', cf.cashProof);
    if (!cash.ok) {
      cash.where.push(`Cash flow closes at ${fmt(cf.closingCash)} against ${fmt(bal.cash)} on the balance sheet.`);
      cash.where.push(`Operating ${fmt(cf.netOperating)} · investing ${fmt(cf.netInvesting)} · financing ${fmt(cf.netFinancing)} = movement ${fmt(cf.netIncrease)}, on opening ${fmt(cf.openingCash)}.`);
      const drivers = [
        ['receivables', cf.dRecv], ['inventories', cf.dStock], ['payables', cf.dPay],
        ['borrowings', n(cf.ncBorrowMove) + n(cf.cBorrowMove)],
      ].sort((a, b) => abs(b[1]) - abs(a[1]));
      cash.where.push('Largest working-capital movements: ' + drivers.slice(0, 3).map(([k, v]) => `${k} ${fmt(v)}`).join(' · '));
    }
    checks.push(cash);

    // ── 3. Each note foots to its face figure ──
    const noteChecks = [
      ['recv', 'Note 3.3 total = Trade & Other Receivables on the face',
        (bal.receivableLines || []).reduce((s, l) => s + n(l.amount) * (/impair/i.test(l.key || '') ? -1 : 1), 0), bal.receivables],
      ['pay', 'Note 3.9 total = Trade & Other Payables on the face',
        (bal.payableLines || []).reduce((s, l) => s + n(l.amount), 0), bal.totalPayables],
      ['ppe', 'Note 3.1 carrying amount = PPE on the face',
        ((r.ppe && r.ppe.totals) || {}).closeCarrying, bal.ppe],
      ['stock', 'Closing stock schedule = Inventories on the face',
        (r.stock && r.stock.fromSchedule) ? r.stock.total : bal.inventories, bal.inventories],
    ];
    for (const [id, label, noteTotal, face] of noteChecks) {
      const c = mk('note-' + id, label, n(noteTotal) - n(face));
      if (!c.ok) c.where.push(`The note adds to ${fmt(noteTotal)} but the statement shows ${fmt(face)}.`);
      checks.push(c);
    }

    // ── 4. Net profit reaches equity ──
    const so = r.soce || {};
    const equityMove = n(so.close) - n(so.open);
    const expected = n(inc.netProfit) - n(so.dividend);
    const eq = mk('equity', 'Net profit − distribution = movement in retained earnings', equityMove - expected);
    if (!eq.ok) {
      eq.where.push(`Retained earnings moved ${fmt(equityMove)}; profit ${fmt(inc.netProfit)} less distribution ${fmt(so.dividend)} is ${fmt(expected)}.`);
      eq.where.push('Capital introduced is a separate line and should not appear in this movement.');
    }
    checks.push(eq);

    // ── 5. The COI bridge ──
    const coi = r.coi || {};
    if (coi.active) {
      const bridge = n(coi.pbt) + n(coi.accountingDep) - n(coi.itDep) - n(coi.bfLoss);
      const c = mk('coi', 'Computation of Income foots to taxable income', bridge - n(coi.taxableProfit));
      if (!c.ok) c.where.push(`Bridge computes ${fmt(bridge)} against a taxable income of ${fmt(coi.taxableProfit)}.`);
      checks.push(c);

      if (!n(coi.itDep)) {
        const j = mk('coi-nodep', 'Income-Tax depreciation is nil while the COI is on', 0, { review: true });
        j.level = 'review';
        j.ok = false;
        j.where.push('The bridge adds back accounting depreciation and deducts nothing, which overstates taxable income. Confirm the client has an Income-Tax depreciation schedule for this year.');
        checks.push(j);
      }
    }

    // ── 6. Register vs statement ──
    // The register is the client's own record of what it bought and sold. If
    // the statement disagrees with it, one of them is wrong — and which is a
    // judgement, so this is flagged rather than resolved.
    const reg = ctx.register;
    if (reg) {
      const rev = mk('reg-revenue', 'Revenue = sales register', n(inc.revenueOps) - n(reg.revenue.value), { review: true });
      if (!rev.ok) {
        rev.where.push(`Statement ${fmt(inc.revenueOps)} against register ${fmt(reg.revenue.value)} (${reg.revenue.detail}).`);
        rev.where.push('Neither figure is automatically right — a provisional set may deliberately differ from the filed register. Confirm which is intended.');
      }
      checks.push(rev);

      const pur = mk('reg-purchases', 'Purchases = purchase register', n(inc.materials && inc.materials.purchases) - n(reg.purchases.value), { review: true });
      if (!pur.ok) {
        pur.where.push(`Statement ${fmt(inc.materials && inc.materials.purchases)} against register ${fmt(reg.purchases.value)} (${reg.purchases.detail}).`);
        pur.where.push('Purchases is the balancing figure when a profit target is held, so a gap here is expected if you typed a profit — check that was intended.');
      }
      checks.push(pur);

      // Party detail against the face figures.
      const partySide = (key, face, label) => {
        const list = Object.values((reg.parties || {})[key] || {});
        const total = list.reduce((s, p) => s + n(p.amount), 0);
        const c = mk('party-' + key, label, total - n(face), { review: true });
        if (!c.ok) {
          c.where.push(`Party detail totals ${fmt(total)} across ${list.length} parties; the statement shows ${fmt(face)}.`);
          const big = list.slice().sort((a, b) => abs(b.amount) - abs(a.amount)).slice(0, 3);
          if (big.length) c.where.push('Largest parties: ' + big.map(p => `${p.name || p.pan || '—'} ${fmt(p.amount)}`).join(' · '));
        }
        return c;
      };
      checks.push(partySide('purchase', inc.materials && inc.materials.purchases, 'Creditor detail = Purchases'));
      checks.push(partySide('sales', inc.revenueOps, 'Debtor detail = Revenue'));
    }

    // ── 7. Openings continue last year's closings ──
    const py = ctx.priorYear;
    if (py && py.sfp) {
      const opens = [
        ['Opening stock', (inc.materials || {}).opening, py.materials && py.materials.closing != null ? py.materials.closing : py.sfp.inventories],
        ['Opening retained earnings', so.open, py.sfp.reserves],
        ['Opening cash', cf.openingCash, py.sfp.cash],
      ];
      for (const [label, thisOpen, lastClose] of opens) {
        const c = mk('open-' + label.replace(/\s+/g, '-').toLowerCase(), `${label} = last year's closing`, n(thisOpen) - n(lastClose));
        if (!c.ok) c.where.push(`Opens at ${fmt(thisOpen)}; last year closed at ${fmt(lastClose)}.`);
        checks.push(c);
      }
    }

    const failing = checks.filter(c => !c.ok && c.level === 'warn');
    const reviewing = checks.filter(c => !c.ok && c.level === 'review');
    return {
      checks,
      failing,
      reviewing,
      allOk: !failing.length && !reviewing.length,
      summary: `${checks.filter(c => c.ok).length} of ${checks.length} reconciled`
        + (failing.length ? `, ${failing.length} not balancing` : '')
        + (reviewing.length ? `, ${reviewing.length} for review` : ''),
    };
  }

  return { run, TOL };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = ProvisionalReconcile;
else window.ProvisionalReconcile = ProvisionalReconcile;
