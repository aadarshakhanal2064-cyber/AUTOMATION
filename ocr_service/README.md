# OCR Service

A small FastAPI service that extracts text from PDFs and images using
[PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR). It backs the app's
**Automation Hub → OCR Extract** tab.

It is a **separate process from the web app** and does not change how the app is
built or deployed. The app stays a static HTML/JS site; this service only runs
when someone wants to use OCR.

---

## Why it runs locally

GitHub Pages, where the app is hosted, serves static files only — it cannot run
Python. So each staff member runs this service on their own machine, the same way
each staff member's browser already holds their own Google OAuth token. If the
service isn't running, the OCR Extract tab says so and the rest of the app is
completely unaffected.

## Requirements

**Python 3.10–3.12.** PaddlePaddle (the inference engine) publishes no wheel for
3.13 or 3.14 — on those versions `pip install paddlepaddle` fails with
`No matching distribution found`. If you only have a newer Python:

```bash
winget install Python.Python.3.12
```

Installing 3.12 does not remove or replace a newer Python; the start script picks
3.12 specifically when building the virtual environment.

## Start it

```bash
./ocr_service/start.ps1
```

On first run this creates `venv/` and installs the dependencies (~200 MB), then
downloads the OCR model weights (~20 MB, needs internet **once** — afterwards it
works offline, weights are cached in `~/.paddlex/`). Later runs skip straight to
serving. `start.sh` is the Git Bash / macOS / Linux equivalent.

The service listens on `http://127.0.0.1:8000`. Interactive API docs are at
`http://127.0.0.1:8000/docs`.

## Endpoints

### `GET /health`

```json
{ "status": "ok", "engine_ready": true, "lang": "en", "max_file_mb": 25 }
```

`engine_ready` is `false` for the few seconds while models load — the service
answers immediately rather than refusing connections, so the frontend can tell
"still loading" apart from "not running".

### `POST /ocr`

`multipart/form-data` with one `file` field. Accepts `.pdf`, `.png`, `.jpg`,
`.jpeg`, `.bmp`, `.webp`, `.tif`, `.tiff`. Multi-page PDFs return one entry per
page.

```json
{
  "filename": "invoice.pdf",
  "page_count": 2,
  "text": "SHAILESH & ASSOCIATES\nInvoice No: SA-000123\n\nBalance Due: 47,500.00",
  "pages": [
    {
      "page": 1,
      "text": "SHAILESH & ASSOCIATES\nInvoice No: SA-000123",
      "lines": [
        { "text": "SHAILESH & ASSOCIATES", "confidence": 0.998 },
        { "text": "Invoice No: SA-000123", "confidence": 0.999 }
      ]
    }
  ]
}
```

Errors return `{ "detail": "..." }` — `415` unsupported file type, `400` empty
file, `413` over the size limit, `500` OCR failure.

## Configuration

All optional, set as environment variables before starting:

| Variable | Default | Meaning |
|---|---|---|
| `OCR_PORT` | `8000` | Port to listen on |
| `OCR_HOST` | `127.0.0.1` | Bind address — loopback only by default |
| `OCR_ALLOWED_ORIGINS` | dev servers + the GitHub Pages origin | Comma-separated CORS allow-list |
| `OCR_MAX_FILE_MB` | `25` | Upload size cap |
| `OCR_LANG` | `ne` | PaddleOCR language model — Nepali (Devanagari). Verified 2026-08-01 to also read plain Latin/English text correctly, so one model serves both. **Do not switch this to `en`**: the English model has no Devanagari support at all — a Nepali page comes back as confident-looking garbage, not an error, which is easy to miss. `ne` costs roughly 2x latency (~40s/page vs ~20s under load; ~13-15s/page on an idle machine) because its detection model is a larger tier. |

Changing `OCR_PORT` also means updating `OCR_SERVICE_URL` in `js/config.js` and
the `connect-src` entry in `index.html`'s CSP.

## Notes for whoever maintains this

- **`enable_mkldnn=False` in `ocr_engine.py` is load-bearing.** With oneDNN on,
  paddlepaddle 3.3.1 aborts during text detection with
  `ConvertPirAttribute2RuntimeAttribute not support`. Re-test before removing it
  on a paddlepaddle upgrade.
- PaddleOCR dispatches on **file extension**, so uploads are written to a temp
  file with a validated suffix rather than passed as raw bytes. The uploaded
  filename itself is never used to build a path.
- The predictor is not thread-safe; `ocr_engine.py` serializes calls behind a
  lock.
- The browser needs two things to reach this service, both already configured:
  the CSP `connect-src` in `index.html` must list the origin, and the service
  must return CORS headers for the calling origin.
