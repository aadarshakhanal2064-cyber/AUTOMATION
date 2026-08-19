// ════════════════════════════════════════════
//  BOOT
// ════════════════════════════════════════════
window.addEventListener('load', () => {
  const showSignInScreen = () => {
    document.getElementById('loading-screen').style.display = 'none';
    document.getElementById('recovery-wrap').style.display = 'none';
    document.getElementById('invite-wrap').style.display = 'none';
    document.getElementById('auth-section-wrap').style.display = 'flex';
    document.getElementById('auth-email').focus();
  };

  const showRecoveryScreen = () => {
    document.getElementById('loading-screen').style.display = 'none';
    document.getElementById('auth-section-wrap').style.display = 'none';
    document.getElementById('invite-wrap').style.display = 'none';
    // Belt and braces: if a stale session from this browser was already
    // shown before the recovery session took over, don't leave the app
    // visible underneath.
    document.getElementById('app-section').style.display = 'none';
    document.getElementById('recovery-wrap').style.display = 'flex';
    document.getElementById('recovery-password').focus();
  };

  // A recovery link's session reliably reaches us — but usually relabelled as
  // a plain INITIAL_SESSION, not the PASSWORD_RECOVERY event Supabase's docs
  // describe. Reason: auth.js is deliberately the LAST script to run (§2),
  // long after config.js's createClient() already kicked off Supabase's own
  // URL processing, and onAuthStateChange only guarantees a synthetic
  // INITIAL_SESSION to each NEW subscriber — not a replay of whichever event
  // originally fired before we were listening. (This is exactly what
  // happened live: a recovery link opened straight into the app.) So the URL
  // itself decides, not the event name — read from window.AUTH_URL_PARAMS
  // (config.js), captured before Supabase could touch it.
  let isRecoveryLink = window.AUTH_URL_PARAMS.hash.get('type') === 'recovery'
                     || window.AUTH_URL_PARAMS.query.get('type') === 'recovery';
  const linkErrorDesc = window.AUTH_URL_PARAMS.hash.get('error_description')
                     || window.AUTH_URL_PARAMS.query.get('error_description');

  // Supabase Auth owns session state now — onAuthStateChange fires once on
  // load with whatever session it restored (INITIAL_SESSION), then again on
  // every subsequent sign-in/out. TOKEN_REFRESHED (Supabase's own ~1hr JWT
  // refresh) is intentionally ignored here — the app is already initialized
  // by that point, nothing to redo.
  // An invitation link is decided by the URL for the same reason a recovery
  // link is (see above): auth.js runs last, so the event name cannot be
  // relied on. Read from the snapshot config.js captured before Supabase
  // could rewrite the URL.
  const inviteToken = window.AUTH_URL_PARAMS.query.get('invite')
                   || window.AUTH_URL_PARAMS.hash.get('invite');

  window.sb.auth.onAuthStateChange((event, session) => {
    // Checked before everything else: someone opening an invitation must land
    // on "join this organisation", not on a sign-in form or — if they happen
    // to still have an old session — straight into an app they have not
    // joined yet.
    if (inviteToken && event !== 'SIGNED_OUT') {
      showInviteScreen(inviteToken);
      // Prefill the address if a session is already open, so an existing user
      // accepting an invite does not retype it.
      if (session && session.user && session.user.email) {
        document.getElementById('invite-email').value = session.user.email;
      }
      return;
    }
    if (linkErrorDesc) {
      // An expired or already-used recovery/magic link redirects here with
      // an error instead of a session — surface it once instead of silently
      // showing a blank sign-in form with no explanation.
      showSignInScreen();
      authStatus('❌ ' + decodeURIComponent(linkErrorDesc.replace(/\+/g, ' ')), 'error');
      return;
    }
    if (isRecoveryLink && (event === 'INITIAL_SESSION' || event === 'SIGNED_IN' || event === 'PASSWORD_RECOVERY')) {
      session ? showRecoveryScreen() : showSignInScreen();
      return;
    }
    if (event === 'INITIAL_SESSION') {
      session ? afterSupabaseSignIn(session) : showSignInScreen();
    } else if (event === 'SIGNED_IN') {
      afterSupabaseSignIn(session);
    } else if (event === 'PASSWORD_RECOVERY') {
      showRecoveryScreen();
    } else if (event === 'SIGNED_OUT') {
      // Skip if the Access Denied screen is up — that sign-out is ours
      // (afterSupabaseSignIn rejecting a non-member) and the denial message
      // must stay visible rather than bouncing back to the sign-in screen.
      if (document.getElementById('access-denied-wrap').style.display !== 'flex') showSignInScreen();
    }
  });

  // submitNewPassword() calls this once the password is actually set —
  // without it, isRecoveryLink would still read true for the rest of this
  // page load (the URL doesn't change), and a later event (a token refresh,
  // a manual reload of the SPA state) would bounce the user right back to
  // this screen even after they're done with it.
  window._clearRecoveryLinkFlag = () => { isRecoveryLink = false; };

  // Safety timeout — if Supabase's client never resolves a session state
  // (e.g. network issue), fall back to the sign-in screen rather than hang.
  setTimeout(() => {
    if (document.getElementById('loading-screen').style.display !== 'none') showSignInScreen();
  }, 5000);
});

