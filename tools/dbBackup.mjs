// ════════════════════════════════════════════
//  DATABASE BACKUP / RESTORE HARNESS
//
//  The Supabase free plan includes NO backups of its own (verified in the
//  dashboard 2026-08-18: "Free Plan does not include project backups"). Until
//  the project moves to Pro, this file is the only backup mechanism that
//  exists, which is why it is committed rather than living as a throwaway
//  script — the same rule that produced tools/spbVerify.mjs (CLAUDE.md §12).
//
//  Schema and data are backed up separately on purpose: db/00_bootstrap.sql
//  already rebuilds the whole schema from nothing, so this only carries rows.
//  A restore is therefore bootstrap-then-restore, and tools/dbRestore.mjs
//  refuses to run against a database whose tables do not already exist.
//
//  What this does NOT cover: Supabase Auth accounts (auth.users). Those live
//  in a schema the REST API will not expose, so after a disaster-recovery
//  restore the sign-in accounts must be recreated by hand — which is already
//  how accounts are made (CLAUDE.md §7). app_users rows ARE covered here, so
//  authorization survives; only the passwords behind them do not.
//
//  Usage:
//    SUPABASE_URL=https://<ref>.supabase.co \
//    SUPABASE_SERVICE_KEY=<service_role key> \
//    node tools/dbBackup.mjs [outputDir]
//
//  The service-role key bypasses RLS, which is what makes a COMPLETE dump
//  possible — a publishable-key session only ever sees what its policies
//  allow, and after Stage 2's org scoping that is one tenant's slice. Pass it
//  by environment variable only. It must never reach the browser bundle or a
//  committed file (CLAUDE.md §13).
// ════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Parent-before-child. A restore replays this order forwards so a foreign key
// never points at a row that has not been inserted yet; dbRestore.mjs walks it
// backwards when clearing. Derived from information_schema, not guessed.
export const TABLE_ORDER = [
  // Tenancy first — every one of the 22 tenant-owned tables now carries an
  // org_id foreign key into organizations, so it has to exist before any of
  // them is replayed (Stage 2 Phase 1, 2026-08-18).
  'organizations',
  'org_members',
  'org_firms',
  'app_users',
  'clients',
  'client_shareholders',
  'bank_accounts',
  'bank_transactions',
  'audit_checklists',
  'audit_report_finalization',
  'autobooks_books',
  'autobooks_entries',
  'autobooks_parties',
  'autobooks_adjustments',
  'depreciation_schedules',
  'document_register',
  'financial_statements',
  'party_opening_balances',
  'projection_reports',
  'saved_documents',
  'service_memos',
  'service_memo_fee_skips',
  'work_done',
  'work_todos',
  'audit_log',
  'send_logs',
];

// Columns Postgres computes itself (GENERATED ALWAYS AS ... STORED). A dump's
// SELECT * naturally includes them, but PostgREST rejects an explicit value
// for one on insert — dbRestore.mjs strips these before writing.
export const GENERATED_COLUMNS = {
  autobooks_books: ['book_key'],
};

const PAGE = 1000; // PostgREST's hard cap on a single select (CLAUDE.md §6).

