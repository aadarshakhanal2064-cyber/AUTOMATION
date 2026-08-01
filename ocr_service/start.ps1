# Starts the OCR service, creating the virtual environment on first run.
# Safe to re-run: the venv and the dependency install are both skipped once present.

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$venv = Join-Path $root "venv"
$venvPython = Join-Path $venv "Scripts\python.exe"

if (-not (Test-Path $venvPython)) {
    Write-Host "No virtual environment found - creating one..." -ForegroundColor Cyan

    # paddlepaddle ships no wheel for 3.13+, so an explicit 3.12 is preferred
    # over whatever `python` happens to point at.
    $interpreter = $null
    foreach ($version in @("3.12", "3.11", "3.10")) {
        try {
            $candidate = (& py "-$version" -c "import sys; print(sys.executable)" 2>$null)
            if ($LASTEXITCODE -eq 0 -and $candidate) { $interpreter = $candidate; break }
        } catch {}
    }
    if (-not $interpreter) {
        Write-Host "Could not find Python 3.10-3.12, which PaddleOCR requires." -ForegroundColor Red
        Write-Host "Install it with:  winget install Python.Python.3.12" -ForegroundColor Yellow
        exit 1
    }

    Write-Host "Using $interpreter"
    & $interpreter -m venv $venv
    & $venvPython -m pip install --upgrade pip
    Write-Host "Installing dependencies (this downloads ~200 MB the first time)..." -ForegroundColor Cyan
    & $venvPython -m pip install -r (Join-Path $root "requirements.txt")
}

Write-Host "Starting OCR service on http://127.0.0.1:8000  (Ctrl+C to stop)" -ForegroundColor Green
Write-Host "Interactive API docs: http://127.0.0.1:8000/docs"
Set-Location $root
& $venvPython -m uvicorn main:app --host 127.0.0.1 --port 8000
