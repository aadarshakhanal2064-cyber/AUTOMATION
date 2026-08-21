// ════════════════════════════════════════════
//  GLOBAL KEYBOARD — Esc and Ctrl/Cmd+S (Stage 6, 2026-08-21)
//
//  Phase 0 found no Escape handler on any of the 17 overlays and no save
//  shortcut anywhere. One document-level handler covers all of them:
//
//  · Escape closes the TOPMOST open overlay — by clicking its own × button,
//    so every module's close function (and whatever cleanup it does) runs
//    exactly as if the mouse had done it. Autocomplete lists own their
//    Escape first (searchEngine stops propagation while a list is open),
//    so Esc in a picker closes the list, and a second Esc the drawer.
//  · Ctrl/Cmd+S clicks the open overlay's primary action button — the same
//    Save the user sees, complete with the busy-button contract. With no
//    overlay open it only suppresses the browser's save-page dialog, which
//    is never what anyone wants inside this app.
//
//  Enter-to-save was deliberately NOT added for drawer forms: Enter already
//  means "choose" in the autocompletes and an accidental Enter firing a
//  save (and its duplicate-confirm dialog) mid-entry is worse than no
//  shortcut. Ctrl+S is the deliberate equivalent.
//
//  The command palette (js/core/commandPalette.js) claims its own keys
//  while open; this handler defers to it.
// ════════════════════════════════════════════
(function () {
  function topOverlay() {
    const open = Array.from(document.querySelectorAll('.modal-overlay.open, .cd-modal.open'));
    if (!open.length) return null;
    // Highest z-index wins; equal z falls back to DOM order (later = on top).
    return open.sort((a, b) =>
      (parseInt(getComputedStyle(a).zIndex, 10) || 0) - (parseInt(getComputedStyle(b).zIndex, 10) || 0)
    ).pop();
  }

  document.addEventListener('keydown', (e) => {
    if (window.CommandPalette && CommandPalette.isOpen()) return;

    if (e.key === 'Escape') {
      const ov = topOverlay();
      if (!ov) return;
      const closeBtn = ov.querySelector('.modal-close, .cd-modal-close');
      if (closeBtn) closeBtn.click();
      else ov.classList.remove('open');
    } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      const ov = topOverlay();
      if (!ov) return;
      const btn = Array.from(ov.querySelectorAll('.action-row .btn-primary'))
        .find(b => b.offsetParent !== null && !b.disabled);
      if (btn) btn.click();
    }
  });
})();