// ════════════════════════════════════════════
//  AUTHENTICATION — Supabase Auth, email + password
//
//  Google OAuth was dropped on 2026-08-01. It had only ever been the
//  identity provider plus the source of session.provider_token, the raw
//  Drive/Gmail access token; once Send Document was removed and Billing
//  switched to a PDF download, nothing called a Google API at all, and a
//  whole GIS silent-renewal loop plus a Client ID setup modal existed to
//  keep a token alive that no longer had a consumer.
//
//  RLS did not have to change: private.jwt_email() reads
//  auth.jwt() ->> 'email', which an email/password session carries exactly
//  the same way a Google one did. The provider is interchangeable; the
//  app_users membership check below is what actually grants access.
//
//  Accounts are created by an admin in the Supabase dashboard — signup is
//  disabled there on purpose. There is no self-serve "Forgot password?" link
//  in the app: the firm has a handful of staff and Supabase's built-in SMTP
//  is rate-limited to a few mails an hour, so an admin triggers the reset
//  (Authentication → Users → Send password recovery) and the user completes
//  it on the "Set a new password" screen below (submitNewPassword()).
// ════════════════════════════════════════════
function authStatus(msg, type) { showStatus(msg, type, 'auth-status'); }

async function signIn() {
  const email    = document.getElementById('auth-email').value.trim();
  const password = document.getElementById('auth-password').value;
  if (!email || !password) return authStatus('Enter your email and password.', 'info');

  const btn = document.getElementById('auth-submit');
  btn.disabled = true;
  authStatus('<span class="spinner spinner-navy"></span> Signing in…', 'searching');

  // Only the failure path is handled here — on success onAuthStateChange
  // fires SIGNED_IN and afterSupabaseSignIn() takes over the whole screen.
  const { error } = await window.sb.auth.signInWithPassword({ email, password });
  if (error) {
    btn.disabled = false;
    authStatus('❌ ' + escHtml(error.message), 'error');
  }
}

