// ════════════════════════════════════════════
//  COMPANY SECRETARY APPOINTMENT — sample renderer
//
//  Renders the built template with realistic-but-FAKE data and writes real
//  .docx files, so the output can be opened in Word — both for a human
//  visual check and for wordPages.ps1 to measure real pagination against.
//
//  Committed on purpose (CLAUDE.md §12: "a committed harness beats an
//  uncommitted one"). Every value here is invented; nothing in this file
//  came off a client's document, which is what separates it from
//  sample-values-cs.local.mjs.
//
//  Usage:
//    node sampleCsAppoint.mjs
//    powershell -File wordPages.ps1 sample-cs.docx=2 sample-cs-five.docx=2
// ════════════════════════════════════════════
import { readFileSync, writeFileSync } from 'fs';
import PizZip from 'pizzip';
import Docxtemplater from 'docxtemplater';

const tplPath = '../../assets/templates/company-secretary-appointment.docx';

function render(name, overrides) {
  const base = {
    companyName: 'नमूना उद्योग प्रा. लि.',
    registrationNumber: '१२३४५६/०७९-०८०',
    chairmanName: 'सूर्य प्रसाद पौडेल',
    secretaryName: 'गीता देवी अधिकारी',
    secretaryAddress: 'भरतपुर महानगरपालिका वडा नं. ५, चितवन',
    citizenshipNo: '४५६७८९',
    meetingDate: '२०८२।०४।०१',
    meetingTime: 'बिहान १० बजे',
    appointmentDate: '२०८२।०४।०१',
    letterDate: '२०८२।०४।०५',
    attendees: [
      { name: 'सूर्य प्रसाद पौडेल', role: 'संचालक अध्यक्ष' },
      { name: 'रमेश कुमार श्रेष्ठ', role: 'संचालक सदस्य' },
    ],
    ...overrides,
  };
  const doc = new Docxtemplater(new PizZip(readFileSync(tplPath)), {
    delimiters: { start: '{{', end: '}}' }, paragraphLoop: true, linebreaks: true,
  });
  doc.render(base);
  writeFileSync(name, doc.getZip().generate({ type: 'nodebuffer' }));
  console.log('wrote', name);
}

// The ordinary case: a two-person board.
render('sample-cs.docx', {});

// The stress case — five directors AND deliberately long values everywhere,
// which is what proves the page break and the alignment columns hold rather
// than happening to fit the sample client's short names. Both must still
// come out at exactly 2 pages.
render('sample-cs-five.docx', {
  companyName: 'श्री हिमालय बहुउद्देश्यीय व्यापार तथा उद्योग प्रा. लि.',
  chairmanName: 'चन्द्र बहादुर विश्वकर्मा',
  secretaryName: 'सरस्वती कुमारी उपाध्याय',
  secretaryAddress: 'भरतपुर महानगरपालिका वडा नं. ११, चितवन, बागमती प्रदेश',
  attendees: [
    { name: 'चन्द्र बहादुर विश्वकर्मा', role: 'संचालक अध्यक्ष' },
    { name: 'रमेश कुमार श्रेष्ठ', role: 'संचालक सदस्य' },
    { name: 'सीता देवी पौडेल', role: 'संचालक सदस्य' },
    { name: 'हरि प्रसाद रेग्मी', role: 'संचालक सदस्य' },
    { name: 'बिनोद कुमार गुरुङ', role: 'संचालक सदस्य' },
  ],
});
