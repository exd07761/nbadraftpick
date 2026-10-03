#!/usr/bin/env node
'use strict';
/**
 * scripts/restore-supabase.js — restore a `supabase-json-v1` backup (the file
 * produced by Admin -> Backup -> "Download Full Supabase JSON") into Supabase.
 *
 * This is a SEPARATE tool from scripts/restore.js, which keeps restoring the
 * legacy Firestore backup directory format and is not touched by this file.
 *
 *   node scripts/restore-supabase.js <backup-file>                     (dry run — the default)
 *   node scripts/restore-supabase.js <backup-file> --apply             (writes, after a snapshot + confirmation)
 *   node scripts/restore-supabase.js <backup-file> --apply --yes       (skips ONLY the final typed confirmation)
 *   node scripts/restore-supabase.js <backup-file> --apply --snapshot-dir <dir>
 *   npm run restore:supabase -- <backup-file> [--apply] [--yes] [--snapshot-dir <dir>]
 *
 * ROLL-FORWARD OVERWRITE — extra live rows will NOT be deleted.
 * This tool is UPSERT-only. It never deletes, truncates or patches rows that
 * are absent from the backup.
 *
 * What it does
 *   1. Parses and fully validates the backup file locally (format, shape,
 *      uniqueness, per-column types, player/pool foreign-key orphans, no
 *      unexpected columns). Nothing is sent anywhere if validation fails.
 *   2. Dry run (default): optionally READS live Supabase (if credentials are
 *      set) and reports what an apply would do. Makes no writes.
 *   3. --apply: requires SUPABASE_SERVICE_ROLE_KEY (see scripts/lib/init-supabase.js),
 *      writes a fresh safety snapshot of the live data OUTSIDE the git repo
 *      (aborts if that fails), asks for a typed confirmation (unless --yes),
 *      then writes in this exact order:
 *         1. nba2k_players   (PostgREST upsert on slug)
 *         2. nba2k27_pool    (PostgREST upsert on nba2k_ref — the FK needs players first)
 *         3. league_state    (RPC save_league_state(p_data) — REPLACES the entire league data)
 *      It stops at the first failure, never continues to a later step, and
 *      does NOT attempt an automatic rollback. The restore is NOT atomic.
 *   4. Reads everything back and compares the whitelisted columns with the
 *      backup. A mismatch is reported as FAILURE even if every write succeeded.
 *
 * Only the columns of the verified production schema are ever sent (explicit
 * whitelists below); backup rows containing any other column are rejected.
 * Backup timestamps are sent back unchanged so database defaults never replace
 * them. league_state.id and league_state.updated_at are never written — only
 * league_state.data is passed to save_league_state, which sets updated_at itself.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { initSupabase } = require('./lib/init-supabase');

const REPO_ROOT = path.resolve(__dirname, '..');
// Mirrors the layout already used for backups: a sibling of the repo checkout.
const DEFAULT_SNAPSHOT_PARENT = path.resolve(REPO_ROOT, '..', 'DraftP-Backups', 'supabase-restore-snapshots');

const BACKUP_FORMAT = 'supabase-json-v1';
const EXPECTED_TABLES = ['league_state', 'nba2k_players', 'nba2k27_pool'];
const LEAGUE_STATE_ID = 'main';
const SAVE_RPC = 'save_league_state';

const BATCH_SIZE = 500;          // same convention as scripts/restore.js and import-nba2k27-live-pool.js
const READ_PAGE_SIZE = 1000;     // PostgREST returns at most 1000 rows per request
const REQUEST_TIMEOUT_MS = 120000;
const MAX_LISTED = 25;

const VALID_POOLS = ['green', 'blue', 'white'];
const VALID_POSITIONS = ['PG', 'SG', 'SF', 'PF', 'C', 'UNASSIGNED'];

// Explicit whitelists = the verified production schema. Nothing else is ever written.
const PLAYER_COLUMNS = [
  'slug', 'name', 'overall', 'team', 'team_type', 'positions', 'build', 'height',
  'weight', 'wingspan', 'attributes', 'badges', 'player_url', 'team_img',
  'player_image', 'last_updated', 'imported_at',
];
const POOL_COLUMNS = [
  'nba2k_ref', 'pool', 'selected_at', 'updated_at', 'position', 'overall_override',
  'name_override', 'variant_group_id', 'variant_label',
];
const LEAGUE_ROW_COLUMNS = ['id', 'data', 'updated_at'];
const PLAYER_TS = ['last_updated', 'imported_at'];
const POOL_TS = ['selected_at', 'updated_at'];

const TABLES = {
  nba2k_players: { key: 'slug', columns: PLAYER_COLUMNS, ts: PLAYER_TS },
  nba2k27_pool: { key: 'nba2k_ref', columns: POOL_COLUMNS, ts: POOL_TS },
};

// ─── Small helpers ──────────────────────────────────────────────────────

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isString(v) { return typeof v === 'string'; }
function isNonEmptyString(v) { return typeof v === 'string' && v.trim() !== ''; }
function isNullOrString(v) { return v === null || typeof v === 'string'; }
function isSmallint(v) { return Number.isInteger(v) && v >= -32768 && v <= 32767; }

const TS_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}(?::?\d{2})?)$/;

function isValidTimestamp(v) {
  return typeof v === 'string' && TS_RE.test(v) && !Number.isNaN(Date.parse(normalizeTsForParse(v)));
}

function normalizeTsForParse(s) {
  const m = TS_RE.exec(s);
  if (!m) return s;
  return `${m[1]}T${m[2]}${normalizeOffset(m[4])}`;
}

function normalizeOffset(tz) {
  if (tz === 'Z') return 'Z';
  const digits = tz.slice(1).replace(':', '');
  const hh = digits.slice(0, 2);
  const mm = digits.slice(2, 4) || '00';
  return `${tz[0]}${hh}:${mm}`;
}

/** Canonical UTC form with microsecond precision, so '+00:00' vs 'Z' and
 *  trailing-zero differences never register as a mismatch. */
