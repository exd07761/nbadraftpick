'use strict';
/**
 * NBA2K27 live-pool audit fixes — dedicated tests.
 *
 * Covers exactly the two fixes from the read-only audit:
 *
 *   FIX 1 — loadData()/getAllPlayers()/getPlayer() only merge the live
 *   NBA2K27 pool (LiveNba2k27PoolCache) when explicitly asked on behalf
 *   of a season whose OWN `playerPoolScope === LIVE_NBA2K27_POOL_SCOPE`.
 *   No global merge exists anymore — an unscoped call, an unscoped
 *   legacy season, and an old-style scoped season (`playerPoolScope`
 *   set to its own id) never see a live-pool entry.
 *
 *   FIX 2 — AdminActions.deleteSeason() removes a deleted OLD-style
 *   season's own stored player records (tagged `seasonId === season.id`
 *   by seedSeasonFromNba2k27Pool), while never touching another
 *   season's players, an unscoped/shared pool's players, or the live
 *   pool's synthetic entries (which are never stored to begin with).
 *
 * Data-layer only (loads js/data.js directly, no jsdom/admin UI) — same
 * approach as tests_season_cutover/season_cutover_test.js.
 *
 * Run with: node tests_nba2k27_live_pool_scoping/live_pool_scoping_fix_test.js
 * Never touches the real nbadraftpick Firestore project — the mock
 * Firestore below is entirely in-memory.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const dataSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'data.js'), 'utf8');

function poolEntry(overrides = {}) {
  return Object.assign({ pool: 'green', position: 'PG' }, overrides);
}
function sourcePlayer(overrides = {}) {
  return Object.assign({ name: 'Source Name', team: 'T', overall: 85 }, overrides);
}

function makeEnv(opts = {}) {
  const {
    nba2k27PoolDocs = { sga: poolEntry({ position: 'PG' }) },
    nba2kPlayersDocs = { sga: sourcePlayer({ name: 'Shai Gilgeous-Alexander', overall: 97 }) },
    initialLeagueDoc = null,
  } = opts;

  const sandbox = {};
  vm.createContext(sandbox);

  let leagueDoc = initialLeagueDoc || { exists: true, data: () => ({ seasons: {}, players: {}, settings: {} }), metadata: { hasPendingWrites: false } };
  const writeLog = [];
  sandbox.firebase = {
    firestore: () => ({
      collection: (name) => {
        if (name === 'league') {
          return {
            doc: () => ({
              onSnapshot: (onNext) => { onNext(leagueDoc); return () => {}; },
              set: (data) => {
                writeLog.push(JSON.parse(JSON.stringify(data)));
                leagueDoc = { exists: true, data: () => data, metadata: { hasPendingWrites: false } };
                return Promise.resolve();
              },
            }),
          };
        }
        if (name === 'nba2k27_pool') {
          return { get: () => Promise.resolve({ size: Object.keys(nba2k27PoolDocs).length, docs: Object.keys(nba2k27PoolDocs).map(id => ({ id, data: () => nba2k27PoolDocs[id] })) }) };
        }
        if (name === 'nba2k_players') {
          return { get: () => Promise.resolve({ docs: Object.keys(nba2kPlayersDocs).map(id => ({ id, data: () => nba2kPlayersDocs[id] })) }) };
        }
        return { get: () => Promise.resolve({ docs: [] }) };
      },
      enablePersistence: () => Promise.resolve(),
    }),
  };
  vm.runInContext(dataSrc, sandbox, { filename: 'data.js' });
  vm.runInContext(
    'this.FirebaseSync = FirebaseSync; this.LeagueData = LeagueData; this.AdminActions = AdminActions; ' +
    'this.LiveNba2k27PoolCache = LiveNba2k27PoolCache; this.LIVE_NBA2K27_POOL_SCOPE = LIVE_NBA2K27_POOL_SCOPE;',
    sandbox,
    { filename: 'export.js' }
  );
  sandbox.FirebaseSync.init();
  return { sandbox, getWriteLog: () => writeLog };
}

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ok - ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL - ${name}`);
    console.log(`    ${e.stack || e.message}`);
  }
}

console.log('NBA2K27 live-pool audit fixes — scoping + orphan cleanup');

(async () => {
  // ── FIX 1 ────────────────────────────────────────────────────────────

  await test('1. a live NBA2K27 season receives live pool players', async () => {
    const { sandbox } = makeEnv();
    await sandbox.LiveNba2k27PoolCache.ensureLoaded();
    const season = sandbox.AdminActions.createSeason('Live Season', null, true);
    assert.strictEqual(season.playerPoolScope, sandbox.LIVE_NBA2K27_POOL_SCOPE);

    const available = sandbox.LeagueData.getAvailablePlayers(season.id);
    assert.strictEqual(available.length, 1);
    assert.strictEqual(available[0].nba2kRef, 'sga');
    assert.strictEqual(sandbox.LeagueData.getAllPlayers(season.id).some(p => p.nba2kRef === 'sga'), true);
  });

  await test('2. an unscoped legacy season does NOT receive live pool players', async () => {
    const initialLeagueDoc = {
      exists: true, metadata: { hasPendingWrites: false },
      data: () => ({
        seasons: { s_legacy: { id: 's_legacy', name: 'Legacy 2K26', status: 'active', playerDraftPicks: [], participants: {}, playerDraftOrder: [] } },
        players: { p_legacy_1: { id: 'p_legacy_1', name: 'Legacy Player', overall: 80, pool: 'green', position: 'PG' } },
        settings: {},
      }),
    };
    const { sandbox } = makeEnv({ initialLeagueDoc });
    await sandbox.LiveNba2k27PoolCache.ensureLoaded();

    const available = sandbox.LeagueData.getAvailablePlayers('s_legacy');
    assert.strictEqual(available.length, 1, 'only the legacy season\'s own real player, no live-pool leak');
    assert.strictEqual(available[0].id, 'p_legacy_1');
    assert.ok(!available.some(p => p.nba2kRef === 'sga'), 'must NOT contain the live pool player');

    // Same check via the raw getAllPlayers(seasonId) entry point.
    assert.ok(!sandbox.LeagueData.getAllPlayers('s_legacy').some(p => p.nba2kRef === 'sga'));
  });

  await test('3. an old-style scoped historical season still receives only its own stored players', async () => {
    const oldId = 's_old_1';
    const initialLeagueDoc = {
      exists: true, metadata: { hasPendingWrites: false },
      data: () => ({
        seasons: { [oldId]: { id: oldId, name: 'Old Workflow Season', status: 'active', playerPoolScope: oldId, playerDraftPicks: [], participants: {}, playerDraftOrder: [] } },
        players: { p_old_1: { id: 'p_old_1', name: 'Old Seeded Player', overall: 90, pool: 'green', position: 'PG', seasonId: oldId, nba2kRef: 'oldref' } },
        settings: {},
      }),
    };
    const { sandbox } = makeEnv({ initialLeagueDoc });
    await sandbox.LiveNba2k27PoolCache.ensureLoaded();

    const available = sandbox.LeagueData.getAvailablePlayers(oldId);
    assert.strictEqual(available.length, 1);
    assert.strictEqual(available[0].id, 'p_old_1');
    assert.ok(!available.some(p => p.nba2kRef === 'sga'), 'an old-style season must not pick up the live pool either');
  });

  await test('4. a public/non-season context does not globally receive live pool players', async () => {
    const { sandbox } = makeEnv();
    await sandbox.LiveNba2k27PoolCache.ensureLoaded();
    sandbox.AdminActions.createSeason('Live Season', null, true); // a live season now exists

    // getAllPlayers() with NO seasonId — exactly what views/home.js and
    // the admin "already promoted" checks call.
    const globalPlayers = sandbox.LeagueData.getAllPlayers();
    assert.ok(!globalPlayers.some(p => p.nba2kRef === 'sga'), 'unscoped getAllPlayers() must never surface a live-pool player');

    // getPlayer() with no seasonId must not resolve a live-pool id either.
    assert.strictEqual(sandbox.LeagueData.getPlayer('p27live_sga'), null);
  });

  // ── FIX 2 ────────────────────────────────────────────────────────────

  function oldStyleFixture() {
    return {
      exists: true, metadata: { hasPendingWrites: false },
      data: () => ({
        seasons: {
          s_a: { id: 's_a', name: 'Season A', status: 'active', playerPoolScope: 's_a', playerDraftPicks: [], participants: {}, playerDraftOrder: [] },
          s_b: { id: 's_b', name: 'Season B', status: 'active', playerPoolScope: 's_b', playerDraftPicks: [], participants: {}, playerDraftOrder: [] },
          s_unscoped: { id: 's_unscoped', name: 'Unscoped Legacy', status: 'active', playerDraftPicks: [], participants: {}, playerDraftOrder: [] },
        },
        players: {
          p_a1: { id: 'p_a1', name: 'A Player 1', overall: 80, pool: 'green', position: 'PG', seasonId: 's_a' },
          p_a2: { id: 'p_a2', name: 'A Player 2', overall: 81, pool: 'blue', position: 'SG', seasonId: 's_a' },
          p_b1: { id: 'p_b1', name: 'B Player 1', overall: 82, pool: 'green', position: 'SF', seasonId: 's_b' },
          p_shared_1: { id: 'p_shared_1', name: 'Shared Legacy Player', overall: 88, pool: 'green', position: 'C' }, // no seasonId — shared/unscoped pool
        },
        settings: { currentSeasonId: 's_a' },
      }),
    };
  }

  await test('5. deleting a season removes only that season\'s own stored player records', async () => {
    const { sandbox, getWriteLog } = makeEnv({ initialLeagueDoc: oldStyleFixture() });
    sandbox.AdminActions.deleteSeason('s_a');

    const write = getWriteLog()[getWriteLog().length - 1];
    assert.ok(!write.seasons.s_a, 'season A itself must be gone');
    assert.strictEqual(write.players.p_a1, undefined, 'season A\'s own player must be removed');
    assert.strictEqual(write.players.p_a2, undefined, 'season A\'s own player must be removed');
  });

  await test('6. deleting one season leaves another season\'s player records intact', async () => {
    const { sandbox, getWriteLog } = makeEnv({ initialLeagueDoc: oldStyleFixture() });
    sandbox.AdminActions.deleteSeason('s_a');

    const write = getWriteLog()[getWriteLog().length - 1];
    assert.ok(write.seasons.s_b, 'season B must still exist');
    assert.ok(write.players.p_b1, 'season B\'s own player must be untouched');
    assert.strictEqual(write.players.p_b1.name, 'B Player 1');
  });

  await test('6b. deleting an old-style season never touches a shared/unscoped-pool player with no seasonId', async () => {
    const { sandbox, getWriteLog } = makeEnv({ initialLeagueDoc: oldStyleFixture() });
    sandbox.AdminActions.deleteSeason('s_a');

    const write = getWriteLog()[getWriteLog().length - 1];
    assert.ok(write.players.p_shared_1, 'a player with no seasonId (shared/unscoped pool) must never be deleted');
  });

  await test('6c. deleting an UNSCOPED legacy season deletes nothing from data.players at all', async () => {
    const { sandbox, getWriteLog } = makeEnv({ initialLeagueDoc: oldStyleFixture() });
    sandbox.AdminActions.deleteSeason('s_unscoped');

    const write = getWriteLog()[getWriteLog().length - 1];
    assert.ok(!write.seasons.s_unscoped, 'the unscoped season itself must be gone');
    // Every single stored player must survive — an unscoped season has no
    // playerPoolScope, so the "own players" branch never runs for it.
    assert.strictEqual(Object.keys(write.players).length, 4, 'no player record should be removed for an unscoped season');
  });

  await test('7. live p27live_* records are never persisted, including across a deleteSeason() call', async () => {
    const { sandbox, getWriteLog } = makeEnv();
    await sandbox.LiveNba2k27PoolCache.ensureLoaded();
    const live = sandbox.AdminActions.createSeason('Live Season', null, true);
    sandbox.AdminActions.deleteSeason(live.id); // deleting a live-pool season must be a no-op on players

    const write = getWriteLog()[getWriteLog().length - 1];
    assert.deepStrictEqual(Object.keys(write.players || {}), [], 'no p27live_* record should ever appear in a write, before or after deleting the season');
  });

  await test('8. existing live-pool creation/availability behavior is unchanged for a season that IS live-scoped', async () => {
    const { sandbox } = makeEnv();
    await sandbox.LiveNba2k27PoolCache.ensureLoaded();
    const season = sandbox.AdminActions.createSeason('Live Season', null, true);
    assert.strictEqual(sandbox.LeagueData.getAvailablePlayers(season.id).length, 1);
  });

  console.log(`\n${failures === 0 ? 'All tests passed.' : failures + ' test(s) failed.'}`);
  process.exitCode = failures === 0 ? 0 : 1;
})();
