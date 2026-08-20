// ════════════════════════════════════════════
//  COMPANY REGISTRATION — decode corrections for the two source documents
//
//  Word-level fixes for Preeti-decode ambiguities and the sources' own
//  typos, applied to the decoded text BEFORE tokenisation. Every pair was
//  verified against a correctly-spelled occurrence of the same word
//  ELSEWHERE IN THIS SAME CORPUS (both sources decoded together) — e.g.
//  कम्फनी appears 3 times against 296 correct कम्पनी.
//
//  This list deliberately does NOT import the shared BM/AGM CORRECTIONS:
//  that list was verified against a different document, and at least one of
//  its entries would corrupt THIS one — its 'वारे'→'बारे' rule matches
//  inside "वारेस" (power of attorney), which appears 4 times here and is
//  spelled correctly. A correction list is only safe against the corpus it
//  was checked on.
// ════════════════════════════════════════════

export const CR_CORRECTIONS = [
  // The ो vowel sign keyed as two glyphs (ा + े) — same class the Company
  // Secretary source had; the single-man source carries it in कम्पनीकाे.
  ['ाे', 'ो'],

  // फ-for-प decode errors (Preeti 'k'-family ambiguity), each verified
  // against the correct spelling elsewhere in the corpus.
  ['कम्फनी', 'कम्पनी'],
  ['हुनुफर्नेछ', 'हुनुपर्नेछ'],
  ['उफनियम', 'उपनियम'],
  [' फद ', ' पद '],
  ['लेखाफरीक्षक', 'लेखापरीक्षक'],
  ['फरीक्षण', 'परीक्षण'],
  ['फरीक्षक', 'परीक्षक'],
  ['सम्फूर्ण', 'सम्पूर्ण'],

  // त्त/क्त and other single-occurrence slips, verified the same way.
  ['वित्री', 'विक्री'],
  ['नियुत्ति', 'नियुक्ति'],
  ['नियुत्त ', 'नियुक्त '],
  ['विववण', 'विवरण'],
  ['व्यत्ति', 'व्यक्ति'],
  ['उल्ल्खे', 'उल्लेख'],
  ['निमायवली', 'नियमावली'],
  ['अर्न्तरगत', 'अन्तर्गत'],
  ['शेयरधनीलेशेयर', 'शेयरधनीले शेयर'],
  ['लागू हने', 'लागू हुने'],
  ['व्यवस्थ थप', 'व्यवस्था थप'],

  // Source typos in the shared application letter (both variants carry the
  // identical letter text).
  ['कागजाहरु', 'कागजातहरु'],
  ['हुंदा', 'हुँदा'],
  ['गरी पाँउ', 'गरी पाऊँ'],
  ['यस प्र.लि तर्फबाट', 'यस प्रा.लि. तर्फबाट'],
  ['।साथै', '। साथै'],
  ['अग्रेजीमा', 'अंग्रेजीमा'],
];
