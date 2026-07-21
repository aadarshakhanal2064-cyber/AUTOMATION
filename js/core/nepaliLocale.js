// ════════════════════════════════════════════
//  NEPALI LOCALE
//  Digit conversion, B.S. (Bikram Sambat) date parsing, and fiscal-year
//  derivation — extracted from bmAgmMinutes.js (where it was originally
//  built and proven) so any future module needing Nepali dates/digits/
//  fiscal years (Income Tax Return, Financial Statements, Section 51, ...)
//  can call this directly instead of reaching into that module.
// ════════════════════════════════════════════
window.NepaliLocale = (function () {
  const DEVANAGARI_DIGITS = '०१२३४५६७८९';
  const NEPALI_MONTHS = ['बैशाख','जेठ','असार','साउन','भदौ','असोज','कार्तिक','मंसिर','पौष','माघ','फागुन','चैत'];

  function toEnglishDigits(s) {
    return String(s || '').replace(/[०-९]/g, d => String(DEVANAGARI_DIGITS.indexOf(d)));
  }

  function toDevanagari(s) {
    return String(s).replace(/[0-9]/g, d => DEVANAGARI_DIGITS[d]);
  }

  // "30,000,000.00" -> "३,००,००,०००" (Nepali lakh/crore grouping, Devanagari, no decimals)
  function formatAmount(raw) {
    let s = String(raw || '').split('.')[0].replace(/[^0-9]/g, '').replace(/^0+/, '');
    if (!s) return '';
    let last3 = s.slice(-3), rest = s.slice(0, -3), grouped = last3;
    while (rest.length) { grouped = rest.slice(-2) + ',' + grouped; rest = rest.slice(0, -2); }
    return toDevanagari(grouped);
  }

  // "2079/09/15" -> { year:२०७९, monthName:पौष, day:१५, full:२०७९/०९/१५ }
  function parseBsDate(str) {
    const parts = String(str || '').trim().split(/[\/\-.]/).map(x => x.trim()).filter(Boolean);
    if (parts.length < 3) return null;
    const [y, m, d] = parts;
    const mNum = parseInt(m, 10);
    if (!(mNum >= 1 && mNum <= 12)) return null;
    return {
      year: toDevanagari(y),
      monthName: NEPALI_MONTHS[mNum - 1],
      day: toDevanagari(String(parseInt(d, 10))),
      full: toDevanagari(y + '/' + String(m).padStart(2, '0') + '/' + String(d).padStart(2, '0')),
    };
  }

  // ── B.S. calendar (2080–2090) ──
  // Month lengths per B.S. year, anchored at 1 Baishakh 2080 = 14 April 2023.
  // Needed to know "today" in B.S. — the fiscal month the firm is currently
  // working in and VAT filing deadlines are both B.S. concepts that can't be
  // derived from the Gregorian Date object alone.
  const BS_ANCHOR_AD_UTC = Date.UTC(2023, 3, 14); // 1 Baishakh 2080
  const NEPAL_UTC_OFFSET_MS = 5.75 * 3600000;     // UTC+5:45 — day boundaries are Nepal-local
  const BS_MONTH_LENGTHS = {
    2080: [31,32,31,32,31,30,29,30,29,30,30,30],
    2081: [31,31,32,32,31,30,30,30,29,30,30,30],
    2082: [30,32,31,32,31,30,30,30,29,30,30,30],
    2083: [31,31,32,31,31,30,30,30,29,30,30,30],
    2084: [31,31,32,31,31,30,30,30,29,30,30,30],
    2085: [31,32,31,32,30,31,30,30,29,30,30,30],
    2086: [30,32,31,32,31,30,30,30,29,30,30,30],
    2087: [31,31,32,31,31,31,30,30,29,30,30,30],
    2088: [30,31,32,32,30,31,30,30,29,30,30,30],
    2089: [30,32,31,32,31,30,30,30,29,30,30,30],
    2090: [30,32,31,32,31,30,30,30,29,30,30,30],
  };

  // Today's date in B.S. — { year, month (1 = Baishakh), day } — or null once
  // the calendar table above runs out; callers must degrade gracefully.
  function todayBs(now) {
    let remaining = Math.floor(((now ? now.getTime() : Date.now()) + NEPAL_UTC_OFFSET_MS - BS_ANCHOR_AD_UTC) / 86400000);
    if (remaining < 0) return null;
    for (let year = 2080; BS_MONTH_LENGTHS[year]; year++) {
      for (let month = 1; month <= 12; month++) {
        const len = BS_MONTH_LENGTHS[year][month - 1];
        if (remaining < len) return { year, month, day: remaining + 1 };
        remaining -= len;
      }
    }
    return null;
  }

  // B.S. calendar date -> fiscal period. Fiscal years run Shrawan-Ashadh
  // (calendar months 4-3), so e.g. 2083/03/24 is fiscal year 2082/83, month 12.
  function bsFiscal(bs) {
    const startYear = bs.month >= 4 ? bs.year : bs.year - 1;
    return {
      fy: startYear + '/' + String((startYear + 1) % 100).padStart(2, '0'),
      monthIdx: bs.month >= 4 ? bs.month - 3 : bs.month + 9,
    };
  }

  // ── B.S. day-count helpers (SLM day-accurate depreciation, §5.8) ──
  // All reuse BS_MONTH_LENGTHS above, so they share its 2080–2090 range (extend
  // the table before 2090). These return NUMBERS, not Devanagari — they feed
  // arithmetic (days in service, remaining useful life), not display.
  function bsPartsNum(str) {
    const p = String(str || '').trim().split(/[\/\-.]/).map(x => parseInt(toEnglishDigits(x), 10));
    if (p.length < 3 || p.some(isNaN)) return null;
    const [year, month, day] = p;
    if (month < 1 || month > 12 || day < 1 || day > 32) return null;
    return { year, month, day };
  }
  // Day index since 1 Baishakh 2080 (0-based); null if the year isn't tabulated.
  function bsOrdinal(bs) {
    if (!bs || !BS_MONTH_LENGTHS[bs.year]) return null;
    let n = 0;
    for (let y = 2080; y < bs.year; y++) { const t = BS_MONTH_LENGTHS[y]; if (!t) return null; for (let i = 0; i < 12; i++) n += t[i]; }
    for (let m = 1; m < bs.month; m++) n += BS_MONTH_LENGTHS[bs.year][m - 1];
    return n + (bs.day - 1);
  }
  // Inclusive day count from a→b (both {year,month,day}); null if out of range.
  function daysBetweenBs(a, b) { const oa = bsOrdinal(a), ob = bsOrdinal(b); return (oa == null || ob == null) ? null : (ob - oa + 1); }
  // Fiscal year runs 1 Shrawan (month 4) startYear → last day Ashadh (month 3) startYear+1.
  function fyStartBs(startYear) { return { year: startYear, month: 4, day: 1 }; }
  function fyEndBs(startYear) { const t = BS_MONTH_LENGTHS[startYear + 1]; return t ? { year: startYear + 1, month: 3, day: t[2] } : null; }
  // Days an asset was in service within fiscal year `startYear`. A whole-year
  // asset returns 365 (the firm's template basis); a mid-year acquisition or
  // disposal returns the actual inclusive B.S. day count. `dateOfUse`/`disposal`
  // are B.S. strings ("2081/09/15") or null. Falls back to 365 if uncomputable.
  function daysInServiceThisFy(dateOfUse, startYear, disposal) {
    const s0 = fyStartBs(startYear), e0 = fyEndBs(startYear);
    const use = dateOfUse ? bsPartsNum(dateOfUse) : null;
    const disp = disposal ? bsPartsNum(disposal) : null;
    const oS0 = bsOrdinal(s0), oE0 = e0 ? bsOrdinal(e0) : null;
    const oUse = use ? bsOrdinal(use) : null;
    const oDisp = disp ? bsOrdinal(disp) : null;
    const startsMid = oUse != null && oS0 != null && oUse > oS0;
    const endsMid = oDisp != null && oE0 != null && oDisp < oE0;
    if (!startsMid && !endsMid) return 365;
    const start = startsMid ? use : s0;
    const end = endsMid ? disp : e0;
    const d = end ? daysBetweenBs(start, end) : null;
    return (d == null || d < 0) ? 365 : d;
  }

  // "2078-79" -> { fy:"०७८/७९", next:"०७९/८०" }
  function fiscalParts(fyValue) {
    const m = String(fyValue || '').match(/(\d{4})\D+(\d{2})/);
    if (!m) return { fy: '', next: '' };
    const y1 = parseInt(m[1], 10);
    const fmt = a => String(a).slice(1) + '/' + String(a + 1).slice(-2);
    return { fy: toDevanagari(fmt(y1)), next: toDevanagari(fmt(y1 + 1)) };
  }

  return { toEnglishDigits, toDevanagari, formatAmount, parseBsDate, fiscalParts, todayBs, bsFiscal, NEPALI_MONTHS,
           bsPartsNum, bsOrdinal, daysBetweenBs, fyStartBs, fyEndBs, daysInServiceThisFy };
})();
