// ════════════════════════════════════════════
//  STATUS BOX
//  Single place that builds the ".status-box status-{type}" markup, so every
//  module's own "xxStatus()" helper (bmStatus, vatStatus, ...) is a one-line
//  wrapper pointing at its own status element instead of a separate copy of
//  this rendering logic.
// ════════════════════════════════════════════
function showStatus(msg, type, targetId) {
  const el = document.getElementById(targetId || 'status-area');
  if (el) el.innerHTML = `<div class="status-box status-${type}">${msg}</div>`;
}
