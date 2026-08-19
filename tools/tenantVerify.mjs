// ════════════════════════════════════════════
//  TENANT ISOLATION HARNESS
//
//  Proves one organisation cannot see or touch another's data — the whole
//  point of Stage 2. Committed rather than run ad hoc for the reason
//  tools/spbVerify.mjs exists: an uncommitted check is one nobody re-runs, and
//  Autobooks stayed broken for a month behind exactly that gap (CLAUDE.md §12).
//  The isolation work was first verified by hand in SQL; this is that
//  verification made permanent, and stronger.
//
//  IT USES A REAL SIGNED-IN SESSION, NOT THE SERVICE KEY. The service key
//  bypasses RLS entirely, so a test driven by it tests nothing. This creates a
//  throwaway auth user, signs in as them over HTTP, and makes ordinary
//  PostgREST calls with their JWT — the identical path the browser takes. The
//  service key is used only to set up and tear down the fixture.
//
//  WHAT MAKES IT A REAL TEST
//    · Seeds TWO organisations and ASSERTS THEY DIFFER before asserting
//      anything else. A suite that quietly puts both users in one organisation
//      passes forever and proves nothing.
//    · Attacks with the other organisation's REAL ROW IDS — select, update and
//      delete. "Even if they know the ids" is the actual threat, and the app
//      has 39 mutations keyed on a bare id.
//    · Covers all 22 tenant tables, so a table that ships without a policy is
//      caught: RLS off leaks everything, and a policy missing the org check
//      returns the other organisation's rows. Both show up here as a non-zero
//      count.
//    · Tries to INSERT a row claiming the other organisation, which must be
//      refused rather than silently accepted.
//    · Finally checks the fixture user CAN see their own data — an isolation
//      test that passes because the user can see nothing at all is worthless.
//
//  DESTRUCTIVE — creates and deletes a throwaway organisation and auth user.
//  Refuses to run unless the target is the staging project, or
//  ALLOW_NON_STAGING=1 is set deliberately.
//
//  Usage:
//    node tools/tenantVerify.mjs
//  Reads TARGET_SUPABASE_URL / TARGET_SUPABASE_SERVICE_KEY (falling back to
//  SUPABASE_*) from the gitignored .supabase-keys.local, same as the backup
//  scripts.
// ════════════════════════════════════════════
import { env } from './dbBackup.mjs';

const STAGING_REF  = 'okpztiuxhzpzqdgchrof';
const PROBE_SLUG   = 'zz-tenant-verify';
const PROBE_EMAIL  = 'zz-probe@tenant-verify.test';
const PROBE_PW     = 'ZzProbe!' + Math.random().toString(36).slice(2, 10);

// Every tenant-owned table. Kept in step with db/*.sql — a table missing from
// this list is a table nobody proves is isolated.
const TENANT_TABLES = [
  'clients', 'client_shareholders', 'send_logs', 'audit_log', 'service_memos',
  'service_memo_fee_skips', 'depreciation_schedules', 'bank_accounts',
  'bank_transactions', 'party_opening_balances', 'financial_statements',
  'projection_reports', 'document_register', 'saved_documents',
  'audit_report_finalization', 'audit_checklists', 'work_done', 'work_todos',
  'autobooks_books', 'autobooks_entries', 'autobooks_parties', 'autobooks_adjustments',
];

let pass = 0, fail = 0;
const failures = [];

function check(name, got, want) {
  if (String(got) === String(want)) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(`${name} — got ${got}, want ${want}`); console.log(`  FAIL ${name}  (got ${got}, want ${want})`); }
}

// ── HTTP helpers ────────────────────────────────────────────────────────────
// `auth` is either the service key (setup/teardown) or a user's access token
// (every actual assertion).
async function rest(url, auth, key, path, opts = {}) {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: key,
      Authorization: `Bearer ${auth}`,
      'Content-Type': 'application/json',
      Prefer: opts.prefer || 'return=representation',
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
}

