/**
 * Phase 8.3.1 — focused, framework-free tests for the safe live-dataset
 * update behavior added to js/admin/nba2k-import.js:
 *   - existing players' `name`/`positions` are preserved, not overwritten
 *     by the fresh API dataset (_toRpcPlayer)
 *   - new players use the API's own `name`/`positions` unmodified,
 *     including unusual source shapes (_toRpcPlayer)
 *   - OVR filtering to 75-99 inclusive (_validateAndPreview) — NEW
 *     behavior as of this phase; no such filter existed before it
 *   - duplicate-slug handling is unchanged
 *   - preview mode performs zero writes
 *   - this file never references nba2k27_pool
 *
 * Same conventions as nba2k-import.phase8_3.test.js: no test framework,
 * plain Node `assert`, `vm` to load the file's object without needing a
 * real browser. Run with:
 *   node js/admin/__tests__/nba2k-import.phase8_3_1.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE_PATH = path.join(__dirname, '..', 'nba2k-import.js');
const source = fs.readFileSync(SOURCE_PATH, 'utf8');

let passed = 0;
function check(label, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok - ${label}`);
  } catch (e) {
    console.error(`  FAIL - ${label}`);
    console.error(`    ${e.stack || e.message}`);
    process.exitCode = 1;
  }
}
async function checkAsync(label, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok - ${label}`);
  } catch (e) {
    console.error(`  FAIL - ${label}`);
    console.error(`    ${e.stack || e.message}`);
    process.exitCode = 1;
  }
}

// ── Static check: this file must never reference nba2k27_pool ───────────
// The simplest, most direct way to prove requirement #13 (the importer
// does not write to nba2k27_pool): the string itself must not appear
// anywhere in the source at all — not in a table name, not in an RPC
// name, not in a comment describing a real code path.
check('source file never references nba2k27_pool', () => {
  assert.strictEqual(source.includes('nba2k27_pool'), false,
    'nba2k-import.js must not reference nba2k27_pool anywhere');
});

// ── A minimal fake DOM, just enough for _validateAndPreview/_runImport ──
function makeFakeElement() {
  return {
    innerHTML: '',
    textContent: '',
    disabled: false,
    classList: { add() {}, remove() {} },
  };
}
function makeFakeContainer() {
  const elements = {
    '#nba2kPreview': makeFakeElement(),
    '#btnNba2kConfirm': makeFakeElement(),
    '#btnNba2kCancel': makeFakeElement(),
    '#nba2kResult': makeFakeElement(),
  };
  return { querySelector: (sel) => elements[sel] };
}

// ── A minimal fake SupabaseQuery, recording every call made ──────────────
function makeFakeSupabaseQuery(existingRows) {
  const calls = { select: [], rpc: [] };
  return {
    calls,
    async select(table, buildQuery) {
      calls.select.push({ table });
      let filterField, filterValues;
      const qb = {
        select() { return qb; },
        in(field, values) { filterField = field; filterValues = values; return qb; },
        order() { return qb; },
        range() { return qb; },
      };
      buildQuery(qb);
      if (filterField === 'slug') {
        return existingRows.filter(r => filterValues.includes(r.slug));
      }
      return existingRows;
    },
    async callWriteRpc(name, params) {
      calls.rpc.push({ name, params });
      return { inserted_count: 0, updated_count: 0, total_count: (params.p_players || []).length };
    },
  };
}

function loadNba2kImport(existingRows) {
  const sandbox = {
    console,
    URL, // Node global, NOT a standard vm-context built-in — _slugFromPlayerUrl needs it
    AuthBoundary: { requireAuth() {} },
    SupabaseQuery: makeFakeSupabaseQuery(existingRows || []),
    escapeHtml: (s) => s,
    showToast: () => {},
  };
  vm.createContext(sandbox);
  const Nba2kImport = vm.runInContext(source + '\n;Nba2kImport;', sandbox, { filename: SOURCE_PATH });
  return { Nba2kImport, supabase: sandbox.SupabaseQuery };
}

function rawPlayer(overrides) {
  return Object.assign({
    name: 'Test Player',
    playerUrl: 'https://www.2kratings.com/test-player',
    team: 'Test Team',
    teamType: 'curr',
    overall: 80,
    attributes: { speed: 70 },
    positions: ['PG'],
    badges: { legendary: 0, hallOfFame: 0, gold: 0, silver: 0, bronze: 0, total: 0, list: [] },
  }, overrides);
}

// ── _toRpcPlayer: preservation rules (pure-function level) ──────────────
console.log('_toRpcPlayer() — existing-player preservation');

check("1. existing player's name is preserved (not overwritten by API)", () => {
  const { Nba2kImport } = loadNba2kImport();
  const existingPlayers = new Map([['dennis-schroder', { name: 'Dennis Schröder', positions: ['PG'] }]]);
  const item = { slug: 'dennis-schroder', doc: { name: 'Dennis Schroder', team: 'T', teamType: 'curr', overall: 84, positions: ['PG', 'SG'], height: null, weight: null, wingspan: null, build: null, playerUrl: 'u', playerImage: null, teamImg: null, attributes: {}, badges: {}, lastUpdated: null } };
  const rpc = Nba2kImport._toRpcPlayer(item, existingPlayers);
  assert.strictEqual(rpc.name, 'Dennis Schröder', 'existing DB name must win over the fresh API name');
});

check("2. existing player's positions are preserved (not overwritten by API)", () => {
  const { Nba2kImport } = loadNba2kImport();
  const existingPlayers = new Map([['some-slug', { name: 'Some Player', positions: ['SF', 'PF'] }]]);
  const item = { slug: 'some-slug', doc: { name: 'Some Player', team: 'T', teamType: 'allt', overall: 90, positions: ['C', 'N'], height: null, weight: null, wingspan: null, build: null, playerUrl: 'u', playerImage: null, teamImg: null, attributes: {}, badges: {}, lastUpdated: null } };
  const rpc = Nba2kImport._toRpcPlayer(item, existingPlayers);
  assert.deepStrictEqual(rpc.positions, ['SF', 'PF'], 'existing DB positions must win over the fresh API positions');
});

check("3. existing player's overall IS updated from the API", () => {
  const { Nba2kImport } = loadNba2kImport();
  const existingPlayers = new Map([['some-slug', { name: 'Old Name', positions: ['PG'] }]]);
  const item = { slug: 'some-slug', doc: { name: 'New Name', team: 'T', teamType: 'curr', overall: 93, positions: ['SG'], height: null, weight: null, wingspan: null, build: null, playerUrl: 'u', playerImage: null, teamImg: null, attributes: {}, badges: {}, lastUpdated: null } };
  const rpc = Nba2kImport._toRpcPlayer(item, existingPlayers);
  assert.strictEqual(rpc.overall, 93, 'overall must always come from the fresh API data');
});

check("4. existing player's attributes ARE updated from the API", () => {
  const { Nba2kImport } = loadNba2kImport();
  const existingPlayers = new Map([['some-slug', { name: 'Old Name', positions: ['PG'] }]]);
  const item = { slug: 'some-slug', doc: { name: 'New Name', team: 'T', teamType: 'curr', overall: 80, positions: ['SG'], height: null, weight: null, wingspan: null, build: null, playerUrl: 'u', playerImage: null, teamImg: null, attributes: { speed: 99, strength: 88 }, badges: {}, lastUpdated: null } };
  const rpc = Nba2kImport._toRpcPlayer(item, existingPlayers);
  assert.deepStrictEqual(rpc.attributes, { speed: 99, strength: 88 }, 'attributes must always come from the fresh API data');
});

check("5. existing player's badges ARE updated from the API", () => {
  const { Nba2kImport } = loadNba2kImport();
  const existingPlayers = new Map([['some-slug', { name: 'Old Name', positions: ['PG'] }]]);
  const newBadges = { legendary: 1, hallOfFame: 2, gold: 3, silver: 4, bronze: 5, total: 15, list: [{ name: 'X', tier: 'gold', category: 'Y' }] };
  const item = { slug: 'some-slug', doc: { name: 'New Name', team: 'T', teamType: 'curr', overall: 80, positions: ['SG'], height: null, weight: null, wingspan: null, build: null, playerUrl: 'u', playerImage: null, teamImg: null, attributes: {}, badges: newBadges, lastUpdated: null } };
  const rpc = Nba2kImport._toRpcPlayer(item, existingPlayers);
  assert.deepStrictEqual(rpc.badges, newBadges, 'badges must always come from the fresh API data');
});

check('6. other supported fields (team, team_type, build, height, weight, wingspan, urls, last_updated) continue updating', () => {
  const { Nba2kImport } = loadNba2kImport();
  const existingPlayers = new Map([['some-slug', { name: 'Old Name', positions: ['PG'] }]]);
  const doc = {
    name: 'New Name', team: 'New Team', teamType: 'class', overall: 85, positions: ['SG'],
    height: `6'5"`, weight: '210 lbs', wingspan: `6'9"`, build: 'Athletic',
    playerUrl: 'https://www.2kratings.com/some-slug', playerImage: 'img.png', teamImg: 'team.png',
    attributes: {}, badges: {}, lastUpdated: '2026-09-01T00:00:00.000Z',
  };
  const rpc = Nba2kImport._toRpcPlayer({ slug: 'some-slug', doc }, existingPlayers);
  assert.strictEqual(rpc.team, 'New Team');
  assert.strictEqual(rpc.team_type, 'class');
  assert.strictEqual(rpc.build, 'Athletic');
  assert.strictEqual(rpc.height, `6'5"`);
  assert.strictEqual(rpc.weight, '210 lbs');
  assert.strictEqual(rpc.wingspan, `6'9"`);
  assert.strictEqual(rpc.player_url, 'https://www.2kratings.com/some-slug');
  assert.strictEqual(rpc.player_image, 'img.png');
  assert.strictEqual(rpc.team_img, 'team.png');
  assert.strictEqual(rpc.last_updated, '2026-09-01T00:00:00.000Z');
});

console.log('_toRpcPlayer() — new-player handling');

check('7. a genuinely new player (no existing entry) is created using the API name', () => {
  const { Nba2kImport } = loadNba2kImport();
  const existingPlayers = new Map(); // empty — nothing exists yet
  const item = { slug: 'brand-new-player', doc: { name: 'Brand New Player', team: 'T', teamType: 'allt', overall: 78, positions: ['PF', 'N'], height: null, weight: null, wingspan: null, build: null, playerUrl: 'u', playerImage: null, teamImg: null, attributes: {}, badges: {}, lastUpdated: null } };
  const rpc = Nba2kImport._toRpcPlayer(item, existingPlayers);
  assert.strictEqual(rpc.name, 'Brand New Player', 'a new player must use the API name as-is');
});

check("8. a new player's API positions are retained verbatim, including unusual shapes like [\"C\",\"N\"]", () => {
  const { Nba2kImport } = loadNba2kImport();
  const existingPlayers = new Map();
  const item = { slug: 'brand-new-player', doc: { name: 'Brand New Player', team: 'T', teamType: 'allt', overall: 78, positions: ['C', 'N'], height: null, weight: null, wingspan: null, build: null, playerUrl: 'u', playerImage: null, teamImg: null, attributes: {}, badges: {}, lastUpdated: null } };
  const rpc = Nba2kImport._toRpcPlayer(item, existingPlayers);
  assert.deepStrictEqual(rpc.positions, ['C', 'N'], 'new-player positions must be retained verbatim — never converted to UNASSIGNED here');
});

check('_toRpcPlayer still works with no existingPlayers argument at all (backward compatible)', () => {
  const { Nba2kImport } = loadNba2kImport();
  const item = { slug: 'x', doc: { name: 'X', team: 'T', teamType: 'curr', overall: 80, positions: ['PG'], height: null, weight: null, wingspan: null, build: null, playerUrl: 'u', playerImage: null, teamImg: null, attributes: {}, badges: {}, lastUpdated: null } };
  const rpc = Nba2kImport._toRpcPlayer(item);
  assert.strictEqual(rpc.name, 'X');
  assert.deepStrictEqual(rpc.positions, ['PG']);
});

// ── Integration-level checks via _validateAndPreview / _runImport ───────
console.log('_validateAndPreview() / _runImport() — integration checks');

(async () => {
  await checkAsync('9. a record with overall < 75 is excluded from both toCreate and toUpdate', async () => {
    const { Nba2kImport } = loadNba2kImport([]);
    const container = makeFakeContainer();
    const json = { players: [rawPlayer({ name: 'Too Low', playerUrl: 'https://www.2kratings.com/too-low', overall: 74 })] };
    await Nba2kImport._validateAndPreview(container, json);
    assert.strictEqual(Nba2kImport._lastParsed.toCreate.length, 0);
    assert.strictEqual(Nba2kImport._lastParsed.toUpdate.length, 0);
    assert.strictEqual(Nba2kImport._lastParsed.excludedByOverall, 1);
  });

  await checkAsync('10. a record with overall > 99 is excluded from both toCreate and toUpdate', async () => {
    const { Nba2kImport } = loadNba2kImport([]);
    const container = makeFakeContainer();
    const json = { players: [rawPlayer({ name: 'Too High', playerUrl: 'https://www.2kratings.com/too-high', overall: 100 })] };
    await Nba2kImport._validateAndPreview(container, json);
    assert.strictEqual(Nba2kImport._lastParsed.toCreate.length, 0);
    assert.strictEqual(Nba2kImport._lastParsed.toUpdate.length, 0);
    assert.strictEqual(Nba2kImport._lastParsed.excludedByOverall, 1);
  });

  await checkAsync('boundary values 75 and 99 are both included (inclusive range)', async () => {
    const { Nba2kImport } = loadNba2kImport([]);
    const container = makeFakeContainer();
    const json = { players: [
      rawPlayer({ name: 'Floor', playerUrl: 'https://www.2kratings.com/floor-player', overall: 75 }),
      rawPlayer({ name: 'Ceiling', playerUrl: 'https://www.2kratings.com/ceiling-player', overall: 99 }),
    ] };
    await Nba2kImport._validateAndPreview(container, json);
    assert.strictEqual(Nba2kImport._lastParsed.toCreate.length, 2);
    assert.strictEqual(Nba2kImport._lastParsed.excludedByOverall, 0);
  });

  await checkAsync('11. duplicate-slug handling is unchanged: the second occurrence is skipped as an error', async () => {
    const { Nba2kImport } = loadNba2kImport([]);
    const container = makeFakeContainer();
    const json = { players: [
      rawPlayer({ name: 'First', playerUrl: 'https://www.2kratings.com/dup-slug', overall: 80 }),
      rawPlayer({ name: 'Second', playerUrl: 'https://www.2kratings.com/dup-slug', overall: 85 }),
    ] };
    await Nba2kImport._validateAndPreview(container, json);
    assert.strictEqual(Nba2kImport._lastParsed.toCreate.length, 1, 'only the first occurrence should survive');
    assert.strictEqual(Nba2kImport._lastParsed.errors.length, 1, 'the duplicate should be recorded as an error');
    assert.ok(/duplicate slug/i.test(Nba2kImport._lastParsed.errors[0]));
  });

  await checkAsync('12. preview mode performs zero writes (no RPC calls) even with mixed new/existing/excluded records', async () => {
    const existingRows = [{ slug: 'existing-player', name: 'Existing Player', positions: ['PG'] }];
    const { Nba2kImport, supabase } = loadNba2kImport(existingRows);
    const container = makeFakeContainer();
    const json = { players: [
      rawPlayer({ name: 'Existing Player', playerUrl: 'https://www.2kratings.com/existing-player', overall: 88 }),
      rawPlayer({ name: 'New Player', playerUrl: 'https://www.2kratings.com/new-player', overall: 80 }),
      rawPlayer({ name: 'Excluded Player', playerUrl: 'https://www.2kratings.com/excluded-player', overall: 50 }),
    ] };
    await Nba2kImport._validateAndPreview(container, json);
    assert.strictEqual(supabase.calls.rpc.length, 0, 'preview must never call the write RPC');
    assert.ok(supabase.calls.select.length >= 1, 'preview should still perform its read');
    assert.strictEqual(Nba2kImport._lastParsed.toUpdate.length, 1);
    assert.strictEqual(Nba2kImport._lastParsed.toCreate.length, 1);
    assert.strictEqual(Nba2kImport._lastParsed.excludedByOverall, 1);
  });

  await checkAsync('13. the full preview -> import pipeline never calls anything referencing nba2k27_pool, and preserves/creates correctly end-to-end', async () => {
    const existingRows = [{ slug: 'existing-player', name: 'Existing Player (DB)', positions: ['C'] }];
    const { Nba2kImport, supabase } = loadNba2kImport(existingRows);
    const container = makeFakeContainer();
    const json = { players: [
      rawPlayer({ name: 'Existing Player (API)', playerUrl: 'https://www.2kratings.com/existing-player', overall: 91, positions: ['PF'] }),
      rawPlayer({ name: 'New Player (API)', playerUrl: 'https://www.2kratings.com/new-player', overall: 82, positions: ['SF', 'N'] }),
    ] };
    await Nba2kImport._validateAndPreview(container, json);
    await Nba2kImport._runImport(container);

    // No call anywhere referenced a pool table or RPC.
    const allCallTargets = [
      ...supabase.calls.select.map(c => c.table),
      ...supabase.calls.rpc.map(c => c.name),
    ];
    assert.ok(allCallTargets.every(t => !String(t).includes('pool')), `no call should touch anything pool-related, got: ${JSON.stringify(allCallTargets)}`);

    assert.strictEqual(supabase.calls.rpc.length, 1, 'the whole (small) batch should fit in one RPC call');
    const sentPlayers = supabase.calls.rpc[0].params.p_players;
    const existingSent = sentPlayers.find(p => p.slug === 'existing-player');
    const newSent = sentPlayers.find(p => p.slug === 'new-player');

    assert.strictEqual(existingSent.name, 'Existing Player (DB)', 'existing name preserved through the full pipeline');
    assert.deepStrictEqual(existingSent.positions, ['C'], 'existing positions preserved through the full pipeline');
    assert.strictEqual(existingSent.overall, 91, 'existing overall still updates through the full pipeline');

    assert.strictEqual(newSent.name, 'New Player (API)', 'new player uses API name through the full pipeline');
    assert.deepStrictEqual(newSent.positions, ['SF', 'N'], 'new player API positions retained through the full pipeline, not UNASSIGNED');
  });

  console.log(`\n${passed} check(s) passed.`);
  if (process.exitCode) {
    console.error('SOME CHECKS FAILED');
    process.exit(1);
  } else {
    console.log('ALL CHECKS PASSED');
  }
})();
