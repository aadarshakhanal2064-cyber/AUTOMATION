// ════════════════════════════════════════════
//  Sample renderer. Fills the built template with realistic-but-FAKE data
//  and writes real .docx files, both for a human visual review in Word and
//  for wordPages.ps1 to measure real pagination against.
//
//  Committed 2026-08-21 (CLAUDE.md §12: "a committed harness beats an
//  uncommitted one" — the same rule that exists because Autobooks' harness
//  was referenced in comments but never committed, and the module was broken
//  for a month). Every value below is invented; nothing came off a client's
//  document, which is what separates this from sample-values.local.mjs.
//
//  Usage: node sampleBmAgm.mjs
//  Writes sample-full.docx and sample-single-shareholder.docx next to this file.
// ════════════════════════════════════════════
import { readFileSync, writeFileSync } from 'fs';
import PizZip from 'pizzip';
import Docxtemplater from 'docxtemplater';

const tplPath = '../../assets/templates/bm-agm-minutes.docx';

function render(name, overrides) {
  const base = {
    companyName: 'नमूना उद्योग प्रा. लि.',
    registrationNumber: '१२३४५६',
    registrationNumberSlash: '१२३४५६',
    companyNameShort: 'नमूना उद्योग प्रा. लि.',
    companyAddress: 'भरतपुर महानगरपालिका वडा नं. ५, चितवन',
    chairmanName: 'सूर्य प्रसाद पौडेल',
    auditorName: 'हरि प्रसाद रेग्मी',
    auditorAddress: 'चितवन',
    bmDate: '२०८२।०४।०१', agmDate: '२०८२।०४।०१',
    letterDate: '२०८२।०४।०५', boardChangeDate: '२०८२।०४।०३',
    fiscalYear: '२०८१।८२', nextFiscalYear: '२०८२।८३',
    authorizedCapital: '१०,००,०००', issuedCapital: '१०,००,०००', paidUpCapital: '१०,००,०००',
    directorTermYears: '४',
    boardChanged: false,
    bmHasExtra: false, bmExtraProposalTitle: '', bmExtraProposalDecision: '',
    bmMiscItemNum: '२', bmMiscDecisionNum: '२',
    agmHasExtra: false, agmExtraProposalTitle: '', agmExtraProposalDecision: '',
    agmExtraItemNum: '४', agmExtraDecisionNum: '४',
    agmMiscItemNum: '४', agmMiscDecisionNum: '४',
    ...overrides,
  };
  const doc = new Docxtemplater(new PizZip(readFileSync(tplPath)), {
    delimiters: { start: '{{', end: '}}' }, paragraphLoop: true, linebreaks: true,
  });
  doc.render(base);
  writeFileSync(name, doc.getZip().generate({ type: 'nodebuffer' }));
  console.log('wrote', name);
}

// Everything present: two shareholders, board reappointed this AGM, an
// extra proposal typed for both meetings — the "nothing hidden" case,
// closest to what the original always-on template used to print.
const secondShareholder = 'गीता देवी पौडेल';
render('sample-full.docx', {
  attendeeNamesJoined: 'सूर्य प्रसाद पौडेल, ' + secondShareholder,
  attendees: [
    { num: '१', name: 'सूर्य प्रसाद पौडेल', role: 'अध्यक्ष', isChairman: true },
    { num: '२', name: secondShareholder, role: 'संचालक', isChairman: false },
  ],
  boardChanged: true,
  bmHasExtra: true, bmExtraProposalTitle: 'नयाँ शाखा कार्यालय खोल्ने सम्बन्धमा', bmExtraProposalDecision: 'सर्वसम्मतिले पारित गरियो ।',
  bmMiscItemNum: '३', bmMiscDecisionNum: '३',
  agmHasExtra: true, agmExtraProposalTitle: 'लगानी बढाउने सम्बन्धमा', agmExtraProposalDecision: 'सर्वसम्मतिले पारित गरियो ।',
  agmExtraItemNum: '५', agmExtraDecisionNum: '५',
  agmMiscItemNum: '६', agmMiscDecisionNum: '६',
});

// Single shareholder, nothing extra: today's fix — no "Change of Board of
// Director" set, no tapsil items 5/6, no AGM item/decision 4, and विविध
// renumbers to take the vacated slot everywhere.
render('sample-single-shareholder.docx', {
  attendeeNamesJoined: 'सूर्य प्रसाद पौडेल',
  attendees: [
    { num: '१', name: 'सूर्य प्रसाद पौडेल', role: 'अध्यक्ष', isChairman: true },
  ],
  boardChanged: false,
  bmHasExtra: false, bmMiscItemNum: '२', bmMiscDecisionNum: '२',
  agmHasExtra: false, agmMiscItemNum: '४', agmMiscDecisionNum: '४',
});
