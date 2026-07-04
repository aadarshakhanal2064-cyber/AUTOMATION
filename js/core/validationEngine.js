// ════════════════════════════════════════════
//  VALIDATION ENGINE
//  Generalizes vatReturn.js's vatRowWarnings() pattern: a list of
//  independent rule functions, each returning null (no issue), one
//  {severity, message} warning, or an array of them — run once, the exact
//  same result array feeding both a live review UI and a submit-blocking
//  gate, so the two can never disagree. Any future review-table module
//  (Section 51, Financial Statements) reuses this instead of re-deriving
//  VAT's single-source-of-truth shape from scratch.
// ════════════════════════════════════════════
window.ValidationEngine = (function () {
  function run(rules, data) {
    const warnings = [];
    for (const rule of rules) {
      const result = rule(data);
      if (!result) continue;
      if (Array.isArray(result)) warnings.push(...result.filter(Boolean));
      else warnings.push(result);
    }
    return warnings;
  }

  function hasBlocking(warnings) {
    return warnings.some(w => w.severity === 'block');
  }

  // Maps a 0-100 OCR (or any) confidence score to a High/Medium/Low tier —
  // generalizes vatConfidenceTier, which was never actually VAT-specific.
  function confidenceTier(confidence) {
    if (confidence >= 80) return { tier: 'high', icon: '🟢', label: 'High' };
    if (confidence >= 50) return { tier: 'medium', icon: '🟡', label: 'Medium' };
    return { tier: 'low', icon: '🔴', label: 'Low' };
  }

  // Summarizes a warnings array as one status badge: a clean checkmark, or
  // a count + severity icon with every message available on hover.
  function statusHtml(warnings) {
    if (!warnings.length) return '<span title="No issues found">✅</span>';
    const icon = hasBlocking(warnings) ? '🔴' : '🟡';
    const tooltip = warnings.map(w => (w.severity === 'block' ? '[blocking] ' : '') + w.message).join('\n');
    return `<span title="${escHtml(tooltip)}">${icon} ${warnings.length} issue${warnings.length > 1 ? 's' : ''}</span>`;
  }

  return { run, hasBlocking, confidenceTier, statusHtml };
})();
