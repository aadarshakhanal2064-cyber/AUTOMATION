// ════════════════════════════════════════════
//  SECTION LOCK — the password gate on Financial Management
//
//  Added 2026-08-29 (user ask): "lock the financial management section so
//  that no one is able to see what's inside it, only a specific person — a
//  personalised lock, only openable with a password, resettable if the
//  password is forgotten."
//
//  WHAT THIS FILE IS AND IS NOT
//  ----------------------------
//  It is NOT the lock. The lock is in the database
//  (db/2026-08-29_financial_section_lock.sql): all 31 RLS policies on the
//  eight tables behind this section carry `and (select
//  private.fin_unlocked())`, so an ungranted or locked member reads zero
//  rows from PostgREST no matter what the browser does. This file is the
//  door in front of it — it exists so a locked member sees a password box
//  instead of five modules that silently render empty.
//
//  That ordering matters if this file is ever changed. Deleting it, or
//  flipping any flag in it from the console, does not open the section; it
//  only produces empty screens. There is no client-side state here that is
//  worth trusting, and none is trusted.
//
//  THREE FACTS DECIDE ACCESS, all read from fin_status():
//    granted      — an owner/admin ticked this member in Team
//    hasPassword  — they have chosen their own section password
//    unlockedUntil— the deadline on their current unlock (4 h server-side)
//
//  Everything else is presentation.
// ════════════════════════════════════════════
window.SectionLock = (function () {

  // The five modules behind the lock. js/tabs.js openModule() consults this
  // list, which is why it lives here rather than being spelled out there:
  // the set of locked modules and the set of locked tables are one decision,
  // and they are both named in the migration's header comment.
  const LOCKED_MODULES = ['serviceMemo', 'vatRegister', 'partyLedger', 'bankBook', 'finalAccount'];

  let state       = null;   // last fin_status() payload
  let resolveGate = null;   // resolve() of the promise require() is awaiting
  let view        = 'unlock';
  let built       = false;

  // ── Reading the lock ──────────────────────────────────────────────────

  // PostgREST's code for "no such function in the schema cache". It is the
  // one failure that means the lock is NOT INSTALLED, as opposed to not
  // answering — and the two must lead to opposite behaviour (see below).
  const RPC_MISSING = 'PGRST202';

  async function refresh() {
    try {
      const { data, error } = await window.sb.rpc('fin_status');
      if (error) throw error;
      // fin_status() returns null when the caller has no membership row.
      state = data || { granted: false, hasPassword: false, unlockedUntil: null };
    } catch (e) {
      if (e && e.code === RPC_MISSING) {
        // The migration has not been applied to this database yet, so there
        // is no lock to enforce: without private.fin_unlocked() the policies
        // never reference it and the eight tables are open to every member
        // regardless. Hiding the menu here would protect nothing and would
        // only take Financial Management away from everyone — which is
        // exactly what happened on 2026-08-29 when the migration went in
        // ahead of this file and the section rendered empty for the owner
        // too. So: no lock installed means behave as if this file did not
        // exist. This is NOT a general fail-open; it is the single case
        // where the database has told us there is nothing to gate.
        state = { notInstalled: true };
      } else {
        // Everything else fails CLOSED. A status call that did not answer is
        // not permission — and because the database is the real gate,
        // guessing "probably fine" would only produce empty modules anyway.
        console.warn('[SectionLock] status unavailable:', e);
        state = { granted: false, hasPassword: false, unlockedUntil: null, unreachable: true };
      }
    }
    applyVisibility();
    return state;
  }

  // With no lock installed the app must look exactly as it did before this
  // feature: menu shown, palette entries listed, openModule() straight
  // through. Both predicates therefore answer true in that one case.
  function notInstalled() { return !!(state && state.notInstalled); }

  function granted() { return notInstalled() || !!(state && state.granted); }

  // Computed from the deadline rather than read off the server's `unlocked`
  // flag, so a window that expires while the tab sits open closes by itself
  // — no polling, and no disagreement with what RLS will decide on the next
  // request.
  function unlocked() {
    if (notInstalled()) return true;
    if (!state || !state.granted || !state.unlockedUntil) return false;
    return new Date(state.unlockedUntil).getTime() > Date.now();
  }

  function isLockedModule(tab) { return LOCKED_MODULES.indexOf(tab) !== -1; }

  // ── The gate ──────────────────────────────────────────────────────────

  // Returns true when the caller may proceed into a locked module. Always
  // re-reads the status first: this is a gate, not a cache, and the extra
  // round-trip only happens on a menu click.
  async function require() {
    await refresh();
    if (unlocked()) return true;

    if (!granted()) {
      if (typeof showToast === 'function') {
        showToast(state && state.unreachable
          ? 'Could not check Financial Management access — try again in a moment.'
          : 'Financial Management is locked. An owner can grant you access in Team.',
          'error', 6000);
      }
      return false;
    }
    return openGate();
  }

  function openGate() {
    build();
    return new Promise(resolve => {
      resolveGate = resolve;
      showView(state.hasPassword ? 'unlock' : 'set');
      document.getElementById('sl-overlay').classList.add('open');
      // The overlay animates in over --dur-2; focusing before it is visible
      // scrolls the page in some browsers.
      setTimeout(focusFirstField, 80);
    });
  }

  function close(ok) {
    const ov = document.getElementById('sl-overlay');
    if (ov) ov.classList.remove('open');
    clearFields();
    const r = resolveGate;
    resolveGate = null;
    if (r) r(!!ok);
  }

  // Wired to the × so js/core/keyboard.js's Escape handler — which closes
  // the topmost overlay by clicking its own close button — resolves the
  // promise instead of leaving require() awaiting forever.
  function cancel() { close(false); }

  // ── Locking again ─────────────────────────────────────────────────────

  // Locking RELOADS the page, deliberately. Switching tabs only toggles a
  // panel's `active` class — every row Bank Entry or Service Memo rendered
  // is still sitting in the DOM, and the module globals still hold the
  // arrays behind them. "Lock now" that leaves the ledger one devtools
  // panel away is theatre. A reload is the only cheap way to be sure the
  // data is actually gone from this tab, and locking is always a deliberate
  // act, never something that fires under someone's hands.
  async function lockNow() {
    try { await window.sb.rpc('fin_lock'); } catch (e) { console.warn('[SectionLock] lock failed:', e); }
    if (window.DataCache) DataCache.invalidateAll();
    state = null;
    location.reload();
  }

  // Called by signOut() before the session ends, so the next person on a
  // shared machine starts locked even if the previous window had hours left.
  async function lockOnSignOut() {
    try { await window.sb.rpc('fin_lock'); } catch (e) { /* signing out anyway */ }
    state = null;
  }

  // ── Menu visibility ───────────────────────────────────────────────────
  //
  // Cosmetic by design: hiding the menu spares an ungranted member five
  // modules that would render empty, and it is not what stops them reading
  // the data. Never treat this as the control.
  function applyVisibility() {
    const trigger = document.getElementById('topbar-fin-trigger');
    if (trigger && trigger.parentElement) {
      trigger.parentElement.style.display = granted() ? '' : 'none';
    }
    // "Lock this section" needs the lock to exist, not merely to be open —
    // unlocked() answers true when nothing is installed, and offering a Lock
    // button there would reload the page to no effect.
    const lockBtn = document.getElementById('topbar-fin-lock');
    if (lockBtn) lockBtn.style.display = (!notInstalled() && unlocked()) ? '' : 'none';
  }

  async function init() {
    await refresh();
  }

  // ── The overlay ───────────────────────────────────────────────────────

  function slStatus(msg, type) { showStatus(msg, type, 'sl-status'); }
  // showStatus always renders a .status-box, so passing '' would leave an
  // empty coloured strip above the fields rather than clearing it.
  function slClearStatus() {
    const el = document.getElementById('sl-status');
    if (el) el.innerHTML = '';
  }

  function build() {
    if (built) return;
    built = true;

    const el = document.createElement('div');
    el.className = 'modal-overlay';
    el.id = 'sl-overlay';
    el.innerHTML = `
      <div class="modal sl-modal">
        <div class="modal-header">
          <h3 id="sl-title">Financial Management</h3>
          <button class="modal-close" onclick="SectionLock.cancel()">&times;</button>
        </div>
        <div class="modal-body">
          <p class="sl-lede" id="sl-lede"></p>
          <div id="sl-status"></div>

          <div id="sl-view-set" class="sl-view">
            <div class="form-group">
              <label for="sl-set-new">Choose a password</label>
              <input type="password" id="sl-set-new" autocomplete="new-password" placeholder="At least 4 characters">
            </div>
            <div class="form-group">
              <label for="sl-set-confirm">Confirm password</label>
              <input type="password" id="sl-set-confirm" autocomplete="new-password">
            </div>
            <div class="action-row">
              <button class="btn btn-outline" onclick="SectionLock.cancel()">Cancel</button>
              <button class="btn btn-primary" id="sl-set-btn" onclick="SectionLock.submitSet()">Set password &amp; open</button>
            </div>
          </div>

          <div id="sl-view-unlock" class="sl-view">
            <div class="form-group">
              <label for="sl-unlock-pw">Password</label>
              <input type="password" id="sl-unlock-pw" autocomplete="current-password">
            </div>
            <button type="button" class="sl-link" onclick="SectionLock.showView('reset')">Forgot your password?</button>
            <div class="action-row">
              <button class="btn btn-outline" onclick="SectionLock.cancel()">Cancel</button>
              <button class="btn btn-primary" id="sl-unlock-btn" onclick="SectionLock.submitUnlock()">Unlock</button>
            </div>
          </div>

          <div id="sl-view-reset" class="sl-view">
            <div class="form-group">
              <label for="sl-reset-acct">Your sign-in password</label>
              <input type="password" id="sl-reset-acct" autocomplete="current-password"
                     placeholder="The password you use to sign in to this app">
            </div>
            <div class="form-group">
              <label for="sl-reset-new">New section password</label>
              <input type="password" id="sl-reset-new" autocomplete="new-password" placeholder="At least 4 characters">
            </div>
            <div class="form-group">
              <label for="sl-reset-confirm">Confirm new password</label>
              <input type="password" id="sl-reset-confirm" autocomplete="new-password">
            </div>
            <div class="action-row">
              <button class="btn btn-outline" onclick="SectionLock.showView('unlock')">Back</button>
              <button class="btn btn-primary" id="sl-reset-btn" onclick="SectionLock.submitReset()">Reset &amp; open</button>
            </div>
          </div>
        </div>
      </div>`;
    document.body.appendChild(el);

    // Enter submits the view you are in. This is a single-purpose password
    // box, not one of the drawer forms the Enter-to-save rule in
    // js/core/keyboard.js deliberately leaves alone — there is nothing here
    // an accidental Enter could half-finish.
    el.querySelectorAll('input').forEach(inp => {
      inp.addEventListener('keydown', e => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const btn = document.querySelector('#sl-view-' + view + ' .action-row .btn-primary');
        if (btn && !btn.disabled) btn.click();
      });
    });
  }

  const LEDE = {
    set:    'This section is private. Choose a password — only you will know it, and you will be asked for it each working session.',
    unlock: 'This section is locked. Enter your Financial Management password to open it.',
    reset:  'Confirm the password you sign in to this app with, then choose a new section password.',
  };
  const TITLE = {
    set:    'Set your Financial Management password',
    unlock: 'Financial Management is locked',
    reset:  'Reset your section password',
  };

  function showView(name) {
    view = name;
    build();
    ['set', 'unlock', 'reset'].forEach(v => {
      const pane = document.getElementById('sl-view-' + v);
      if (pane) pane.style.display = v === name ? '' : 'none';
    });
    document.getElementById('sl-title').textContent = TITLE[name];
    document.getElementById('sl-lede').textContent  = LEDE[name];
    slClearStatus();
    focusFirstField();
  }

  function focusFirstField() {
    const inp = document.querySelector('#sl-view-' + view + ' input');
    if (inp) inp.focus();
  }

  function clearFields() {
    ['sl-set-new', 'sl-set-confirm', 'sl-unlock-pw',
     'sl-reset-acct', 'sl-reset-new', 'sl-reset-confirm'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    slClearStatus();
  }

  // Every failure the RPCs can return, in the firm's own words. Anything
  // unrecognised falls through to the raw code rather than being swallowed
  // — the same "never silently hide" idiom as wdActivityInScope().
  const MESSAGES = {
    no_access:            'You do not have access to Financial Management. An owner can grant it in Team.',
    no_password:          'No password is set yet for this section.',
    too_short:            'Password must be at least 4 characters.',
    bad_password:         'That password is not right.',
    bad_account_password: 'That is not your sign-in password.',
    not_admin:            'Only an owner or admin can change who has access.',
    not_found:            'That member is not in this organisation.',
  };

  function messageFor(res) {
    if (res && res.error === 'locked_out') {
      return 'Too many wrong tries. Try again in about 15 minutes, or use “Forgot your password?”.';
    }
    if (res && res.error === 'bad_password' && typeof res.attemptsLeft === 'number') {
      return `That password is not right. ${res.attemptsLeft} ${res.attemptsLeft === 1 ? 'try' : 'tries'} left before a 15-minute wait.`;
    }
    return (res && MESSAGES[res.error]) || (res && res.error) || 'Something went wrong.';
  }

  // ── Submit handlers ───────────────────────────────────────────────────

  async function callRpc(fn, args) {
    const { data, error } = await window.sb.rpc(fn, args);
    if (error) throw error;
    return data || { ok: false, error: 'no_response' };
  }

  function submitSet() {
    return WorkflowEngine.withBusyButton('sl-set-btn', 'Setting…', async () => {
      const pw = document.getElementById('sl-set-new').value;
      const cf = document.getElementById('sl-set-confirm').value;
      if (pw.length < 4)  return slStatus('❌ Password must be at least 4 characters.', 'error');
      if (pw !== cf)      return slStatus('❌ The two passwords do not match.', 'error');
      try {
        const res = await callRpc('fin_set_password', { p_current: null, p_new: pw });
        if (!res.ok) return slStatus('❌ ' + messageFor(res), 'error');
        await refresh();
        close(true);
        if (typeof showToast === 'function') showToast('Financial Management unlocked.', 'success');
      } catch (e) {
        slStatus('❌ ' + friendlyDbError(e), 'error');
      }
    });
  }

  function submitUnlock() {
    return WorkflowEngine.withBusyButton('sl-unlock-btn', 'Unlocking…', async () => {
      const pw = document.getElementById('sl-unlock-pw').value;
      if (!pw) return slStatus('❌ Enter your password.', 'error');
      try {
        const res = await callRpc('fin_unlock', { p_password: pw });
        if (!res.ok) {
          document.getElementById('sl-unlock-pw').value = '';
          focusFirstField();
          return slStatus('❌ ' + messageFor(res), 'error');
        }
        await refresh();
        close(true);
      } catch (e) {
        slStatus('❌ ' + friendlyDbError(e), 'error');
      }
    });
  }

  function submitReset() {
    return WorkflowEngine.withBusyButton('sl-reset-btn', 'Resetting…', async () => {
      const acct = document.getElementById('sl-reset-acct').value;
      const pw   = document.getElementById('sl-reset-new').value;
      const cf   = document.getElementById('sl-reset-confirm').value;
      if (!acct)         return slStatus('❌ Enter the password you sign in with.', 'error');
      if (pw.length < 4) return slStatus('❌ New password must be at least 4 characters.', 'error');
      if (pw !== cf)     return slStatus('❌ The two new passwords do not match.', 'error');
      try {
        const res = await callRpc('fin_reset_password', { p_account_password: acct, p_new: pw });
        if (!res.ok) return slStatus('❌ ' + messageFor(res), 'error');
        await refresh();
        close(true);
        if (typeof showToast === 'function') showToast('Section password reset. Financial Management unlocked.', 'success');
      } catch (e) {
        slStatus('❌ ' + friendlyDbError(e), 'error');
      }
    });
  }

  return {
    init, refresh, require, granted, unlocked, isLockedModule,
    lockNow, lockOnSignOut, applyVisibility,
    showView, cancel, submitSet, submitUnlock, submitReset,
    LOCKED_MODULES,
  };
})();
