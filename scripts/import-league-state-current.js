#!/usr/bin/env node
/**
 * scripts/import-league-state.js
 *
 * ONE-TIME tool (Phase 9.2): copies the production Firestore document
 * league/main, as captured in a verified local backup, into the
 * Supabase table public.league_state (row id = 'main') created by the
 * Phase 9.1 migration, then reads it back and verifies it.
 *
 *   node scripts/import-league-state.js --dry-run
 *   node scripts/import-league-state.js --apply
 *
 * Exactly one of --dry-run / --apply is required. There is no default.
 *
 * SOURCE (hardcoded, not overridable — this is a one-time tool):
 *   backups/2026-10-03_192438/firestore/league.json
 * The file is only ever READ. It is never opened for writing, renamed,
 * or deleted. Its SHA-256 is taken when it is read and re-checked at the
 * end of every run to prove it was not modified.
 *
 * --dry-run
 *   Validates the source and prints what would be imported. Makes NO
 *   network request, reads NO credentials, writes NOTHING.
 *
 * --apply
 *   1. Re-runs every source validation (a failing source never reaches
 *      the network).
 *   2. Calls the RPC initialize_league_state(p_data) ONCE. That RPC
 *      inserts only id='main', fails if 'main' already exists, and never
 *      overwrites. This script does not call any other write RPC, never
 *      issues PATCH/DELETE/upsert, and never retries a failed write.
 *   3. Reads league_state/main back and verifies: id is 'main', data is
 *      an object, top-level keys match the source, and the JSON content
 *      is deeply equal to the source data (key order ignored, because
 *      jsonb does not preserve it).
 *   If the write succeeds but verification fails, the script reports it
 *   loudly and exits non-zero; it does NOT try to repair, overwrite, or
 *   delete anything.
 *
 * CREDENTIALS (same convention as scripts/lib/init-supabase.js — plain
 * environment variables, nothing stored in the repo, never printed):
 *   SUPABASE_SERVICE_ROLE_KEY   required for --apply only
 *   SUPABASE_URL                optional override of the project URL
 *
 * NOTE: initialize_league_state() begins with
 * PERFORM public.require_commissioner(). That function lives only in the
 * production database (it is not defined in this repo), so whether a
 * service-role caller passes it cannot be confirmed from here. If it
 * rejects the call, the RPC raises before touching anything and this
 * script stops with the server's error message.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { initSupabase } = require('./lib/init-supabase');

const SOURCE_PATH = path.resolve(
  __dirname, '..', 'backups', '2026-10-03_192438', 'firestore', 'league.json'
);
const SOURCE_DOC_ID = 'main';
const REQUIRED_OBJECT_KEYS = ['players', 'seasons', 'settings'];
const RPC_NAME = 'initialize_league_state';
const REQUEST_TIMEOUT_MS = 120000;
// Tagged-value markers written by scripts/lib/firestore-serialize.js.
const FIRESTORE_TAGS = new Set(['timestamp', 'geopoint', 'bytes', 'ref']);

const USAGE =
  '\nUsage:\n' +
  '  node scripts/import-league-state.js --dry-run\n' +
  '  node scripts/import-league-state.js --apply\n';

// ─── Helpers ────────────────────────────────────────────────────────────

class UserError extends Error {}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function byteLen(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function fmtBytes(n) {
  return `${n.toLocaleString('en-US')} bytes (${(n / 1024 / 1024).toFixed(2)} MB)`;
}

function parseArgs(argv) {
  const args = { dryRun: false, apply: false };
  for (const a of argv) {
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--apply') args.apply = true;
    else throw new UserError(`Unknown argument: ${a}`);
  }
  if (args.dryRun && args.apply) {
    throw new UserError('Specify exactly one of --dry-run or --apply, not both.');
  }
  if (!args.dryRun && !args.apply) {
    throw new UserError('Specify exactly one of --dry-run or --apply.');
  }
  return args;
}

/**
 * Canonical (sorted-key) JSON — used only for hashing/printing, so two
 * values that differ only in object key order produce the same string.
 */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort()
      .map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Returns a description of the first difference between a and b (object
 * key order ignored, array order significant), or null if deeply equal.
 */
