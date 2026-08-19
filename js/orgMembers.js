// ════════════════════════════════════════════
//  TEAM — members and invitations (Stage 3)
//
//  Replaces "ask the one person with Supabase dashboard access to create an
//  account". An owner or admin can now invite their own colleagues, change a
//  role, deactivate someone who has left, and revoke an unused invitation —
//  without anyone outside their firm being involved.
//
//  THE INVITE LINK IS NOT EMAILED BY THE APP, DELIBERATELY. create_invitation()
//  returns a one-time token; this screen shows the resulting link once and the
//  admin sends it however they already talk to that person. Supabase's built-in
//  SMTP is rate-limited to a few messages an hour across the WHOLE project, so
//  an app that emailed invitations would throttle onboarding for every firm at
//  once. Handing over a link has no such limit and no dependency on mail
//  reaching an inbox.
//
//  Every rule this screen appears to enforce is really enforced in Postgres —
//  admin-only invites, the email on the invitation having to match the person
//  who signs up, single use, expiry, and the refusal to remove an
//  organisation's last owner. The UI only avoids offering what would be
//  refused; see db/2026-08-18_stage3_invitations.sql.
//
//  Deliberately a plain table rather than TableEngine/Tabulator (§15's default
//  for list tables): this is at most a handful of rows per firm, every row
//  carries inline controls, and there is nothing to sort or filter.
// ════════════════════════════════════════════

ModuleRegistry.register({
  id: 'orgMembers',
  group: 'main',
  buttonId: null,           // launched from the topbar user menu
  panelId: 'tab-orgMembers-panel',
});

let omMembers = [];
let omInvites = [];

function omStatus(msg, type) { showStatus(msg, type, 'om-status'); }

function omIsAdmin() {
  const r = (window.currentUser || {}).role;
  return r === 'admin' || r === 'owner';
}

async function omInit() {
  const orgName = (window.currentOrg || {}).name || '—';
  const el = document.getElementById('om-org-name');
  if (el) el.textContent = orgName;

  // Non-admins get the roster but none of the controls. The database would
  // refuse their writes anyway; hiding the buttons keeps the screen honest
  // rather than offering actions that always fail.
  // display is cleared rather than set to 'flex' so the stylesheet keeps
  // owning the layout — hardcoding it here would silently override .om-invite-bar.
  document.getElementById('om-invite-bar').style.display = omIsAdmin() ? '' : 'none';
  document.getElementById('om-invites-card').style.display = omIsAdmin() ? '' : 'none';

  await omReload();
}

async function omReload() {
  await Promise.all([omLoadMembers(), omIsAdmin() ? omLoadInvites() : Promise.resolve()]);
  omRenderMembers();
  if (omIsAdmin()) omRenderInvites();
}

async function omLoadMembers() {
  const { data, error } = await window.sb
    .from('org_members')
    .select('id, email, role, status, invited_by, created_at')
    .order('role')
    .order('email');
  if (error) { omStatus('❌ ' + escHtml(error.message), 'error'); omMembers = []; return; }
  omMembers = data || [];
}

async function omLoadInvites() {
  // Outstanding only — an accepted invitation is now a member row, and a
  // revoked one is history nobody needs on screen.
  const { data, error } = await window.sb
    .from('org_invitations')
    .select('id, email, role, expires_at, created_at, created_by')
    .is('accepted_at', null)
    .is('revoked_at', null)
    .order('created_at', { ascending: false });
  if (error) { omInvites = []; return; }
  omInvites = data || [];
}

function omRoleBadge(role) {
  const cls = role === 'owner' ? 'badge-green' : role === 'admin' ? 'badge-yellow' : '';
  return `<span class="log-badge ${cls}">${escHtml(role)}</span>`;
}

// .status-pill is the app's existing active/inactive treatment (Clients uses
// it) — a dot plus a word, rather than another badge variant.
function omStatusPill(status) {
  const on = status === 'active';
  return `<span class="status-pill ${on ? 'active' : 'inactive'}"><span class="dot"></span>${escHtml(status)}</span>`;
}

function omRenderMembers() {
  const body = document.getElementById('om-members-body');
  if (!body) return;

  if (!omMembers.length) {
    body.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:24px;">No members found.</td></tr>`;
    return;
  }

  const me = ((window.currentUser || {}).email || '').toLowerCase();

  body.innerHTML = omMembers.map(m => {
    const isMe = (m.email || '').toLowerCase() === me;
    const inactive = m.status !== 'active';
    const roleCell = omIsAdmin() && !isMe
      ? `<select class="om-role-select" data-id="${m.id}" onchange="omSetRole(this)">
           ${['owner','admin','staff'].map(r =>
             `<option value="${r}"${r === m.role ? ' selected' : ''}>${r}</option>`).join('')}
         </select>`
      : omRoleBadge(m.role);

    // Only ids reach the handler — never the email, which is free text
    // (CLAUDE.md rule 13). The row is looked up from state.
    const actions = (omIsAdmin() && !isMe)
      ? `<button class="btn btn-outline btn-sm" onclick="omToggleStatus(${m.id})">${inactive ? 'Reactivate' : 'Deactivate'}</button>`
        + `<button class="btn btn-outline btn-sm" onclick="omRemoveMember(${m.id})">Remove</button>`
      : (isMe ? '<span class="om-you">This is you</span>' : '');

    return `<tr${inactive ? ' class="om-muted-row"' : ''}>
      <td>${escHtml(m.email)}</td>
      <td>${roleCell}</td>
      <td>${omStatusPill(m.status)}</td>
      <td>${escHtml(m.invited_by || '—')}</td>
      <td class="om-actions">${actions}</td>
    </tr>`;
  }).join('');
}