function canonicalTimestamp(s) {
  const m = TS_RE.exec(s);
  if (!m) return `INVALID:${String(s)}`;
  const base = new Date(Date.parse(`${m[1]}T${m[2]}${normalizeOffset(m[4])}`));
  const frac = (m[3] ? m[3].slice(1) : '').padEnd(6, '0').slice(0, 6);
  return `${base.toISOString().slice(0, 19)}.${frac}Z`;
}

/** Key-order-independent JSON (Postgres jsonb does not preserve key order). */
function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (isPlainObject(v)) {
    return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v === undefined ? null : v);
}

function comparable(column, value, tsColumns) {
  if (value === undefined) value = null;
  if (value !== null && tsColumns.includes(column)) return `ts:${canonicalTimestamp(value)}`;
  return canonicalJson(value);
}

/** Names of whitelisted columns whose values differ between two rows. */
function differingColumns(meta, a, b) {
  return meta.columns.filter(c => comparable(c, a[c], meta.ts) !== comparable(c, b[c], meta.ts));
}

function hasNulChar(v) {
  if (typeof v === 'string') return v.includes('\u0000');
  if (Array.isArray(v)) return v.some(hasNulChar);
  if (isPlainObject(v)) return Object.entries(v).some(([k, val]) => k.includes('\u0000') || hasNulChar(val));
  return false;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function pad2(n) { return String(n).padStart(2, '0'); }
function stamp(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}_` +
    `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

function listCapped(items, max = MAX_LISTED) {
  const shown = items.slice(0, max).map(i => `    - ${i}`);
  if (items.length > max) shown.push(`    ... and ${items.length - max} more`);
  return shown;
}

// ─── CLI ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { backup: null, apply: false, yes: false, snapshotDir: null, error: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--yes') args.yes = true;
    else if (a === '--snapshot-dir') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) { args.error = '--snapshot-dir requires a directory argument.'; return args; }
      args.snapshotDir = next;
      i++;
    } else if (a.startsWith('--')) {
      args.error = `Unknown option: ${a}`;
      return args;
    } else if (args.backup === null) {
      args.backup = a;
    } else {
      args.error = `Unexpected extra argument: ${a}`;
      return args;
    }
  }
  if (!args.error && !args.backup) args.error = 'Missing <backup-file> argument.';
  if (!args.error && args.yes && !args.apply) args.error = '--yes is only meaningful together with --apply.';
  if (!args.error && args.snapshotDir && !args.apply) args.error = '--snapshot-dir is only meaningful together with --apply.';
  return args;
}

const USAGE =
  'Usage: node scripts/restore-supabase.js <backup-file> [--apply] [--yes] [--snapshot-dir <dir>]\n' +
  '  (dry run by default; --apply is required to write anything)';

