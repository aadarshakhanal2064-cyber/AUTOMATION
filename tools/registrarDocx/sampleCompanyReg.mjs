// ════════════════════════════════════════════
//  COMPANY REGISTRATION — sample renderer
//
//  Renders both built templates with realistic-but-FAKE data and writes real
//  .docx files, for a human visual check and for wordPages.ps1 to measure
//  real pagination against. Committed on purpose (CLAUDE.md §12) — every
//  value is invented; nothing here came off a client's document.
//
//  The data blocks below are also the CONTRACT for js/companyRegistration.js:
//  crBuildData() must produce exactly these keys.
//
//  Usage:
//    node sampleCompanyReg.mjs
//    powershell -File wordPages.ps1 sample-cr-single.docx=9 sample-cr-multi-2.docx=18 sample-cr-multi-5.docx=22
//
//  (Expected page counts MEASURED in Word on 2026-08-20, at the templates'
//  default line height — buildCompanyReg.mjs's footer holds the grid the
//  value was chosen from. A regression baseline, not a design target: the
//  MOA/AOA genuinely span sheets.)
// ════════════════════════════════════════════
import { readFileSync, writeFileSync } from 'fs';
import PizZip from 'pizzip';
import Docxtemplater from 'docxtemplater';

function render(tpl, name, data) {
  const doc = new Docxtemplater(new PizZip(readFileSync(`../../assets/templates/company-registration-${tpl}.docx`)), {
    delimiters: { start: '{{', end: '}}' }, paragraphLoop: true, linebreaks: true,
  });
  doc.render(data);
  writeFileSync(name, doc.getZip().generate({ type: 'nodebuffer' }));
  console.log('wrote', name);
}

const OBJECTIVES = [
  'विभिन्न प्रकारका खाद्यान्न, किराना तथा दैनिक उपभोग्य वस्तुहरुको थोक तथा खुद्रा व्यापार गर्ने ।',
  'स्वदेशी तथा विदेशी उत्पादनहरुको आयात, निर्यात, ढुवानी, भण्डारण तथा वितरण सम्बन्धी सम्पूर्ण कार्यहरु गर्ने गराउने ।',
  'कम्पनीको उद्देश्य प्राप्तिका लागि आवश्यक पर्ने मेसिनरी औजार तथा उपकरणहरु खरिद गरी वा भाडामा लिई प्रयोग गर्ने ।',
].map((text, i) => ({ letter: 'कखगघङचछजझञ'[i], text }));

const F = (name, address, father, cn, cnd, shares, wName, wAddress, wCn, wD) =>
  ({ name, address, fatherName: father, citizenshipNo: cn, citizenshipDistrict: cnd, shares,
     witnessName: wName, witnessAddress: wAddress, witnessCitizenshipNo: wCn, witnessDistrict: wD });

const FOUNDERS = [
  F('नमूना बहादुर श्रेष्ठ', 'भरतपुर महानगरपालिका वडा नं. १०, चितवन', 'हर्क बहादुर श्रेष्ठ', '१२३४५/६७८', 'चितवन', '२,५००',
    'सीता कुमारी पौडेल', 'भरतपुर महानगरपालिका वडा नं. ५, चितवन', '२३४५६', 'चितवन'),
  F('कमला देवी अधिकारी', 'रत्ननगर नगरपालिका वडा नं. ३, चितवन', 'टीका राम अधिकारी', '५४३२१/९८७', 'नवलपरासी', '२,५००',
    'राम प्रसाद गौतम', 'खैरहनी नगरपालिका वडा नं. २, चितवन', '३४५६७', 'चितवन'),
  F('गोपाल प्रसाद रेग्मी', 'कालिका नगरपालिका वडा नं. ६, चितवन', 'दुर्गा प्रसाद रेग्मी', '११२२३', 'तनहुँ', '१,०००',
    'हरि माया गुरुङ', 'भरतपुर महानगरपालिका वडा नं. १५, चितवन', '४५६७८', 'चितवन'),
  F('विष्णु कुमारी थापा मगर लामिछाने', 'माडी नगरपालिका वडा नं. १, चितवन', 'धन बहादुर थापा मगर', '९९८८७/५५४', 'चितवन', '१,०००',
    'लक्ष्मी प्रसाद देवकोटा शर्मा', 'रत्ननगर नगरपालिका वडा नं. १६, चितवन', '५६७८९', 'मकवानपुर'),
  F('टेक नारायण पौडेल क्षेत्री', 'भरतपुर महानगरपालिका वडा नं. २९, चितवन', 'खड्क बहादुर पौडेल क्षेत्री', '६६७७८', 'गोरखा', '१,०००',
    'शान्ति देवी वि.क.', 'खैरहनी नगरपालिका वडा नं. ७, चितवन', '६७८९०', 'चितवन'),
];