function omRenderInvites() {
  const body = document.getElementById('om-invites-body');
  if (!body) return;

  if (!omInvites.length) {
    body.innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--text-muted);padding:18px;">No invitations waiting.</td></tr>`;
    return;
  }

  body.innerHTML = omInvites.map(i => {
    const days = Math.ceil((new Date(i.expires_at) - Date.now()) / 86400000);
    return `<tr>
      <td>${escHtml(i.email)}</td>
      <td>${omRoleBadge(i.role)}</td>
      <td>${days > 0 ? `in ${days} day${days === 1 ? '' : 's'}` : 'expired'}</td>
      <td class="om-actions"><button class="btn btn-outline btn-sm" onclick="omRevokeInvite(${i.id})">Revoke</button></td>
    </tr>`;
  }).join('');
}

// ── Inviting ────────────────────────────────────────────────────────────────

async function omCreateInvite() {
  const email = document.getElementById('om-invite-email').value.trim();
  const role  = document.getElementById('om-invite-role').value;
  if (!email) return omStatus('Enter the person’s email address.', 'info');

  const btn = document.getElementById('om-invite-btn');
  btn.disabled = true;
  omStatus('<span class="spinner spinner-navy"></span> Creating invitation…', 'searching');

  // The token comes back exactly once and is never stored in readable form —
  // if this response is lost, the invitation has to be recreated.
  const { data, error } = await window.sb.rpc('create_invitation', {
    p_email: email, p_role: role, p_days: 14,
  });

  btn.disabled = false;
  if (error) return omStatus('❌ ' + escHtml(error.message), 'error');

  const row = Array.isArray(data) ? data[0] : data;
  if (!row || !row.token) return omStatus('❌ No invitation was returned.', 'error');

  omShowInviteLink(email, row.token);
  document.getElementById('om-invite-email').value = '';
  omStatus('', 'info');
  await omReload();
}

function omShowInviteLink(email, token) {
  const url = `${location.origin}${location.pathname}?invite=${encodeURIComponent(token)}`;
  document.getElementById('om-link-for').textContent = email;
  const box = document.getElementById('om-link-value');
  box.value = url;
  document.getElementById('om-link-modal').style.display = 'flex';
}

function omCopyInviteLink() {
  const box = document.getElementById('om-link-value');
  box.select();
  navigator.clipboard.writeText(box.value).then(
    () => { document.getElementById('om-link-copied').textContent = 'Copied.'; },
    () => { document.getElementById('om-link-copied').textContent = 'Press Ctrl+C to copy.'; }
  );
}

function omCloseLinkModal() {
  document.getElementById('om-link-modal').style.display = 'none';
  document.getElementById('om-link-copied').textContent = '';
}

async function omRevokeInvite(id) {
  const inv = omInvites.find(i => i.id === id);
  if (!inv) return;
  if (!confirm(`Revoke the invitation for ${inv.email}? The link will stop working.`)) return;

  const { error } = await window.sb
    .from('org_invitations')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', id);
  if (error) return omStatus('❌ ' + escHtml(error.message), 'error');
  omStatus('✅ Invitation revoked.', 'success');
  await omReload();
}

// ── Managing members ────────────────────────────────────────────────────────

async function omSetRole(sel) {
  const id = Number(sel.dataset.id);
  const m  = omMembers.find(x => x.id === id);
  if (!m) return;
  const role = sel.value;

  const { error } = await window.sb.from('org_members').update({ role }).eq('id', id);
  if (error) {
    // Reload rather than leave the dropdown asserting a change the database
    // refused — the last-owner guard lives there, not here.
    omStatus('❌ ' + escHtml(error.message), 'error');
    await omReload();
    return;
  }
  omStatus(`✅ ${escHtml(m.email)} is now ${escHtml(role)}.`, 'success');
  await omReload();
}

async function omToggleStatus(id) {
  const m = omMembers.find(x => x.id === id);
  if (!m) return;
  const next = m.status === 'active' ? 'inactive' : 'active';
  if (next === 'inactive' && !confirm(`Deactivate ${m.email}? They lose access immediately.`)) return;

  const { error } = await window.sb.from('org_members').update({ status: next }).eq('id', id);
  if (error) { omStatus('❌ ' + escHtml(error.message), 'error'); await omReload(); return; }
  omStatus(`✅ ${escHtml(m.email)} is now ${next}.`, 'success');
  await omReload();
}

async function omRemoveMember(id) {
  const m = omMembers.find(x => x.id === id);
  if (!m) return;
  if (!confirm(`Remove ${m.email} from this organisation?\n\nTheir name stays on work they already recorded. Deactivating instead keeps the account recoverable.`)) return;

  const { error } = await window.sb.from('org_members').delete().eq('id', id);
  if (error) { omStatus('❌ ' + escHtml(error.message), 'error'); await omReload(); return; }
  omStatus(`✅ ${escHtml(m.email)} removed.`, 'success');
  await omReload();
}
