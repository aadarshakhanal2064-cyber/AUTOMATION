// ════════════════════════════════════════════
//  OCR EXTRACT
//  Upload a scanned PDF or an image, get its text back. Thin front end over
//  OcrEngine (js/core/ocrEngine.js), which talks to the local PaddleOCR
//  service in ocr_service/.
//
//  Deliberately generic: it extracts text and hands it to the user (copy or
//  download), and is not wired into any client record or document pipeline.
//  Nothing else in the app depends on it, so the OCR service being stopped
//  affects only this tab.
// ════════════════════════════════════════════
// No buttonId — launched from the topbar "Automation Hub" menu, not a sidebar button.
ModuleRegistry.register({ id: 'ocrExtract', group: 'main', buttonId: null, panelId: 'tab-ocrExtract-panel' });

// Mirrors ocr_service/config.py ALLOWED_EXTENSIONS. The service validates
// independently — this copy exists only to fail fast with a clearer message
// than a round-trip 415 would give.
const OCR_ACCEPTED_EXTENSIONS = ['.pdf', '.png', '.jpg', '.jpeg', '.bmp', '.webp', '.tif', '.tiff'];

let ocrSelectedFile = null;
let ocrResult = null;      // the service's last response
let ocrBusy = false;

function ocrStatus(msg, type) {
  showStatus(msg, type, 'ocr-status');
}

// ── Service availability ──

// Called on every tab open. The previous run's file and text are cleared first
// so reopening the tab never shows the last document's text under a new one.
function ocrInit() {
  ocrSelectedFile = null;
  ocrResult = null;
  ocrBusy = false;
  const picker = document.getElementById('ocr-file-input');
  if (picker) picker.value = '';
  ocrStatus('', 'info');
  ocrRender();
  ocrCheckService();
}

// A stopped service is the normal case (staff start it only when they need
// OCR), so this is a plain informational state, not an error.
async function ocrCheckService() {
  const badge = document.getElementById('ocr-service-badge');
  if (!badge) return;
  badge.innerHTML = '<span class="log-badge badge-neutral">Checking service…</span>';
  try {
    const health = await OcrEngine.checkHealth();
    badge.innerHTML = health.engine_ready
      ? '<span class="log-badge badge-sent">Service running</span>'
      : '<span class="log-badge badge-amber">Service starting — models loading…</span>';
  } catch {
    badge.innerHTML = '<span class="log-badge badge-error">Service not running</span>';
    ocrStatus(escHtml(OcrEngine.NOT_RUNNING), 'error');
  }
}

// ── File selection ──

function ocrHandleFile(input) {
  const file = input.files && input.files[0];
  if (!file) return;

  const dot = file.name.lastIndexOf('.');
  const ext = dot === -1 ? '' : file.name.slice(dot).toLowerCase();
  if (!OCR_ACCEPTED_EXTENSIONS.includes(ext)) {
    ocrSelectedFile = null;
    input.value = '';
    ocrStatus(`Unsupported file type. Choose one of: ${OCR_ACCEPTED_EXTENSIONS.join(', ')}`, 'error');
    ocrRender();
    return;
  }

  ocrSelectedFile = file;
  ocrResult = null;
  ocrStatus('', 'info');
  ocrRender();
}

async function ocrRun() {
  if (!ocrSelectedFile || ocrBusy) return;

  ocrBusy = true;
  ocrRender();
  ocrStatus('Extracting text… large scans can take a while.', 'searching');

  try {
    ocrResult = await OcrEngine.extractText(ocrSelectedFile);
    const lineCount = ocrResult.pages.reduce((n, p) => n + p.lines.length, 0);
    ocrStatus(
      `Extracted ${lineCount} line${lineCount === 1 ? '' : 's'} from ${ocrResult.page_count} page${ocrResult.page_count === 1 ? '' : 's'}.`,
      'success'
    );
    AuditLog.record('ocr_extract_run', {
      module: 'ocrExtract',
      filename: ocrResult.filename,
      pageCount: ocrResult.page_count,
      lineCount,
    });
  } catch (err) {
    ocrResult = null;
    ocrStatus(escHtml(err.message), 'error');
  } finally {
    ocrBusy = false;
    ocrRender();
  }
}

// ── Output ──

function ocrRender() {
  const runBtn = document.getElementById('ocr-run-btn');
  if (runBtn) {
    runBtn.disabled = !ocrSelectedFile || ocrBusy;
    runBtn.textContent = ocrBusy ? 'Extracting…' : 'Extract Text';
  }

  const nameEl = document.getElementById('ocr-file-name');
  if (nameEl) {
    nameEl.textContent = ocrSelectedFile
      ? `${ocrSelectedFile.name} (${(ocrSelectedFile.size / 1024).toFixed(0)} KB)`
      : 'No file selected.';
  }

  const card = document.getElementById('ocr-result-card');
  const body = document.getElementById('ocr-result-body');
  if (!card || !body) return;

  if (!ocrResult) {
    card.style.display = 'none';
    body.innerHTML = '';
    return;
  }

  card.style.display = '';
  body.innerHTML = ocrResult.pages.map(page => `
    <div style="margin-bottom:18px;">
      <div style="font-size:12.5px; font-weight:600; color:var(--text-muted); margin-bottom:6px;">
        Page ${page.page} — ${page.lines.length} line${page.lines.length === 1 ? '' : 's'}
      </div>
      <pre style="white-space:pre-wrap; word-break:break-word; font-size:13px; line-height:1.6; margin:0; padding:12px; background:var(--bg-page-alt); border:1px solid var(--border); border-radius:var(--radius);">${escHtml(page.text) || '<span style="color:var(--text-muted);">No text found on this page.</span>'}</pre>
    </div>
  `).join('');
}

async function ocrCopyText() {
  if (!ocrResult) return;
  try {
    await navigator.clipboard.writeText(ocrResult.text);
    ocrStatus('Extracted text copied to clipboard.', 'success');
  } catch {
    ocrStatus('Could not copy — your browser blocked clipboard access.', 'error');
  }
}

function ocrDownloadText() {
  if (!ocrResult) return;
  const base = ocrResult.filename.replace(/\.[^.]+$/, '') || 'ocr-extract';
  const blob = new Blob([ocrResult.text], { type: 'text/plain;charset=utf-8' });
  DocumentEngine.downloadBlob(blob, `${base}.txt`, { module: 'ocrExtract' });
}
