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

  // ── Word-parity pagination for flow-mode documents ──
  // docx-preview cannot paginate flowed content: a multi-sheet sub-document
  // renders as one tall section, so the preview showed no page boundaries
  // and Save-as-PDF let the browser break pages by rules unrelated to the
  // Word file's. This splits each flow section into real page-sized
  // sections by the SAME rules the .docx carries: it reads every block's
  // <w:keepNext/> out of the rendered blob itself (so template and preview
  // can never disagree about what chains to what), welds keep-chains and
  // tables into atomic units, and moves whole units onto A4-sized pages.
  // A unit taller than one page keeps a page to itself and overruns it —
  // the print CSS's break-inside hints then split it gracefully, the same
  // "genuinely too long" exception Word applies.
  //
  // Pixel-identical page breaks to Word are NOT promised — two renderers,
  // one font — but the RULES match: a paragraph never splits, a table row
  // never splits, and a chained unit (a दफा with sub-clauses, a signature
  // block with its table) moves whole.
  async function paginateFlowSections(container, className, blob) {
    // The blocks and their keep flags, straight from the document body.
    // Table-cell paragraphs never appear here: tables are separate chunks,
    // and a table chains onward when its LAST row's paragraphs keep-next.
    const xml = new PizZip(await blob.arrayBuffer()).file('word/document.xml').asText();
    const body = xml.slice(xml.indexOf('<w:body>') + 8, xml.indexOf('</w:body>'));
    const blocks = [];
    body.split(/(<w:tbl>[\s\S]*?<\/w:tbl>)/).forEach(chunk => {
      if (chunk.startsWith('<w:tbl>')) {
        const rows = chunk.match(/<w:tr\b[\s\S]*?<\/w:tr>/g) || [];
        blocks.push({ keepNext: (rows[rows.length - 1] || '').includes('<w:keepNext/>') });
        return;
      }
      const RE = /<w:p\b[^>]*\/>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;
      let m;
      while ((m = RE.exec(chunk))) {
        const pPr = (m[0].match(/<w:pPr>[\s\S]*?<\/w:pPr>/) || [''])[0];
        blocks.push({ keepNext: pPr.includes('<w:keepNext/>') });
      }
    });

    const sections = Array.from(container.querySelectorAll('section.' + className));
    if (!sections.length) return 0;

    // Word's lineRule="auto" spacing is value/240 × the FONT'S OWN single-
    // line metric, and for Nirmala UI that metric is ~1.36em — docx-preview
    // maps the same value to a flat CSS line-height, so the browser packs
    // ~⅓ more lines per page and the preview's page breaks land three pages
    // early of the Word file's. Scaling every paragraph's computed
    // line-height by the font metric makes the two renderers lay out at the
    // same density (verified against Word's own page map — see
    // docs/modules/registrar.md §5.11d).
    const LINE_METRIC = 1.36;
    sections.forEach(sec => sec.querySelectorAll('p').forEach(p => {
      if (p.dataset.deLineAdj) return;
      const lh = parseFloat(getComputedStyle(p).lineHeight);
      if (isFinite(lh)) { p.style.lineHeight = (lh * LINE_METRIC) + 'px'; p.dataset.deLineAdj = '1'; }
    }));

    // docx-preview may wrap a section's blocks in a single inner element;
    // walk down single-child wrappers to whatever actually holds the <p>s.
    const perSection = sections.map(sec => {
      let host = sec;
      const wrappers = [];
      while (host.children.length === 1 && !/^(P|TABLE)$/.test(host.children[0].tagName)) {
        wrappers.push(host.children[0]);
        host = host.children[0];
      }
      return { sec, host, wrappers, els: Array.from(host.children) };
    });

    // The XML block list and the DOM block list must be the same list. If a
    // docx-preview version ever renders extra elements, fall back to
    // per-block units — pages still never split a paragraph or a table,
    // only the chains are lost — rather than mis-assigning keep flags.
    const domTotal = perSection.reduce((s, x) => s + x.els.length, 0);
    const chained = domTotal === blocks.length &&
      perSection.every(x => x.els.every(el => /^(P|TABLE)$/.test(el.tagName)));
    if (!chained) console.warn('paginateFlowSections: block lists disagree (' + domTotal + ' rendered vs ' + blocks.length + ' in the document) — paginating without keep-chains');

    // Measure everything before anything moves.
    const height = new Map();
    perSection.forEach(({ els }) => els.forEach(el => {
      const cs = getComputedStyle(el);
      height.set(el, el.getBoundingClientRect().height + (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0));
    }));

    let bi = 0, pageCount = 0;
    perSection.forEach(({ sec, wrappers, els }) => {
      const cs = getComputedStyle(sec);
      const usable = parseFloat(cs.minHeight) - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0);

      // Weld keep-chains into atomic units: a block with keepNext binds the
      // block after it into the same unit.
      const units = [];
      let cur = null;
      els.forEach(el => {
        const keepNext = chained ? blocks[bi++].keepNext : false;
        if (!cur) { cur = []; units.push(cur); }
        cur.push(el);
        if (!keepNext) cur = null;
      });

      // Greedy fill: a unit that no longer fits starts the next page; a unit
      // taller than a page keeps one to itself and overruns.
      const pages = [];
      let page = null, used = 0;
      units.forEach(u => {
        const uh = u.reduce((s, el) => s + height.get(el), 0);
        if (!page || (used + uh > usable && used > 0)) { page = []; pages.push(page); used = 0; }
        page.push(...u);
        used += uh;
      });
      pageCount += pages.length || 1;
      if (pages.length <= 1) return;

      pages.forEach(pageEls => {
        const ns = sec.cloneNode(false);
        let into = ns;
        wrappers.forEach(w => { const c = w.cloneNode(false); into.appendChild(c); into = c; });
        pageEls.forEach(el => into.appendChild(el));
        sec.parentNode.insertBefore(ns, sec);
      });
      sec.remove();
    });
    return pageCount;
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
      if (flow) await paginateFlowSections(content, className, blob);

      // textContent, not innerHTML — docx-preview injects its CSS as a real
      // nested <style> element, and innerHTML would serialize that tag
      // literally, closing our own wrapping <style> block early.
      // The flow-mode break hints only matter on a page a too-tall unit
      // overran: the browser then splits it without cutting a paragraph's
      // lines or a table row in half.
      return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${title}</title><style>
    @page { size: ${pageW}px ${pageH}px; margin: 0; }
    html, body { margin:0; padding:0; background:#fff; }
    ${styleEl.textContent}
    .${className}-wrapper { display:block !important; background:#fff !important; padding:0 !important; }
    .${className}-wrapper > section.${className} { box-shadow:none !important; margin:0 auto !important; page-break-after: always; }
    .${className}-wrapper > section.${className}:last-child { page-break-after: auto; }
    ${flow ? `section.${className} p { break-inside: avoid; } section.${className} tr { break-inside: avoid; }` : ''}
  </style></head><body>${content.innerHTML}
  <script>window.onload = function(){ setTimeout(function(){ window.print(); }, 300); };<\/script>
  </body></html>`;
    } finally {
      holder.remove();
    }
  }

  return { downloadBlob, getTemplate, renderWord, previewWordAsHtml, fitPagesToSheet, paginateFlowSections, buildPrintableHtml };
})();