function pairs(founders) {
  const out = [];
  for (let i = 0; i < founders.length; i += 2) {
    out.push({
      numLeft: String(i + 1).replace(/\d/g, d => '०१२३४५६७८९'[d]),
      nameLeft: founders[i].name,
      hasRight: !!founders[i + 1],
      numRight: founders[i + 1] ? String(i + 2).replace(/\d/g, d => '०१२३४५६७८९'[d]) : '',
      nameRight: founders[i + 1] ? founders[i + 1].name : '',
    });
  }
  return out;
}

const COMMON = {
  companyName: 'नमूना व्यापार कम्पनी प्रा.लि.',
  companyNameFull: 'नमूना व्यापार कम्पनी प्राइभेट लिमिटेड',
  companyNameEnglish: 'Namuna Byapar Company Pvt. Ltd.',
  registeredAddress: 'चितवन जिल्ला भरतपुर महानगरपालिका वडा नं. १०',
  businessNature: 'व्यापार मूलक तथा सेवामूलक',
  objectives: OBJECTIVES,
  authorizedCapitalFig: '५,००,०००।–', authorizedCapitalWords: 'पाँच लाख रुपैयाँ',
  authorizedShares: '५,०००', authorizedSharesWords: 'पाँच हजार',
  issuedCapitalFig: '५,००,०००।–', issuedCapitalWords: 'पाँच लाख रुपैयाँ',
  issuedShares: '५,०००', issuedSharesWords: 'पाँच हजार',
  paidupCapitalFig: '५,००,०००।–', paidupCapitalWords: 'पाँच लाख रुपैयाँ',
  paidupShares: '५,०००', paidupSharesWords: 'पाँच हजार',
  docDateLong: '२०८३ साल भदौ महिना ०२ गते रोज ०३',
  docDateNum: '२०८३।०५।०२',
  letterDateNum: '२०८३।०५।०२',
  letterDateLong: '२०८३ साल भदौ महिना ०२ गते रोज ०३',
  advocateName: 'परीक्षा अधिकारी',
  advocateLicense: '९९९९९',
};

function multi(founders) {
  return {
    ...COMMON,
    directorCount: String(founders.length).replace(/\d/g, d => '०१२३४५६७८९'[d]),
    founderCount: String(founders.length).replace(/\d/g, d => '०१२३४५६७८९'[d]),
    founders,
    founderPairs: pairs(founders),
  };
}

render('multi', 'sample-cr-multi-2.docx', multi(FOUNDERS.slice(0, 2)));
render('multi', 'sample-cr-multi-5.docx', multi(FOUNDERS));

const f = FOUNDERS[0];
render('single', 'sample-cr-single.docx', {
  ...COMMON,
  companyName: 'नमूना ढुवानी सेवा प्रा.लि.',
  companyNameEnglish: 'Namuna Dhuwani Sewa Pvt. Ltd.',
  businessNature: 'उत्पादन तथा व्यापार मूलक',
  authorizedCapitalFig: '१,००,००,०००।–', authorizedCapitalWords: 'एक करोड रुपैयाँ', authorizedShares: '१,००,०००',
  issuedCapitalFig: '५०,००,०००।–', issuedCapitalWords: 'पचास लाख रुपैयाँ', issuedShares: '५०,०००',
  paidupCapitalFig: '५०,००,०००।–', paidupCapitalWords: 'पचास लाख रुपैयाँ',
  founderCount: '१',
  founderName: f.name, founderAddress: f.address, fatherName: f.fatherName,
  citizenshipNo: f.citizenshipNo, citizenshipDistrict: f.citizenshipDistrict, founderShares: '५०,०००',
  witnessName: f.witnessName, witnessAddress: f.witnessAddress,
  witnessCitizenshipNo: f.witnessCitizenshipNo, witnessDistrict: f.witnessDistrict,
});
