// ── EngineMath — numeric helpers shared by the financial engines ──
// Small, pure, and deliberately free of any business meaning, so both
// projectionEngine.js and finStatementEngine.js can depend on it without
// depending on each other.
//
// No DOM: stays loadable in Node for engine verification.

const EngineMath = (() => {

  // Deterministic PRNG keyed by a string (xorshift over an FNV-style hash).
  //
  // Several figures in the firm's workbooks are specified as "unique on each
  // case" — cash, and the projection's seeded creditors. Random would make a
  // re-run of the same client produce a different statement, so the key is
  // built from client identity (PAN + company + FY): unique across clients,
  // reproducible for one.
  function seededRng(key) {
    const s = String(key);
    let h = 1779033703 ^ s.length;
    for (let i = 0; i < s.length; i++) {
      h = Math.imul(h ^ s.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    return function () {
      h = Math.imul(h ^ (h >>> 16), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      return ((h ^= h >>> 16) >>> 0) / 4294967296;
    };
  }

  const round1000Up   = (v) => Math.ceil(v / 1000) * 1000;
  const round1000Down = (v) => Math.floor(v / 1000) * 1000;

  // A seeded figure landing on an exact thousand reads as a round number
  // somebody typed rather than a real balance, so nudge it off.
  const deRound = (v) => (v % 1000 === 0 ? v + 137 : v);

  return { seededRng, round1000Up, round1000Down, deRound };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = EngineMath;
else window.EngineMath = EngineMath;
