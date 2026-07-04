// ════════════════════════════════════════════
//  PDF ENGINE
//  Rendering/cropping (PDF.js) promoted out of vatReturn.js — these three
//  functions never actually depended on anything VAT-specific (no
//  VAT_FIELD_BOXES, no VAT business logic), they were just sitting in a
//  business-logic file. Construction/merging (PDF-Lib) is new: no module
//  ships PDF-Lib usage yet (it was only ever used in this project's
//  scratchpad testing to generate synthetic PDFs — see HANDOFF_VAT.md),
//  but future PDF-producing modules (Company Registration, Section 51
//  assembly) will need it, so the dependency is adopted here with the one
//  operation general enough to build and verify without a real consumer
//  yet: merging multiple PDFs into one.
// ════════════════════════════════════════════
window.PdfEngine = (function () {
  // ── PDF.js: rendering, image placement, cropping ──

  // Walks a page's operator list to find the CTM active at its embedded
  // image draw call, returning that placement as fractions of the page.
  // `pageWidth`/`pageHeight` are explicit parameters (not read from the PDF
  // itself) so a caller with an already-known, calibrated page size (like
  // vatReturn.js's A4 constants) gets byte-identical output to before.
  async function getImagePlacement(page, pageWidth, pageHeight) {
    const opList = await page.getOperatorList();
    const OPS = pdfjsLib.OPS;
    let stack = [[1, 0, 0, 1, 0, 0]];
    const mul = (a, b) => [
      a[0]*b[0] + a[1]*b[2],        a[0]*b[1] + a[1]*b[3],
      a[2]*b[0] + a[3]*b[2],        a[2]*b[1] + a[3]*b[3],
      a[4]*b[0] + a[5]*b[2] + b[4],  a[4]*b[1] + a[5]*b[3] + b[5],
    ];
    let found = null, imageCount = 0;
    for (let i = 0; i < opList.fnArray.length; i++) {
      const fn = opList.fnArray[i], args = opList.argsArray[i];
      if (fn === OPS.save) stack.push(stack[stack.length - 1].slice());
      else if (fn === OPS.restore) stack.pop();
      else if (fn === OPS.transform) stack[stack.length - 1] = mul(args, stack[stack.length - 1]);
      else if (fn === OPS.paintImageXObject) { found = stack[stack.length - 1].slice(); imageCount++; }
    }
    if (!found) return { topFraction: 0, leftFraction: 0, heightFraction: 1, widthFraction: 1, imageCount, ctm: null };
    const [a, , , d, , f] = found;
    return {
      topFraction: (pageHeight - (f + d)) / pageHeight,
      heightFraction: d / pageHeight,
      leftFraction: 0,
      widthFraction: a / pageWidth,
      imageCount,
      ctm: found,
    };
  }

  async function renderPageToCanvas(page, scale) {
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    return canvas;
  }

  // Crops `canvas` to the region described by `box` (fractions of the raw
  // image) after correcting for `placement` (the embedded image's own
  // offset/scale within the page, from getImagePlacement()).
  function cropCanvas(canvas, placement, box) {
    const w = canvas.width, h = canvas.height;
    const yFrac = placement.topFraction + box.top * placement.heightFraction;
    const hFrac = box.height * placement.heightFraction;
    const xFrac = placement.leftFraction + box.left * placement.widthFraction;
    const wFrac = box.width * placement.widthFraction;
    const sx = Math.max(0, Math.round(xFrac * w)), sy = Math.max(0, Math.round(yFrac * h));
    const sw = Math.max(1, Math.round(wFrac * w)), sh = Math.max(1, Math.round(hFrac * h));
    const crop = document.createElement('canvas');
    crop.width = sw; crop.height = sh;
    crop.getContext('2d').drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
    return crop;
  }

  // ── PDF-Lib: construction ──
  async function mergePdfs(pdfByteArrays) {
    const merged = await PDFLib.PDFDocument.create();
    for (const bytes of pdfByteArrays) {
      const src = await PDFLib.PDFDocument.load(bytes);
      const pages = await merged.copyPages(src, src.getPageIndices());
      pages.forEach(p => merged.addPage(p));
    }
    return merged.save(); // Uint8Array
  }

  return { getImagePlacement, renderPageToCanvas, cropCanvas, mergePdfs };
})();