// Self-serve password reset. This REVERSES the "there is deliberately no
// Forgot password link" decision, which was made when the firm had a handful
// of staff and one admin could reset them by hand — that does not survive ten
// firms and ~60 users, none of whose admins have Supabase dashboard access.
//
// The recovery LINK half of this already existed (showRecoveryScreen /
// submitNewPassword); all that was missing was a way to ask for one.
//
// Uses Supabase's built-in SMTP, which is rate-limited to a few messages an
// hour ACROSS THE WHOLE PROJECT. That is why the message below says to wait
// rather than implying the address was wrong, and why invitations deliberately
// do not send mail at all (js/orgMembers.js). Custom SMTP is the fix and is
// Stage 5 infrastructure work.
async function sendPasswordReset() {
  const email = document.getElementById('auth-email').value.trim();
  if (!email) return authStatus('Enter your email address first, then click Forgot password.', 'info');

  authStatus('<span class="spinner spinner-navy"></span> Sending reset email…', 'searching');

  // redirectTo must land back on this app so the recovery link opens the
  // "Set a new password" screen rather than Supabase's own page.
  const { error } = await window.sb.auth.resetPasswordForEmail(email, {
    redirectTo: location.origin + location.pathname,
  });

  if (error) return authStatus('❌ ' + escHtml(error.message), 'error');

  // Deliberately does NOT confirm whether the address exists — that would let
  // anyone test which of a firm's staff have accounts.
  authStatus('✅ If that address has an account, a reset link is on its way. '
           + 'Check spam too. If nothing arrives in a few minutes, the mail '
           + 'limit may have been reached — wait an hour and try again.', 'success');
}

// ── Accepting an invitation ─────────────────────────────────────────────────
//
// Reached by opening ?invite=<token>. The person may not have an account yet,
// so this screen offers "set a password and join" and calls signUp() first.
//
// Signup being enabled is not a hole: an auth account with no org_members row
// passes every policy's first test and fails the second, so it can read and
// write nothing anywhere. Access begins at accept_invitation(), which is the
// only path that creates a membership.
function inviteStatus(msg, type) { showStatus(msg, type, 'invite-status'); }

function showInviteScreen(token) {
  document.getElementById('loading-screen').style.display = 'none';
  document.getElementById('app-section').style.display = 'none';
  document.getElementById('access-denied-wrap').style.display = 'none';
  document.getElementById('recovery-wrap').style.display = 'none';
  document.getElementById('auth-section-wrap').style.display = 'none';
  document.getElementById('invite-wrap').style.display = 'flex';
  document.getElementById('invite-token').value = token;
}

async function submitInvite() {
  const token = document.getElementById('invite-token').value;
  const email = document.getElementById('invite-email').value.trim();
  const pw    = document.getElementById('invite-password').value;
  const pw2   = document.getElementById('invite-password-confirm').value;

  if (!email) return inviteStatus('Enter the email address the invitation was sent to.', 'info');
  if (pw.length < 8) return inviteStatus('Choose a password of at least 8 characters.', 'info');
  if (pw !== pw2) return inviteStatus("The two passwords don't match.", 'info');

  const btn = document.getElementById('invite-submit');
  btn.disabled = true;
  inviteStatus('<span class="spinner spinner-navy"></span> Creating your account…', 'searching');

  // Sign up, or sign in if the account already exists — an invited colleague
  // may already have had an account (e.g. a previous firm, or a re-invite).
  let { error } = await window.sb.auth.signUp({ email, password: pw });
  if (error && /already registered/i.test(error.message)) {
    ({ error } = await window.sb.auth.signInWithPassword({ email, password: pw }));
    if (error) {
      btn.disabled = false;
      return inviteStatus('❌ That address already has an account, and this password does not match it. '
                        + 'Sign in instead, or use Forgot password.', 'error');
    }
  } else if (error) {
    btn.disabled = false;
    return inviteStatus('❌ ' + escHtml(error.message), 'error');
  }

  // If the project requires email confirmation there is no session yet, so the
  // membership cannot be created until they confirm. Say so plainly instead of
  // failing with a confusing "must be signed in".
  const { data: { session } } = await window.sb.auth.getSession();
  if (!session) {
    btn.disabled = false;
    return inviteStatus('✅ Account created. Please confirm your email address from the message just sent, '
                      + 'then open this invitation link again to finish joining.', 'success');
  }

  inviteStatus('<span class="spinner spinner-navy"></span> Joining the organisation…', 'searching');
  const { data, error: accErr } = await window.sb.rpc('accept_invitation', { p_token: token });
  if (accErr) {
    btn.disabled = false;
    return inviteStatus('❌ ' + escHtml(accErr.message), 'error');
  }

  const joined = Array.isArray(data) ? data[0] : data;
  inviteStatus(`✅ Joined ${escHtml((joined && joined.org_name) || 'your organisation')}. Loading…`, 'success');

  // Clear the token from the address bar so a shoulder-surfed or bookmarked
  // URL cannot be replayed, then boot normally.
  history.replaceState(null, '', location.pathname);
  await afterSupabaseSignIn(session);
}

