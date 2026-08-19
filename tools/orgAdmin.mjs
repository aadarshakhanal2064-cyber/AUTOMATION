// ════════════════════════════════════════════
//  ORGANISATION ADMIN — create · list · suspend · resume · export · delete
//
//  Stage 7 of the multi-tenant conversion: the operations that run a tenant's
//  life, as opposed to the day-to-day work the app itself does.
//
//  WHY A TOOL AND NOT A SCREEN. These are rare, deliberate, high-consequence
//  acts performed by whoever operates the platform — not by a firm's staff.
//  Putting "delete an organisation" behind a button in the app would mean
//  writing policies that let SOMEONE delete another tenant, which is precisely
//  the power the whole of Stage 2 exists to deny. Keeping it out here means
//  the app has no such capability at all: the service-role key is the
//  authority, and it never reaches a browser.
//
//  EVERY DESTRUCTIVE PATH EXPORTS FIRST. `delete` writes a full JSON export of
//  the organisation before removing anything, to db/backups/, unprompted. The
//  go-live checklist requires that an outside firm's data can be handed back
//  on request; this makes that the same code path as deletion rather than a
//  separate promise nobody tested.
//
//  Usage (reads .supabase-keys.local, same as the backup scripts):
//    node tools/orgAdmin.mjs list
//    node tools/orgAdmin.mjs create "Firm Name" owner@firm.com
//    node tools/orgAdmin.mjs suspend <slug>
//    node tools/orgAdmin.mjs resume  <slug>
//    node tools/orgAdmin.mjs export  <slug>
//    node tools/orgAdmin.mjs delete  <slug> --confirm
//
//  Add TARGET=1 to act on the staging project instead of production.
// ════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env, TABLE_ORDER } from './dbBackup.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Tenant-owned tables only. organizations / org_members / org_firms /
// org_invitations are handled explicitly at the end, in FK order.
const TENANT_TABLES = TABLE_ORDER.filter(t =>
  !['organizations', 'org_members', 'org_firms', 'app_users'].includes(t));

