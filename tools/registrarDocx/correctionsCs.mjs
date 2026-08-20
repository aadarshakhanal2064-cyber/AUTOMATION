// ════════════════════════════════════════════
//  COMPANY SECRETARY APPOINTMENT — decode corrections
//
//  Applied on top of the shared CORRECTIONS (corrections.mjs) for artefacts
//  specific to THIS source document. Two kinds, in this order:
//
//   1. NORMALISATIONS — mechanical, whole-corpus character-sequence repairs.
//      This source was typed with the vowel sign ो keyed as ा + े, which
//      Preeti stores as two glyphs and the decoder faithfully reproduces as
//      two Unicode marks. `ाे` is not a legal Devanagari sequence (a
//      consonant takes exactly one vowel sign), so collapsing it is safe
//      everywhere rather than word by word — it appears in 15 different
//      words here, and listing each would guarantee missing the sixteenth
//      the next time this document is re-typed.
//
//   2. WORD FIXES — the reph (र्) and short-i (ि) reorderings that Preeti's
//      visual encoding cannot express positionally, plus this document's own
//      typos. Each was confirmed against a correctly-decoded occurrence of
//      the same word elsewhere in the same document, or against standard
//      Nepali legal spelling.
// ════════════════════════════════════════════

export const CS_CORRECTIONS = [
  // ── 1. normalisations (must come first: the word fixes below are written
  //       against already-normalised text) ──
  ['ाे', 'ो'],
  ['ाै', 'ौ'],

  // ── 2. reph reorderings (र् typed after the syllable it precedes) ──
  // longest first, so a shorter pattern can't partially match inside a
  // word a longer one already fixes completely
  ['निण्र्ाय', 'निर्णय'],
  ['कायर्ालय', 'कार्यालय'],
  ['कायार्लय', 'कार्यालय'],
  ['उपयर्ुक्त', 'उपर्युक्त'],
  ['बोधाथर्', 'बोधार्थ'],
  ['गनर् ु', 'गर्नु'],
  ['गनर्ु', 'गर्नु'],

  // ── short-i reorderings (ि typed after its consonant instead of before) ──
  ['पािरत', 'पारित'],
  ['नागिरकता', 'नागरिकता'],
  ['िवषय', 'विषय'],

  // ── stray latin "m" left by the decoder ──
  // "m" is the Preeti key for a half-form ligature (क्त / फ्). In four
  // places the decoder cannot resolve it from the surrounding bytes and
  // emits the raw key instead. Each is listed explicitly rather than fixed
  // by a blanket "delete every m", because the correct expansion differs
  // per word and a blanket rule would silently delete a real one somewhere
  // else. None of the four is a word on its own, so each match is
  // unambiguous.
  ['आपmनो', 'आफ्नो'],
  ['सचिवmको', 'सचिवको'],
  ['दफmा', 'दफा'],
  ['चुत्ता', 'चुक्ता'],

  // ── this source's own typos ──
  ['रजिष्ट्रर्ड', 'रजिष्टर्ड'],
  ['नियुुक्ति', 'नियुक्ति'],       // doubled ु
  ['प्रचलीत', 'प्रचलित'],
  ['कम्पनी एनेको', 'कम्पनी ऐनको'],
  ['सर्वसम्मतले', 'सर्वसम्मतिले'],
  ['तपाई', 'तपाईं'],
  ['मिती', 'मिति'],
  ['अध्यक्षज्यु को', 'अध्यक्षज्यूको'],
  ['ज्यु', 'ज्यू'],

  // The two decision headings disagree with each other in the source —
  // "निर्णय नं १" and "निर्णय नं। २" (a danda where the first has nothing).
  // Neither is the firm's usual form, which is a full stop.
  ['निर्णय नं।', 'निर्णय नं.'],
  ['निर्णय नं १', 'निर्णय नं. १'],
];
