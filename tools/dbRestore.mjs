// ════════════════════════════════════════════
//  DATABASE RESTORE — the other half of tools/dbBackup.mjs
//
//  An untested backup is not a backup, so this exists to be RUN, not merely to
//  exist. Restoring into a scratch project and comparing row counts against the
//  manifest is what proves the dump is real (Stage 0 of the multi-tenant plan).
//
//  Expects the target's schema to already exist — build it with
//  db/00_bootstrap.sql first. It will not create tables.
//
//  Usage (TARGET_ prefix, so the destination can never be confused with the
//  source in a shell that already carries the production keys):
//    TARGET_SUPABASE_URL=https://<ref>.supabase.co \
//    TARGET_SUPABASE_SERVICE_KEY=<service_role key> \
//    node tools/dbRestore.mjs <backupDir> [--wipe]
//  Both may instead live in the gitignored .supabase-keys.local at the repo
//  root, which is how a service-role key stays out of shell history.
//
//  --wipe deletes existing rows from every table first, child-before-parent.
//  It is DESTRUCTIVE and refuses to run unless CONFIRM_WIPE=yes is also set,
//  because the difference between "restore into a scratch project" and
//  "restore over production" is one wrong SUPABASE_URL.
// ════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import { TABLE_ORDER, GENERATED_COLUMNS, env, fetchAll } from './dbBackup.mjs';

const CHUNK = 500; // Rows per insert request; keeps each POST body manageable.

function stripGenerated(table, rows) {
  const cols = GENERATED_COLUMNS[table];
  if (!cols) return rows;
  return rows.map(r => {
    const copy = { ...r };
    for (const c of cols) delete copy[c];
    return copy;
  });
}

async function insertRows(url, key, table, rows) {
  rows = stripGenerated(table, rows);
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const res = await fetch(`${url}/rest/v1/${table}`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal,missing=default',
      },
      body: JSON.stringify(slice),
    });
    if (!res.ok) throw new Error(`${table} rows ${i}-${i + slice.length}: ${res.status} ${await res.text()}`);
  }
}

async function wipe(url, key, table) {
  // PostgREST requires a filter on DELETE; `id=gte.0` is a no-op predicate that
  // matches every row without naming one.
  const res = await fetch(`${url}/rest/v1/${table}?id=not.is.null`, {
    method: 'DELETE',
    headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: 'return=minimal' },
  });
  if (!res.ok && res.status !== 404) throw new Error(`wipe ${table}: ${res.status} ${await res.text()}`);
}

async function main() {
  // Restores read TARGET_* so the destination can never be confused with the
  // source in a shell that already has the production keys exported.
  const { url, key } = env('TARGET_');
  const dir = process.argv[2];
  if (!dir) { console.error('Usage: node tools/dbRestore.mjs <backupDir> [--wipe]'); process.exit(1); }

  const manifestPath = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) { console.error(`No manifest.json in ${dir}`); process.exit(1); }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  if (manifest.sourceUrl === url) {
    console.error(`REFUSING: target ${url} is the same project this backup came from.`);
    console.error('Restoring a backup over its own source is how a "recovery" becomes an outage.');
    process.exit(1);
  }

  const shouldWipe = process.argv.includes('--wipe');
  if (shouldWipe && process.env.CONFIRM_WIPE !== 'yes') {
    console.error('--wipe is destructive. Re-run with CONFIRM_WIPE=yes to proceed.');
    process.exit(1);
  }

  console.log(`Restoring ${manifest.totalRows} rows into ${url}`);
  console.log(`Backup taken ${manifest.takenAt} from ${manifest.sourceUrl}\n`);

  if (shouldWipe) {
    for (const table of [...TABLE_ORDER].reverse()) await wipe(url, key, table);
    console.log('Existing rows cleared.\n');
  }

  for (const table of TABLE_ORDER) {
    const file = path.join(dir, `${table}.json`);
    if (!fs.existsSync(file)) { console.log(`  SKIP  ${table} (not in backup)`); continue; }
    const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (rows.length) await insertRows(url, key, table, rows);
    console.log(`${String(rows.length).padStart(6)}  ${table}`);
  }

  // The verification that makes this a drill rather than a hope.
  console.log('\nVerifying against manifest...');
  let ok = true;
  for (const table of TABLE_ORDER) {
    const expected = manifest.counts[table] ?? 0;
    const actual = (await fetchAll(url, key, table)).length;
    const mark = actual === expected ? 'ok  ' : 'FAIL';
    if (actual !== expected) ok = false;
    console.log(`  ${mark} ${table}: expected ${expected}, found ${actual}`);
  }
  console.log(ok ? '\nRESTORE VERIFIED — every table matches the manifest.'
                 : '\nRESTORE MISMATCH — counts differ, see FAIL rows above.');
  process.exit(ok ? 0 : 1);
}

main().catch(err => { console.error(err.message); process.exit(1); });
