#!/usr/bin/env node
/**
 * scripts/import-nba2k27-live-pool.js
 *
 * One-time(-per-snapshot), idempotent import of the two NBA2K27 live-pool
 * Firestore collections — `nba2k_players` (raw source) and `nba2k27_pool`
 * (curated pool) — into their Supabase counterparts, from a backup
 * produced by `scripts/backup.js`. Built per the Phase 6.7g design audit's
 * exact field mapping (js/data.js's LiveNba2k27PoolCache.buildEntries()
 * is the behavioral spec these two tables feed; see that audit for the
 * full reasoning).
 *
 * SAFETY / SCOPE:
 *   - Touches ONLY `nba2k_players` and `nba2k27_pool` in Supabase. No
 *     other table (seasons, players, draft_picks, roster_entries,
 *     financial_transactions, schedule/playoff tables, etc.) is ever
 *     referenced by this script.
 *   - NEVER deletes/truncates anything — upsert only, keyed on `slug`
 *     (nba2k_players) / `nba2k_ref` (nba2k27_pool).
 *   - Idempotent by construction: since each Firestore doc ID already
 *     equals the record's own key (slug / nba2kRef), re-running this
 *     script against the same or a newer backup simply re-asserts the
 *     same rows.
 *   - Validates everything BEFORE opening any Supabase connection. Any
 *     validation error (including orphaned pool references) aborts with
 *     ZERO writes attempted.
 *   - Dry-run (--dry-run) never touches Supabase at all — not even to
 *     check credentials. It parses, validates, maps, and reports exactly
 *     what WOULD be upserted.
 *
 * CREDENTIALS (Phase 6.7i/6.7j convention):
 *   Resolved via scripts/lib/init-supabase.js — plain process.env
 *   variables only, no .env file/loader, no new dependency:
 *     SUPABASE_URL               optional, defaults to this project's
 *                                 known public URL (not a secret — the
 *                                 same value js/supabase-config.js already
 *                                 ships to every browser).
 *     SUPABASE_SERVICE_ROLE_KEY  required, no default. Never logged,
 *                                 echoed, or included in any error
 *                                 message. Missing/blank => immediate
 *                                 failure, zero network requests.
 *   Credential resolution happens LAST — only after backup-path
 *   validation, JSON parsing, full source validation, mapping, and batch
 *   calculation have already succeeded (see main() below). Writes use
 *   native fetch() against Supabase PostgREST directly — no
 *   `@supabase/supabase-js` dependency was added.
 *
 * Usage:
 *   node scripts/import-nba2k27-live-pool.js --backup <path> --dry-run
 *   SUPABASE_SERVICE_ROLE_KEY=... node scripts/import-nba2k27-live-pool.js --backup <path>
 *   node scripts/import-nba2k27-live-pool.js --backup <path> --dry-run --batch-size 250
 */

const fs = require('fs');
const path = require('path');
const { initSupabase } = require('./lib/init-supabase');

const DEFAULT_BATCH_SIZE = 500; // matches scripts/restore.js's BATCH_LIMIT convention

const VALID_POOLS = ['green', 'blue', 'white'];
const VALID_POSITIONS = ['PG', 'SG', 'SF', 'PF', 'C', 'UNASSIGNED'];

// ─── Arg parsing (no CLI-parsing dependency — matches this project's
//     existing scripts, which parse process.argv directly) ────────────
function parseArgs(argv) {
  const args = { backup: null, dryRun: false, batchSize: DEFAULT_BATCH_SIZE };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--backup') {
      args.backup = argv[++i];
    } else if (a === '--dry-run') {
      args.dryRun = true;
    } else if (a === '--batch-size') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error(`--batch-size must be a positive integer, got: ${argv[i]}`);
      }
      args.batchSize = n;
    } else {
      throw new Error(`Unrecognized argument: ${a}`);
    }
  }
  return args;
}

// ─── Input loading ──────────────────────────────────────────────────────
/**
 * Requires an EXPLICIT backup path — never guesses/picks the newest
 * backup on disk. Validates both expected input files exist before any
 * parsing or Supabase-related code runs at all.
 */
function loadInputFiles(backupDir) {
  const playersPath = path.join(backupDir, 'firestore', 'nba2k_players.json');
  const poolPath = path.join(backupDir, 'firestore', 'nba2k27_pool.json');

  const missing = [playersPath, poolPath].filter((p) => !fs.existsSync(p));
  if (missing.length) {
    throw new Error(
      `Missing expected backup file(s):\n` + missing.map((p) => `  - ${p}`).join('\n')
    );
  }

  const players = JSON.parse(fs.readFileSync(playersPath, 'utf8'));
  const pool = JSON.parse(fs.readFileSync(poolPath, 'utf8'));

  if (!Array.isArray(players)) throw new Error(`${playersPath} did not contain a JSON array.`);
  if (!Array.isArray(pool)) throw new Error(`${poolPath} did not contain a JSON array.`);

  return { playersPath, poolPath, players, pool };
}