function firstDifference(a, b, p = '$') {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return `${p}: array vs non-array`;
    if (a.length !== b.length) return `${p}: array length ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = firstDifference(a[i], b[i], `${p}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (isPlainObject(a) || isPlainObject(b)) {
    if (!isPlainObject(a) || !isPlainObject(b)) return `${p}: object vs non-object`;
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    for (const k of ka) if (!(k in b)) return `${p}.${k}: missing in Supabase copy`;
    for (const k of kb) if (!(k in a)) return `${p}.${k}: extra in Supabase copy`;
    for (const k of ka) {
      const d = firstDifference(a[k], b[k], `${p}.${k}`);
      if (d) return d;
    }
    return null;
  }
  return Object.is(a, b) ? null : `${p}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
}

/**
 * One pass over the data counting things that would make the import
 * silently wrong or impossible:
 *   - Firestore-native values the backup tagged ({__type:'timestamp',...}):
 *     importing them as-is would store the tag, not the original value.
 *   - NUL characters: PostgreSQL jsonb cannot store \u0000 in text.
 */
function scanData(root) {
  const found = { tagged: 0, firstTaggedPath: null, nul: 0, firstNulPath: null };
  (function walk(v, p) {
    if (typeof v === 'string') {
      if (v.includes('\u0000')) {
        found.nul++;
        if (!found.firstNulPath) found.firstNulPath = p;
      }
    } else if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${p}[${i}]`));
    } else if (isPlainObject(v)) {
      if (typeof v.__type === 'string' && FIRESTORE_TAGS.has(v.__type)) {
        found.tagged++;
        if (!found.firstTaggedPath) found.firstTaggedPath = p;
      }
      for (const [k, x] of Object.entries(v)) {
        if (k.includes('\u0000')) {
          found.nul++;
          if (!found.firstNulPath) found.firstNulPath = `${p}.<key>`;
        }
        walk(x, `${p}.${k}`);
      }
    }
  })(root, '$');
  return found;
}

// ─── Source loading (read-only) ─────────────────────────────────────────

