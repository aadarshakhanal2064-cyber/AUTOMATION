// ════════════════════════════════════════════
//  BOOT
// ════════════════════════════════════════════
window.addEventListener('load', () => {
  const showSignInScreen = () => {
    document.getElementById('loading-screen').style.display = 'none';
    document.getElementById('auth-section-wrap').style.display = 'flex';
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
//  SETUP MODAL
//  Only needed for the GIS silent-renewal calls below now — Supabase Auth
//  owns the login flow itself and doesn't need this app to know a client_id.
// ════════════════════════════════════════════
function showSetup() {
  document.getElementById('setup-modal').classList.add('open');
  if (window.CLIENT_ID) document.getElementById('clientIdInput').value = window.CLIENT_ID;
}
function closeSetup() { document.getElementById('setup-modal').classList.remove('open'); }
function saveClientId() {
  const val = document.getElementById('clientIdInput').value.trim();
  if (!val) return alert('Please paste your Client ID first.');
  window.CLIENT_ID = val;
  localStorage.setItem('gClientId', val);
  closeSetup();
  alert('✅ Client ID saved! It will be used to silently renew your Drive/Gmail access.');
}

// ════════════════════════════════════════════
//  GOOGLE AUTH (via Supabase Auth) + DRIVE/GMAIL TOKEN RENEWAL (via GIS)
//
//  Login and the Drive/Gmail access token come from ONE Google consent
//  screen: signInWithOAuth() requests the Drive/Gmail scopes alongside
//  login, and Supabase hands back session.provider_token — Google's raw
//  access token, usable exactly like before. Google ties a consent grant to
//  (user, client_id, scope, origin) regardless of which SDK asked for it, so
//  GIS's silent renewal (same Google Cloud OAuth Client ID, configured via
//  the Setup modal) can keep reissuing that token afterward without a
//  second prompt. Supabase itself does NOT auto-refresh provider_token, so
//  this renewal loop (carried over from the earlier silent-refresh change)
//  is still what keeps Drive/Gmail working hour after hour.
// ════════════════════════════════════════════
const TOKEN_LIFETIME_MS = 55 * 60 * 1000; // Google tokens last 60m; match existing cache margin
const RENEW_BEFORE_MS   = 5  * 60 * 1000; // silently renew 5 min before that mark

function handleTokenResponse(resp) {
  const isSilent = window._silentRenewalInFlight;
  window._silentRenewalInFlight = false;

  if (resp.error) {
    if (isSilent) {
      // Google session/cookie is gone — stop trying; Drive/Gmail calls will
      // fail until the next sign-in, same fallback as before this existed.
      clearTimeout(window._renewalTimer);
      window.accessToken = null;
      return;
    }
    return; // interactive GIS calls aren't used anymore; nothing else to do
  }

  window.accessToken = resp.access_token;
  scheduleTokenRenewal(Date.now() + TOKEN_LIFETIME_MS);
}

function ensureTokenClient() {
  if (window.tokenClient) return;
  window.tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: window.CLIENT_ID,
    scope: SCOPES,
    callback: handleTokenResponse,
  });
}

function scheduleTokenRenewal(expiresAt) {
  clearTimeout(window._renewalTimer);
  const delay = Math.max(expiresAt - Date.now() - RENEW_BEFORE_MS, 10000);
  window._renewalTimer = setTimeout(renewTokenSilently, delay);
}

function renewTokenSilently() {
  if (!window.CLIENT_ID) return; // Setup modal never configured — nothing to renew with
  ensureTokenClient();
  window._silentRenewalInFlight = true;
  window.tokenClient.requestAccessToken({ prompt: '' });
}

function signIn() {
  window.sb.auth.signInWithOAuth({
    provider: 'google',
    options: {
      scopes: SCOPES,
      redirectTo: window.location.origin + window.location.pathname,
    },
  });
}

function signOut() {
  clearTimeout(window._renewalTimer);
  const tokenToRevoke = window.accessToken;
  window.accessToken = null;
  window.currentUser = null;
  window.clientsList = [];
  window.allLogs     = [];

  if (window.tokenClient && tokenToRevoke) google.accounts.oauth2.revoke(tokenToRevoke, () => {});
  window.sb.auth.signOut();

  document.getElementById('topbar').style.display       = 'none';
  document.getElementById('sidebar').style.display      = 'none';
  document.getElementById('app-section').style.display  = 'none';
  document.getElementById('access-denied-wrap').style.display = 'none';
  document.getElementById('auth-section-wrap').style.display  = 'flex';
}

async function afterSupabaseSignIn(session) {
  const email = session.user.email || '';

  // Seed the Drive/Gmail token from this same sign-in's OAuth grant, then
  // hand off to the renewal loop above for everything after.
  if (session.provider_token) {
    window.accessToken = session.provider_token;
    scheduleTokenRenewal(Date.now() + TOKEN_LIFETIME_MS);
  }

  // Check app_users table in Supabase
  const { data, error } = await window.sb
    .from('app_users')
    .select('email, role')
    .eq('email', email)
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
    document.getElementById('log-filter-sender').style.display = 'block';
  }

  // Show app
  document.getElementById('loading-screen').style.display = 'none';
  document.getElementById('auth-section-wrap').style.display = 'none';
  document.getElementById('app-section').style.display  = 'block';

  // Load data - assuming loadClients and loadLogs are defined in other scripts
  await loadClients();
  await loadLogs();
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

function showAuthError(msg) {
  document.getElementById('auth-section-wrap').style.display = 'flex';
  alert('❌ ' + msg);
}
