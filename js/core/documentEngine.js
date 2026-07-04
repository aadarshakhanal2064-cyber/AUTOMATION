// ════════════════════════════════════════════
//  DOCUMENT ENGINE
//  Started here with just downloadBlob() — promoted out of bmAgmMinutes.js,
//  where vatReturn.js was already reaching across module boundaries to use
//  it. Word/Excel/PDF generation (docxtemplater, ExcelJS) move in here in a
//  later phase; this file is that engine's real home, built incrementally.
// ════════════════════════════════════════════
window.DocumentEngine = (function () {
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return { downloadBlob };
})();