// ─── Firebase timestamp handling (Phase 6.7m) ──────────────────────────
/**
 * Shape guard for a Firebase-serialized Timestamp, exactly as this
 * project's backup export represents it (see
 * scripts/lib/firestore-serialize.js): { __type: 'timestamp', seconds,
 * nanoseconds }. Confirmed by direct inspection of the validated
 * snapshot: `nba2k_players.importedAt` is ALWAYS this object shape
 * (1,987/1,987 records); `nba2k_players.lastUpdated` and
 * `nba2k27_pool.selectedAt`/`updatedAt` are ALWAYS already plain
 * ISO-8601 strings today. All four map to a `timestamptz` column
 * (confirmed via schema inspection), so all four are validated and
 * converted the same way for consistency — even though only one of
 * them currently needs an actual conversion.
 */
function isFirebaseTimestampObject(v) {
  return !!v && typeof v === 'object' && v.__type === 'timestamp';
}

/**
 * True if a source value is one of the three shapes actually observed
 * (or otherwise safe) for a timestamp-mapped field: absent, an
 * already-ISO string, or a well-formed Firebase timestamp object
 * (integer seconds, integer nanoseconds in 0-999,999,999). Anything
 * else fails validation before any mapping/write is attempted, per the
 * validation-first execution order.
 */
function isValidTimestampSourceValue(v) {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string') return true;
  if (isFirebaseTimestampObject(v)) {
    return Number.isInteger(v.seconds) &&
      Number.isInteger(v.nanoseconds) &&
      v.nanoseconds >= 0 && v.nanoseconds <= 999999999;
  }
  return false;
}

/**
 * Converts a Firebase-serialized Timestamp ({ __type: 'timestamp',
 * seconds, nanoseconds }) into a PostgreSQL-compatible ISO-8601 UTC
 * string at microsecond precision — the finest unit `timestamptz`
 * actually stores. Rounds (never truncates) nanoseconds to the nearest
 * microsecond, so no meaningful precision already present in the source
 * is dropped beyond PostgreSQL's own storage granularity. Always
 * expressed in UTC ('Z' suffix) — never the local machine's timezone.
 *
 * A plain string is returned unchanged (it's already ISO-8601 — see
 * lastUpdated/selectedAt/updatedAt in this snapshot). null/undefined
 * pass through as null. Any other shape returns null, but
 * isValidTimestampSourceValue() above is expected to have already
 * rejected it during validation, before mapping is ever reached.
 */
function toPostgresTimestamp(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') return v;
  if (isFirebaseTimestampObject(v)) {
    const totalMicros = v.seconds * 1e6 + Math.round(v.nanoseconds / 1000);
    const epochMillis = Math.floor(totalMicros / 1000);
    const subMillisecondMicros = ((totalMicros % 1000) + 1000) % 1000; // correct modulo for pre-1970 seconds too
    const iso = new Date(epochMillis).toISOString(); // '...sssZ', always UTC
    return iso.replace('Z', String(subMillisecondMicros).padStart(3, '0') + 'Z');
  }
  return null;
}

// ─── Validation ─────────────────────────────────────────────────────────
/**
 * Validates nba2k_players entries. Returns { errors: string[] }.
 * Deliberately checks only what the Supabase mapping actually needs
 * (§5/§6 of the Phase 6.7g audit) — no invented rules beyond that.
 */
