'use strict';
/**
 * NBA2K27 live-pool season-creation tests.
 *
 * NBA2K27 season-creation redesign: `/league/main` was hitting Firestore's
 * 1 MiB single-document limit because the old workflow
 * (AdminActions.seedSeasonFromNba2k27Pool(), triggered automatically right
 * after AdminActions.createSeason(..., true)) copied the entire curated
 * NBA2K27 pool into `data.players`, which lives inside that one document.
 *
 * This file replaces the old "automatic seed-on-creation" tests (which
 * asserted `season.playerPoolScope === season.id` and real player records
 * appearing in `LeagueData.getAllPlayers()` right after creation) with
 * tests for the new architecture: a new season is scoped to the
 * LIVE_NBA2K27_POOL_SCOPE sentinel, its players are served from the
 * in-memory-only LiveNba2k27PoolCache (js/data.js), and NOTHING is ever
 * written to `league/main.players` for them — verified directly against
 * the fake Firestore's write log, not just against in-memory getters.
 *
 * Loads the real js/data.js, js/shared-utils.js, and the real
 * js/admin/seasons.js (the "New Season" form, now with no checkbox) into
 * a jsdom document, with a fake Firestore backing both the league/main
 * single-document pattern and the nba2k27_pool / nba2k_players
 * collection.get() pattern. Deliberately does NOT load
 * js/admin/nba2k-database.js — LiveNba2k27PoolCache's pool-joining logic
 * is self-contained in data.js precisely so it also works on the public
 * site, which never loads that admin-only file (see index.html vs.
 * admin.html) — omitting it here is itself a check of that independence.
 *
 * Same "load the real source into a sandbox" approach as
 * tests_season_cutover/season_cutover_test.js (data-layer only) and
 * tests_f6/f6_phase6_position_test.js (jsdom, for an admin/*.js view).
 *
 * Run with: node tests_nba2k27_autoseed/nba2k27_autoseed_test.js
 * Requires the `jsdom` package (installed via `npm install --no-save jsdom`).
 * Never touches the real nbadraftpick Firestore project — the mock
 * Firestore below is entirely in-memory.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const { JSDOM } = require('jsdom');

const dataSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'data.js'), 'utf8');
const sharedUtilsSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'shared-utils.js'), 'utf8');
const seasonsSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'admin', 'seasons.js'), 'utf8');

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

function poolEntry(overrides = {}) {
  return Object.assign({ pool: 'green', position: 'PG', selectedAt: 'x', updatedAt: 'x' }, overrides);
}
function sourcePlayer(overrides = {}) {
  return Object.assign({ name: 'Source Name', team: 'T', teamType: 'curr', overall: 85 }, overrides);
}

function defaultPoolFixture() {
  return {
    nba2k27PoolDocs: {
      sga: poolEntry({ pool: 'green', position: 'PG', variantGroupId: '' }),
      mj96: poolEntry({ pool: 'white', position: 'SG', variantGroupId: 'mj', variantLabel: '1996', nameOverride: 'MJ (96)' }),
      lbj: poolEntry({ pool: 'blue', position: 'SF' }),
      badpos: poolEntry({ pool: 'green', position: 'UNASSIGNED' }), // must be excluded
      orphan: poolEntry({ pool: 'green', position: 'PG' }), // no nba2k_players match — must be excluded
    },
    nba2kPlayersDocs: {
      sga: sourcePlayer({ name: 'Shai Gilgeous-Alexander', teamType: 'curr', overall: 97 }),
      mj96: sourcePlayer({ name: 'Michael Jordan', teamType: 'class', overall: 98 }),
      lbj: sourcePlayer({ name: 'LeBron James', teamType: 'curr', overall: 96 }),
      badpos: sourcePlayer({ name: 'Bad Position Guy', overall: 80 }),
      // no 'orphan' entry here on purpose
    },
  };
}

/**
 * Builds a jsdom window with the real app scripts loaded, a fake
 * Firestore, and a rendered #adminViewContainer wired up the same way
 * admin.html/admin.js does (AdminApp.renderView -> re-render the view).
 *
 * opts.failPoolFetch: if true, the nba2k27_pool collection.get() rejects
 * (simulates LiveNba2k27PoolCache.ensureLoaded() failing).
 * opts.initialLeagueDoc: override the starting league/main document — used
 * for the old-workflow backward-compatibility test.
 */
