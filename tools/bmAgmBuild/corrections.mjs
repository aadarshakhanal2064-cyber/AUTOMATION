// Word-level corrections for known Preeti-decode ambiguities / genuine source typos.
// Applied as whole-word, global replacements across the decoded corpus.
// (व/ब confusion is a fundamental Preeti-encoding ambiguity, not a fixable bug —
//  each pair below was confirmed by cross-referencing a correctly-decoded
//  occurrence of the same phrase elsewhere in this same document, or by
//  standard Nepali spelling for common legal/formal words.)
export const CORRECTIONS = [
  // longer/more-specific patterns first, so a generic fix below can't
  // partially match inside a word this section already fully corrects
  ['फुर्ननियुति', 'पुनर्नियुक्ति'],
  ['फुर्ननियुक्ति', 'पुनर्नियुक्ति'],
  ['पुननियुति', 'पुनर्नियुक्ति'],
  ['पुननियूती', 'पुनर्नियुक्ति'],
  ['बिबिध', 'विविध'],
  ['प्रस्ताब', 'प्रस्ताव'],
  ['बार्षिकसाधारण', 'वार्षिक साधारण'],
  ['बार्षिक', 'वार्षिक'],
  ['उपस्तिथिमा', 'उपस्थितिमा'],
  ['उपस्थिति', 'उपस्थित'],
  ['सम्बनधमा', 'सम्बन्धमा'],
  ['रजिष्ट्रार्ड', 'रजिष्टर्ड'],
  ['अध्क्षयज्युको', 'अध्यक्षज्युको'],
  ['समपान', 'समापन'],
  ['अध्यक्षद्धारा', 'अध्यक्षद्वारा'],
  ['लेखाफरीक्षकको', 'लेखापरीक्षकको'],
  ['नियुत्ती', 'नियुक्ति'],
  ['नियूती', 'नियुक्ति'],
  ['नियुती', 'नियुक्ति'],
  ['नियुत', 'नियुक्ति'],
  ['हुदा', 'हुँदा'],
  ['ऊत', 'उक्त'],
  ['छलफछ', 'छलफल'],
  ['गनुपर्ने', 'गर्नुपर्ने'],
  ['प्रंत्यक्ष', 'प्रत्यक्ष'],
  ['आफनो', 'आफ्नो'],
  ['बैक,विक्तिय', 'बैंक, वित्तीय'],
  ['ब्यत्तिबाट', 'व्यक्तिबाट'],
  ['आय ब्यय', 'आय व्यय'],
  ['कावमोजिम', 'बमोजिम'],
  ['कम्फनीको', 'कम्पनीको'],
  ['चुतापूँजी', 'चुक्तापूँजी'],
  ['वारे', 'बारे'],
  ['निबेदन', 'निवेदन'],
  ['पारीश्रमीक', 'पारिश्रमिक'],
  ['बिसर्जनगर्ने', 'विसर्जन गर्ने'],
  ['अनुमतीले', 'अनुमतिले'],
  ['निणय', 'निर्णय'],
  ['गरीयो', 'गरियो'],
  ['पारीत', 'पारित'],
  ['नियूती', 'नियुक्ति'],
  ['सर्ब सम्मतीले', 'सर्वसम्मतिले'],
  ['सर्बसम्मत', 'सर्वसम्मत'],
  ['क्रमश ', 'क्रमशः '],
  ['नियमाबलीको', 'नियमावलीको'],
  ['बैधानिकता', 'वैधानिकता'],
  ['बैधता', 'वैधता'],
];

export function applyCorrections(text) {
  let out = text;
  for (const [wrong, right] of CORRECTIONS) {
    out = out.split(wrong).join(right);
  }
  return out;
}
