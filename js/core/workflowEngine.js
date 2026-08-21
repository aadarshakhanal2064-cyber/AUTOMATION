// ════════════════════════════════════════════
//  WORKFLOW ENGINE
//  Generalizes the autosave/completion-indicator/debounced-live-preview/
//  zoom pattern bmAgmMinutes.js already built and proved working, so a
//  future step-by-step module (Section 51, Financial Statements, ...) gets
//  it for free instead of re-deriving it from scratch.
// ════════════════════════════════════════════
window.WorkflowEngine = (function () {
  // Wires a panel's own input/change events to one callback, so a module
  // doesn't need to attach the same two listeners itself.
  function attachFormWatcher(panelEl, onChange) {
    if (!panelEl) return;
    const handler = e => { if (e.target.matches('input, select, textarea')) onChange(e); };
    panelEl.addEventListener('input', handler);
    panelEl.addEventListener('change', handler);
  }

  // Wraps a slow async operation (e.g. re-rendering a live preview) so rapid
  // repeated triggers only let the LAST one take effect — an in-flight run
  // that finishes after a newer one started is discarded via the isCurrent()
  // check it's passed, rather than overwriting fresher results. Generalizes
  // bmAgmMinutes.js's bmSchedulePreviewRefresh/bmPreviewRenderToken pattern.
  function createDebouncedRefresh(asyncFn, debounceMs) {
    let timer = null;
    let token = 0;

    async function run() {
      const myToken = ++token;
      await asyncFn(() => myToken === token);
    }
    function schedule() {
      clearTimeout(timer);
      timer = setTimeout(run, debounceMs || 500);
    }
    return { schedule };
  }

  // Debounced localStorage draft, never sent to the backend. `collect()`
  // returns a JSON-serializable snapshot of form state; `restore(draft)`
  // re-applies it — both caller-supplied since "form state" varies per
  // module (e.g. dynamic repeatable rows a plain field-id sweep can't
  // capture on its own).
  function createAutosave(storageKey, { collect, restore, debounceMs }) {
    let timer = null;

    function save() {
      try { localStorage.setItem(storageKey, JSON.stringify(collect())); }
      catch (e) { /* best-effort only — a full/unavailable localStorage shouldn't break the form */ }
    }
    function scheduleSave() {
      clearTimeout(timer);
      timer = setTimeout(save, debounceMs || 600);
    }
    function clear() {
      try { localStorage.removeItem(storageKey); } catch (e) { /* ignore */ }
    }
    function load() {
      let draft;
      try { draft = JSON.parse(localStorage.getItem(storageKey) || 'null'); }
      catch (e) { return false; }
      if (!draft) return false;
      restore(draft);
      return true;
    }
    return { scheduleSave, save, clear, load };
  }

  // Counts how many of `requiredFieldIds` are non-empty and reports it in
  // `elId` — the "N of M required fields set" / ready badge pattern.
  function updateCompletionIndicator(elId, requiredFieldIds, readyText) {
    const el = document.getElementById(elId);
    if (!el) return;
    const done = requiredFieldIds.filter(id => (document.getElementById(id).value || '').trim()).length;
    el.textContent = done === requiredFieldIds.length
      ? (readyText || '✅ Ready')
      : done + ' of ' + requiredFieldIds.length + ' required fields set';
  }

  // Live-preview zoom (CSS transform scale), clamped to [min, max].
  function createZoomControl(targetEl, labelEl, options) {
    const min = (options && options.min) || 50;
    const max = (options && options.max) || 150;
    const step = (options && options.step) || 10;
    let level = (options && options.initial) || 100;

    function apply() {
      if (targetEl) targetEl.style.transform = 'scale(' + (level / 100) + ')';
      if (labelEl) labelEl.textContent = level + '%';
    }
    function set(newLevel) {
      level = Math.max(min, Math.min(max, newLevel));
      apply();
    }
    apply();
    return { set, zoomIn: () => set(level + step), zoomOut: () => set(level - step), getLevel: () => level };
  }

  // Status lifecycle for record-tracking modules (File In Out and
  // Audit Report Finalization): one definition of statuses + display
  // metadata, and one
  // transition() choke point every status change goes through — so the badge
  // a table shows, the update that's persisted, and the audit entry written
  // can never disagree. `onTransition(record, from, to, ctx)` is
  // caller-supplied and does the actual persistence + audit write.
  function createStatusFlow({ statuses, onTransition }) {
    function meta(key) {
      return statuses[key] || { label: key || '—', icon: '❔', badgeClass: '' };
    }
    function badgeHtml(key) {
      const m = meta(key);
      return `<span class="log-badge ${m.badgeClass}">${m.icon} ${escHtml(m.label)}</span>`;
    }
    async function transition(record, toStatus, ctx) {
      const from = record.status;
      // Same-status is only a no-op when there is nothing else to persist.
      // With a patch it MUST still run: File In Out's second partial outtake
      // (partial → partial) and an undo of one-of-several partials both keep
      // the status while changing `outtakes` — the old unconditional early
      // return silently dropped that patch, then reported success and
      // repainted the row from the server without it (found in Stage 3's
      // Phase 0 trace; shipped as real data loss).
      if (from === toStatus && !(ctx && ctx.patch)) return record;
      return onTransition(record, from, toStatus, ctx || {});
    }
    return { meta, badgeHtml, transition, statusKeys: Object.keys(statuses) };
  }

  // One choke point for "which client is this screen showing?".
  //
  // Every module used to fill its fields from the picked client and nothing
  // else — so anything the NEW client didn't supply kept the OLD client's
  // value, and any loader that returned early (no saved sheet for this
  // client/year) left the previous client's grid on screen under the new
  // client's name. This inverts that: clear() runs unconditionally BEFORE
  // load(), so no path through the loader — early return, thrown error,
  // slow network — can leak the previous client's data.
  //
  //   clear(reason)  'client'  → blank identity fields AND loaded data
  //                  'context' → blank loaded data only (same client, new
  //                              fiscal year / scheme / method)
  //   load(client, reason)     fill from the record + fetch what's saved
  //
  // Because the surface is already blank when load() runs, load() never
  // needs to clear anything itself — that is the whole point of the split.
  function createClientScope({ clear, load }) {
    let current = null;

    function select(client) {
      clear('client');
      current = client || null;
      if (current) load(current, 'client');
    }
    // Fiscal year / scheme / method changed — same client, different context.
    function refresh() {
      if (!current) { clear('context'); return; }
      clear('context');
      load(current, 'context');
    }
    // Typing freely in the search box instead of picking a result: the
    // identity on screen no longer matches a real record, so nothing may
    // save or carry forward against the old id.
    function invalidate() { current = null; }
    function reset() { clear('client'); current = null; }

    return { select, refresh, invalidate, reset, get: () => current, id: () => (current && current.id != null ? current.id : null) };
  }

  // One in-flight contract for every async button (Stage 3, 2026-08-21).
  // Phase 0 found exactly 6 call sites in the whole app that disabled a
  // button during a save and ZERO that changed its label — every drawer's
  // Save stayed clickable, so a double-click submitted twice and a slow
  // write read as a frozen screen. This is the choke point that fixes the
  // class: disables, swaps the label for a spinner + busy text, restores in
  // finally, and swallows re-entry while busy (the double-click guard is the
  // dataset flag, not the disabled attribute, because a programmatic second
  // call never sees the repaint). The caller's fn does the actual work and
  // its rejection still propagates after the button is restored.
  async function withBusyButton(btnOrId, busyLabel, fn) {
    const el = typeof btnOrId === 'string' ? document.getElementById(btnOrId) : btnOrId;
    if (!el) return fn();
    if (el.dataset.busy) return;
    el.dataset.busy = '1';
    const prevHtml = el.innerHTML;
    const prevDisabled = el.disabled;
    el.disabled = true;
    el.innerHTML = `<span class="spinner"></span> ${escHtml(busyLabel || 'Saving…')}`;
    try {
      return await fn();
    } finally {
      delete el.dataset.busy;
      el.disabled = prevDisabled;
      el.innerHTML = prevHtml;
    }
  }

  return { attachFormWatcher, createDebouncedRefresh, createAutosave, updateCompletionIndicator, createZoomControl, createStatusFlow, createClientScope, withBusyButton };
})();
