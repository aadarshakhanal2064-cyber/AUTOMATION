"""Runtime settings, all overridable by environment variable."""

import os


def _csv_env(name: str, default: str) -> list[str]:
    return [item.strip() for item in os.getenv(name, default).split(",") if item.strip()]


PORT = int(os.getenv("OCR_PORT", "8000"))
HOST = os.getenv("OCR_HOST", "127.0.0.1")

# The dev-server ports from .claude/launch.json plus the GitHub Pages origin the
# app is deployed to. 127.0.0.1 and localhost are distinct origins to a browser,
# so both spellings are listed.
ALLOWED_ORIGINS = _csv_env(
    "OCR_ALLOWED_ORIGINS",
    "http://localhost:5173,http://127.0.0.1:5173,"
    "http://localhost:5199,http://127.0.0.1:5199,"
    "https://aadarshakhanal2064-cyber.github.io",
)

MAX_FILE_MB = int(os.getenv("OCR_MAX_FILE_MB", "25"))
MAX_FILE_BYTES = MAX_FILE_MB * 1024 * 1024

# "ne" (Nepali/Devanagari) rather than "en": verified 2026-08-01 to read both
# Devanagari and Latin-script text correctly under one model, whereas "en" reads
# Devanagari as unrelated Latin glyphs (garbage output, not just lower accuracy).
# Costs roughly 2x latency per page (~40s vs ~20s) — a bigger detection model
# backs the Devanagari pipeline. See docs/architecture.md §2.6.
OCR_LANG = os.getenv("OCR_LANG", "ne")

IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".bmp", ".webp", ".tif", ".tiff"}
PDF_EXTENSIONS = {".pdf"}
ALLOWED_EXTENSIONS = IMAGE_EXTENSIONS | PDF_EXTENSIONS