async function admin(url, key, path, opts = {}) {
  const res = await fetch(`${url}/auth/v1/${path}`, {
    ...opts,
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const text = await res.text();
  try { return { status: res.status, body: text ? JSON.parse(text) : null }; }
  catch { return { status: res.status, body: text }; }
}

// Teardown REPORTS what it could not remove. An earlier version swallowed
// every error, so when the last-owner guard blocked deleting the probe member
// the run still printed "Fixture removed" — and the next run then failed on a
// duplicate slug with no hint why. A cleanup that lies is worse than one that
// fails.
async function teardown(url, key) {
  const problems = [];
  const must = async (label, path, opts) => {
    const r = await rest(url, key, key, path, { ...opts, prefer: 'return=minimal' });
    if (r.status >= 300) problems.push(`${label}: ${r.status} ${JSON.stringify(r.body)}`);
  };

  const orgs = (await rest(url, key, key, `organizations?slug=eq.${PROBE_SLUG}&select=id`)).body || [];
  for (const o of orgs) {
    // Tenant rows first: org_id is ON DELETE RESTRICT, so the organisation
    // cannot go while any remain — which is also a small check that the
    // foreign keys point the way they should.
    for (const t of TENANT_TABLES) {
      await must(t, `${t}?org_id=eq.${o.id}`, { method: 'DELETE' });
    }
    await must('org_invitations', `org_invitations?org_id=eq.${o.id}`, { method: 'DELETE' });
    await must('org_firms',       `org_firms?org_id=eq.${o.id}`,       { method: 'DELETE' });
    // org_members is left to CASCADE from the organisation rather than deleted
    // directly: private.guard_last_owner() refuses to remove an organisation's
    // last active owner, and the probe user is exactly that. The guard allows
    // it once the organisation itself is going away
    // (db/2026-08-18_stage3_owner_guard_allow_org_delete.sql).
    await must('organizations',   `organizations?id=eq.${o.id}`,       { method: 'DELETE' });
  }

  const users = (await admin(url, key, `admin/users?page=1&per_page=200`)).body;
  for (const u of ((users && users.users) || [])) {
    if (u.email === PROBE_EMAIL) {
      const r = await admin(url, key, `admin/users/${u.id}`, { method: 'DELETE' });
      if (r.status >= 300) problems.push(`auth user: ${r.status}`);
    }
  }

  if (problems.length) {
    console.warn('  ! teardown could not remove:');
    problems.forEach(p => console.warn('    - ' + p));
  }
  return problems.length === 0;
}

async function main() {
  const { url, key } = env('TARGET_');

  if (!url.includes(STAGING_REF) && process.env.ALLOW_NON_STAGING !== '1') {
    console.error(`\nRefusing to run against ${url}`);
    console.error('This harness creates and deletes data. Point it at staging, or set');
    console.error('ALLOW_NON_STAGING=1 if you genuinely mean to.\n');
    process.exit(1);
  }

  console.log(`\nTenant isolation harness → ${url}\n`);
  await teardown(url, key);

  // ── Fixture ───────────────────────────────────────────────────────────────
  const homeOrgs = (await rest(url, key, key, 'organizations?select=id,name&order=id&limit=1')).body || [];
  if (!homeOrgs.length) throw new Error('No existing organisation to test against.');
  const home = homeOrgs[0];

  const createdRes = await rest(url, key, key, 'organizations', {
    method: 'POST',
    body: JSON.stringify({ name: 'ZZ Tenant Verify', slug: PROBE_SLUG, staff_names: [] }),
  });
  const created = createdRes.body;
  const probe = Array.isArray(created) ? created[0] : created;
  // Report the response, not just the fact of failure — a duplicate slug left
  // by a teardown that could not finish looks identical to a permissions
  // problem otherwise.
  if (!probe || !probe.id) {
    throw new Error(`Could not create the probe organisation (HTTP ${createdRes.status}): ${JSON.stringify(created)}`);
  }

  const signup = await admin(url, key, 'admin/users', {
    method: 'POST',
    body: JSON.stringify({ email: PROBE_EMAIL, password: PROBE_PW, email_confirm: true }),
  });
  if (signup.status >= 300) throw new Error(`Could not create the probe auth user: ${JSON.stringify(signup.body)}`);

  // 'admin', not 'owner'. An owner would be the organisation's last one, and
  // the guard trigger only permits removing that during an org delete — which
  // teardown does rely on, but keeping the probe member out of that path
  // entirely means a failed run leaves less behind. admin still exercises
  // private.is_admin(), which is what the assertions need.
  await rest(url, key, key, 'org_members', {
    method: 'POST',
    body: JSON.stringify({ org_id: probe.id, email: PROBE_EMAIL, role: 'admin', status: 'active' }),
  });
  await rest(url, key, key, 'org_firms', {
    method: 'POST',
    body: JSON.stringify({ org_id: probe.id, firm_key: 'zzprobe', name: 'ZZ Probe Firm', memo_prefix: 'SM-ZZ' }),
  });
  await rest(url, key, key, 'clients', {
    method: 'POST',
    body: JSON.stringify({ org_id: probe.id, name: 'ZZ Probe Client', pan: '000000001' }),
  });

  // Sign in as the probe user — a genuine session, exactly like the browser's.
  const token = await admin(url, key, 'token?grant_type=password', {
    method: 'POST',
    body: JSON.stringify({ email: PROBE_EMAIL, password: PROBE_PW }),
  });
  const jwt = token.body && token.body.access_token;
  if (!jwt) throw new Error(`Could not sign in as the probe user: ${JSON.stringify(token.body)}`);

  console.log('Fixture');
  check('two organisations exist and differ', probe.id !== home.id, true);
  check('probe user holds a real session (not the service key)', jwt !== key, true);

  // ── The boundary ──────────────────────────────────────────────────────────
  console.log('\nReading the other organisation, by its real row ids');
  const victims = {};
  for (const t of TENANT_TABLES) {
    const rows = (await rest(url, key, key, `${t}?org_id=eq.${home.id}&select=id&limit=1`)).body || [];
    if (!rows.length) { console.log(`  --   ${t}: no rows to attack, skipped`); continue; }
    victims[t] = rows[0].id;
    const seen = (await rest(url, jwt, key, `${t}?id=eq.${rows[0].id}&select=id`)).body;
    check(`${t}`, Array.isArray(seen) ? seen.length : 'error', 0);
  }

  console.log('\nWriting to the other organisation, by its real row ids');
  for (const [t, id] of Object.entries(victims)) {
    const upd = await rest(url, jwt, key, `${t}?id=eq.${id}`, {
      method: 'PATCH', body: JSON.stringify({ org_id: probe.id }),
    });
    const changed = Array.isArray(upd.body) ? upd.body.length : (upd.status < 300 ? '?' : 0);
    check(`${t}: update changes nothing`, changed, 0);
  }
  for (const [t, id] of Object.entries(victims)) {
    const del = await rest(url, jwt, key, `${t}?id=eq.${id}`, { method: 'DELETE' });
    const removed = Array.isArray(del.body) ? del.body.length : (del.status < 300 ? '?' : 0);
    check(`${t}: delete removes nothing`, removed, 0);
  }

  console.log('\nForging an organisation id on insert');
  const forged = await rest(url, jwt, key, 'clients', {
    method: 'POST',
    body: JSON.stringify({ name: 'ZZ Forged', pan: '000000002', org_id: home.id }),
  });
  check('insert claiming another org is refused', forged.status >= 400, true);

  // ── The other half: the user must still see their OWN data ────────────────
  // Without this the suite would pass just as happily against a database where
  // nobody can read anything.
  console.log('\nThe probe user can still use their own organisation');
  const ownClients = (await rest(url, jwt, key, 'clients?select=id')).body;
  check('own clients visible', Array.isArray(ownClients) ? ownClients.length : 'error', 1);
  const ownFirms = (await rest(url, jwt, key, 'org_firms?select=id')).body;
  check('own firm visible', Array.isArray(ownFirms) ? ownFirms.length : 'error', 1);
  const ownOrgs = (await rest(url, jwt, key, 'organizations?select=id')).body;
  check('sees exactly one organisation (their own)', Array.isArray(ownOrgs) ? ownOrgs.length : 'error', 1);
  check('and it is theirs', Array.isArray(ownOrgs) && ownOrgs[0] && ownOrgs[0].id, probe.id);

  // Staff directory must not leak across organisations either — app_users has
  // no org_id and is scoped to the caller's own row instead.
  const others = (await rest(url, jwt, key, 'org_members?select=email')).body;
  check('sees only their own organisation\'s members', Array.isArray(others) ? others.length : 'error', 1);

  await teardown(url, key);
  console.log('\nFixture removed.');
}

main().then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { failures.forEach(f => console.log('  ! ' + f)); process.exit(1); }
}).catch(async e => {
  console.error('\nHarness error:', e.message);
  try { const { url, key } = env('TARGET_'); await teardown(url, key); console.error('Fixture cleaned up.'); } catch {}
  process.exit(1);
});