// ─── Validation (pure, no I/O) ──────────────────────────────────────────

function validateRowShape(row, meta, label, errors) {
  if (!isPlainObject(row)) {
    errors.push(`${label}: not a JSON object`);
    return;
  }
  const unexpected = Object.keys(row).filter(k => !meta.columns.includes(k));
  if (unexpected.length) errors.push(`${label}: unexpected column(s) [${unexpected.join(', ')}] — refusing to restore columns outside the verified schema`);
  const missing = meta.columns.filter(k => !(k in row));
  if (missing.length) errors.push(`${label}: missing column(s) [${missing.join(', ')}] — every column must be present so no database default can replace a backed-up value`);
}

function validatePlayerRow(row, i, errors) {
  const label = `nba2k_players[${i}]${isPlainObject(row) && isString(row.slug) ? ` (slug=${row.slug})` : ''}`;
  validateRowShape(row, TABLES.nba2k_players, label, errors);
  if (!isPlainObject(row)) return;
  const bad = (col, why) => errors.push(`${label}: '${col}' ${why}`);
  if ('slug' in row && !isNonEmptyString(row.slug)) bad('slug', 'must be a non-empty string');
  if ('name' in row && !isNonEmptyString(row.name)) bad('name', 'must be a non-empty string (NOT NULL)');
  if ('overall' in row && !isSmallint(row.overall)) bad('overall', 'must be an integer within smallint range (NOT NULL)');
  for (const c of ['team', 'team_type', 'build', 'height', 'weight', 'wingspan', 'player_url', 'team_img', 'player_image']) {
    if (c in row && !isNullOrString(row[c])) bad(c, 'must be a string or null');
  }
  if ('positions' in row && !(Array.isArray(row.positions) && row.positions.every(isString))) bad('positions', 'must be an array of strings (NOT NULL)');
  for (const c of ['attributes', 'badges']) {
    if (c in row && !isPlainObject(row[c])) bad(c, 'must be a JSON object (NOT NULL)');
  }
  for (const c of PLAYER_TS) {
    if (c in row && row[c] !== null && !isValidTimestamp(row[c])) bad(c, 'must be null or an ISO-8601 timestamp string with a UTC offset');
  }
}

function validatePoolRow(row, i, errors) {
  const label = `nba2k27_pool[${i}]${isPlainObject(row) && isString(row.nba2k_ref) ? ` (nba2k_ref=${row.nba2k_ref})` : ''}`;
  validateRowShape(row, TABLES.nba2k27_pool, label, errors);
  if (!isPlainObject(row)) return;
  const bad = (col, why) => errors.push(`${label}: '${col}' ${why}`);
  if ('nba2k_ref' in row && !isNonEmptyString(row.nba2k_ref)) bad('nba2k_ref', 'must be a non-empty string');
  if ('pool' in row && !VALID_POOLS.includes(row.pool)) bad('pool', `must be one of ${VALID_POOLS.join('/')}`);
  if ('position' in row && row.position !== null && !VALID_POSITIONS.includes(row.position)) bad('position', `must be null or one of ${VALID_POSITIONS.join('/')}`);
  if ('overall_override' in row && row.overall_override !== null && !isSmallint(row.overall_override)) bad('overall_override', 'must be null or a smallint integer');
  for (const c of ['name_override', 'variant_group_id', 'variant_label']) {
    if (c in row && !isNullOrString(row[c])) bad(c, 'must be a string or null');
  }
  for (const c of POOL_TS) {
    if (c in row && !isValidTimestamp(row[c])) bad(c, 'must be an ISO-8601 timestamp string with a UTC offset (NOT NULL)');
  }
}

/**
 * Validates a parsed backup object. Returns { errors, orphans } — empty
 * `errors` means the backup is safe to use. Performs no I/O.
 */