function validatePlayers(players) {
  const errors = [];
  const seenIds = new Set();

  players.forEach((entry, i) => {
    const label = `nba2k_players[${i}]`;
    if (!entry || typeof entry !== 'object') {
      errors.push(`${label}: not an object`);
      return;
    }
    const id = entry.id;
    const data = entry.data || {};

    if (!id || typeof id !== 'string') {
      errors.push(`${label}: missing/invalid document id (slug)`);
    } else if (seenIds.has(id)) {
      errors.push(`${label} (id=${id}): duplicate slug`);
    } else {
      seenIds.add(id);
    }

    if (!data.name || typeof data.name !== 'string' || !data.name.trim()) {
      errors.push(`${label} (id=${id}): missing/empty required field 'name'`);
    }
    if (data.overall !== undefined && typeof data.overall !== 'number') {
      errors.push(`${label} (id=${id}): 'overall' present but not a number`);
    }
    if (data.positions !== undefined && !Array.isArray(data.positions)) {
      errors.push(`${label} (id=${id}): 'positions' present but not an array`);
    }
    if (data.attributes !== undefined && typeof data.attributes !== 'object') {
      errors.push(`${label} (id=${id}): 'attributes' present but not an object`);
    }
    if (data.badges !== undefined && typeof data.badges !== 'object') {
      errors.push(`${label} (id=${id}): 'badges' present but not an object`);
    }
    if (!isValidTimestampSourceValue(data.lastUpdated)) {
      errors.push(`${label} (id=${id}): 'lastUpdated' is not a valid timestamp (expected an ISO string, a well-formed Firebase timestamp object, or absent)`);
    }
    if (!isValidTimestampSourceValue(data.importedAt)) {
      errors.push(`${label} (id=${id}): 'importedAt' is not a valid timestamp (expected an ISO string, a well-formed Firebase timestamp object, or absent)`);
    }
  });

  return { errors, uniqueIds: seenIds };
}

/**
 * Validates nba2k27_pool entries against the exact Phase 6.7a column
 * constraints (pool/position CHECKs) plus the doc-id/nba2kRef identity
 * rule this codebase relies on throughout (confirmed 1:1 in production
 * data during the Phase 6.7g audit). Returns { errors: string[] }.
 */
function validatePool(pool) {
  const errors = [];
  const seenIds = new Set();
  const seenRefs = new Set();

  pool.forEach((entry, i) => {
    const label = `nba2k27_pool[${i}]`;
    if (!entry || typeof entry !== 'object') {
      errors.push(`${label}: not an object`);
      return;
    }
    const id = entry.id;
    const data = entry.data || {};
    const ref = data.nba2kRef;

    if (!id || typeof id !== 'string') {
      errors.push(`${label}: missing/invalid document id`);
    } else if (seenIds.has(id)) {
      errors.push(`${label} (id=${id}): duplicate document id`);
    } else {
      seenIds.add(id);
    }

    if (!ref || typeof ref !== 'string') {
      errors.push(`${label} (id=${id}): missing/invalid required field 'nba2kRef'`);
    } else {
      if (seenRefs.has(ref)) {
        errors.push(`${label} (id=${id}): duplicate nba2kRef '${ref}'`);
      } else {
        seenRefs.add(ref);
      }
      if (id && ref !== id) {
        errors.push(`${label}: document id ('${id}') !== nba2kRef ('${ref}')`);
      }
    }

    if (!VALID_POOLS.includes(data.pool)) {
      errors.push(`${label} (id=${id}): 'pool' is '${data.pool}', expected one of ${VALID_POOLS.join('/')}`);
    }

    if (data.position !== undefined && data.position !== null && !VALID_POSITIONS.includes(data.position)) {
      errors.push(`${label} (id=${id}): 'position' is '${data.position}', expected absent/null or one of ${VALID_POSITIONS.join('/')}`);
    }

    if (data.overallOverride !== undefined && data.overallOverride !== null && typeof data.overallOverride !== 'number') {
      errors.push(`${label} (id=${id}): 'overallOverride' present but not numeric/null`);
    }
    if (data.nameOverride !== undefined && data.nameOverride !== null && typeof data.nameOverride !== 'string') {
      errors.push(`${label} (id=${id}): 'nameOverride' present but not a string/null`);
    }
    if (data.variantGroupId !== undefined && data.variantGroupId !== null && typeof data.variantGroupId !== 'string') {
      errors.push(`${label} (id=${id}): 'variantGroupId' present but not a string/null`);
    }
    if (!isValidTimestampSourceValue(data.selectedAt)) {
      errors.push(`${label} (id=${id}): 'selectedAt' is not a valid timestamp (expected an ISO string, a well-formed Firebase timestamp object, or absent)`);
    }
    if (!isValidTimestampSourceValue(data.updatedAt)) {
      errors.push(`${label} (id=${id}): 'updatedAt' is not a valid timestamp (expected an ISO string, a well-formed Firebase timestamp object, or absent)`);
    }
  });

  return { errors, uniqueRefs: seenRefs };
}

/** Cross-references every pool.nba2kRef against the known player slugs. */
function findOrphans(pool, playerIds) {
  const orphans = [];
  pool.forEach((entry) => {
    const ref = entry.data && entry.data.nba2kRef;
    if (ref && !playerIds.has(ref)) orphans.push(ref);
  });
  return orphans;
}

