// ════════════════════════════════════════════
//  STATUS BOX
//  Single place that builds the ".status-box status-{type}" markup, so every
//  module's own "xxStatus()" helper (bmStatus, vatStatus, ...) is a one-line
//  wrapper pointing at its own status element instead of a separate copy of
//  this rendering logic.
// ════════════════════════════════════════════
// targetId is required — it used to default to Send Document's own
// 'status-area' div, which no longer exists. Every caller passes its own
// prefixed id, so a silent no-op here would hide a typo rather than surface it.
function showStatus(msg, type, targetId) {
  const el = document.getElementById(targetId);
  if (el) el.innerHTML = `<div class="status-box status-${type}">${msg}</div>`;
  else console.warn('showStatus: no element with id', targetId);
}
