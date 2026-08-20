# Playbook — turning a firm's Nepali Word document into a generated module

> **How to use this:** when starting a new module of this kind, tell Claude:
>
> > Read `docs/nepali-docx-playbook.md` and follow it. We're building a new
> > module from `<path to the .docx>`. Start at Phase 1.
>
> That is the whole prompt. Everything below is the detail that would
> otherwise have to be re-learned, and every item on it cost real debugging
> time on BM/AGM Minutes (2026-08-20). `docs/modules/registrar.md` §5.11a is
> the worked example; `tools/registrarDocx/` is the reference implementation to
> copy.
>
> **You are not copying a script any more — you are adding one.**
> `tools/registrarDocx/core.mjs` already holds everything that is common to
> every Preeti source: the decode, run grouping, cross-run token replacement,
> the page-break style, font scaling, the structural checks. A new document
> gets its own `build<Name>.mjs` holding only its tokens, its alignment
> repairs and its own measured page sizes — see `buildCsAppoint.mjs`
> (Company Secretary Appointment, 2026-08-21), which is the second document
> through this pipeline and the smaller of the two to read first.

---

## Two traps found on the SECOND document (2026-08-21)

Both are now handled in `core.mjs`, but they are worth knowing because they
are invisible until they corrupt text, and because the first document showed
no sign of either:

- **`<w:proofErr>` markers break formatting groups.** They are Word's
  spell/grammar squiggles, they render nothing, and they sit *between* runs.
  Two identically-formatted runs separated by one stop being adjacent, land
  in different groups, and any Preeti ligature spanning them decodes wrong.
  The Company Secretary source carries **506** of them (141 in one paragraph)
  and silently produced `कम्फनी` for `कम्पनी` and `दफmा` for `दफा`.
  `stripProofErr()` removes them before the body walk. The BM/AGM source has
  **zero**, so a clean run on one document proves nothing about the next.
- **Empty spacer paragraphs, not font size, are what overflows a letter.**
  A letter laid out with blank paragraphs as vertical space (17 of 32 on the
  Company Secretary letter page) does not respond to font scaling the way a
  dense minutes page does — scaling down to 0.78 still produced 4 pages.
  Shrink the empty paragraphs to a fixed small size *first*, then scale, then
  re-measure. Getting this backwards costs a whole measurement grid.

---

## What this playbook is for

The firm has many statutory documents written as **Preeti-encoded Word files**
that need to become app-generated documents: same layout, same wording, with
the client-specific values turned into fill-in tokens.

It looks like a text-substitution job. It is not. The expensive problems are
all in the `.docx` XML and in the gap between how **Word** and the app's
**preview** render the same file. This playbook exists so those are decided
up front instead of discovered one screenshot at a time.

**The single most important rule:** the firm's document *is* the
specification. You are not designing a layout — you are preserving one and
making parts of it dynamic.

---

## Phase 1 — Understand the document before writing any code

1. **Get the source `.docx`** (not a PDF). Keep it outside the repo. It names
   a real client, so it is never committed (CLAUDE.md §1 rule 7).
2. **Ask the user to send a screenshot of every page**, and walk them one page
   at a time. Do not batch. For each page, state back:
   - which values you think are dynamic, and what data source each maps to;
   - which text is fixed boilerplate;
   - anything that repeats (attendee lists, per-person pages) and therefore
     needs a loop;
   - anything conditional (a whole section that only applies sometimes).
3. **Ask about anything ambiguous rather than guessing.** These are legal
   filings. Real questions that changed the outcome last time: is a time fixed
   or typed? Does this list vary in length? Should this whole block appear only
   sometimes? Is this English text intentional?
4. **Expect the source to contain mistakes**, and confirm each one you find
   instead of silently "fixing" or faithfully reproducing it. The BM/AGM source
   had: a typo in a name, a dropped vowel sign, one date separator inconsistent
   with every other, and an entire page still carrying **a different client's
   name** because it had been copied from their file. Highlighting in the source
   is a hand-marking of "fill this in" — treat it as a hint, not as truth, and
   remember the user may not have finished marking.
5. **Check the data actually exists.** Every token needs a source column. Query
   the database before promising a field. If a value has no Nepali counterpart
   (e.g. an address stored only in English), surface that early — it will
   otherwise print half-Devanagari, half-English on a Nepali filing.

**Deliverable of this phase:** an agreed field map — token name, source column,
fixed vs dynamic, loop/conditional — before a line of build code.

---

## Phase 2 — Build the template with a committed script

**Never hand-edit the `.docx`.** It is a build artifact. A hand-edit is
invisible, unreproducible, and silently lost on the next rebuild. Everything
happens in a committed `tools/<module>Build/build.mjs`.

### The governing rule: minimal touch