function makeEnv(opts = {}) {
  const { nba2k27PoolDocs = {}, nba2kPlayersDocs = {}, failPoolFetch = false, initialLeagueDoc = null } = opts;
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="adminViewContainer"></div></body></html>',
    { url: 'https://example.test/' }
  );
  const window = dom.window;
  const document = window.document;

  let leagueDoc = initialLeagueDoc || { exists: true, data: () => ({ seasons: {}, players: {}, settings: {} }), metadata: { hasPendingWrites: false } };
  const writeLog = [];
  let setCallCount = 0;
  let poolFetchCount = 0;
  let playersFetchCount = 0;

  window.firebase = {
    firestore: () => ({
      collection: (name) => {
        if (name === 'league') {
          return {
            doc: () => ({
              onSnapshot: (onNext) => { onNext(leagueDoc); return () => {}; },
              set: (data) => {
                setCallCount++;
                writeLog.push(JSON.parse(JSON.stringify(data)));
                leagueDoc = { exists: true, data: () => data, metadata: { hasPendingWrites: false } };
                return Promise.resolve();
              },
            }),
          };
        }
        if (name === 'nba2k27_pool') {
          poolFetchCount++;
          return {
            get: () => failPoolFetch
              ? Promise.reject(new Error('simulated pool fetch failure'))
              : Promise.resolve({
                  size: Object.keys(nba2k27PoolDocs).length,
                  docs: Object.keys(nba2k27PoolDocs).map(id => ({ id, data: () => nba2k27PoolDocs[id] })),
                }),
          };
        }
        if (name === 'nba2k_players') {
          playersFetchCount++;
          return {
            get: () => Promise.resolve({
              docs: Object.keys(nba2kPlayersDocs).map(id => ({ id, data: () => nba2kPlayersDocs[id] })),
            }),
          };
        }
        return { get: () => Promise.resolve({ docs: [] }) };
      },
      enablePersistence: () => Promise.resolve(),
    }),
  };
  window.AuthBoundary = { requireAuth: () => {} };
  window.confirm = () => true;
  window.normalizePlayerName = (n) => String(n || '').trim().toLowerCase();

  vm.createContext(window);
  vm.runInContext(dataSrc, window, { filename: 'data.js' });
  // shared-utils.js declares its own top-level `function showToast(...)`,
  // which — like any classic-script function declaration — binds onto the
  // shared global object and would otherwise clobber a mock assigned
  // beforehand. Load it first, then install the test's mock afterward so
  // seasons.js (loaded next) picks up the mock, not the real DOM-toast one.
  vm.runInContext(sharedUtilsSrc, window, { filename: 'shared-utils.js' });
  window.toasts = [];
  window.showToast = (msg, type) => { window.toasts.push({ msg, type }); };
  vm.runInContext(seasonsSrc, window, { filename: 'seasons.js' });
  vm.runInContext(
    'this.FirebaseSync = FirebaseSync; this.LeagueData = LeagueData; ' +
    'this.AdminActions = AdminActions; this.AdminSeasonsView = AdminSeasonsView; ' +
    'this.LiveNba2k27PoolCache = LiveNba2k27PoolCache; this.LIVE_NBA2K27_POOL_SCOPE = LIVE_NBA2K27_POOL_SCOPE;',
    window,
    { filename: 'export.js' }
  );
  window.FirebaseSync.init();

  const container = document.getElementById('adminViewContainer');
  window.AdminApp = {
    renderView: (name) => {
      if (name === 'seasons') window.AdminSeasonsView.render(container);
    },
  };
  window.AdminSeasonsView.render(container);

  return {
    window, document, container,
    getWriteLog: () => writeLog,
    getSetCallCount: () => setCallCount,
    getPoolFetchCount: () => poolFetchCount,
    getPlayersFetchCount: () => playersFetchCount,
  };
}

