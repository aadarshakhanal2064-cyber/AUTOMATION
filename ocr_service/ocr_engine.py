"""PaddleOCR wrapper.

Owns the single PaddleOCR instance and the conversion from an uploaded file to
plain text. Nothing else in the service imports paddleocr directly.
"""

import logging
import os
import tempfile
import threading

import config
from models import OcrLine, OcrPage

logger = logging.getLogger(__name__)

_ocr = None
_init_lock = threading.Lock()

# PaddleOCR's predictor holds per-instance inference state and is not safe to
# run concurrently; FastAPI dispatches sync endpoints onto a threadpool, so
# without this every parallel upload would race inside the same predictor.
_predict_lock = threading.Lock()


def _build():
    from paddleocr import PaddleOCR

    return PaddleOCR(
        lang=config.OCR_LANG,
        # The three document-preprocessing sub-models are off because this
        # service takes already-upright scans and photos; each one adds a model
        # download plus per-page latency for no gain here.
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
        # Load-bearing: with oneDNN enabled, paddlepaddle 3.3.1 aborts during
        # text detection with "ConvertPirAttribute2RuntimeAttribute not support
        # [pir::ArrayAttribute<pir::DoubleAttribute>]". Inference succeeds on the
        # plain CPU kernels. Re-test before removing this on a paddlepaddle bump.
        enable_mkldnn=False,
    )


def warm_up() -> None:
    """Build the predictor (downloads model weights on first ever run)."""
    global _ocr
    with _init_lock:
        if _ocr is None:
            logger.info("Loading PaddleOCR models (lang=%s)...", config.OCR_LANG)
            _ocr = _build()
            logger.info("PaddleOCR ready.")


def is_ready() -> bool:
    return _ocr is not None


def extract(data: bytes, extension: str) -> list[OcrPage]:
    """OCR the given file bytes. `extension` must already be validated."""
    warm_up()

    # PaddleOCR dispatches on the file extension (a .pdf is rasterized page by
    # page via pypdfium2), so the upload has to reach it as a real file with the
    # right suffix. Only the caller-validated extension is used for the temp
    # name — never the uploaded filename, which is untrusted.
    handle, temp_path = tempfile.mkstemp(suffix=extension)
    os.close(handle)
    try:
        with open(temp_path, "wb") as f:
            f.write(data)

        with _predict_lock:
            results = list(_ocr.predict(temp_path))
    finally:
        try:
            os.unlink(temp_path)
        except OSError:
            logger.warning("Could not delete temp file %s", temp_path)

    pages: list[OcrPage] = []
    for index, result in enumerate(results):
        texts = result.get("rec_texts") or []
        scores = result.get("rec_scores") or []
        lines = [
            OcrLine(text=text, confidence=float(score))
            for text, score in zip(texts, scores)
        ]
        pages.append(
            OcrPage(
                page=index + 1,
                text="\n".join(line.text for line in lines),
                lines=lines,
            )
        )
    return pages
