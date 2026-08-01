"""Response schemas for the OCR API."""

from pydantic import BaseModel, Field


class OcrLine(BaseModel):
    text: str
    confidence: float = Field(ge=0.0, le=1.0)


class OcrPage(BaseModel):
    page: int = Field(ge=1, description="1-based page number")
    text: str = Field(description="Lines of this page joined by newline")
    lines: list[OcrLine]


class OcrResponse(BaseModel):
    filename: str
    page_count: int
    text: str = Field(description="All pages joined, blank line between pages")
    pages: list[OcrPage]


class HealthResponse(BaseModel):
    status: str
    engine_ready: bool
    lang: str
    max_file_mb: int


class ErrorResponse(BaseModel):
    detail: str