Rewrite **only the text inside runs**. Copy every `<w:pPr>`, every `<w:rPr>`,
every table wrapper and every tab stop through byte for byte. Never rebuild a
paragraph from a synthesised `<w:pPr>`.

The first BM/AGM attempt extracted every `<w:p>` and re-joined them as a flat
list. That silently discarded the `<w:tbl>`/`<w:tr>`/`<w:tc>` wrappers, and a
ruled 11-row statutory table rendered as loose unboxed paragraphs. **Table
markup lives in the gaps *between* paragraph matches** — any walk over the
document must preserve those gaps.

### Five XML traps, all of which will bite

| Trap | What happens | What to do |
|---|---|---|
| **Self-closing paragraphs** (`<w:p …/>`) | A naive `<w:p …>…</w:p>` regex swallows the *next* real paragraph, shifting every index after it and corrupting loop anchors | Match the self-closing form **first** in the alternation |
| **Runs split by invisible metadata** | Word splits runs on `szCs`, complex-script font, `eastAsia` lang, explicit black `w:color` — grouping on raw `rPr` slices words apart, so a word decodes to the wrong vowel and a title never matches its token | Group adjacent runs by **visible** formatting only (bold/italic/underline/size/colour/vertAlign/strike/caps) |
| **A value spanning runs of different size** | Digit separators set 2pt smaller, a half-size space mid-title, a placeholder split across two fonts — no per-run rule can match it | Replace **across** runs: cut the match from wherever it lives, insert the token into the **first** run touched, so it inherits the formatting where the value started. Do **not** merge the runs — some paragraphs use differently-sized space runs as indentation, and flattening moves the text |
| **A Preeti syllable straddling a formatting boundary** | A name ends bold while the following syllable has its consonant inside the bold run and its vowel sign outside — decoding the groups separately produces different text than decoding the paragraph whole | Nudge the boundary a few characters until group-wise decode == whole-paragraph decode; report which paragraphs were repaired |
| **Preeti needs cross-run context** | Decoding run-by-run in isolation produces garbage ligatures | Decode per **formatting group**, not per run; preserve tabs across the decode with a sentinel character |

### Decoding Preeti

Use the `preeti-to-unicode` npm package inside the build folder. This is the
one deliberate exception to the repo's zero-npm rule — a hand-rolled Preeti
decoder is exactly the thing that burns days on ligature and reph reordering.

Keep a `corrections.mjs` of word-level fixes for genuine decode ambiguities
(ब/व is inherent to the encoding) and real source typos. **Verify each rule
against a correctly-decoded occurrence elsewhere in the same document** —
one over-broad rule turned a correct word into a wrong one and also corrupted
every word containing it as a substring.

---

## Phase 3 — Pagination: the part that looks done and isn't

The document is several sub-documents in one file, each of which must start on
its own sheet.

### Forcing a page break — three ways, only one works

| Method | Word | App preview | Verdict |
|---|---|---|---|
| A `<w:p>` containing `<w:br w:type="page"/>` | breaks, but the paragraph mark lands at the top of the new page and pushes everything down a line — enough to spill the last line of a full page | splits | ❌ causes spill |
| `<w:pageBreakBefore/>` in the paragraph's own `pPr` | correct | **ignored** — docx-preview reads that property only off a paragraph's *style*, so it renders every page as one section and the fit-to-page code shrinks the whole document onto one sheet | ❌ breaks preview |
| A **named style** carrying `<w:pageBreakBefore/>` | correct | correct | ✅ **use this** |

Base the style on Normal and set nothing else, so each paragraph's own direct
formatting still wins. Throw at build time if a section-start paragraph already
carries a `pStyle`.

### Don't inherit the source's spacer-paragraph pagination

These documents typically separate sections with **runs of blank paragraphs**,
which only land correctly because the sample client's text happens to fill each
page to the right height. A longer company name or one more director pushes a
signature block onto the next sheet. Replace those spacers with real breaks —
and drop trailing blanks at the very end, which otherwise land after the last
loop iteration and push it over.

Cross-check your section boundaries against the source's own
`<w:lastRenderedPageBreak/>` markers — they record where Word actually broke.
Note a section may legitimately span two sheets; don't force those.

---

## Phase 4 — Word vs the preview: verify BOTH, they disagree

**Microsoft Word is installed and drivable over COM** (CLAUDE.md §2). Use it.
This is not optional — structural assertions cannot see pagination.

```powershell
$w = New-Object -ComObject Word.Application; $w.Visible = $false
$doc = $w.Documents.Open($path, $false, $true)   # read-only
$doc.ComputeStatistics(2)                        # real page count
$p.Range.Information(3)                          # page a paragraph lands on
$doc.ExportAsFixedFormat($pdf, 17)               # Word's own PDF
$doc.Close(0); $w.Quit()
```

