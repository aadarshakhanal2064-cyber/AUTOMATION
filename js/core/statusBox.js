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

// Toast — the same status vocabulary, but fixed-position and auto-dismissing
// (Stage 3, 2026-08-21). A StatusBox is a static div wherever the panel put
// it; Phase 0 found the message routinely renders off-screen (the registrar
// builders write it ~90 form rows BELOW the buttons), so a successful save
// could be invisible. A toast is for exactly those confirmations: visible
// regardless of scroll, gone by itself, never something the user must clear.
// Deliberately an EXTENSION of StatusBox, not a parallel system — same
// .status-box classes, same types, one visual language.
function showToast(msg, type, ms) {
  let stack = document.getElementById('toast-stack');
  if (!stack) {
    stack = document.createElement('div');
    stack.id = 'toast-stack';
    document.body.appendChild(stack);
  }
  const t = document.createElement('div');
  t.className = `status-box status-${type || 'success'} toast`;
  t.innerHTML = msg;
  stack.appendChild(t);
  requestAnimationFrame(() => t.classList.add('toast-in'));
  setTimeout(() => {
    t.classList.remove('toast-in');
    setTimeout(() => t.remove(), 250);
  }, ms || 4500);
}
