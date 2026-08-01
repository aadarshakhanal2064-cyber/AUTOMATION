// ════════════════════════════════════════════
//  BOOT
// ════════════════════════════════════════════
window.addEventListener('load', () => {
  const showSignInScreen = () => {
    document.getElementById('loading-screen').style.display = 'none';
    document.getElementById('auth-section-wrap').style.display = 'flex';
    document.getElementById('auth-email').focus();
  };

  // Supabase Auth owns session state now — onAuthStateChange fires once on
  // load with whatever session it restored (INITIAL_SESSION), then again on
  // every subsequent sign-in/out. TOKEN_REFRESHED (Supabase's own ~1hr JWT
  // refresh) is intentionally ignored here — the app is already initialized
  // by that point, nothing to redo.
  window.sb.auth.onAuthStateChange((event, session) => {
    if (event === 'INITIAL_SESSION') {
      session ? afterSupabaseSignIn(session) : showSignInScreen();
    } else if (event === 'SIGNED_IN') {
      afterSupabaseSignIn(session);
    } else if (event === 'SIGNED_OUT') {
      // Skip if the Access Denied screen is up — that sign-out is ours
      // (afterSupabaseSignIn rejecting a non-member) and the denial message
      // must stay visible rather than bouncing back to the sign-in screen.
      if (document.getElementById('access-denied-wrap').style.display !== 'flex') showSignInScreen();
    }
  });

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
//  disabled there on purpose. There is no self-serve password reset: the
//  firm has a handful of staff and Supabase's built-in SMTP is rate-limited
//  to a few mails an hour, so an admin resets it instead.
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

function signOut() {
  window.currentUser = null;
  window.clientsList = [];

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

  // Membership check — ilike, not eq. private.jwt_email() lowercases before
  // matching, so a mixed-case address passes RLS; a case-sensitive lookup
  // here would reject that same user and the two layers would disagree.
  const { data, error } = await window.sb
    .from('app_users')
    .select('email, role')
    .ilike('email', email)
    .maybeSingle();

  if (error || !data) {
    // Not in app_users — show access denied. Also end the Supabase session:
    // RLS gives non-members zero rows anyway, but a lingering authenticated
    // session has no business persisting for someone we just rejected.
    window.sb.auth.signOut();
    document.getElementById('loading-screen').style.display = 'none';
    document.getElementById('auth-section-wrap').style.display = 'none';
    document.getElementById('access-denied-msg').textContent =
      `"${email}" is not registered as an authorised user. Ask your admin to add you in Supabase → app_users.`;
    document.getElementById('access-denied-wrap').style.display = 'flex';
    return;
  }

  // Authorised — store user
  window.currentUser = { email: data.email, role: data.role };

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

  // Show/hide admin-only UI
  if (window.currentUser.role === 'admin') {
    document.getElementById('add-client-btn').style.display = 'inline-flex';
    document.getElementById('import-client-btn').style.display = 'inline-flex';
  }

  // Show app
  document.getElementById('loading-screen').style.display = 'none';
  document.getElementById('auth-section-wrap').style.display = 'none';
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