function recoveryStatus(msg, type) { showStatus(msg, type, 'recovery-status'); }

// The other half of "Accounts are admin-created" (see the block comment
// above): an admin can't type a password into the Supabase dashboard for an
// existing user, only trigger a recovery email — so this screen is what
// actually lets someone set one. Reached only via the PASSWORD_RECOVERY
// event above, never by direct navigation.
async function submitNewPassword() {
  const pw  = document.getElementById('recovery-password').value;
  const pw2 = document.getElementById('recovery-password-confirm').value;
  if (pw.length < 8) return recoveryStatus('Password must be at least 8 characters.', 'info');
  if (pw !== pw2) return recoveryStatus("Passwords don't match.", 'info');

  const btn = document.getElementById('recovery-submit');
  btn.disabled = true;
  recoveryStatus('<span class="spinner spinner-navy"></span> Setting password…', 'searching');

  const { data, error } = await window.sb.auth.updateUser({ password: pw });
  if (error) {
    btn.disabled = false;
    recoveryStatus('❌ ' + escHtml(error.message), 'error');
    return;
  }

  // updateUser() doesn't itself fire SIGNED_IN, so the recovery session
  // established by the link would otherwise leave the user stuck on this
  // screen with a valid session and nowhere to go. Route in directly —
  // afterSupabaseSignIn only ever reads session.user, and data.user here is
  // the same full User object a real session would carry.
  document.getElementById('recovery-form').reset();
  if (window._clearRecoveryLinkFlag) window._clearRecoveryLinkFlag();
  await afterSupabaseSignIn({ user: data.user });
}

function signOut() {
  window.currentUser = null;
  window.clientsList = [];
  // Cached ledger rows are this user's data as much as clientsList is — they
  // must not survive into the next person's session on a shared machine.
  DataCache.invalidateAll();
  // Same reasoning for the firm's identity: once ten organisations share this
  // app, leaving one firm's letterhead in memory means the next person to sign
  // in on this machine could see it before their own loads.
  OrgIdentity.clear();

  window.sb.auth.signOut();

  document.getElementById('topbar').style.display       = 'none';
  document.getElementById('sidebar').style.display      = 'none';
  document.getElementById('app-section').style.display  = 'none';
  document.getElementById('access-denied-wrap').style.display = 'none';
  document.getElementById('auth-section-wrap').style.display  = 'flex';

  // Clear the form so the next person doesn't land on the last one's email,
  // and re-enable the button signIn() disabled on its way out.
  const form = document.getElementById('auth-form');
  if (form) form.reset();
  document.getElementById('auth-submit').disabled = false;
  document.getElementById('auth-status').innerHTML = '';
}

