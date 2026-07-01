// ════════════════════════════════════════════
//  BOOT
// ════════════════════════════════════════════
window.addEventListener('load', () => {
  const tryAutoSignIn = () => {
    if (!window.CLIENT_ID) {
      document.getElementById('loading-screen').style.display = 'none';
      document.getElementById('auth-section').style.display = 'block';
      return;
    }

    // Only attempt silent sign-in if user previously ticked "Remember me"
    const rememberMe = localStorage.getItem('rememberMe') === 'true';
    if (!rememberMe) {
      document.getElementById('loading-screen').style.display = 'none';
      document.getElementById('auth-section').style.display = 'block';
      return;
    }

    // Silent token request — uses existing Google browser session, no popup
    const silentClient = google.accounts.oauth2.initTokenClient({
      client_id: window.CLIENT_ID,
      scope: SCOPES,
      prompt: '',
      callback: async (resp) => {
        if (resp.error || !resp.access_token) {
          // Session expired or cookies cleared — fall back to sign-in screen
          document.getElementById('loading-screen').style.display = 'none';
          document.getElementById('auth-section').style.display = 'block';
          return;
        }
        window.accessToken = resp.access_token;
        document.getElementById('loading-screen').style.display = 'none';
        await afterGoogleSignIn();
      },
    });
    silentClient.requestAccessToken({ prompt: '' });
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
      document.getElementById('auth-section').style.display = 'block';
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
function signIn() {
  if (!window.CLIENT_ID) { showSetup(); return; }

  window.tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: window.CLIENT_ID,
    scope: SCOPES,
    callback: async (resp) => {
      if (resp.error) {
        showAuthError('Google sign-in failed: ' + resp.error);
        return;
      }
      window.accessToken = resp.access_token;
      // Save "remember me" flag so next page load attempts silent sign-in
      if (document.getElementById('rememberMeCheck')?.checked) {
        localStorage.setItem('rememberMe', 'true');
      }
      await afterGoogleSignIn();
    },
  });
  window.tokenClient.requestAccessToken();
}

function signOut() {
  window.accessToken = null;
  window.currentUser = null;
  window.clientsList = [];
  window.allLogs     = [];
  // Clear remember-me so next visit shows sign-in screen
  localStorage.removeItem('rememberMe');

  if (window.tokenClient) google.accounts.oauth2.revoke(window.accessToken, () => {});

  document.getElementById('user-pill').style.display    = 'none';
  document.getElementById('signout-btn').style.display  = 'none';
  document.getElementById('header-tag').style.display   = 'inline';
  document.getElementById('app-section').style.display  = 'none';
  document.getElementById('access-denied').style.display= 'none';
  document.getElementById('auth-section').style.display = 'block';
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
    document.getElementById('auth-section').style.display = 'none';
    document.getElementById('access-denied-msg').textContent =
      `"${email}" is not registered as an authorised user. Ask your admin to add you in Supabase → app_users.`;
    document.getElementById('access-denied').style.display = 'block';
    return;
  }

  // 3. Authorised — store user
  window.currentUser = { email: data.email, role: data.role };

  // Update header UI
  document.getElementById('user-avatar').textContent = (info.name || email)[0].toUpperCase();
  document.getElementById('user-name').textContent   = email;
  document.getElementById('role-badge').textContent  = data.role;
  document.getElementById('user-pill').style.display = 'flex';
  document.getElementById('signout-btn').style.display = 'inline-block';
  document.getElementById('header-tag').style.display  = 'none';

  // Show/hide admin-only UI
  if (window.currentUser.role === 'admin') {
    document.getElementById('add-client-btn').style.display = 'inline-flex';
    document.getElementById('import-client-btn').style.display = 'inline-flex';
    document.getElementById('log-filter-sender').style.display = 'block';
  }

  // Show app
  document.getElementById('auth-section').style.display = 'none';
  document.getElementById('app-section').style.display  = 'block';

  // Load data - assuming loadClients and loadLogs are defined in other scripts
  await loadClients();
  await loadLogs();
}

function showAuthError(msg) {
  document.getElementById('auth-section').style.display = 'block';
  alert('❌ ' + msg);
}