// A backup that quietly skips a table is worse than one that fails, because
// nobody finds out until a restore. That is not hypothetical: TABLE_ORDER was
// written against 23 tables, Stage 2 Phase 1 added three, and the very next
// backup silently omitted them — it still said "23 tables" and looked fine.
// Had it been restored, every org_id would have pointed at an organizations
// row that no longer existed.
//
// So the list is cross-checked against the live database on every run. It is
// still an explicit ORDERED list, because a restore has to respect foreign
// keys and information_schema does not hand you a safe order for free — but it
// can no longer fall behind the schema without saying so.
export async function assertTableListCurrent(url, key, tables) {
  // PostgREST exposes exactly the API-visible tables of the public schema in
  // its OpenAPI document, which is the same set a backup can read.
  const res = await fetch(`${url}/rest/v1/`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/openapi+json' },
  });
  if (!res.ok) {
    console.warn(`! Could not verify the table list (${res.status}); continuing.`);
    return;
  }
  const spec = await res.json();
  const live = Object.keys(spec.definitions || spec.components?.schemas || {})
    .filter(n => !n.startsWith('(') && !n.includes('.'));
  if (!live.length) {
    console.warn('! Table list check returned nothing; continuing.');
    return;
  }
  const missing = live.filter(t => !tables.includes(t));
  const stale   = tables.filter(t => !live.includes(t));
  if (missing.length) {
    console.error(`\nTABLE_ORDER is out of date — these exist in the database but`);
    console.error(`would NOT be backed up: ${missing.join(', ')}`);
    console.error(`Add them to TABLE_ORDER in tools/dbBackup.mjs, parent before child.\n`);
    process.exit(1);
  }
  if (stale.length) console.warn(`! In TABLE_ORDER but not in the database: ${stale.join(', ')}`);
}

// Keys come from the environment, or from a gitignored local file so a
// service-role key never has to be pasted into a shared terminal or a chat
// transcript. Format is one KEY=value per line; blank lines and # comments
// are ignored.
const KEY_FILE = path.join(ROOT, '.supabase-keys.local');

function fileEnv() {
  if (!fs.existsSync(KEY_FILE)) return {};
  const out = {};
  for (const line of fs.readFileSync(KEY_FILE, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i > 0) out[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

export function env(prefix = '') {
  const f = fileEnv();
  const pick = name => process.env[prefix + name] || f[prefix + name]
                     || process.env[name] || f[name];
  const url = pick('SUPABASE_URL');
  const key = pick('SUPABASE_SERVICE_KEY');
  if (!url || !key) {
    console.error(`Missing ${prefix}SUPABASE_URL / ${prefix}SUPABASE_SERVICE_KEY.`);
    console.error(`Set them as environment variables, or put them in ${KEY_FILE}`);
    console.error('(that file is gitignored). Find both under Supabase dashboard');
    console.error('-> Project Settings -> API. The service_role key is secret.');
    process.exit(1);
  }
  return { url: url.replace(/\/$/, ''), key };
}

export async function fetchAll(url, key, table) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const res = await fetch(`${url}/rest/v1/${table}?select=*`, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        Range: `${from}-${from + PAGE - 1}`,
        Prefer: 'count=exact',
      },
    });
    if (!res.ok) throw new Error(`${table}: ${res.status} ${await res.text()}`);
    const batch = await res.json();
    rows.push(...batch);
    if (batch.length < PAGE) return rows;
  }
}

async function main() {
  const { url, key } = env();
  const stamp = new Date().toISOString().slice(0, 10);
  const outDir = process.argv[2] || path.join(ROOT, 'db', 'backups', `${stamp}_backup`);

  // Before writing anything — a half-complete backup directory is a trap.
  await assertTableListCurrent(url, key, TABLE_ORDER);

  fs.mkdirSync(outDir, { recursive: true });

  const counts = {};
  for (const table of TABLE_ORDER) {
    const rows = await fetchAll(url, key, table);
    fs.writeFileSync(path.join(outDir, `${table}.json`), JSON.stringify(rows));
    counts[table] = rows.length;
    console.log(`${String(rows.length).padStart(6)}  ${table}`);
  }

  const manifest = {
    takenAt: new Date().toISOString(),
    sourceUrl: url,
    schemaReference: 'db/00_bootstrap.sql',
    tableOrder: TABLE_ORDER,
    counts,
    totalRows: Object.values(counts).reduce((a, b) => a + b, 0),
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  console.log(`\n${manifest.totalRows} rows across ${TABLE_ORDER.length} tables -> ${outDir}`);
  console.log('Restore with: node tools/dbRestore.mjs "' + outDir + '"');
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('dbBackup.mjs')) {
  main().catch(err => { console.error(err.message); process.exit(1); });
}