Copy `tools/registrarDocx/wordPages.ps1` — it asserts expected page counts and
can print a per-page paragraph map to show you *which* section overflows.

### The two renderers disagree, and each can look right while the other is wrong

A document that was **perfect in the preview and Save-as-PDF opened as 19 pages
instead of 10 in Word.** The preview scales each section to fit its sheet; Word
does not. Then fixing Word by tightening line height made the *preview* render
lines on top of each other. Both directions happened, in that order.

Known divergences:

- **Inherited paragraph defaults.** The source's `styles.xml` typically carries
  Word's stock `pPrDefault` (`after=200 line=276`) — 10pt after *every*
  paragraph plus 15% leading. On ~100 paragraphs with no explicit spacing that
  was ~1000pt (~14in) of whitespace in Word. Set `after=0`. **Keep `line` at
  276** — dropping it to 240 is fine in Word (which derives "single" from font
  metrics, leaving Devanagari matras room) and makes lines *touch* in the
  preview (which maps it to a flat CSS `line-height: 1.0`).
- **Font availability decides the metrics.** Naming a font that isn't installed
  means Word silently substitutes something with different metrics — worth 6 of
  those 19 pages by itself. **Check what's actually installed**
  (`Get-ChildItem C:\Windows\Fonts`) and name that. On this machine Mangal is
  absent and **Nirmala UI** is present; Nirmala UI ships with Windows 8+ and is
  the safe choice for Devanagari. (Never go back to Preeti — CLAUDE.md §15.)
- **A font swap must run last** if any earlier fix matches on literal font
  names. Same for a global font-size scale, if earlier fixes match on `w:sz`.

### Tune by measurement, and leave headroom

Sweep a value, measure each, and pick one with slack — not the first that
works. The default line height held at 10 pages up to `line=300` and turned 11
at 312; 276 was chosen for real margin. A fix that sits exactly on the limit
will break for the next client with a longer name.

---

## Phase 5 — Harnesses (commit them, or they don't exist)

Three layers, all committed:

1. **Structural assertions inside the build** — fail the build if the table
   count or cell count changes, if any sample value survives un-tokenised, or
   if the page-break style isn't applied exactly once per section. The
   "un-tokenised" check is what catches a field silently hard-coded to the
   sample client.
2. **A fidelity harness** — render the template with the source's own sample
   values and diff it line-by-line against the source. Assert the line count
   and the expected number of differences; every surviving difference must be a
   documented, deliberate normalisation. This catches what a page count cannot:
   the first BM/AGM build produced the right number of pages and was still
   wrong, with a table flattened and three pages hard-coded to the sample
   client. Print diffs to the console, never to a tracked file — the text is a
   real client's document.
3. **A Word page-count harness** — see Phase 4.

A harness that isn't committed doesn't exist: the previous BM/AGM pipeline
referenced one that was never committed, and the module threw on every import
for a month with nobody noticing.

---

## Phase 6 — Client data never reaches the repo

**This repo is public.** The build script needs the source's real sample values
(company name, registration number, chairman, addresses, dates) in order to
find and replace them — so those live in a **gitignored**
`tools/<module>Build/sample-values.local.mjs`, imported at run time. Both the
build and the fidelity harness fail with a clear message if it's absent.

This is not hypothetical: the first version held those values as string
literals in a committed script, and was caught only just before pushing.

Also gitignore generated samples (`sample-*.docx`, `sample-*.pdf`) and any diff
dump. Before committing, grep the staged diff for the client's name, PAN and
registration number.

---

## Phase 7 — Delivering

- Generate real sample documents at **several shapes** — the minimum case, the
  typical case, and a large one (e.g. 1 / 2 / 5 people) — and assert page
  counts for each. Loops and conditionals only break at the edges.
- **Export Word's own PDF and send that**, not just the `.docx`. It's what the
  user will actually print, and it removes an entire round-trip.
- Say plainly what you verified and what you didn't. Structural checks prove
  nothing *regressed*; only Word proves pagination; only the user can confirm
  wording and visual alignment.
- Update the module doc in the same commit, including the *why* — the next
  session will otherwise undo a deliberate decision that looks like a mistake.

---

## The short version

1. The firm's document is the spec — preserve, don't redesign.
2. Rewrite text inside runs; never rebuild a paragraph. Table markup lives in
   the gaps.
3. Group runs by visible formatting; replace tokens across runs.
4. Page breaks belong to a named **style**.
5. Word and the preview disagree — verify in both, every time.
6. Measure with Word over COM; tune by sweep; leave headroom.
7. Commit the build script and all three harnesses.
8. Real client values live in a gitignored file, never in a committed script.
9. Ask about every ambiguity; the source contains real mistakes.
