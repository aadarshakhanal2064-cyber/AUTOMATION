// ════════════════════════════════════════════
//  LIB LOADER — on-demand loading for the heavy vendor libraries
//  (Stage 4 of the overhaul, 2026-08-21)
//
//  The five libraries below total ~890 KB gzip / ~2.9 MB raw and none of
//  them is needed to sign in or to browse any list — they exist for
//  imports, exports and document previews. They used to be five of the
//  twelve synchronous CDN <script> tags every visitor downloaded before
//  the login box could appear. Now:
//
//    · ensure(name) loads one on first use and resolves when its global
//      exists. Same pinned URL, same SRI hash, same crossorigin as the
//      old tags — the integrity guarantee is unchanged. Concurrent calls
//      share one in-flight promise; a failed load is NOT cached, so a
//      retry after a network blip works.
//    · prefetchAll() fires from auth.js the moment the boot settles, so
//      in practice every global is present within seconds of sign-in.
//      The awaits at the entry points exist for the race window (someone
//      importing a file two seconds after login on a slow connection),
//      not as the normal path.
//
//  When bumping a version here, recompute the SRI hash exactly as for
//  index.html's tags (CLAUDE.md §2) — a wrong hash means the file
//  silently refuses to run. jszip stays an eager tag: docx-preview
//  expects it at parse time, and pizzip/docxtemplater (Word templating)
//  are small and load-bearing for DocumentEngine.
// ════════════════════════════════════════════
window.LibLoader = (function () {
  const LIBS = {
    xlsx: {
      global: 'XLSX',
      src: 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
      integrity: 'sha384-vtjasyidUo0kW94K5MXDXntzOJpQgBKXmE7e2Ga4LG0skTTLeBi97eFAXsqewJjw',
    },
    exceljs: {
      global: 'ExcelJS',
      src: 'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js',
      integrity: 'sha384-Pqp51FUN2/qzfxZxBCtF0stpc9ONI6MYZpVqmo8m20SoaQCzf+arZvACkLkirlPz',
    },
    pdflib: {
      global: 'PDFLib',
      src: 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js',
      integrity: 'sha384-weMABwrltA6jWR8DDe9Jp5blk+tZQh7ugpCsF3JwSA53WZM9/14PjS5LAJNHNjAI',
    },
    htmldocx: {
      global: 'htmlDocx',
      src: 'https://cdn.jsdelivr.net/npm/html-docx-js@0.3.1/dist/html-docx.js',
      integrity: 'sha384-TtrQp5nveof/QP1+f/OLiEHL3GuOIRyl3IfsGxu5X45VO2vHeT4HRNmQuTR3Ea3w',
    },
    docxpreview: {
      global: 'docx',
      src: 'https://cdn.jsdelivr.net/npm/docx-preview@0.3.7/dist/docx-preview.min.js',
      integrity: 'sha384-Fw+ZM2MtvxCe867uRzZY5GtGP+gs0NLvrlJS768RZWuKhOHMN4Fln3i3gMt1NSyQ',
    },
  };

  const inflight = {};

  function ensure(name) {
    const lib = LIBS[name];
    if (!lib) return Promise.reject(new Error('LibLoader: unknown library "' + name + '"'));
    if (window[lib.global]) return Promise.resolve(window[lib.global]);
    if (inflight[name]) return inflight[name];

    inflight[name] = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = lib.src;
      s.integrity = lib.integrity;
      s.crossOrigin = 'anonymous';
      s.onload = () => {
        if (window[lib.global]) resolve(window[lib.global]);
        else reject(new Error(name + ' loaded but its global "' + lib.global + '" is missing'));
      };
      s.onerror = () => {
        // Drop the failed promise so the next attempt injects a fresh tag —
        // a network blip must not permanently kill exports for the session.
        delete inflight[name];
        s.remove();
        reject(new Error('Could not load the ' + name + ' library — check the internet connection and try again.'));
      };
      document.head.appendChild(s);
    });
    return inflight[name];
  }

  // Fired after boot settles: warms every library in the background so the
  // ensure() calls at entry points are usually already-resolved no-ops.
  // Failures are ignored here — the entry-point ensure() will retry and
  // surface a real message if the user actually needs the library.
  function prefetchAll() {
    Object.keys(LIBS).forEach(name => { ensure(name).catch(() => {}); });
  }

  return { ensure, prefetchAll };
})();