function validateBackup(backup) {
  const errors = [];
  const orphans = [];

  if (!isPlainObject(backup)) {
    return { errors: ['Backup root is not a JSON object.'], orphans };
  }

  const unexpectedTop = Object.keys(backup).filter(k => k !== 'metadata' && !EXPECTED_TABLES.includes(k));
  if (unexpectedTop.length) errors.push(`Unexpected top-level key(s): [${unexpectedTop.join(', ')}]`);

  // metadata
  const md = backup.metadata;
  if (!isPlainObject(md)) {
    errors.push('metadata is missing or not an object.');
  } else {
    if (md.format !== BACKUP_FORMAT) {
      errors.push(`metadata.format is ${JSON.stringify(md.format)}, expected "${BACKUP_FORMAT}".`);
    }
    const tables = Array.isArray(md.tables) ? md.tables : null;
    if (!tables || tables.length !== EXPECTED_TABLES.length ||
        [...tables].sort().join('|') !== [...EXPECTED_TABLES].sort().join('|')) {
      errors.push(`metadata.tables must be exactly [${EXPECTED_TABLES.join(', ')}], got ${JSON.stringify(md.tables)}.`);
    }
    if (md.createdAt !== undefined && !isValidTimestamp(md.createdAt)) {
      errors.push('metadata.createdAt is present but not a valid timestamp.');
    }
  }

  // league_state
  const ls = backup.league_state;
  if (ls === undefined) {
    errors.push('league_state dataset is missing.');
  } else if (!isPlainObject(ls)) {
    errors.push('league_state must be a single row object.');
  } else {
    const unexpected = Object.keys(ls).filter(k => !LEAGUE_ROW_COLUMNS.includes(k));
    if (unexpected.length) errors.push(`league_state: unexpected column(s) [${unexpected.join(', ')}]`);
    if (ls.id !== LEAGUE_STATE_ID) errors.push(`league_state.id is ${JSON.stringify(ls.id)}, expected "${LEAGUE_STATE_ID}".`);
    if (!isPlainObject(ls.data)) errors.push('league_state.data must be a JSON object.');
    else if (hasNulChar(ls.data)) errors.push('league_state.data contains a NUL (\\u0000) character, which PostgreSQL jsonb cannot store.');
    if (!isValidTimestamp(ls.updated_at)) errors.push('league_state.updated_at must be a valid timestamp string.');
  }

  // datasets
  for (const name of ['nba2k_players', 'nba2k27_pool']) {
    if (backup[name] === undefined) errors.push(`${name} dataset is missing.`);
    else if (!Array.isArray(backup[name])) errors.push(`${name} must be an array.`);
  }

  const players = Array.isArray(backup.nba2k_players) ? backup.nba2k_players : null;
  const pool = Array.isArray(backup.nba2k27_pool) ? backup.nba2k27_pool : null;

  const rowErrors = [];
  if (players) players.forEach((r, i) => validatePlayerRow(r, i, rowErrors));
  if (pool) pool.forEach((r, i) => validatePoolRow(r, i, rowErrors));
  if (rowErrors.length) {
    errors.push(...rowErrors.slice(0, MAX_LISTED));
    if (rowErrors.length > MAX_LISTED) errors.push(`... and ${rowErrors.length - MAX_LISTED} more row-level error(s).`);
  }
  if (players && players.some(hasNulChar)) errors.push('nba2k_players contains a NUL (\\u0000) character, which PostgreSQL cannot store.');
  if (pool && pool.some(hasNulChar)) errors.push('nba2k27_pool contains a NUL (\\u0000) character, which PostgreSQL cannot store.');

  // uniqueness
  const dupes = (rows, col) => {
    const seen = new Set(); const dup = new Set();
    for (const r of rows) {
      if (isPlainObject(r) && isString(r[col])) { if (seen.has(r[col])) dup.add(r[col]); seen.add(r[col]); }
    }
    return [...dup];
  };
  if (players) {
    const d = dupes(players, 'slug');
    if (d.length) errors.push(`Duplicate nba2k_players.slug value(s): ${d.slice(0, MAX_LISTED).join(', ')}${d.length > MAX_LISTED ? ` ... and ${d.length - MAX_LISTED} more` : ''}`);
  }
  if (pool) {
    const d = dupes(pool, 'nba2k_ref');
    if (d.length) errors.push(`Duplicate nba2k27_pool.nba2k_ref value(s): ${d.slice(0, MAX_LISTED).join(', ')}${d.length > MAX_LISTED ? ` ... and ${d.length - MAX_LISTED} more` : ''}`);
  }

  // FK: every pool.nba2k_ref must exist in the backup's players
  if (players && pool) {
    const slugs = new Set(players.filter(isPlainObject).map(p => p.slug));
    for (const r of pool) {
      if (isPlainObject(r) && isString(r.nba2k_ref) && !slugs.has(r.nba2k_ref)) orphans.push(r.nba2k_ref);
    }
    if (orphans.length) {
      errors.push(
        `${orphans.length} nba2k27_pool row(s) reference a player that is not in the backup's nba2k_players (orphans):\n` +
        listCapped(orphans).join('\n')
      );
    }
  }

  return { errors, orphans };
}

