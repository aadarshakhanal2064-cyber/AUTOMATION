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

  // Gregorian -> B.S. Service Memo stores memo_date as a real Postgres `date`
  // while every ledger range is B.S., so the two have to meet somewhere; this
  // is that conversion. Accepts a Date or an ISO 'YYYY-MM-DD' string (parsed at
  // UTC midnight so the +5:45 shift inside todayBs lands on the same day).
  // Returns { year, month, day } or null outside the tabulated range.
  function adToBs(d) {
    const dt = (d instanceof Date) ? d : new Date(String(d || '').slice(0, 10) + 'T00:00:00Z');
    return isNaN(dt.getTime()) ? null : todayBs(dt);
  }
  // { year, month, day } -> the app's stored text form 'YYYY.MM.DD'.
  function bsToStr(bs) {
    return bs ? `${bs.year}.${String(bs.month).padStart(2, '0')}.${String(bs.day).padStart(2, '0')}` : '';
  }

  // ── B.S. date-string helpers for report date ranges ──
  // Extracted from bankBook.js (bbDateOrd / bbValidBsDate / bbFyFromDate /
  // bbTodayBsStr) once Party Ledger and Final Account needed the same four —
  // every module that filters records by a B.S. From/To range does this
  // identically, so the parsing lives here rather than in each of them.
  // All take/return the app's stored B.S. text form, 'YYYY.MM.DD'.

  // Day index for range compare / ordering; null if unparseable or outside the
  // 2080–2090 table, which callers must tolerate rather than treat as "before".
  function bsDateOrd(str) {
    const p = bsPartsNum(str);
    return p ? bsOrdinal(p) : null;
  }
  function isValidBsDate(str) { return bsPartsNum(str) != null; }
  // Fiscal year of a B.S. date in the dash format Bank Book / Service Memo use.
  function bsFyDash(str) {
    const p = bsPartsNum(str);
    return p ? bsFiscal(p).fy.replace('/', '-') : null;
  }
  // Today as 'YYYY.MM.DD', or '' once the calendar table runs out.
  function todayBsStr() { return bsToStr(todayBs()); }

  // Today's GREGORIAN date as 'YYYY-MM-DD' with the day boundary at Nepal
  // midnight. Ten call sites used new Date().toISOString().slice(0,10),
  // which flips to the new day 5 h 45 m late from Nepal's perspective — so
  // between 00:00 and 05:45 local, every date field seeded that way
  // defaulted to YESTERDAY (fixed Stage 3, 2026-08-21). Same shift todayBs()
  // has always applied for B.S. dates, now available for Gregorian ones.
  function todayISO() {
    return new Date(Date.now() + NEPAL_UTC_OFFSET_MS).toISOString().slice(0, 10);
  }

  // ── Nepali number words (Company Registration MOA/AOA, §5.11d) ──
  // The registrar documents write every figure twice — "रु ५०,००,०००।– (पचास
  // लाख रुपैंया मात्र)" — and the words in the firm's sources are typed by
  // hand, with real mistakes ("पाँच हजार" beside a 5-lakh figure). Deriving
  // them from the figure is what makes the two impossible to disagree.
  // Full 0–99 table because Nepali numerals are irregular below 100.
  const NEPALI_ONES = [
    '', 'एक', 'दुई', 'तीन', 'चार', 'पाँच', 'छ', 'सात', 'आठ', 'नौ', 'दश',
    'एघार', 'बाह्र', 'तेह्र', 'चौध', 'पन्ध्र', 'सोह्र', 'सत्र', 'अठार', 'उन्नाइस', 'बीस',
    'एक्काइस', 'बाइस', 'तेइस', 'चौबिस', 'पच्चिस', 'छब्बिस', 'सत्ताइस', 'अठ्ठाइस', 'उनन्तिस', 'तीस',
    'एकतिस', 'बत्तिस', 'तेत्तिस', 'चौतिस', 'पैंतिस', 'छत्तिस', 'सैतिस', 'अठतिस', 'उनन्चालीस', 'चालीस',
    'एकचालीस', 'बयालीस', 'त्रिचालीस', 'चवालीस', 'पैंतालीस', 'छयालीस', 'सतचालीस', 'अठचालीस', 'उनन्चास', 'पचास',
    'एकाउन्न', 'बाउन्न', 'त्रिपन्न', 'चवन्न', 'पचपन्न', 'छपन्न', 'सन्ताउन्न', 'अन्ठाउन्न', 'उनन्साठी', 'साठी',
    'एकसट्ठी', 'बयसट्ठी', 'त्रिसट्ठी', 'चौंसट्ठी', 'पैंसट्ठी', 'छयसट्ठी', 'सतसट्ठी', 'अठसट्ठी', 'उनन्सत्तरी', 'सत्तरी',
    'एकहत्तर', 'बहत्तर', 'त्रिहत्तर', 'चौहत्तर', 'पचहत्तर', 'छयहत्तर', 'सतहत्तर', 'अठहत्तर', 'उनासी', 'असी',
    'एकासी', 'बयासी', 'त्रियासी', 'चौरासी', 'पचासी', 'छयासी', 'सतासी', 'अठासी', 'उनान्नब्बे', 'नब्बे',
    'एकानब्बे', 'बयानब्बे', 'त्रियानब्बे', 'चौरानब्बे', 'पन्चानब्बे', 'छयानब्बे', 'सन्तानब्बे', 'अन्ठानब्बे', 'उनान्सय',
  ];
  // 5000000 -> "पचास लाख". Pure number words — the caller appends "रुपैंया
  // मात्र" for money and nothing for share counts, because the same figure
  // reads both ways in these documents. Empty string for 0/invalid, so a
  // blank field never renders as a word.
  function amountToWords(raw) {
    let n = Math.floor(Number(toEnglishDigits(String(raw)).replace(/[^0-9.]/g, '')));
    if (!isFinite(n) || n <= 0) return '';
    const parts = [];
    const step = (div, label) => {
      if (n >= div) { parts.push(amountToWords(Math.floor(n / div)) + ' ' + label); n %= div; }
    };
    step(1e11, 'खरब'); step(1e9, 'अरब'); step(1e7, 'करोड'); step(1e5, 'लाख'); step(1000, 'हजार'); step(100, 'सय');
    if (n > 0) parts.push(NEPALI_ONES[n]);
    return parts.join(' ');
  }

  // रोज — the weekday number the registrar's ईति सम्वत line carries
  // ("... गते रोज ०३"), आइतबार=१ … शनिबार=७. Anchored on 1 Baishakh 2080 =
  // 14 April 2023, a Friday (रोज ६); verified against the firm's own multi-
  // shareholder source, whose भदौ ०२ गते line says रोज ०३ and computes to 3.
  // Accepts the same date strings bsPartsNum does; null outside 2080–2090.
  function bsWeekday(str) {
    const ord = bsDateOrd(str);
    return ord == null ? null : ((ord + 5) % 7) + 1;
  }

  // "2078-79" -> { fy:"०७८/७९", next:"०७९/८०" }
  function fiscalParts(fyValue) {
    const m = String(fyValue || '').match(/(\d{4})\D+(\d{2})/);
    if (!m) return { fy: '', next: '' };
    const y1 = parseInt(m[1], 10);
    const fmt = a => String(a).slice(1) + '/' + String(a + 1).slice(-2);
    return { fy: toDevanagari(fmt(y1)), next: toDevanagari(fmt(y1 + 1)) };
  }

  // Start year of a fiscal year written in ANY of the firm's five formats
  // (2081-82 · 2081/82 · 2081/082 · 2081.2082 · 2081), Devanagari included.
  // Those formats differ per module BY DECISION (CLAUDE.md §8) — this is the
  // boundary normalizer that lets two modules be joined on fiscal year
  // without unifying how either one displays it. Work Done's Pending List
  // joins document_register (free text, dash) to work_done (dropdown, slash)
  // through this; comparing the raw strings would match nothing and fail
  // silently. Returns null when no 4-digit year is present, so callers can
  // report unmatchable rows rather than dropping them unnoticed.
  function fyStartYear(value) {
    const m = toEnglishDigits(String(value == null ? '' : value)).match(/(\d{4})/);
    return m ? parseInt(m[1], 10) : null;
  }

  // Last day of a B.S. month — 29, 30, 31 or 32 depending on the year.
  // The calendar table is the only thing that knows, which is why this lives
  // here rather than in the module that wanted it: VAT Register prints its
  // trimester periods as date spans ("2083.04.01 – 2083.07.30") and a
  // hardcoded 30 is wrong for exactly the months that make a VAT period
  // misstate itself. Note it is used for LABELS only there — a bill is
  // bucketed into a period by its month number, never by day arithmetic, so
  // a year outside the table degrades to a missing label, not a lost bill.
  // Returns null outside 2080–2090 (extend BS_MONTH_LENGTHS before 2090).
  function bsMonthEnd(year, month) {
    const t = BS_MONTH_LENGTHS[year];
    return (t && month >= 1 && month <= 12) ? t[month - 1] : null;
  }

  return { toEnglishDigits, toDevanagari, formatAmount, parseBsDate, fiscalParts, todayBs, bsFiscal, NEPALI_MONTHS,
           bsPartsNum, bsOrdinal, daysBetweenBs, fyStartBs, fyEndBs, daysInServiceThisFy, bsMonthEnd,
           bsDateOrd, isValidBsDate, bsFyDash, todayBsStr, todayISO, adToBs, bsToStr, fyStartYear,
           amountToWords, bsWeekday };
})();
