// ════════════════════════════════════════════
//  BOOT
// ════════════════════════════════════════════
window.addEventListener('load', () => {
  const tryAutoSignIn = () => {
    if (!window.CLIENT_ID) {
      document.getElementById('loading-screen').style.display = 'none';
      document.getElementById('auth-section-wrap').style.display = 'flex';
      return;
    }

    // Check for cached token from "Remember Me"
    const cachedToken = localStorage.getItem('accessToken');
    const tokenExpiry = localStorage.getItem('tokenExpiry');

    if (cachedToken && tokenExpiry && Date.now() < parseInt(tokenExpiry, 10)) {
      // Token is still valid! Skip Google API and go straight to app
      window.accessToken = cachedToken;
      window._rememberMeActive = true;
      scheduleTokenRenewal(parseInt(tokenExpiry, 10));
      document.getElementById('loading-screen').style.display = 'none';
      afterGoogleSignIn();
      return;
    }

    // If we reach here, token is missing or expired
    localStorage.removeItem('accessToken');
    localStorage.removeItem('tokenExpiry');
    
    document.getElementById('loading-screen').style.display = 'none';
    document.getElementById('auth-section-wrap').style.display = 'flex';
  };

  // GIS loads async — poll until ready
  const interval = setInterval(() => {
    if (window.google?.accounts?.oauth2) {
      clearInterval(interval);
      tryAutoSignIn();
    }
  }, 100);

  // Safety timeout — if GIS never loads in 5s, show auth screen
  setTimeout(() => {
    clearInterval(interval);
    if (document.getElementById('loading-screen').style.display !== 'none') {
      document.getElementById('loading-screen').style.display = 'none';
      document.getElementById('auth-section-wrap').style.display = 'flex';
    }
  }, 5000);
});

// ════════════════════════════════════════════
//  SETUP MODAL
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
  alert('✅ Client ID saved! Now click "Sign in with Google".');
}

// ════════════════════════════════════════════
//  GOOGLE AUTH
// ════════════════════════════════════════════
const TOKEN_LIFETIME_MS = 55 * 60 * 1000; // Google tokens last 60m; match existing cache margin
const RENEW_BEFORE_MS   = 5  * 60 * 1000; // silently renew 5 min before that mark

// Single callback shared by interactive sign-in and background silent renewal —
// window._silentRenewalInFlight tells it which one just happened, since a
// fresh sign-in needs afterGoogleSignIn() (load the app UI) while a renewal
// just needs the token value swapped out underneath an already-loaded app.
function handleTokenResponse(resp) {
  const isSilent = window._silentRenewalInFlight;
  window._silentRenewalInFlight = false;

  if (resp.error) {
    if (isSilent) {
      // Google session/cookie is gone — stop trying; next Drive/Gmail call
      // will fail and the user re-signs in same as before this change.
      clearTimeout(window._renewalTimer);
      localStorage.removeItem('accessToken');
      localStorage.removeItem('tokenExpiry');
      return;
    }
    showAuthError('Google sign-in failed: ' + resp.error);
    return;
  }

  window.accessToken = resp.access_token;
  const expiresAt = Date.now() + TOKEN_LIFETIME_MS;

  if (window._rememberMeActive) {
    localStorage.setItem('accessToken', resp.access_token);
    localStorage.setItem('tokenExpiry', expiresAt);
  }

  scheduleTokenRenewal(expiresAt);

  if (!isSilent) afterGoogleSignIn();
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
  if (!window.CLIENT_ID) return;
  ensureTokenClient();
  window._silentRenewalInFlight = true;
  window.tokenClient.requestAccessToken({ prompt: '' });
}

function signIn() {
  if (!window.CLIENT_ID) { showSetup(); return; }
  window._rememberMeActive = !!document.getElementById('rememberMeCheck')?.checked;
  ensureTokenClient();
  window.tokenClient.requestAccessToken();
}

function signOut() {
  clearTimeout(window._renewalTimer);
  window._rememberMeActive = false;
  window.accessToken = null;
  window.currentUser = null;
  window.clientsList = [];
  window.allLogs     = [];

  // Clear remember-me cached token
  localStorage.removeItem('accessToken');
  localStorage.removeItem('tokenExpiry');

  if (window.tokenClient) google.accounts.oauth2.revoke(window.accessToken, () => {});

  document.getElementById('topbar').style.display       = 'none';
  document.getElementById('sidebar').style.display      = 'none';
  document.getElementById('app-section').style.display  = 'none';
  document.getElementById('access-denied-wrap').style.display = 'none';
  document.getElementById('auth-section-wrap').style.display  = 'flex';
}

async function afterGoogleSignIn() {
  // 1. Get Google user info
  const infoResp = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: 'Bearer ' + window.accessToken }
  });
  const info = await infoResp.json();
  const email = info.email || '';

  // 2. Check app_users table in Supabase
  const { data, error } = await window.sb
    .from('app_users')
    .select('email, role')
    .eq('email', email)
    .maybeSingle();

  if (error || !data) {
    // Not in app_users — show access denied
    document.getElementById('auth-section-wrap').style.display = 'none';
    document.getElementById('access-denied-msg').textContent =
      `"${email}" is not registered as an authorised user. Ask your admin to add you in Supabase → app_users.`;
    document.getElementById('access-denied-wrap').style.display = 'flex';
    return;
  }

  // 3. Authorised — store user
  window.currentUser = { email: data.email, role: data.role };

  // Update sidebar UI
  const initial = (info.name || email)[0].toUpperCase();
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
