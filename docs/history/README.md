# Historical records — not current state

Everything in this folder describes the project **as it was**, not as it is.
`CLAUDE.md` and `docs/` are the only authoritative descriptions of the codebase
today. Never quote a file from here as if it were current.

They are kept because each one is the *only* record of something, and a few of
those things would be genuinely expensive to reconstruct.

| File | Date | Still the only record of |
|---|---|---|
| `HANDOFF.md` | 2026-07-03 | **The BM/AGM Preeti→Unicode template pipeline** (§4–5): the conversion, the token list, and the formatting-group-preserving rebuild. The build tooling was never committed, so rebuilding `assets/templates/bm-agm-minutes.docx` starts by recreating it from this prose. Read this before touching that template. |
| `HANDOFF_VAT.md` | 2026-07-04 | The VAT Return OCR engineering record — the module was removed 2026-07-14 by user decision. Recoverable from git at commit `ad0e9f2`. |
| `HANDOFF_2026-07-05.md` | 2026-07-05 | The engine-layer rebuild rationale and per-engine migration notes. Four of those engines (`ocrEngine`, `pdfEngine`, `visionEngine`, `validationEngine`) went with the VAT Return module. |
| `README-2026-07-02.md` | 2026-07-02 | The original project README, written in the pre-engine era when the app had ~6 modules (it now has 18). Superseded by the root `README.md` and `CLAUDE.md`. Its "Future Modules" roadmap section is the part still worth a look. |

## Local-only archives (present on disk, deliberately untracked)

These two are **gitignored** and exist only on this machine. Both carry real
client names — the permission rules and two of the memory files reference client
workbooks by filename — and this repository is public, so they can be kept but
never published.

| Path | What it is |
|---|---|
| `settings.local.json.bak` | `.claude/settings.local.json` as it stood on 2026-07-27, before `Bash(git push *)` and ~150 spent one-off permission rules were pruned. Restore from here if a pruned rule turns out to still be needed. |
| `memory-2026-07-27/` | Full prior text of all 12 memory files, taken before seven of them were collapsed into pointers at `docs/modules/`. |

If either is lost, it is not recoverable from the repository.