function fillCreateForm(container, { name }) {
  container.querySelector('#btnNewSeason').onclick();
  container.querySelector('#newSeasonName').value = name;
}

async function clickCreate(container) {
  return container.querySelector('#btnCreateSeason').onclick();
}

console.log('NBA2K27 live-pool season-creation tests');

(async () => {
  await test('0a. FirebaseSync.waitForPendingSave resolves after a successful save()', async () => {
    const { window } = makeEnv();
    window.FirebaseSync.save({ seasons: {}, players: {}, settings: {} });
    await window.FirebaseSync.waitForPendingSave(); // must resolve, not hang or throw
  });

  await test('1. the New Season form has no NBA2K27 checkbox — every season is automatically live-pool scoped', async () => {
    const { container } = makeEnv(defaultPoolFixture());
    container.querySelector('#btnNewSeason').onclick();
    assert.strictEqual(container.querySelector('#newSeasonScopePool'), null, 'the manual seeding checkbox must be gone');
  });

  await test('2. creating a season sets playerPoolScope to the live-pool sentinel, not its own id', async () => {
    const { window, container } = makeEnv(defaultPoolFixture());
    fillCreateForm(container, { name: 'NBA2K27 Season 2' });
    await clickCreate(container);

    const seasons = window.LeagueData.getAllSeasons();
    assert.strictEqual(seasons.length, 1);
    const season = seasons[0];
    assert.strictEqual(season.playerPoolScope, window.LIVE_NBA2K27_POOL_SCOPE);
    assert.notStrictEqual(season.playerPoolScope, season.id, 'must NOT be scoped to its own id (that was the old, now-retired, workflow)');
  });

  await test('3. the Draft pool is available immediately — no manual seed step — and nothing is written to league/main.players', async () => {
    const { window, container, getWriteLog } = makeEnv(defaultPoolFixture());
    fillCreateForm(container, { name: 'NBA2K27 Season 3' });
    await clickCreate(container);
    const season = window.LeagueData.getAllSeasons()[0];

    // Available immediately, with no separate seed call of any kind.
    const available = window.LeagueData.getAvailablePlayers(season.id);
    const refs = available.map(p => p.nba2kRef).sort();
    assert.deepStrictEqual(refs, ['lbj', 'mj96', 'sga'], 'badpos (UNASSIGNED) and orphan (no source record) must be excluded, the rest immediately available');

    // The actual Firestore write for season creation must contain only the
    // season itself — no player records at all. This is the concrete
    // regression test for the 1 MiB /league/main failure: the write must
    // not grow with the size of the NBA2K27 pool.
    const creationWrite = getWriteLog()[getWriteLog().length - 1];
    assert.deepStrictEqual(Object.keys(creationWrite.players || {}), [], 'no player record of any kind should be written for season creation');
  });

  await test('4. green/blue/white pools all resolve correctly with the right minimums-relevant data', async () => {
    const { window, container } = makeEnv(defaultPoolFixture());
    fillCreateForm(container, { name: 'NBA2K27 Season 4' });
    await clickCreate(container);
    const season = window.LeagueData.getAllSeasons()[0];
    const available = window.LeagueData.getAvailablePlayers(season.id);

    const sga = available.find(p => p.nba2kRef === 'sga');
    const mj = available.find(p => p.nba2kRef === 'mj96');
    const lbj = available.find(p => p.nba2kRef === 'lbj');
    assert.strictEqual(sga.pool, 'green');
    assert.strictEqual(sga.overall, 97);
    assert.strictEqual(mj.pool, 'white');
    assert.strictEqual(mj.name, 'MJ (96)', 'nameOverride must win');
    assert.strictEqual(mj.overall, 98);
    assert.strictEqual(lbj.pool, 'blue');
    assert.strictEqual(lbj.overall, 96);
  });

  await test('5. variantGroup is copied from nba2k27_pool.variantGroupId', async () => {
    const { window, container } = makeEnv(defaultPoolFixture());
    fillCreateForm(container, { name: 'NBA2K27 Season 5' });
    await clickCreate(container);
    const season = window.LeagueData.getAllSeasons()[0];
    const available = window.LeagueData.getAvailablePlayers(season.id);

    const mj = available.find(p => p.nba2kRef === 'mj96');
    const sga = available.find(p => p.nba2kRef === 'sga');
    assert.strictEqual(mj.variantGroup, 'mj');
    assert.strictEqual(sga.variantGroup, undefined, 'no variantGroupId on this entry -> no variantGroup');
  });

  await test('6. drafting a live-pool player resolves via getPlayer with a deterministic id, and that id is never persisted to league/main', async () => {
    const { window, container, getWriteLog } = makeEnv(defaultPoolFixture());
    fillCreateForm(container, { name: 'NBA2K27 Season 6' });
    await clickCreate(container);
    const season = window.LeagueData.getAllSeasons()[0];

    const participant = window.AdminActions.addParticipant(season.id, 'Alice');
    window.AdminActions.setPlayerDraftOrder(season.id, [participant.id]);
    const sga = window.LeagueData.getAvailablePlayers(season.id).find(p => p.nba2kRef === 'sga');
    assert.strictEqual(sga.id, 'p27live_sga', 'id must be deterministic (livePlayerId(slug))');

    window.AdminActions.makeDraftPick(season.id, sga.id);

    // Resolves correctly post-pick, GIVEN the season context (live-pool
    // audit Fix 1: getPlayer()/loadData() are season-aware — a caller
    // must say which season it's asking on behalf of to see a live-pool
    // player at all; see tests_nba2k27_live_pool_scoping for the
    // dedicated scoping tests).
    const resolved = window.LeagueData.getPlayer(sga.id, season.id);
    assert.ok(resolved, 'the drafted player must resolve via getPlayer(id, seasonId)');
    assert.strictEqual(resolved.name, sga.name);

    // Reloading (simulating a fresh page load reading the same season
    // again) resolves the SAME id to the SAME player — required since
    // playerDraftPicks only stores the id.
    const reResolved = window.LeagueData.getPlayer('p27live_sga', season.id);
    assert.ok(reResolved);

    // The pick write itself must be tiny — no full player record for
    // sga/mj96/lbj anywhere in what actually got persisted.
    const pickWrite = getWriteLog()[getWriteLog().length - 1];
    assert.deepStrictEqual(Object.keys(pickWrite.players || {}), [], 'the live-pool player record must never be written to league/main.players');
    assert.strictEqual(pickWrite.seasons[season.id].playerDraftPicks.length, 1, 'the pick itself (a tiny id reference) is what gets persisted');
  });

  await test('7. a season created the OLD way (already-seeded, real records) keeps working, and keeps its Seed/Undo buttons', async () => {
    const oldSeasonId = 's_old_1';
    const initialLeagueDoc = {
      exists: true,
      metadata: { hasPendingWrites: false },
      data: () => ({
        seasons: {
          [oldSeasonId]: {
            id: oldSeasonId, name: 'Old Workflow Season', status: 'active',
            playerPoolScope: oldSeasonId, playerDraftPicks: [], participants: [],
            financialSettings: { entryFee: 300, freeTrades: 2, freeSwaps: 2 },
          },
        },
        players: {
          p_old_1: { id: 'p_old_1', name: 'Old Seeded Player', overall: 90, pool: 'green', position: 'PG', seasonId: oldSeasonId, nba2kRef: 'oldref' },
        },
        settings: {},
      }),
    };
    const { window, container } = makeEnv({ ...defaultPoolFixture(), initialLeagueDoc });

    // Still resolves its own real, previously-seeded players — completely
    // unaffected by LiveNba2k27PoolCache.
    const available = window.LeagueData.getAvailablePlayers(oldSeasonId);
    assert.strictEqual(available.length, 1);
    assert.strictEqual(available[0].id, 'p_old_1');

    // The old manual Seed/Undo buttons are still offered for THIS season
    // (it's mid-migration under the old scheme), even though they're gone
    // from the "New Season" creation flow.
    assert.ok(container.querySelector('[data-action="seedPool"][data-id="' + oldSeasonId + '"]'), 'Seed button must still be offered for an old-workflow season');
    assert.ok(container.querySelector('[data-action="undoSeed"][data-id="' + oldSeasonId + '"]'), 'Undo Seed button must still be offered for an old-workflow season');
  });

  await test('8. a live-pool-scoped season shows neither Seed nor Undo Seed buttons', async () => {
    const { window, container } = makeEnv(defaultPoolFixture());
    fillCreateForm(container, { name: 'NBA2K27 Season 8' });
    await clickCreate(container);
    const season = window.LeagueData.getAllSeasons()[0];

    assert.strictEqual(container.querySelector(`[data-action="seedPool"][data-id="${season.id}"]`), null);
    assert.strictEqual(container.querySelector(`[data-action="undoSeed"][data-id="${season.id}"]`), null);
  });

  await test('9. seedSeasonFromNba2k27Pool()/undoSeasonSeed() refuse to run against a live-pool-scoped season', async () => {
    const { window, container } = makeEnv(defaultPoolFixture());
    fillCreateForm(container, { name: 'NBA2K27 Season 9' });
    await clickCreate(container);
    const season = window.LeagueData.getAllSeasons()[0];

    await assert.rejects(() => window.AdminActions.seedSeasonFromNba2k27Pool(season.id), /live NBA2K27 pool/i);
    assert.throws(() => window.AdminActions.undoSeasonSeed(season.id), /live NBA2K27 pool/i);
  });

  await test('10. AdminActions.createSeason(name) with no scope flag still creates a fully unscoped season (used by every other test suite)', async () => {
    const { window } = makeEnv();
    const season = window.AdminActions.createSeason('Plain Unscoped Season');
    assert.strictEqual(season.playerPoolScope, undefined);
  });

  await test('11. LiveNba2k27PoolCache fetches nba2k27_pool/nba2k_players only once, even across repeated creations/renders', async () => {
    const { window, container, getPoolFetchCount, getPlayersFetchCount } = makeEnv(defaultPoolFixture());
    await window.LiveNba2k27PoolCache.ensureLoaded();
    fillCreateForm(container, { name: 'NBA2K27 Season 11a' });
    await clickCreate(container);
    fillCreateForm(container, { name: 'NBA2K27 Season 11b' });
    await clickCreate(container);
    await window.LiveNba2k27PoolCache.ensureLoaded();

    assert.strictEqual(getPoolFetchCount(), 1, 'nba2k27_pool must be fetched only once per page load');
    assert.strictEqual(getPlayersFetchCount(), 1, 'nba2k_players must be fetched only once per page load');
  });

  await test('12. a pool-fetch failure still lets the season get created, and is reported without crashing', async () => {
    const { window, container } = makeEnv({ ...defaultPoolFixture(), failPoolFetch: true });
    fillCreateForm(container, { name: 'NBA2K27 Season 12' });
    await clickCreate(container);

    const seasons = window.LeagueData.getAllSeasons();
    assert.strictEqual(seasons.length, 1, 'the season itself must still be created even if the pool fetch fails');
    const errorToast = window.toasts.find(t => t.type === 'error');
    assert.ok(errorToast, 'an error toast must be shown');
    assert.ok(/pool failed to load/i.test(errorToast.msg));
  });

  await test('13. create button is disabled immediately (no double-submission window)', async () => {
    const { container } = makeEnv(defaultPoolFixture());
    fillCreateForm(container, { name: 'NBA2K27 Season 13' });
    const btn = container.querySelector('#btnCreateSeason');
    const clickPromise = btn.onclick();
    assert.strictEqual(btn.disabled, true, 'button must be disabled synchronously, before the pool-load await resolves');
    await clickPromise;
  });

  console.log(`\n${failures === 0 ? 'All tests passed.' : failures + ' test(s) failed.'}`);
  process.exitCode = failures === 0 ? 0 : 1;
})();
