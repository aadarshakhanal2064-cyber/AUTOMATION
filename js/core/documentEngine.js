// ════════════════════════════════════════════
//  DOCUMENT ENGINE
//  One place that wraps Word generation (PizZip + docxtemplater) and Word
//  preview (docx-preview) — proven against the already-working modules
//  that used to each hand-roll this themselves. Any future
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

  // ── Template fetching (any format — .docx, .xlsx, ...) ──
  // Template bytes never change at runtime — fetch once per URL, reuse the
  // ArrayBuffer for every render (a live preview re-renders far more often
  // than a document is actually downloaded).
  const templateCache = new Map(); // url -> Promise<ArrayBuffer>

  function getTemplate(url) {
    if (!templateCache.has(url)) {
      const promise = fetch(url).then(resp => {
        if (!resp.ok) throw new Error('Template file not found at ' + url);
        return resp.arrayBuffer();
      }).catch(err => { templateCache.delete(url); throw err; });
      templateCache.set(url, promise);
    }
    return templateCache.get(url);
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

  return { downloadBlob, getTemplate, renderWord, previewWordAsHtml };
})();
