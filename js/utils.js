// ════════════════════════════════════════════
//  UTILS — shared helper functions
// ════════════════════════════════════════════

function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function showStatus(msg, type) {
  document.getElementById('status-area').innerHTML = `<div class="status-box status-${type}">${msg}</div>`;
}

// ════════════════════════════════════════════
//  FUZZY STRING SIMILARITY
//  Returns 0.0 (completely different) to 1.0 (identical)
//  Uses Levenshtein edit distance normalised by string length
// ════════════════════════════════════════════
function stringSimilarity(a, b) {
  if (a === b) return 1.0;
  if (!a.length || !b.length) return 0.0;

  // Build Levenshtein distance matrix
  const dp = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      if (a[i-1] === b[j-1]) {
        dp[i][j] = dp[i-1][j-1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
      }
    }
  }

  const dist = dp[a.length][b.length];
  const maxLen = Math.max(a.length, b.length);
  return 1 - dist / maxLen;
}
