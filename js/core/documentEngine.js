// ════════════════════════════════════════════
//  DOCUMENT ENGINE
//  One place that wraps Word generation (PizZip + docxtemplater), Word
//  preview (docx-preview), and Excel generation (ExcelJS) — proven first
//  against bmAgmMinutes.js and vatReturn.js, the two already-working
//  modules that used to each hand-roll this themselves. Any future
//  document-producing module (Financial Statements, Company Registration,
//  Audit Working Papers, ...) calls this instead of repeating it.
// ════════════════════════════════════════════
window.DocumentEngine = (function () {
  // `meta` ({ module, clientName }) is optional and purely for audit
  // logging — omit it and this behaves exactly as before. Not awaited: the
  // actual download must never wait on a network round-trip to Supabase,
  // and AuditLog.record() is itself already best-effort/non-throwing.
  function downloadBlob(blob, filename, meta) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    if (window.AuditLog && meta) {
      AuditLog.record('document_generated', Object.assign({ filename }, meta));
    }
  }

  // ── Word (PizZip + docxtemplater) ──
  // Template bytes never change at runtime — fetch once per URL, reuse the
  // ArrayBuffer for every render (a live preview re-renders far more often
  // than a document is actually downloaded).
  const wordTemplateCache = new Map(); // url -> Promise<ArrayBuffer>

  function getWordTemplate(url) {
    if (!wordTemplateCache.has(url)) {
      const promise = fetch(url).then(resp => {
        if (!resp.ok) throw new Error('Template file not found at ' + url);
        return resp.arrayBuffer();
      }).catch(err => { wordTemplateCache.delete(url); throw err; });
      wordTemplateCache.set(url, promise);
    }
    return wordTemplateCache.get(url);
  }

  // Fills `templateBuffer` with `data` and returns the resulting .docx as a
  // Blob. `templateBuffer.slice(0)` because PizZip/docxtemplater consume the
  // buffer, and the cached buffer above must stay reusable for later renders.
  function renderWord(templateBuffer, data) {
    const zip = new PizZip(templateBuffer.slice(0));
    const doc = new window.docxtemplater(zip, { delimiters: { start: '{{', end: '}}' }, paragraphLoop: true, linebreaks: true });
    doc.render(data);
    return doc.getZip().generate({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  }

  // Renders a .docx Blob into `container` as HTML via docx-preview — the
  // preview is never a second, independently-maintained representation of
  // the document that could drift from the real Word file; it IS the Word
  // file, just displayed as HTML.
  async function previewWordAsHtml(blob, container, styleEl, options) {
    const buffer = await blob.arrayBuffer();
    container.innerHTML = '';
    await window.docx.renderAsync(buffer, container, styleEl, options);
  }

  // ── Excel (ExcelJS) ──
  // Sheet layout (columns, formulas, merged cells) is business logic that
  // stays in each module — this only wraps the generic "workbook -> Blob"
  // step, the one piece every ExcelJS consumer needs identically. Right now
  // vatReturn.js is the only real consumer; a shared header/formula-block
  // helper is worth extracting once a second Excel-generating module exists
  // to validate the abstraction against, matching how renderWord() above was
  // only generalized after proving it against two real modules.
  async function workbookToBlob(workbook) {
    const buf = await workbook.xlsx.writeBuffer();
    return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  return { downloadBlob, getWordTemplate, renderWord, previewWordAsHtml, workbookToBlob };
})();
