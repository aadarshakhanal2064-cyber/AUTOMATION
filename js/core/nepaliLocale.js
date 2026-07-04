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

  // "2078-79" -> { fy:"०७८/७९", next:"०७९/८०" }
  function fiscalParts(fyValue) {
    const m = String(fyValue || '').match(/(\d{4})\D+(\d{2})/);
    if (!m) return { fy: '', next: '' };
    const y1 = parseInt(m[1], 10);
    const fmt = a => String(a).slice(1) + '/' + String(a + 1).slice(-2);
    return { fy: toDevanagari(fmt(y1)), next: toDevanagari(fmt(y1 + 1)) };
  }

  return { toEnglishDigits, toDevanagari, formatAmount, parseBsDate, fiscalParts, NEPALI_MONTHS };
})();
