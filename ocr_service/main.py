"""FastAPI OCR service.

Local companion process to the static browser app: it accepts a PDF or image
upload and returns the extracted text as JSON. Runs on each staff member's own
machine — GitHub Pages, where the app itself is hosted, cannot run Python.
"""

import logging
import os
import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

import config
import ocr_engine
from models import HealthResponse, OcrPage, OcrResponse

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Model loading takes several seconds (and downloads weights the very first
    # time). Doing it in a background thread keeps startup non-blocking, so
    # /health answers immediately with engine_ready=false instead of the port
    # simply refusing connections while the user waits.
    threading.Thread(target=ocr_engine.warm_up, daemon=True).start()
    yield


app = FastAPI(
    title="Audit Automation OCR Service",
    description="PaddleOCR-backed text extraction for the Shailesh & Associates app.",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=config.ALLOWED_ORIGINS,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


@app.middleware("http")
async def allow_private_network(request, call_next):
    # Chrome's Private Network Access check: a page on a public origin (the
    # deployed GitHub Pages site) preflights before it may call a loopback
    # service, and expects this header back or the request never happens.
    response = await call_next(request)
    if request.headers.get("access-control-request-private-network"):
        response.headers["Access-Control-Allow-Private-Network"] = "true"
    return response


@app.get("/health", response_model=HealthResponse)
def health():
    return HealthResponse(
        status="ok",
        engine_ready=ocr_engine.is_ready(),
        lang=config.OCR_LANG,
        max_file_mb=config.MAX_FILE_MB,
    )


@app.post("/ocr", response_model=OcrResponse)
def ocr(file: UploadFile = File(...)):
    filename = os.path.basename(file.filename or "")
    extension = os.path.splitext(filename)[1].lower()

    if extension not in config.ALLOWED_EXTENSIONS:
        allowed = ", ".join(sorted(config.ALLOWED_EXTENSIONS))
        raise HTTPException(
            status_code=415,
            detail=f"Unsupported file type '{extension or filename}'. Allowed: {allowed}",
        )

    data = file.file.read()
    if not data:
        raise HTTPException(status_code=400, detail="The uploaded file is empty.")
    if len(data) > config.MAX_FILE_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"File is larger than the {config.MAX_FILE_MB} MB limit.",
        )

    try:
        pages: list[OcrPage] = ocr_engine.extract(data, extension)
    except Exception:
        # Logged in full server-side; the client gets a plain message rather
        # than a stack trace.
        logger.exception("OCR failed for %s", filename)
        raise HTTPException(
            status_code=500,
            detail="OCR failed while processing this file. See the service log for details.",
        )

    return OcrResponse(
        filename=filename,
        page_count=len(pages),
        text="\n\n".join(page.text for page in pages),
        pages=pages,
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=config.HOST, port=config.PORT)
