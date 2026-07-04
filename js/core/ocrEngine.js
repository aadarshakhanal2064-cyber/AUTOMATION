// ════════════════════════════════════════════
//  OCR ENGINE
//  Business logic (vatReturn.js's field extraction, confidence tiers,
//  validation) calls only OcrEngine.* below, never Tesseract.* directly —
//  so a future engine (PaddleOCR, or anything else) can replace
//  TESSERACT_ADAPTER here without touching any module's business logic.
//
//  Session-based, not a flat "recognize one thing" call: a real extraction
//  run does ~140 recognitions (14 fields x 10 pages) and Phase 2 of the VAT
//  work proved a single reused worker is 4.1x faster than spinning one up
//  per call — that lifecycle (create once, reuse, guarantee termination)
//  is the actual proven need, so the engine exposes it explicitly rather
//  than hiding it behind an auto-managed singleton.
// ════════════════════════════════════════════
window.OcrEngine = (function () {
  const TESSERACT_ADAPTER = {
    async createSession(options) {
      const worker = await Tesseract.createWorker('eng');
      await worker.setParameters({ tessedit_char_whitelist: (options && options.charWhitelist) || '0123456789' });

      async function recognizeDigits(canvas) {
        try {
          const { data } = await worker.recognize(canvas);
          return { value: data.text.replace(/\D/g, ''), confidence: data.confidence || 0 };
        } catch (err) {
          return { value: '', confidence: 0 };
        }
      }

      async function terminate() {
        await worker.terminate();
      }

      return { recognizeDigits, terminate };
    },
  };

  // The only adapter today. A future PaddleOcrAdapter (or any other engine)
  // just needs the same { createSession(options) -> { recognizeDigits, terminate } }
  // shape to replace this — no OCR-consuming module changes.
  const ACTIVE_ADAPTER = TESSERACT_ADAPTER;

  function createDigitSession(options) {
    return ACTIVE_ADAPTER.createSession(options);
  }

  return { createDigitSession };
})();