async function afterSupabaseSignIn(session) {
  const email = session.user.email || '';

  // Membership check — reads org_members, NOT app_users. The database made
  // the same move in Stage 2 Phase 3: private.is_app_user() and
  // private.is_admin() both read org_members now, so looking anywhere else
  // here would let the app and RLS disagree about who is allowed in — which is
  // the exact bug class the tenant work exists to remove.
  //
  // ilike, not eq: private.jwt_email() lowercases before matching, so a
  // mixed-case address passes RLS, and a case-sensitive lookup here would
  // reject that same user.
  //
  // `status` is filtered in SQL rather than checked afterwards so an
  // inactive member reads as "not a member" through this path too, matching
  // current_org_id(), which returns NULL for them.
  const { data, error } = await window.sb
    .from('org_members')
    .select('email, role, status')
    .ilike('email', email)
    .eq('status', 'active')
    .maybeSingle();

  if (error || !data) {
    // Not a member — show access denied. Also end the Supabase session:
    // RLS gives non-members zero rows anyway, but a lingering authenticated
    // session has no business persisting for someone we just rejected.
    window.sb.auth.signOut();
    document.getElementById('loading-screen').style.display = 'none';
    document.getElementById('auth-section-wrap').style.display = 'none';
    document.getElementById('access-denied-msg').textContent =
      `"${email}" is not registered as an authorised user. Ask your admin to add you to your organisation.`;
    document.getElementById('access-denied-wrap').style.display = 'flex';
    return;
  }

  // Authorised — store user. 'owner' is an org_members role that app_users
  // never had; it outranks admin, so it must not read as lesser anywhere the
  // UI checks for 'admin'.
  window.currentUser = { email: data.email, role: data.role };

  // Load this organisation's letterheads and staff BEFORE any module can
  // open — every firm picker, report header and memo PDF reads the globals
  // this fills, and they are empty until it runs (js/core/orgIdentity.js).
  try {
    await OrgIdentity.load();
  } catch (e) {
    // Without an organisation the app would render blank letterheads and
    // silently produce documents naming nobody. Refuse rather than degrade.
    console.error('Org identity failed to load', e);
    window.sb.auth.signOut();
    document.getElementById('loading-screen').style.display = 'none';
    document.getElementById('auth-section-wrap').style.display = 'none';
    document.getElementById('access-denied-msg').textContent =
      `Your account is not linked to an organisation, so the firm's details could not be loaded. Ask your admin to check your membership.`;
    document.getElementById('access-denied-wrap').style.display = 'flex';
    return;
  }

  // Update sidebar UI
  const initial = (session.user.user_metadata?.full_name || email)[0].toUpperCase();
  document.getElementById('user-avatar').textContent = initial;
  document.getElementById('user-name').textContent   = email;
  document.getElementById('role-badge').textContent  = data.role;
  document.getElementById('sidebar').style.display   = 'flex';

  // Update topbar UI
  document.getElementById('tb-user-avatar').textContent = initial;
  document.getElementById('tb-user-email').textContent  = email;
  document.getElementById('tb-role-badge').textContent  = data.role;
  document.getElementById('topbar').style.display       = 'flex';

  // Show/hide admin-only UI. 'owner' is org_members' top role and did not
  // exist in app_users — checking only for 'admin' would hide Add Client and
  // Import Clients from the person who owns the organisation. Mirrors
  // private.is_admin(), which also treats owner as admin.
  if (window.currentUser.role === 'admin' || window.currentUser.role === 'owner') {
    document.getElementById('add-client-btn').style.display = 'inline-flex';
    document.getElementById('import-client-btn').style.display = 'inline-flex';
  }

  // Show app
  document.getElementById('loading-screen').style.display = 'none';
  document.getElementById('auth-section-wrap').style.display = 'none';
  document.getElementById('invite-wrap').style.display = 'none';
  document.getElementById('app-section').style.display  = 'block';

  // Dashboard is the landing tab, so its data has to be pulled here — the
  // nav button's onclick (which is what loads it for every later visit)
  // never fires on boot.
  await loadClients();
  await loadDashboard();
  await loadSidebarStorageUsage();
}

// Free tier cap is hardcoded rather than queried — Supabase doesn't expose
// plan tier via the client, and this is the number that actually matters
// operationally (when to worry about hitting the ceiling).
async function loadSidebarStorageUsage() {
  const FREE_TIER_LIMIT_MB = 500;
  const { data, error } = await window.sb.rpc('get_db_storage_usage');
  if (error || !data || !data[0]) return;
  const usedMb = data[0].bytes_used / (1024 * 1024);
  const pct = Math.min(100, Math.round((usedMb / FREE_TIER_LIMIT_MB) * 100));
  document.getElementById('pu-bar-fill').style.width = pct + '%';
  document.getElementById('pu-storage-text').textContent = `${usedMb.toFixed(1)} MB of ${FREE_TIER_LIMIT_MB} MB used`;
}
