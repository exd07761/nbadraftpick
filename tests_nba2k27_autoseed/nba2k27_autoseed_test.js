'use strict';
/**
 * NBA2K27 automatic season-seed-on-creation tests.
 *
 * Loads the real js/data.js (AdminActions.createSeason /
 * seedSeasonFromNba2k27Pool / FirebaseSync — all unmodified except the
 * additive FirebaseSync.waitForPendingSave()), js/shared-utils.js,
 * js/admin/nba2k-database.js (effective-value helpers the seed operation
 * reuses), and the real js/admin/seasons.js (the new orchestration under
 * test — the "New Season" form handler) into a jsdom document, with a
 * fake Firestore backing both the league/main single-document pattern
 * and the nba2k27_pool / nba2k_players collection.get() pattern.
 *
 * Same "load the real source into a sandbox" approach as
 * tests_season_cutover/season_cutover_test.js (data-layer only) and
 * tests_f6/f6_phase6_position_test.js (jsdom, for an admin/*.js view).
 * This file combines both because the behavior under test lives in the
 * seasons.js view's button handler, not in data.js.
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
const dbSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'admin', 'nba2k-database.js'), 'utf8');
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
    },
    nba2kPlayersDocs: {
      sga: sourcePlayer({ name: 'Shai Gilgeous-Alexander', teamType: 'curr', overall: 97 }),
      mj96: sourcePlayer({ name: 'Michael Jordan', teamType: 'class', overall: 98 }),
    },
  };
}

/**
 * Builds a jsdom window with the real app scripts loaded, a fake
 * Firestore, and a rendered #adminViewContainer wired up the same way
 * admin.html/admin.js does (AdminApp.renderView -> re-render the view).
 *
 * opts.failSetOnCall: 1-based call index of the league/main docRef().set()
 * to reject. Used to simulate "season creation succeeds, the auto-seed
 * write fails" by targeting the 2nd call specifically.
 */
