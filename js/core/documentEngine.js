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

  // ── Fitting rendered pages onto real sheets ──
  // Fits each rendered page-section onto exactly one sheet. Sections are the
  // page breaks the template itself carries, so a document's header always
  // tops its own sheet and its signature block stays with it.
  //
  // A section that runs taller than the sheet has its FONT SIZES genuinely
  // reduced (every inline font-size/min-height/line-height the docx renderer
  // emitted, scaled from stashed originals) until it fits — a real layout
  // change, deliberately NOT a visual trick:
  //   * CSS zoom paginates print from the PRE-zoom layout box, producing a
  //     phantom blank page.
  //   * transform:scale is skipped outright by Chrome's print engine — the
  //     content is clipped at the paper edge at unscaled size.
  // Font scaling is the one approach where screen and print cannot disagree,
  // because the laid-out geometry IS the shrunk geometry. The section box is
  // then locked to the sheet's exact pixel size with overflow:hidden as the
  // final guarantee that no page can ever spill.
  //
  // Shared by every module's live preview and print window so both paginate
  // identically. `className` is the class docx-preview was told to put on
  // each section (see previewWordAsHtml's options.className).
  //
  // `opts.flow` opts a document OUT of one-sheet fitting: each section keeps
  // scale 1 and grows to its natural height instead. Fitting is right for
  // documents whose every section is one sheet by design (BM/AGM, Company
  // Secretary); it is wrong for Company Registration, whose MOA and AOA
  // genuinely span several sheets — bisecting those to 0.5 and clipping
  // would silently hide most of the filing. In flow mode the print window's
  // browser paginates the tall sections across real sheets; the section
  // boundaries (the template's own page-break style) still force a fresh
  // sheet per sub-document.
  function fitPagesToSheet(container, className, opts) {
    const sections = container.querySelectorAll('section.' + className);
    if (!sections.length) return null;

    if (opts && opts.flow) {
      const pageW = Math.round(parseFloat(getComputedStyle(sections[0]).width));
      const pageH = Math.round(parseFloat(getComputedStyle(sections[0]).minHeight));
      sections.forEach(m => {
        m.style.height = 'auto';
        m.style.minHeight = pageH + 'px';
        m.style.overflow = 'visible';
      });
      return { pageW, pageH };
    }

    // Hidden container (e.g. a preview refreshed before its tab was opened,
    // such as a draft restore at load): everything measures 0 in place, so
    // measure an offscreen clone instead (the docx stylesheet is a global
    // <style>, so the clone renders identically) and copy the result back.
    const hidden = !sections[0].getBoundingClientRect().height;
    let measureSections = sections;
    let holder = null;
    if (hidden) {
      const wrapper = container.querySelector('.' + className + '-wrapper') || container;
      holder = document.createElement('div');
      holder.style.cssText = 'position:absolute; left:-10000px; top:0;';
      holder.appendChild(wrapper.cloneNode(true));
      document.body.appendChild(holder);
      measureSections = holder.querySelectorAll('section.' + className);
    }

    // Scale one stashed inline value (e.g. "37pt", "16px"), preserving its unit.
    const scaleLen = (orig, z) => (parseFloat(orig) * z) + (orig.replace(/[\d. ]/g, '') || 'px');

    try {
      const pageW = Math.round(parseFloat(getComputedStyle(measureSections[0]).width));
      const pageH = Math.round(parseFloat(getComputedStyle(measureSections[0]).minHeight));

      measureSections.forEach((m, i) => {
        m.style.width = pageW + 'px';
        m.style.minHeight = pageH + 'px';
        m.style.height = pageH + 'px';
        m.style.overflow = 'hidden';

        // Stash every inline length the docx renderer emitted, once per
        // element, so each fit attempt scales from the true originals rather
        // than compounding on a previous attempt.
        let els = Array.from(m.querySelectorAll('[data-de-fs]'));
        if (!els.length) {
          els = Array.from(m.querySelectorAll('*')).filter(el => el.style && (el.style.fontSize || el.style.minHeight));
          els.forEach(el => {
            el.dataset.deFs = el.style.fontSize || '';
            el.dataset.deMh = el.style.minHeight || '';
            el.dataset.deLh = el.style.lineHeight || '';
            el.dataset.deMb = el.style.marginBottom || '';
          });
        }
        const applyScale = z => els.forEach(el => {
          if (el.dataset.deFs) el.style.fontSize = scaleLen(el.dataset.deFs, z);
          if (el.dataset.deMh) el.style.minHeight = scaleLen(el.dataset.deMh, z);
          if (el.dataset.deLh && parseFloat(el.dataset.deLh)) el.style.lineHeight = scaleLen(el.dataset.deLh, z);
          if (el.dataset.deMb) el.style.marginBottom = scaleLen(el.dataset.deMb, z);
        });

        // Bisect for the largest scale that fits (each probe forces a full
        // reflow, so ~6 probes beats a ~25-step linear walk on preview-refresh
        // latency). Fitting is monotonic in z: smaller text never gets taller.
        applyScale(1);
        if (m.scrollHeight > m.clientHeight + 1) {
          let lo = 0.5, hi = 1;
          while (hi - lo > 0.01) {
            const z = (lo + hi) / 2;
            applyScale(z);
            if (m.scrollHeight <= m.clientHeight + 1) lo = z; else hi = z;
          }
          applyScale(lo);
        }

        if (hidden && sections[i]) {
          sections[i].innerHTML = m.innerHTML;
          sections[i].style.cssText = m.style.cssText;
        }
      });
      return { pageW, pageH };
    } finally {
      if (holder) holder.remove();
    }
  }

  // Renders `blob` offscreen, fits it to sheets, and returns a standalone
  // HTML document string that prints one template page per sheet — the same
  // pagination the on-screen preview shows, because it is the same code.
  // Returns null if the document produced no page sections.
  async function buildPrintableHtml(blob, { className, title, flow }) {
    const holder = document.createElement('div');
    holder.style.cssText = 'position:absolute; left:-10000px; top:0;';
    const styleEl = document.createElement('div');
    const content = document.createElement('div');
    holder.appendChild(styleEl);
    holder.appendChild(content);
    document.body.appendChild(holder);
    try {
      await previewWordAsHtml(blob, content, styleEl, {
        className, inWrapper: true, breakPages: true,
        ignoreLastRenderedPageBreak: true, experimental: true,
      });

      const fit = fitPagesToSheet(content, className, { flow });
      if (!fit) return null;
      const { pageW, pageH } = fit;

      // textContent, not innerHTML — docx-preview injects its CSS as a real
      // nested <style> element, and innerHTML would serialize that tag
      // literally, closing our own wrapping <style> block early.
      return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${title}</title><style>
    @page { size: ${pageW}px ${pageH}px; margin: 0; }
    html, body { margin:0; padding:0; background:#fff; }
    ${styleEl.textContent}
    .${className}-wrapper { display:block !important; background:#fff !important; padding:0 !important; }
    .${className}-wrapper > section.${className} { box-shadow:none !important; margin:0 auto !important; page-break-after: always; }
    .${className}-wrapper > section.${className}:last-child { page-break-after: auto; }
  </style></head><body>${content.innerHTML}
  <script>window.onload = function(){ setTimeout(function(){ window.print(); }, 300); };<\/script>
  </body></html>`;
    } finally {
      holder.remove();
    }
  }

  return { downloadBlob, getTemplate, renderWord, previewWordAsHtml, fitPagesToSheet, buildPrintableHtml };
})();