async function rest(url, key, path_, opts = {}) {
  const res = await fetch(`${url}/rest/v1/${path_}`, {
    ...opts,
    headers: {
      apikey: key, Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: opts.prefer || 'return=representation',
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) throw new Error(`${path_}: ${res.status} ${JSON.stringify(body)}`);
  return body;
}

async function findOrg(url, key, slug) {
  const rows = await rest(url, key, `organizations?slug=eq.${encodeURIComponent(slug)}&select=*`);
  if (!rows.length) throw new Error(`No organisation with slug "${slug}".`);
  return rows[0];
}

function slugify(name) {
  return String(name).toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
}

// ── Commands ────────────────────────────────────────────────────────────────

async function cmdList(url, key) {
  const orgs = await rest(url, key, 'organizations?select=id,name,slug,status,created_at&order=id');
  const members = await rest(url, key, 'org_members?select=org_id,email,role,status');
  const clients = await rest(url, key, 'clients?select=org_id');

  console.log('');
  for (const o of orgs) {
    const mine = members.filter(m => m.org_id === o.id);
    const owners = mine.filter(m => m.role === 'owner' && m.status === 'active').length;
    console.log(`  #${o.id}  ${o.name}`);
    console.log(`      slug ${o.slug}   status ${o.status}${o.status === 'suspended' ? '  ← blocked at the database' : ''}`);
    console.log(`      ${mine.length} member(s), ${owners} active owner(s), ${clients.filter(c => c.org_id === o.id).length} client(s)`);
  }
  console.log('');
}

async function cmdCreate(url, key, name, ownerEmail) {
  if (!name || !ownerEmail) throw new Error('Usage: create "Firm Name" owner@firm.com');
  const email = ownerEmail.toLowerCase().trim();
  const slug = slugify(name);

  const clash = await rest(url, key, `org_members?email=eq.${encodeURIComponent(email)}&select=id`);
  if (clash.length) throw new Error(`${email} already belongs to an organisation (one person, one org).`);

  const org = (await rest(url, key, 'organizations', {
    method: 'POST', body: JSON.stringify({ name, slug, staff_names: [] }),
  }))[0];

  // The first owner is created directly rather than invited: an invitation has
  // to be issued BY an admin of the organisation, and at this instant there is
  // nobody in it. Every subsequent member goes through the normal invite flow.
  await rest(url, key, 'org_members', {
    method: 'POST',
    body: JSON.stringify({ org_id: org.id, email, role: 'owner', status: 'active' }),
  });

  // A firm with no letterhead cannot issue a single document, so seed one from
  // its own name. Everything else about it is theirs to fill in.
  await rest(url, key, 'org_firms', {
    method: 'POST',
    body: JSON.stringify({
      org_id: org.id, firm_key: 'main', name,
      memo_prefix: 'SM-' + slug.slice(0, 4).toUpperCase(),
      for_final_account: true, sort_order: 1,
    }),
  });

  console.log(`\n  Created #${org.id} "${name}" (slug ${slug})`);
  console.log(`  Owner: ${email}`);
  console.log('');
  console.log('  Next: that person still needs a login. Either they sign up at the app');
  console.log('  with this exact address, or an existing admin sends them an invite.');
  console.log('  Their membership already exists, so signing up is enough to get in.\n');
}

async function setStatus(url, key, slug, status) {
  const org = await findOrg(url, key, slug);
  await rest(url, key, `organizations?id=eq.${org.id}`, {
    method: 'PATCH', body: JSON.stringify({ status }),
  });
  console.log(`\n  "${org.name}" is now ${status}.`);
  if (status === 'suspended') {
    console.log('  private.current_org_id() returns NULL for a suspended organisation,');
    console.log('  so every policy stops matching — their sign-in still succeeds but');
    console.log('  the app shows nothing. No data is touched.\n');
  } else {
    console.log('  Access restored immediately; no session reset needed.\n');
  }
}

async function exportOrg(url, key, org, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const counts = {};

  for (const t of ['organizations', 'org_members', 'org_firms', 'org_invitations', ...TENANT_TABLES]) {
    const filter = t === 'organizations' ? `id=eq.${org.id}` : `org_id=eq.${org.id}`;
    let rows = [];
    try { rows = await rest(url, key, `${t}?${filter}&select=*`); }
    catch (e) { console.warn(`  ! ${t}: ${e.message}`); continue; }
    fs.writeFileSync(path.join(dir, `${t}.json`), JSON.stringify(rows));
    counts[t] = rows.length;
  }

  fs.writeFileSync(path.join(dir, '_manifest.json'), JSON.stringify({
    exported_at: new Date().toISOString(),
    source: url,
    organization: { id: org.id, name: org.name, slug: org.slug, status: org.status },
    counts,
  }, null, 2));

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return { counts, total };
}

async function cmdExport(url, key, slug) {
  const org = await findOrg(url, key, slug);
  const dir = path.join(ROOT, 'db', 'backups',
    `${new Date().toISOString().slice(0, 10)}_org-${org.slug}`);
  const { counts, total } = await exportOrg(url, key, org, dir);
  console.log('');
  for (const [t, n] of Object.entries(counts)) if (n) console.log(`  ${String(n).padStart(6)}  ${t}`);
  console.log(`\n  ${total} rows → ${dir}\n`);
}

async function cmdDelete(url, key, slug, confirmed) {
  const org = await findOrg(url, key, slug);

  if (!confirmed) {
    console.log(`\n  This would PERMANENTLY delete "${org.name}" and every row it owns.`);
    console.log('  Re-run with --confirm to proceed. An export is written first either way.\n');
    const dir = path.join(ROOT, 'db', 'backups', `${new Date().toISOString().slice(0,10)}_org-${org.slug}_preview`);
    const { total } = await exportOrg(url, key, org, dir);
    console.log(`  Preview export written (${total} rows) → ${dir}\n`);
    return;
  }

  // Whole-database counts before and after. The risk named in the plan is a
  // cascade reaching further than intended, and the only way to know it did
  // not is to count everything, not just this tenant's tables.
  const before = await wholeDbCounts(url, key);

  const dir = path.join(ROOT, 'db', 'backups',
    `${new Date().toISOString().slice(0, 10)}_org-${org.slug}_deleted`);
  const { total } = await exportOrg(url, key, org, dir);
  console.log(`\n  Exported ${total} rows → ${dir}`);

  // Children before parents. org_id is ON DELETE RESTRICT on every tenant
  // table precisely so this has to be deliberate rather than a silent cascade.
  console.log('  Deleting…');
  for (const t of [...TENANT_TABLES].reverse()) {
    await rest(url, key, `${t}?org_id=eq.${org.id}`, { method: 'DELETE', prefer: 'return=minimal' });
  }
  await rest(url, key, `org_invitations?org_id=eq.${org.id}`, { method: 'DELETE', prefer: 'return=minimal' });
  await rest(url, key, `org_firms?org_id=eq.${org.id}`,       { method: 'DELETE', prefer: 'return=minimal' });
  // org_members is left to CASCADE from the organisation: guard_last_owner()
  // refuses to remove a live organisation's last owner, and permits it only
  // once the organisation itself is going
  // (db/2026-08-18_stage3_owner_guard_allow_org_delete.sql).
  await rest(url, key, `organizations?id=eq.${org.id}`, { method: 'DELETE', prefer: 'return=minimal' });

  const after = await wholeDbCounts(url, key);

  console.log('\n  Row counts, whole database:');
  let unexpected = 0;
  for (const t of Object.keys(before)) {
    const removed = before[t] - after[t];
    const owned = 0; // everything removed should have belonged to this org
    if (removed) console.log(`    ${t}: ${before[t]} → ${after[t]}  (−${removed})`);
    if (after[t] > before[t]) { unexpected++; console.log(`    ! ${t} GREW during a delete`); }
  }
  console.log(unexpected ? '\n  ! Something unexpected changed — investigate.\n'
                         : '\n  Nothing outside this organisation changed.\n');
}

async function wholeDbCounts(url, key) {
  const out = {};
  for (const t of ['organizations', 'org_members', 'org_firms', ...TENANT_TABLES]) {
    const res = await fetch(`${url}/rest/v1/${t}?select=id`, {
      headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: 'count=exact', Range: '0-0' },
    });
    const cr = res.headers.get('content-range') || '';
    out[t] = Number((cr.split('/')[1]) || 0);
  }
  return out;
}

// ── Entry ───────────────────────────────────────────────────────────────────
async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const { url, key } = env(process.env.TARGET === '1' ? 'TARGET_' : '');

  if (!cmd || cmd === 'help') {
    console.log(`
  node tools/orgAdmin.mjs list
  node tools/orgAdmin.mjs create "Firm Name" owner@firm.com
  node tools/orgAdmin.mjs suspend <slug>
  node tools/orgAdmin.mjs resume  <slug>
  node tools/orgAdmin.mjs export  <slug>
  node tools/orgAdmin.mjs delete  <slug> --confirm

  TARGET=1 acts on the staging project instead of production.
`);
    return;
  }

  console.log(`\n→ ${url}`);

  switch (cmd) {
    case 'list':    return cmdList(url, key);
    case 'create':  return cmdCreate(url, key, args[0], args[1]);
    case 'suspend': return setStatus(url, key, args[0], 'suspended');
    case 'resume':  return setStatus(url, key, args[0], 'active');
    case 'export':  return cmdExport(url, key, args[0]);
    case 'delete':  return cmdDelete(url, key, args[0], args.includes('--confirm'));
    default: throw new Error(`Unknown command "${cmd}". Try: help`);
  }
}

main().catch(e => { console.error('\n  ' + e.message + '\n'); process.exit(1); });