function loadSource() {
  if (!fs.existsSync(SOURCE_PATH)) {
    throw new UserError(`Source backup file does not exist:\n  ${SOURCE_PATH}`);
  }

  const buf = fs.readFileSync(SOURCE_PATH); // read-only; no write handle is ever opened
  const hash = sha256(buf);

  let parsed;
  try {
    parsed = JSON.parse(buf.toString('utf8'));
  } catch (err) {
    throw new UserError(`Source is not valid JSON: ${err.message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new UserError(
      'Source is not a backup collection file (expected a JSON array of {id, data} entries).'
    );
  }

  const matches = parsed.filter(e => isPlainObject(e) && e.id === SOURCE_DOC_ID);
  if (matches.length === 0) {
    const ids = parsed.map(e => (isPlainObject(e) ? e.id : '?')).join(', ') || '(none)';
    throw new UserError(`Source does not contain a document with id="${SOURCE_DOC_ID}". Found ids: ${ids}`);
  }
  if (matches.length > 1) {
    throw new UserError(`Source contains ${matches.length} documents with id="${SOURCE_DOC_ID}" — ambiguous, refusing.`);
  }

  const data = matches[0].data;
  if (!isPlainObject(data)) {
    throw new UserError(`Document "${SOURCE_DOC_ID}": data is not a JSON object.`);
  }

  for (const key of REQUIRED_OBJECT_KEYS) {
    if (!isPlainObject(data[key])) {
      throw new UserError(
        `Document "${SOURCE_DOC_ID}": expected top-level "${key}" to be an object — ` +
        'this does not look like the league document. Refusing.'
      );
    }
  }

  const scan = scanData(data);
  if (scan.tagged > 0) {
    throw new UserError(
      `Source data contains ${scan.tagged} Firestore-tagged value(s) (first at ${scan.firstTaggedPath}). ` +
      'Importing them as-is would store the backup tag instead of the original value. Refusing.'
    );
  }
  if (scan.nul > 0) {
    throw new UserError(
      `Source data contains ${scan.nul} string(s) with a NUL (\\u0000) character (first at ${scan.firstNulPath}); ` +
      'PostgreSQL jsonb cannot store these. Refusing.'
    );
  }

  return { fileBytes: buf.length, fileHash: hash, data };
}

function assertSourceUnchanged(expectedHash) {
  const after = sha256(fs.readFileSync(SOURCE_PATH));
  if (after !== expectedHash) {
    throw new Error(
      'The source backup file changed while this script was running (SHA-256 mismatch). ' +
      'This script never writes to it — investigate.'
    );
  }
}

// ─── Reporting ──────────────────────────────────────────────────────────

function printSourceSummary({ fileBytes, fileHash, data }) {
  console.log(`Source path:        ${SOURCE_PATH}`);
  console.log(`Source file size:   ${fmtBytes(fileBytes)}`);
  console.log(`Source SHA-256:     ${fileHash}`);
  console.log(`Document id:        ${SOURCE_DOC_ID}`);
  console.log(`data JSON size:     ${fmtBytes(byteLen(data))}`);
  console.log(`Top-level keys:     ${Object.keys(data).join(', ')}`);
  console.log('\nTop-level key sizes:');
  for (const key of Object.keys(data)) {
    const v = data[key];
    const entries = isPlainObject(v) ? `${Object.keys(v).length} entries`
      : Array.isArray(v) ? `${v.length} items` : typeof v;
    const star = REQUIRED_OBJECT_KEYS.includes(key) ? ' *' : '';
    console.log(`  ${key.padEnd(18)} ${fmtBytes(byteLen(v)).padEnd(34)} ${entries}${star}`);
  }
  const csid = data.settings && data.settings.currentSeasonId;
  console.log(`\nsettings.currentSeasonId: ${csid === undefined ? '(not set)' : JSON.stringify(csid)}`);
  console.log('Validation: OK (no Firestore-tagged values, no NUL characters)');
}

// ─── Supabase (apply path only) ─────────────────────────────────────────

/**
 * Same two server-credential shapes the existing import script documents:
 *   sb_secret_...  -> not a JWT: send only `apikey`
 *   eyJ... (legacy service_role JWT) -> `apikey` AND `Authorization: Bearer`
 * Derived here because initSupabase() does not return a key type.
 */
function buildHeaders(serviceRoleKey, extra = {}) {
  const headers = { apikey: serviceRoleKey, ...extra };
  if (serviceRoleKey.startsWith('eyJ')) {
    headers.Authorization = `Bearer ${serviceRoleKey}`;
  }
  return headers;
}

async function failureText(res) {
  let body = '';
  try { body = await res.text(); } catch { /* best effort */ }
  return `status: ${res.status} ${res.statusText}\n  body:   ${body.slice(0, 2000)}`;
}

async function callInitialize({ url, serviceRoleKey }, data) {
  const endpoint = `${url.replace(/\/+$/, '')}/rest/v1/rpc/${RPC_NAME}`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: buildHeaders(serviceRoleKey, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ p_data: data }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`${RPC_NAME} failed\n  target: ${endpoint}\n  ${await failureText(res)}`);
  }
  return res.json();
}

async function readBackMain({ url, serviceRoleKey }) {
  const endpoint = `${url.replace(/\/+$/, '')}/rest/v1/league_state` +
    `?id=eq.${encodeURIComponent(SOURCE_DOC_ID)}&select=id,data,updated_at`;
  const res = await fetch(endpoint, {
    method: 'GET',
    // Exactly one row or an error (406) — never a silently empty/multi result.
    headers: buildHeaders(serviceRoleKey, { Accept: 'application/vnd.pgrst.object+json' }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Read-back of league_state/main failed\n  target: ${endpoint}\n  ${await failureText(res)}`);
  }
  return res.json();
}

/** Returns a list of failed-check messages (empty = fully verified). */
function verifyRow(row, sourceData) {
  const failures = [];
  if (!row || row.id !== SOURCE_DOC_ID) {
    failures.push(`row id is ${JSON.stringify(row && row.id)}, expected "${SOURCE_DOC_ID}"`);
  }
  if (!row || !isPlainObject(row.data)) {
    failures.push('row data is not a JSON object');
    return failures;
  }
  const srcKeys = Object.keys(sourceData).sort();
  const dbKeys = Object.keys(row.data).sort();
  if (srcKeys.join('\u0001') !== dbKeys.join('\u0001')) {
    failures.push(
      `top-level keys differ — source: [${srcKeys.join(', ')}] vs Supabase: [${dbKeys.join(', ')}]`
    );
  }
  const diff = firstDifference(sourceData, row.data);
  if (diff) failures.push(`deep comparison failed — first difference at ${diff}`);
  return failures;
}