// ─── Firebase -> Supabase row mapping (Phase 6.7g field mapping,
//     applied exactly) ──────────────────────────────────────────────────
/** Missing/absent optional fields become explicit `null`, never '' or
 *  an omitted key — an omitted key would leave a stale prior value in
 *  place on a re-import via upsert; explicit null correctly clears it. */
function mapPlayerRow(entry) {
  const d = entry.data || {};
  return {
    slug: entry.id,
    name: d.name,
    overall: d.overall ?? null,
    team: d.team ?? null,
    team_type: d.teamType ?? null,
    positions: d.positions ?? null,
    build: d.build ?? null,
    height: d.height ?? null,
    weight: d.weight ?? null,
    wingspan: d.wingspan ?? null,
    attributes: d.attributes ?? null,
    badges: d.badges ?? null,
    player_url: d.playerUrl ?? null,
    team_img: d.teamImg ?? null,
    player_image: d.playerImage ?? null,
    last_updated: toPostgresTimestamp(d.lastUpdated),
    imported_at: toPostgresTimestamp(d.importedAt),
  };
}

function mapPoolRow(entry) {
  const d = entry.data || {};
  return {
    nba2k_ref: d.nba2kRef,
    pool: d.pool,
    position: d.position ?? null,
    overall_override: d.overallOverride ?? null,
    name_override: d.nameOverride ?? null,
    variant_group_id: d.variantGroupId ?? null,
    selected_at: toPostgresTimestamp(d.selectedAt),
    updated_at: toPostgresTimestamp(d.updatedAt),
  };
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ─── Write path — real PostgREST upsert, native fetch() only, no
//     @supabase/supabase-js. Only ever called AFTER every source-data
//     check above has already passed (see main()). ─────────────────────
/**
 * POSTs one batch of rows to a PostgREST upsert endpoint
 * (`/rest/v1/<table>?on_conflict=<column>`), using
 * `Prefer: resolution=merge-duplicates,return=minimal` so it's a true
 * upsert (never a plain insert that would fail on an existing key) and
 * never returns row bodies we don't need. POST-only — no PATCH, DELETE,
 * or TRUNCATE is ever issued by this script.
 *
 * Throws with the target table/batch/HTTP status/response body on
 * failure — the credential value itself is never included (it lives
 * only in the request headers, never interpolated into any message).
 */
/**
 * Builds the request headers for a PostgREST call, shaped per Supabase's
 * two server-side credential formats (Phase 6.7l):
 *   - 'modern' (sb_secret_...): NOT a JWT — send only `apikey`, never an
 *     Authorization Bearer header.
 *   - 'legacy' (eyJ... service_role JWT): send both `apikey` and
 *     `Authorization: Bearer <key>`, as PostgREST has always expected.
 */
function buildSupabaseHeaders(serviceRoleKey, keyType) {
  const headers = {
    apikey: serviceRoleKey,
    'Content-Type': 'application/json',
    Prefer: 'resolution=merge-duplicates,return=minimal',
  };
  if (keyType === 'legacy') {
    headers.Authorization = `Bearer ${serviceRoleKey}`;
  }
  return headers;
}

async function upsertBatch({ url, serviceRoleKey, keyType }, table, onConflictColumn, rows, batchIndex, totalBatches) {
  const endpoint = `${url.replace(/\/+$/, '')}/rest/v1/${encodeURIComponent(table)}` +
    `?on_conflict=${encodeURIComponent(onConflictColumn)}`;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: buildSupabaseHeaders(serviceRoleKey, keyType),
    body: JSON.stringify(rows),
  });

  if (!res.ok) {
    let bodyText = '';
    try {
      bodyText = await res.text();
    } catch {
      /* best-effort only */
    }
    throw new Error(
      `Supabase upsert failed for table '${table}' ` +
      `(batch ${batchIndex + 1}/${totalBatches}, ${rows.length} row${rows.length === 1 ? '' : 's'}):\n` +
      `  target: ${endpoint}\n` +
      `  status: ${res.status} ${res.statusText}\n` +
      `  body:   ${bodyText.slice(0, 2000)}`
    );
  }
}

/** Upserts every batch for both tables, in order: all of nba2k_players
 *  first (so nba2k27_pool's nba2k_ref FK always has something to point
 *  at), then all of nba2k27_pool. Stops on the first failed batch. */
async function performUpsert(creds, playerBatches, poolBatches) {
  for (let i = 0; i < playerBatches.length; i++) {
    await upsertBatch(creds, 'nba2k_players', 'slug', playerBatches[i], i, playerBatches.length);
  }
  for (let i = 0; i < poolBatches.length; i++) {
    await upsertBatch(creds, 'nba2k27_pool', 'nba2k_ref', poolBatches[i], i, poolBatches.length);
  }
}

