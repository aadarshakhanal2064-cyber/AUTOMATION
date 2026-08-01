// ════════════════════════════════════════════
//  OCR ENGINE
//  Client for the local PaddleOCR service (ocr_service/). That service runs as
//  a separate process on the staff member's own machine — GitHub Pages serves
//  static files only and can't host Python — so every call here is to loopback
//  and every call can legitimately fail with "it isn't running".
//
//  Distinguishing "service down" from "OCR failed" is this engine's main job:
//  a bare fetch() rejection says only "Failed to fetch", which tells the user
//  nothing actionable. Callers get an Error whose message is safe to show.
// ════════════════════════════════════════════
window.OcrEngine = (function () {
  const NOT_RUNNING =
    'OCR service is not running. Start it with ocr_service/start.ps1, then try again.';

  function baseUrl() {
    return (window.OCR_SERVICE_URL || 'http://127.0.0.1:8000').replace(/\/+$/, '');
  }

  // A fetch() to a dead loopback port rejects rather than returning a status,
  // so the network-level failure is caught here and rewritten into the one
  // message that tells the user what to actually do about it.
  async function request(path, options) {
    let resp;
    try {
      resp = await fetch(baseUrl() + path, options);
    } catch {
      throw new Error(NOT_RUNNING);
    }
    if (!resp.ok) {
      let detail = '';
      try {
        detail = (await resp.json()).detail || '';
      } catch {
        // Non-JSON error body (a proxy page, an HTML error) — fall through to
        // the status-code message below rather than masking it.
      }
      throw new Error(detail || `OCR service returned ${resp.status}.`);
    }
    return resp.json();
  }

  // Resolves with the service's health payload, or throws NOT_RUNNING. Used to
  // tell the user up front rather than on their first failed upload.
  //
  // Timed out deliberately: this runs on every OCR tab open, and a dead port
  // normally rejects instantly — but a firewall that drops SYNs instead of
  // refusing leaves the fetch hanging, and the tab sits on a spinner with no
  // way out. 2s is far longer than a local health check ever needs.
  // No timeout on extractText(): OCR of a multi-page scan legitimately takes
  // a while, and cutting that off would be a bug, not a safeguard.
  async function checkHealth() {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 2000);
    try {
      return await request('/health', { method: 'GET', signal: ctl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  // `file` is a File/Blob from an <input type="file">. Returns the service's
  // JSON: { filename, page_count, text, pages: [{ page, text, lines }] }.
  async function extractText(file) {
    const form = new FormData();
    form.append('file', file, file.name);
    return request('/ocr', { method: 'POST', body: form });
  }

  return { checkHealth, extractText, NOT_RUNNING };
})();