// ─── Main ───────────────────────────────────────────────────────────────

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`\nERROR: ${err.message}`);
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  let source;
  try {
    source = loadSource();
  } catch (err) {
    console.error(`\nERROR: ${err.message}\n`);
    process.exitCode = 1;
    return;
  }

  console.log(args.dryRun ? '\n=== DRY RUN ===\n' : '\n=== APPLY ===\n');
  printSourceSummary(source);

  if (args.dryRun) {
    try {
      assertSourceUnchanged(source.fileHash);
    } catch (err) {
      console.error(`\nERROR: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    console.log('\nSource file unchanged (SHA-256 re-checked).');
    console.log('DRY RUN — no Supabase connection was made, no credentials were read, nothing was written.');
    return;
  }

  // Credentials are resolved only now, after the source passed every
  // check. A missing key fails here with zero network requests.
  let creds;
  try {
    creds = initSupabase();
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
    return;
  }

  console.log(`\nTarget:             ${creds.url}`);
  console.log(`Calling ${RPC_NAME}(p_data) once (inserts only id="main"; fails if it already exists) ...`);

  let initResult;
  try {
    initResult = await callInitialize(creds, source.data);
  } catch (err) {
    console.error(`\nImport FAILED: ${err.message}`);
    if (err.name === 'TimeoutError' || err.name === 'AbortError' || err.cause) {
      console.error(
        '\nThe outcome of the write is UNKNOWN (network/timeout). Do NOT simply re-run --apply: ' +
        'check whether public.league_state already has a "main" row first.'
      );
    } else {
      console.error('\nNo retry was attempted. Nothing else was written.');
    }
    process.exitCode = 1;
    return;
  }
  console.log(`Initialized. Server reported: ${JSON.stringify(initResult)}`);

  console.log('\nReading league_state/main back for verification ...');
  let row;
  try {
    row = await readBackMain(creds);
  } catch (err) {
    console.error(`\nVERIFICATION NOT COMPLETED: ${err.message}`);
    console.error('The row WAS initialized, but could not be read back. Nothing was modified or deleted.');
    process.exitCode = 1;
    return;
  }

  const failures = verifyRow(row, source.data);
  if (failures.length > 0) {
    console.error('\nVERIFICATION FAILED — the row was initialized but does not match the source:');
    for (const f of failures) console.error(`  - ${f}`);
    console.error('\nNothing was repaired, overwritten, or deleted. Investigate before doing anything else.');
    process.exitCode = 1;
    return;
  }

  try {
    assertSourceUnchanged(source.fileHash);
  } catch (err) {
    console.error(`\nERROR: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const srcCanon = sha256(Buffer.from(canonicalJson(source.data)));
  const dbCanon = sha256(Buffer.from(canonicalJson(row.data)));

  console.log('\n=== Import Complete and Verified ===');
  console.log(`Row id:                     ${row.id}`);
  console.log(`Row updated_at:             ${row.updated_at}`);
  console.log(`data is a JSON object:      yes`);
  console.log(`Top-level keys match:       yes (${Object.keys(row.data).sort().join(', ')})`);
  console.log(`Deep equality with source:  yes`);
  console.log(`Canonical SHA-256 (source): ${srcCanon}`);
  console.log(`Canonical SHA-256 (db):     ${dbCanon}`);
  console.log('Source backup file:         unchanged');
  console.log('Status: SUCCESS');
}

// Run only when invoked directly (node scripts/import-league-state.js ...),
// so the pure helpers below can be unit-tested by require()-ing this file
// without triggering an import.
if (require.main === module) {
  main().catch(err => {
    console.error(`\nUnexpected error: ${err && err.message ? err.message : err}`);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs, scanData, firstDifference, verifyRow, canonicalJson, buildHeaders,
  callInitialize, readBackMain, SOURCE_PATH,
};