function makeEnv(opts = {}) {
  const { nba2k27PoolDocs = {}, nba2kPlayersDocs = {}, failSetOnCall = null } = opts;
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="adminViewContainer"></div></body></html>',
    { url: 'https://example.test/' }
  );
  const window = dom.window;
  const document = window.document;

  let leagueDoc = { exists: true, data: () => ({ seasons: {}, players: {}, settings: {} }), metadata: { hasPendingWrites: false } };
  const writeLog = [];
  let setCallCount = 0;

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
                if (failSetOnCall && setCallCount === failSetOnCall) {
                  return Promise.reject(new Error('simulated write failure'));
                }
                leagueDoc = { exists: true, data: () => data, metadata: { hasPendingWrites: false } };
                return Promise.resolve();
              },
            }),
          };
        }
        if (name === 'nba2k27_pool') {
          return {
            get: () => Promise.resolve({
              size: Object.keys(nba2k27PoolDocs).length,
              docs: Object.keys(nba2k27PoolDocs).map(id => ({ id, data: () => nba2k27PoolDocs[id] })),
            }),
          };
        }
        if (name === 'nba2k_players') {
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
  vm.runInContext(dbSrc, window, { filename: 'nba2k-database.js' });
  vm.runInContext(seasonsSrc, window, { filename: 'seasons.js' });
  vm.runInContext(
    'this.FirebaseSync = FirebaseSync; this.LeagueData = LeagueData; ' +
    'this.AdminActions = AdminActions; this.AdminSeasonsView = AdminSeasonsView;',
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

  return { window, document, container, getWriteLog: () => writeLog, getSetCallCount: () => setCallCount };
}

function fillCreateForm(container, { name, scopePool }) {
  container.querySelector('#btnNewSeason').onclick();
  container.querySelector('#newSeasonName').value = name;
  if (scopePool) container.querySelector('#newSeasonScopePool').checked = true;
}

async function clickCreate(container) {
  return container.querySelector('#btnCreateSeason').onclick();
}

console.log('NBA2K27 automatic season-seed-on-creation tests');

(async () => {
  await test('0a. FirebaseSync.waitForPendingSave resolves after a successful save()', async () => {
    const { window } = makeEnv();
    window.FirebaseSync.save({ seasons: {}, players: {}, settings: {} });
    await window.FirebaseSync.waitForPendingSave(); // must resolve, not hang or throw
  });

  await test('0b. FirebaseSync.waitForPendingSave rejects after a failed save() (signals failure to callers)', async () => {
    const { window } = makeEnv({ failSetOnCall: 1 });
    window.FirebaseSync.save({ seasons: {}, players: {}, settings: {} });
    await assert.rejects(
      () => window.FirebaseSync.waitForPendingSave(),
      /simulated write failure/,
      'waitForPendingSave must reject with the underlying Firestore error'
    );
  });

  await test('0c. a failed save() still reports its own error (toast) with no unhandled rejection, whether or not waitForPendingSave is awaited', async () => {
    const { window } = makeEnv({ failSetOnCall: 1 });
    window.FirebaseSync.save({ seasons: {}, players: {}, settings: {} });
    // Deliberately do NOT await/attach to waitForPendingSave() here — this
    // must not produce an unhandled-rejection warning, since save() itself
    // already attaches its own handler to the same underlying promise.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const errorToast = window.toasts.find(t => t.type === 'error');
    assert.ok(errorToast, 'save() must still show its existing cloud-sync-failed toast');
    assert.ok(/cloud sync failed/i.test(errorToast.msg));
  });

  await test('1. unscoped season creation does NOT auto-seed (NBA2K26 / non-scoped behavior unchanged)', async () => {
    const { window, container } = makeEnv(defaultPoolFixture());
    let seedCalls = 0;
    const realSeed = window.AdminActions.seedSeasonFromNba2k27Pool.bind(window.AdminActions);
    window.AdminActions.seedSeasonFromNba2k27Pool = (...args) => { seedCalls++; return realSeed(...args); };

    fillCreateForm(container, { name: 'NBA2K26 Season 1', scopePool: false });
    await clickCreate(container);

    assert.strictEqual(seedCalls, 0, 'seed must never be invoked for an unscoped season');
    const seasons = window.LeagueData.getAllSeasons();
    assert.strictEqual(seasons.length, 1);
    assert.strictEqual(seasons[0].playerPoolScope, undefined);
    assert.strictEqual(window.LeagueData.getAllPlayers().length, 0);
  });

  await test('2. NBA2K27-scoped season creation automatically seeds players', async () => {
    const { window, container } = makeEnv(defaultPoolFixture());
    fillCreateForm(container, { name: 'NBA2K27 Season 2', scopePool: true });
    await clickCreate(container);

    const seasons = window.LeagueData.getAllSeasons();
    assert.strictEqual(seasons.length, 1);
    const season = seasons[0];
    assert.strictEqual(season.playerPoolScope, season.id, "playerPoolScope must equal the season's own id");

    const players = window.LeagueData.getAllPlayers();
    assert.strictEqual(players.length, 2, 'both eligible pool entries should be seeded automatically');
    players.forEach(p => assert.strictEqual(p.seasonId, season.id));
  });

  await test('3. variantGroup is copied from nba2k27_pool.variantGroupId', async () => {
    const { window, container } = makeEnv(defaultPoolFixture());
    fillCreateForm(container, { name: 'NBA2K27 Season 3', scopePool: true });
    await clickCreate(container);

    const players = window.LeagueData.getAllPlayers();
    const mj = players.find(p => p.nba2kRef === 'mj96');
    const sga = players.find(p => p.nba2kRef === 'sga');
    assert.ok(mj, 'expected the mj96 pool entry to be seeded');
    assert.strictEqual(mj.variantGroup, 'mj');
    assert.ok(sga, 'expected the sga pool entry to be seeded');
    assert.strictEqual(sga.variantGroup, undefined, 'no variantGroupId on this entry -> no variantGroup');
  });

  await test('4. seed failure leaves the created season intact and surfaces an error (no false success)', async () => {
    // 1st docRef().set() call = season creation (must succeed).
    // 2nd call = the auto-seed's saveAndConfirm() (forced to fail here).
    const { window, container } = makeEnv(Object.assign(defaultPoolFixture(), { failSetOnCall: 2 }));
    fillCreateForm(container, { name: 'NBA2K27 Season 4', scopePool: true });
    await clickCreate(container);

    const seasons = window.LeagueData.getAllSeasons();
    assert.strictEqual(seasons.length, 1, 'the season itself must still exist');
    const season = seasons[0];
    assert.strictEqual(season.playerPoolScope, season.id, 'creation already set playerPoolScope — a valid pre-seed intermediate state');
    assert.strictEqual(window.LeagueData.getAllPlayers().length, 0, 'no players should be persisted when the seed write fails');

    const errorToast = window.toasts.find(t => t.type === 'error');
    assert.ok(errorToast, 'an error toast must be shown');
    assert.ok(!/fully seeded|ready for drafting/i.test(errorToast.msg), 'must not claim the season is fully seeded/ready to draft');
    assert.ok(/failed/i.test(errorToast.msg), 'must clearly say seeding failed');

    // Existing manual "Seed NBA2K27 Pool" retry path must still work.
    const result = await window.AdminActions.seedSeasonFromNba2k27Pool(season.id);
    assert.strictEqual(result.seeded, 2);
  });

  await test('4b. season-creation write itself fails -> auto-seed never starts, no false "created" claim', async () => {
    // 1st docRef().set() call = the season-creation write (forced to fail
    // here) — this is the scenario the auto-seed flow must guard against:
    // waitForPendingSave() rejecting must stop it from ever reaching
    // seedSeasonFromNba2k27Pool().
    const { window, container } = makeEnv(Object.assign(defaultPoolFixture(), { failSetOnCall: 1 }));
    let seedCalls = 0;
    const realSeed = window.AdminActions.seedSeasonFromNba2k27Pool.bind(window.AdminActions);
    window.AdminActions.seedSeasonFromNba2k27Pool = (...args) => { seedCalls++; return realSeed(...args); };

    fillCreateForm(container, { name: 'NBA2K27 Season 4b', scopePool: true });
    await clickCreate(container);

    assert.strictEqual(seedCalls, 0, 'seeding must never be attempted when the creation write itself failed');
    assert.strictEqual(window.LeagueData.getAllPlayers().length, 0, 'no players should be seeded');

    const errorToast = window.toasts.find(t => t.type === 'error' && /seed/i.test(t.msg));
    assert.ok(errorToast, 'an error toast about the failed flow must be shown');
    assert.ok(!/created and seeded/i.test(errorToast.msg), 'must not claim the season was created and seeded');
    assert.ok(!/^"[^"]+" was created,/i.test(errorToast.msg), 'must not claim plain "was created" when creation itself was not confirmed');
  });

  await test('5. retrying the seed after auto-seed already ran does not duplicate players', async () => {
    const { window, container } = makeEnv(defaultPoolFixture());
    fillCreateForm(container, { name: 'NBA2K27 Season 5', scopePool: true });
    await clickCreate(container);

    const season = window.LeagueData.getAllSeasons()[0];
    assert.strictEqual(window.LeagueData.getAllPlayers().length, 2);

    // Simulate the admin also clicking the manual "Seed NBA2K27 Pool"
    // button afterwards (e.g. a double click, or out of habit).
    const result = await window.AdminActions.seedSeasonFromNba2k27Pool(season.id);
    assert.strictEqual(result.seeded, 0, 'nothing new to seed');
    assert.strictEqual(result.alreadySeeded, 2);
    assert.strictEqual(window.LeagueData.getAllPlayers().length, 2, 'no duplicate player records');
  });

  await test('6. create button is disabled immediately (no double-submission window)', async () => {
    const { window, container } = makeEnv(defaultPoolFixture());
    fillCreateForm(container, { name: 'NBA2K27 Season 6', scopePool: true });
    const btn = container.querySelector('#btnCreateSeason');
    const clickPromise = btn.onclick();
    assert.strictEqual(btn.disabled, true, 'button must be disabled synchronously, before the seed await resolves');
    await clickPromise;
  });

  console.log(`\n${failures === 0 ? 'All tests passed.' : failures + ' test(s) failed.'}`);
  process.exitCode = failures === 0 ? 0 : 1;
})();
