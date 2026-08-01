#!/usr/bin/env bash
# Starts the OCR service, creating the virtual environment on first run.
# Safe to re-run: the venv and the dependency install are both skipped once present.

set -e
root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
venv="$root/venv"

if [ -x "$venv/Scripts/python.exe" ]; then
  venv_python="$venv/Scripts/python.exe"   # Windows layout (Git Bash)
else
  venv_python="$venv/bin/python"
fi

if [ ! -x "$venv_python" ]; then
  echo "No virtual environment found - creating one..."

  # paddlepaddle ships no wheel for 3.13+, so an explicit 3.12 is preferred
  # over whatever `python3` happens to be.
  interpreter=""
  for version in python3.12 python3.11 python3.10; do
    if command -v "$version" >/dev/null 2>&1; then interpreter="$version"; break; fi
  done
  if [ -z "$interpreter" ]; then
    echo "Could not find Python 3.10-3.12, which PaddleOCR requires." >&2
    echo "Install it from https://www.python.org/downloads/ (or: winget install Python.Python.3.12)" >&2
    exit 1
  fi

  echo "Using $interpreter"
  "$interpreter" -m venv "$venv"
  if [ -x "$venv/Scripts/python.exe" ]; then
    venv_python="$venv/Scripts/python.exe"
  else
    venv_python="$venv/bin/python"
  fi
  "$venv_python" -m pip install --upgrade pip
  echo "Installing dependencies (this downloads ~200 MB the first time)..."
  "$venv_python" -m pip install -r "$root/requirements.txt"
fi

echo "Starting OCR service on http://127.0.0.1:8000  (Ctrl+C to stop)"
echo "Interactive API docs: http://127.0.0.1:8000/docs"
cd "$root"
exec "$venv_python" -m uvicorn main:app --host 127.0.0.1 --port 8000
