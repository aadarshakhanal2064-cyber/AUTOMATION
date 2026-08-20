# ════════════════════════════════════════════
#  BM/AGM MINUTES — Word pagination check
#
#  Opens .docx files in Word and reports the REAL page count, optionally
#  asserting an expected one. This exists because nothing else can see
#  pagination: the template once opened as 19 pages instead of 10 — every
#  sub-document spilling onto a second sheet — while the app's own preview
#  and Save-as-PDF looked perfect (the preview scales each section to fit
#  the sheet; Word does not) and every structural assertion in build.mjs
#  passed. Structural checks prove nothing regressed; only Word proves it
#  paginates.
#
#  Expected counts, one sub-document per sheet:
#    board-change toggle OFF, 1 shareholder ....  7
#    board-change toggle ON,  2 directors ...... 10
#    board-change toggle ON,  5 directors ...... 13
#  (7 fixed sections + 1 board-change minutes + one declaration per attendee)
#
#  Usage:
#    powershell -File wordPages.ps1 sample-full.docx
#    powershell -File wordPages.ps1 sample-full.docx=10 sample-single-shareholder.docx=7
#    powershell -File wordPages.ps1 -Map sample-five.docx      # per-page breakdown
#
#  Word is opened read-only and always closed, so it is safe to run against
#  a file you have open elsewhere.
# ════════════════════════════════════════════
param(
  [switch]$Map,
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$Targets
)

if (-not $Targets -or $Targets.Count -eq 0) {
  Write-Output 'Usage: wordPages.ps1 [-Map] <file.docx>[=expectedPages] ...'
  exit 2
}

$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
$failed = 0

try {
  foreach ($t in $Targets) {
    $path = $t
    $expect = $null
    if ($t -match '^(.*)=(\d+)$') { $path = $Matches[1]; $expect = [int]$Matches[2] }
    if (-not [System.IO.Path]::IsPathRooted($path)) { $path = Join-Path (Get-Location) $path }
    if (-not (Test-Path $path)) { Write-Output ("MISSING  {0}" -f $path); $failed++; continue }

    $doc = $word.Documents.Open($path, $false, $true)
    $pages = $doc.ComputeStatistics(2)   # wdStatisticPages

    if ($null -eq $expect) {
      Write-Output ("{0,-34} {1,3} pages" -f (Split-Path $path -Leaf), $pages)
    } elseif ($pages -eq $expect) {
      Write-Output ("OK       {0,-34} {1,3} pages" -f (Split-Path $path -Leaf), $pages)
    } else {
      Write-Output ("FAIL     {0,-34} {1,3} pages, expected {2}" -f (Split-Path $path -Leaf), $pages, $expect)
      $failed++
    }

    if ($Map) {
      $prev = 0
      foreach ($p in $doc.Paragraphs) {
        $pg = $p.Range.Information(3)    # wdActiveEndPageNumber
        if ($pg -ne $prev) {
          $txt = $p.Range.Text.Trim()
          Write-Output ("    page {0,2} <- {1}" -f $pg, $txt.Substring(0, [Math]::Min(50, $txt.Length)))
          $prev = $pg
        }
      }
    }
    $doc.Close(0)
  }
} finally {
  $word.Quit()
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null
}

if ($failed -gt 0) { exit 1 }