// ─── Main ───────────────────────────────────────────────────────────────
async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`Argument error: ${err.message}`);
    console.error('\nUsage: node scripts/import-nba2k27-live-pool.js --backup <path> [--dry-run] [--batch-size <n>]');
    process.exitCode = 1;
    return;
  }

  if (!args.backup) {
    console.error('Error: --backup <path> is required (this script never guesses a backup directory).');
    console.error('\nUsage: node scripts/import-nba2k27-live-pool.js --backup <path> [--dry-run] [--batch-size <n>]');
    process.exitCode = 1;
    return;
  }

  let players, pool, playersPath, poolPath;
  try {
    ({ players, pool, playersPath, poolPath } = loadInputFiles(args.backup));
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const playerValidation = validatePlayers(players);
  const poolValidation = validatePool(pool);
  const orphans = findOrphans(pool, playerValidation.uniqueIds);

  const poolCounts = { green: 0, blue: 0, white: 0, other: 0 };
  pool.forEach((entry) => {
    const p = entry.data && entry.data.pool;
    if (VALID_POOLS.includes(p)) poolCounts[p]++;
    else poolCounts.other++;
  });

  const allErrors = [
    ...playerValidation.errors,
    ...poolValidation.errors,
    ...orphans.map((ref) => `orphan: nba2k27_pool references nba2kRef '${ref}', not found in nba2k_players`),
  ];

  console.log('\n=== NBA2K27 Live Pool Import — Validation Summary ===');
  console.log(`Source backup:        ${path.resolve(args.backup)}`);
  console.log(`  nba2k_players file: ${playersPath}`);
  console.log(`  nba2k27_pool file:  ${poolPath}`);
  console.log(`nba2k_players count: ${players.length}`);
  console.log(`nba2k27_pool count:  ${pool.length}`);
  console.log(`  pool breakdown:    green=${poolCounts.green} blue=${poolCounts.blue} white=${poolCounts.white}` +
    (poolCounts.other ? ` other/invalid=${poolCounts.other}` : ''));
  console.log(`Orphan count:        ${orphans.length}`);
  console.log(`Validation errors:   ${allErrors.length}`);
  if (allErrors.length) {
    console.log('\nErrors:');
    allErrors.forEach((e) => console.log(`  - ${e}`));
  }

  if (allErrors.length > 0) {
    console.error('\nABORTING: validation failed. Zero Supabase writes were attempted.');
    process.exitCode = 1;
    return;
  }

  const playerRows = players.map(mapPlayerRow);
  const poolRows = pool.map(mapPoolRow);
  const playerBatches = chunk(playerRows, args.batchSize);
  const poolBatches = chunk(poolRows, args.batchSize);

  console.log('\n=== Planned Upsert ===');
  console.log(`Batch size:                 ${args.batchSize}`);
  console.log(`nba2k_players rows to upsert: ${playerRows.length} (${playerBatches.length} batch${playerBatches.length === 1 ? '' : 'es'})`);
  console.log(`nba2k27_pool rows to upsert:  ${poolRows.length} (${poolBatches.length} batch${poolBatches.length === 1 ? '' : 'es'})`);
  console.log('Upsert keys: nba2k_players.slug, nba2k27_pool.nba2k_ref (never a DELETE/TRUNCATE)');

  if (args.dryRun) {
    console.log('\nDRY RUN — no Supabase connection was made, no writes were attempted.');
    return;
  }

  // Credential validation happens LAST, only now that every source-data
  // check above has already passed — see the Phase 6.7i/6.7j design.
  // Missing/blank SUPABASE_SERVICE_ROLE_KEY fails here with zero network
  // requests ever made.
  let creds;
  try {
    creds = initSupabase();
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
    return;
  }

  console.log(`\nUpserting to ${creds.url} ...`);
  try {
    await performUpsert(creds, playerBatches, poolBatches);
  } catch (err) {
    console.error(`\nImport FAILED: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  console.log('\n=== Import Complete ===');
  console.log(`Source backup:              ${path.resolve(args.backup)}`);
  console.log(`Target:                     ${creds.url}`);
  console.log(`nba2k_players rows written: ${playerRows.length} (${playerBatches.length} batch${playerBatches.length === 1 ? '' : 'es'})`);
  console.log(`nba2k27_pool rows written:  ${poolRows.length} (${poolBatches.length} batch${poolBatches.length === 1 ? '' : 'es'})`);
  console.log('Status: SUCCESS');
}

main();