// ─── Supabase REST (native fetch only; injectable for tests) ────────────

function makeClient({ url, serviceRoleKey }, fetchImpl) {
  const base = url.replace(/\/+$/, '');

  function headers(extra = {}) {
    const h = { apikey: serviceRoleKey, ...extra };
    // Legacy service_role JWTs need Authorization too; sb_secret_... keys must not send it.
    if (serviceRoleKey.startsWith('eyJ')) h.Authorization = `Bearer ${serviceRoleKey}`;
    return h;
  }

  async function failureText(res) {
    let body = '';
    try { body = await res.text(); } catch { /* best effort */ }
    return `status: ${res.status} ${res.statusText || ''}\n  body:   ${String(body).slice(0, 2000)}`;
  }

  async function getJson(pathAndQuery, what) {
    const res = await fetchImpl(`${base}/rest/v1/${pathAndQuery}`, {
      method: 'GET',
      headers: headers({ Accept: 'application/json' }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Read of ${what} failed\n  ${await failureText(res)}`);
    return res.json();
  }

  /** Reads EVERY row (paged — PostgREST caps a response at 1000 rows). */
  async function readAll(table) {
    const order = TABLES[table].key;
    const rows = [];
    let offset = 0;
    while (true) {
      const page = await getJson(`${table}?select=*&order=${order}.asc&limit=${READ_PAGE_SIZE}&offset=${offset}`, table);
      if (!Array.isArray(page)) throw new Error(`Read of ${table} returned a non-array response.`);
      rows.push(...page);
      if (page.length < READ_PAGE_SIZE) break;
      offset += READ_PAGE_SIZE;
    }
    return rows;
  }

  async function readLeagueState() {
    const rows = await getJson(`league_state?id=eq.${LEAGUE_STATE_ID}&select=id,data,updated_at`, 'league_state');
    if (!Array.isArray(rows)) throw new Error('Read of league_state returned a non-array response.');
    return rows[0] || null;
  }

  /** One PostgREST upsert batch. POST only; `columns` restricts the written columns to the whitelist. */
  async function upsertBatch(table, rows, batchIndex, totalBatches) {
    const meta = TABLES[table];
    const endpoint = `${base}/rest/v1/${table}?on_conflict=${encodeURIComponent(meta.key)}` +
      `&columns=${encodeURIComponent(meta.columns.join(','))}`;
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify(rows),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(
        `Supabase upsert failed for table '${table}' (batch ${batchIndex + 1}/${totalBatches}, ${rows.length} rows):\n  ${await failureText(res)}`
      );
    }
  }

  async function saveLeagueState(data) {
    const res = await fetchImpl(`${base}/rest/v1/rpc/${SAVE_RPC}`, {
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ p_data: data }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`${SAVE_RPC} failed\n  ${await failureText(res)}`);
  }

  return { readAll, readLeagueState, upsertBatch, saveLeagueState };
}

// ─── Plan / comparison ──────────────────────────────────────────────────

function indexByKey(rows, key) {
  const m = new Map();
  for (const r of rows) m.set(r[key], r);
  return m;
}

function planTable(table, backupRows, liveRows) {
  const meta = TABLES[table];
  const live = indexByKey(liveRows, meta.key);
  const backupKeys = new Set(backupRows.map(r => r[meta.key]));
  let existing = 0; let changed = 0;
  for (const r of backupRows) {
    const l = live.get(r[meta.key]);
    if (l) { existing++; if (differingColumns(meta, r, l).length) changed++; }
  }
  const extraLive = liveRows.filter(r => !backupKeys.has(r[meta.key])).map(r => r[meta.key]);
  return {
    backupCount: backupRows.length,
    liveCount: liveRows.length,
    existing,
    existingChanged: changed,
    created: backupRows.length - existing,
    extraLive,
  };
}

function printPlan(log, args, backup, live, plan) {
  log('');
  log('═══════════════ RESTORE PLAN ═══════════════');
  log('ROLL-FORWARD OVERWRITE — extra live rows will NOT be deleted.');
  log('');
  log(`Backup file:                  ${path.basename(args.backup)}`);
  log(`Backup created at:            ${backup.metadata.createdAt || '(not recorded)'}`);
  log(`Backup league_state.updated_at: ${backup.league_state.updated_at}`);
  if (!live) {
    log('');
    log('Live comparison skipped (no SUPABASE_SERVICE_ROLE_KEY set). Set it to see live counts and overwrite details.');
    log(`Backup nba2k_players rows:    ${backup.nba2k_players.length}`);
    log(`Backup nba2k27_pool rows:     ${backup.nba2k27_pool.length}`);
    return;
  }
  const lsLive = live.league;
  log(`Live league_state.updated_at: ${lsLive ? lsLive.updated_at : '(NO live league_state/main row)'}`);
  if (lsLive && Date.parse(normalizeTsForParse(lsLive.updated_at)) > Date.parse(normalizeTsForParse(backup.league_state.updated_at))) {
    log('  WARNING: the LIVE league state is NEWER than the backup — applying will roll back everything saved since the backup.');
  }
  log('');
  const row = (label, p) => {
    log(`${label}`);
    log(`  backup rows: ${p.backupCount}   live rows: ${p.liveCount}`);
    log(`  already exist (would be overwritten): ${p.existing}  (of which ${p.existingChanged} differ from the backup)`);
    log(`  new rows (would be created):          ${p.created}`);
    if (p.extraLive.length) {
      log(`  WARNING: ${p.extraLive.length} live row(s) are NOT in the backup and will be LEFT AS-IS (not deleted):`);
      for (const l of listCapped(p.extraLive, 10)) log(l);
    }
  };
  row('nba2k_players', plan.players);
  row('nba2k27_pool', plan.pool);
  log('');
  if (!lsLive) {
    log('league_state: live row missing — save_league_state cannot restore into a missing row.');
  } else {
    const same = canonicalJson(lsLive.data) === canonicalJson(backup.league_state.data);
    log(`league_state: WOULD BE REPLACED${same ? ' (live data is already identical to the backup)' : ' (live data differs from the backup)'}`);
  }
  log('');
}

// ─── Snapshot ───────────────────────────────────────────────────────────

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function resolveSnapshotTarget(args, now) {
  const ts = stamp(now);
  const dir = args.snapshotDir
    ? path.resolve(args.snapshotDir)
    : path.join(DEFAULT_SNAPSHOT_PARENT, ts);
  if (isInside(dir, REPO_ROOT)) {
    throw new Error(`Refusing to write the safety snapshot inside the git repository (${REPO_ROOT}). Use --snapshot-dir with a path outside it.`);
  }
  return { dir, file: path.join(dir, `supabase-snapshot-${ts}.json`) };
}

/** Writes the pre-restore snapshot (same supabase-json-v1 shape as the browser backup) and verifies it by re-reading it. */
function writeSnapshot(target, live, now) {
  const snapshot = {
    metadata: { format: BACKUP_FORMAT, createdAt: now.toISOString(), tables: EXPECTED_TABLES, note: 'pre-restore safety snapshot written by scripts/restore-supabase.js' },
    league_state: live.league,
    nba2k_players: live.players,
    nba2k27_pool: live.pool,
  };
  fs.mkdirSync(target.dir, { recursive: true });
  const text = JSON.stringify(snapshot, null, 2);
  fs.writeFileSync(target.file, text, { encoding: 'utf8', flag: 'wx' });

  const reread = JSON.parse(fs.readFileSync(target.file, 'utf8'));
  if (!reread.league_state || canonicalJson(reread.league_state.data) !== canonicalJson(live.league.data) ||
      !Array.isArray(reread.nba2k_players) || reread.nba2k_players.length !== live.players.length ||
      !Array.isArray(reread.nba2k27_pool) || reread.nba2k27_pool.length !== live.pool.length) {
    throw new Error(`Snapshot written to ${target.file} but failed read-back verification.`);
  }
  return { file: target.file, sha256: crypto.createHash('sha256').update(text).digest('hex') };
}

// ─── Confirmation ───────────────────────────────────────────────────────

const CONFIRM_WORD = 'RESTORE';

function defaultConfirm() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let answered = false;
    rl.question(`Type ${CONFIRM_WORD} (exactly) to write to Supabase, anything else to abort: `, (ans) => {
      answered = true; rl.close(); resolve(ans.trim() === CONFIRM_WORD);
    });
    rl.on('close', () => { if (!answered) resolve(false); }); // EOF / non-interactive stdin => decline
  });
}

// ─── Read-back verification ─────────────────────────────────────────────

async function verifyReadBack(client, backup) {
  const failures = [];
  const liveLeague = await client.readLeagueState();
  if (!liveLeague) failures.push('league_state/main row not found on read-back.');
  else if (canonicalJson(liveLeague.data) !== canonicalJson(backup.league_state.data)) {
    failures.push('league_state.data on read-back does not match the backup.');
  }

  const counts = {};
  for (const table of ['nba2k_players', 'nba2k27_pool']) {
    const meta = TABLES[table];
    const live = indexByKey(await client.readAll(table), meta.key);
    let verified = 0;
    for (const row of backup[table]) {
      const l = live.get(row[meta.key]);
      if (!l) { failures.push(`${table}: row ${row[meta.key]} missing on read-back.`); continue; }
      const diff = differingColumns(meta, row, l);
      if (diff.length) failures.push(`${table}: row ${row[meta.key]} differs on read-back in column(s) [${diff.join(', ')}].`);
      else verified++;
    }
    counts[table] = verified;
  }
  return { failures, counts };
}

// ─── Main ───────────────────────────────────────────────────────────────

/**
 * Runs the tool. Returns the process exit code (0 ok, 1 failure) instead of
 * exiting, so tests can drive it. `deps` allows injecting fetch, creds,
 * confirm(), now(), and log/error for tests; defaults are the real ones.
 */
async function main(argv, deps = {}) {
  const log = deps.log || ((...a) => console.log(...a));
  const error = deps.error || ((...a) => console.error(...a));
  const fetchImpl = deps.fetch || globalThis.fetch;
  const nowFn = deps.now || (() => new Date());
  const confirmFn = deps.confirm || defaultConfirm;

  const args = parseArgs(argv);
  if (args.error) {
    error(`ERROR: ${args.error}\n${USAGE}`);
    return 1;
  }

  // 1. Parse + validate locally. No network before this passes.
  let backup;
  try {
    backup = JSON.parse(fs.readFileSync(args.backup, 'utf8'));
  } catch (err) {
    error(`ERROR: could not read/parse backup file "${args.backup}": ${err.message}`);
    return 1;
  }
  const { errors } = validateBackup(backup);
  if (errors.length) {
    error('\nBACKUP VALIDATION FAILED — nothing was sent to Supabase:');
    for (const e of errors) error(`  - ${e}`);
    return 1;
  }
  log(`Backup validated: format ${BACKUP_FORMAT}, ${backup.nba2k_players.length} players, ${backup.nba2k27_pool.length} pool rows, league_state/${LEAGUE_STATE_ID}.`);

  // 2. Credentials
  let creds = deps.creds || null;
  if (!creds) {
    try { creds = initSupabase(); } catch (err) { creds = null; if (args.apply) { error(err.message); return 1; } }
  }
  if (!args.apply && !creds) {
    printPlan(log, args, backup, null, null);
    log('DRY RUN — no writes were made. Re-run with --apply (and SUPABASE_SERVICE_ROLE_KEY set) to restore.');
    return 0;
  }
  const client = makeClient(creds, fetchImpl);

  // 3. Read live state (read-only)
  let live;
  try {
    live = { league: await client.readLeagueState(), players: await client.readAll('nba2k_players'), pool: await client.readAll('nba2k27_pool') };
  } catch (err) {
    error(`\nERROR: could not read live Supabase state: ${err.message}`);
    return 1;
  }
  const plan = { players: planTable('nba2k_players', backup.nba2k_players, live.players), pool: planTable('nba2k27_pool', backup.nba2k27_pool, live.pool) };
  printPlan(log, args, backup, live, plan);

  if (!args.apply) {
    log('DRY RUN — no writes were made. Re-run with --apply to restore.');
    return 0;
  }

  // 4. Apply preconditions
  if (!live.league) {
    error('ABORTED: live league_state/main row does not exist. save_league_state cannot create it, so the restore would end half-applied. Nothing was written.');
    return 1;
  }

  // 5. Safety snapshot — abort on any failure
  const now = nowFn();
  let snap;
  try {
    snap = writeSnapshot(resolveSnapshotTarget(args, now), live, now);
  } catch (err) {
    error(`\nABORTED: could not create the pre-restore safety snapshot — nothing was written to Supabase.\n  ${err.message}`);
    return 1;
  }
  log(`Safety snapshot written: ${snap.file}`);
  log(`  sha256: ${snap.sha256}`);

  // 6. Confirmation
  log('');
  log('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
  log('!!  league_state: this REPLACES THE ENTIRE CURRENT LEAGUE STATE with   !!');
  log("!!  the backup's league state (save_league_state is a full replace).  !!");
  log('!!  Anything saved since the backup was taken will be lost.           !!');
  log('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
  log('This restore is NOT atomic. nba2k_players -> nba2k27_pool -> league_state, stopping at the first failure.');
  if (args.yes) {
    log('--yes supplied: skipping the typed confirmation.');
  } else if (!(await confirmFn())) {
    log('ABORTED by user — nothing was written to Supabase. (Snapshot kept.)');
    return 1;
  }

  // 7. Writes, in order
  const steps = [
    ['nba2k_players', backup.nba2k_players],
    ['nba2k27_pool', backup.nba2k27_pool],
  ];
  for (const [table, rows] of steps) {
    const batches = chunk(rows, BATCH_SIZE);
    log(`\nUpserting ${rows.length} ${table} row(s) in ${batches.length} batch(es) ...`);
    try {
      for (let i = 0; i < batches.length; i++) await client.upsertBatch(table, batches[i], i, batches.length);
    } catch (err) {
      error(`\nRESTORE FAILED while writing ${table}: ${err.message}`);
      if (err.name === 'TimeoutError' || err.name === 'AbortError') error('The outcome of that request is UNKNOWN (timeout).');
      error(`Stopped immediately. ${table === 'nba2k_players' ? 'nba2k27_pool and league_state were NOT written.' : 'league_state was NOT written.'}`);
      error('Earlier batches may already have been applied (the restore is not atomic). No automatic rollback was attempted.');
      error(`Safety snapshot: ${snap.file}`);
      return 1;
    }
  }

  log('\nREPLACING league_state via save_league_state ...');
  try {
    await client.saveLeagueState(backup.league_state.data);
  } catch (err) {
    error(`\nRESTORE FAILED while writing league_state: ${err.message}`);
    if (err.name === 'TimeoutError' || err.name === 'AbortError') error('The outcome of that request is UNKNOWN (timeout) — check the live league_state before retrying.');
    error('nba2k_players and nba2k27_pool were ALREADY RESTORED; league_state was not confirmed. No automatic rollback was attempted.');
    error(`Safety snapshot: ${snap.file}`);
    return 1;
  }

  // 8. Read-back verification
  log('\nVerifying by reading everything back ...');
  let verdict;
  try {
    verdict = await verifyReadBack(client, backup);
  } catch (err) {
    error(`\nRESTORE FAILED: read-back verification could not be completed: ${err.message}`);
    error('The writes were issued but are UNVERIFIED.');
    error(`Safety snapshot: ${snap.file}`);
    return 1;
  }
  if (verdict.failures.length) {
    error('\nRESTORE FAILED — read-back verification found differences (the writes may have succeeded, but the live data does not match the backup):');
    for (const f of listCapped(verdict.failures, MAX_LISTED)) error(f);
    error(`Safety snapshot: ${snap.file}`);
    return 1;
  }

  log('\nRESTORE COMPLETE');
  log(`  players restored:       ${verdict.counts.nba2k_players}`);
  log(`  pool rows restored:     ${verdict.counts.nba2k27_pool}`);
  log('  league state restored:  yes (read-back matches)');
  log(`  safety snapshot:        ${snap.file}`);
  log('  (upsert-only: live rows absent from the backup were left untouched)');
  return 0;
}

module.exports = {
  parseArgs, validateBackup, canonicalJson, canonicalTimestamp, isValidTimestamp,
  differingColumns, makeClient, planTable, resolveSnapshotTarget, writeSnapshot,
  verifyReadBack, main,
  PLAYER_COLUMNS, POOL_COLUMNS, BATCH_SIZE, BACKUP_FORMAT, REPO_ROOT,
};

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((err) => {
    console.error(`\nUnexpected error: ${err && err.message ? err.message : err}`);
    process.exitCode = 1;
  });
}
