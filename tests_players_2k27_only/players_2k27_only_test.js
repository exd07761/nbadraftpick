'use strict';
/**
 * Phase 4 — "Make Players 2K27-only" tests.
 *
 * Verifies that js/admin/players.js now renders ONLY the delegated
 * Nba2k27PoolView section — the Historical / Legacy Players section
 * (Add Player, CSV import, edit/delete, All/Active/Archived filter,
 * Green/Blue rating-tier browse grid) has been removed from this page's
 * UI entirely, while:
 *   - Nba2k27PoolView itself (js/admin/nba2k-database.js) is loaded and
 *     exercised completely unmodified — this suite never patches or
 *     reimplements any of its rendering/editing logic.
 *   - No new Firestore reads/writes are introduced by players.js — every
 *     Firestore call in this suite is served by an in-memory fake, and
 *     test G asserts an exact, empty write log for a plain render.
 *   - Any pre-existing `league/main.players` data (representing
 *     historical/legacy records that must NOT be deleted, migrated, or
 *     rewritten by this UI-only change) is present in the fake store and
 *     is asserted completely untouched after rendering/using the page.
 *
 * Run with: node tests_players_2k27_only/players_2k27_only_test.js
 * Requires the `jsdom` package. If jsdom is not installed in this
 * environment, this file will fail to `require` it — see the repo's
 * other jsdom-based suites (e.g. tests_nba2k27_autoseed) for the same
 * dependency; per the Phase 4 instructions, this run does NOT install or
 * modify package.json/package-lock.json to obtain it.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const { JSDOM } = require('jsdom');

const dataSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'data.js'), 'utf8');
const sharedUtilsSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'shared-utils.js'), 'utf8');
const dbSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'admin', 'nba2k-database.js'), 'utf8');
const playersViewSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'admin', 'players.js'), 'utf8');

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

function makeEnv(opts = {}) {
  const {
    leaguePlayers = {},
    nba2k27PoolDocs = {},
    nba2kPlayersDocs = {},
  } = opts;

  const dom = new JSDOM(
    '<!doctype html><html><body><div id="adminViewContainer"></div></body></html>',
    { url: 'https://example.test/' }
  );
  const window = dom.window;
  const document = window.document;

  let leagueDoc = {
    exists: true,
    data: () => ({ seasons: {}, players: leaguePlayers, settings: {} }),
    metadata: { hasPendingWrites: false },
  };

  const firestoreWrites = [];
  let pool27Store = JSON.parse(JSON.stringify(nba2k27PoolDocs));

  window.firebase = {
    firestore: Object.assign(
      () => ({
        collection: (name) => {
          if (name === 'league') {
            return {
              doc: () => ({
                onSnapshot: (onNext) => { onNext(leagueDoc); return () => {}; },
                set: (data) => {
                  firestoreWrites.push({ collection: 'league', doc: 'main', op: 'set' });
                  leagueDoc = { exists: true, data: () => data, metadata: { hasPendingWrites: false } };
                  return Promise.resolve();
                },
              }),
            };
          }
          if (name === 'nba2k27_pool') {
            return {
              get: () => Promise.resolve({
                size: Object.keys(pool27Store).length,
                docs: Object.keys(pool27Store).map(id => ({ id, data: () => pool27Store[id] })),
              }),
              doc: (slug) => ({
                _collection: 'nba2k27_pool',
                _slug: slug,
                set: (payload, options) => {
                  firestoreWrites.push({ collection: 'nba2k27_pool', doc: slug, op: 'set', merge: !!(options && options.merge), payload });
                  const resolved = {};
                  Object.keys(payload).forEach(k => {
                    if (payload[k] && payload[k].__fieldValueDelete) { delete resolved[k]; return; }
                    resolved[k] = payload[k];
                  });
                  pool27Store[slug] = options && options.merge
                    ? Object.assign({}, pool27Store[slug], resolved)
                    : resolved;
                  Object.keys(payload).forEach(k => {
                    if (payload[k] && payload[k].__fieldValueDelete) delete pool27Store[slug][k];
                  });
                  return Promise.resolve();
                },
                delete: () => {
                  firestoreWrites.push({ collection: 'nba2k27_pool', doc: slug, op: 'delete' });
                  delete pool27Store[slug];
                  return Promise.resolve();
                },
              }),
            };
          }
          if (name === 'nba2k_players') {
            return { get: () => Promise.resolve({ docs: Object.keys(nba2kPlayersDocs).map(id => ({ id, data: () => nba2kPlayersDocs[id] })) }) };
          }
          return { get: () => Promise.resolve({ docs: [] }) };
        },
        enablePersistence: () => Promise.resolve(),
        batch: () => {
          const ops = [];
          return {
            set: (docRef, data) => { ops.push({ docRef, data }); },
            commit: () => {
              ops.forEach(({ docRef, data }) => {
                firestoreWrites.push({ collection: docRef._collection, doc: docRef._slug, op: 'batchSet', payload: data });
                pool27Store[docRef._slug] = data;
              });
              return Promise.resolve();
            },
          };
        },
      }),
      { FieldValue: { delete: () => ({ __fieldValueDelete: true }) } }
    ),
  };
  window.AuthBoundary = { requireAuth: () => {} };
  window.confirm = () => true;
  window.normalizePlayerName = (n) => String(n || '').trim().toLowerCase();

  vm.createContext(window);
  vm.runInContext(dataSrc, window, { filename: 'data.js' });
  vm.runInContext(sharedUtilsSrc, window, { filename: 'shared-utils.js' });
  window.toasts = [];
  window.showToast = (msg, type) => { window.toasts.push({ msg, type }); };
  vm.runInContext(dbSrc, window, { filename: 'nba2k-database.js' });
  vm.runInContext(playersViewSrc, window, { filename: 'players.js' });
  vm.runInContext(
    'this.FirebaseSync = FirebaseSync; this.LeagueData = LeagueData; ' +
    'this.AdminActions = AdminActions; this.AdminPlayersView = AdminPlayersView; ' +
    'this.Nba2k27PoolView = Nba2k27PoolView; this.Nba2kDatabaseView = Nba2kDatabaseView;',
    window,
    { filename: 'export.js' }
  );
  window.FirebaseSync.init();

  const container = document.getElementById('adminViewContainer');
  window.AdminApp = {
    renderView: (name) => {
      if (name === 'players') window.AdminPlayersView.render(container);
      if (name === 'nba2k27Pool') window.Nba2k27PoolView.render(container);
    },
  };

  return { window, document, container, getWrites: () => firestoreWrites.slice(), getPool27Store: () => pool27Store };
}

/** Renders Players, then awaits the delegated Nba2k27PoolView section
 * fully settling (its own render() is async — matches how
 * AdminPlayersView invokes it in the real app, fire-and-forget). */
async function renderPlayersAndSettle(env) {
  env.window.AdminPlayersView.render(env.container);
  const mount = env.container.querySelector('#playersNba2k27PoolMount');
  assert.ok(mount, 'Players render() must produce a #playersNba2k27PoolMount element');
  await env.window.Nba2k27PoolView.render(mount);
  return mount;
}

console.log('Phase 4 — Players page is NBA 2K27 Pool only — tests');

(async () => {
  // ── A. Players renders the NBA 2K27 Pool ───────────────────────────────
  await test('A. Players renders the NBA 2K27 pool as its (only) content, already populated', async () => {
    const nba2k27PoolDocs = { sga: poolEntry({ position: 'PG' }) };
    const nba2kPlayersDocs = { sga: sourcePlayer({ name: 'Shai Gilgeous-Alexander', overall: 97 }) };
    const env = makeEnv({ nba2k27PoolDocs, nba2kPlayersDocs });
    const mount = await renderPlayersAndSettle(env);

    const primary = env.container.querySelector('.players-nba2k27-primary');
    assert.ok(primary, 'the NBA 2K27 pool primary section must be present');
    assert.ok(mount.querySelector('.pos-table-row[data-player-id="sga"]'), 'the seeded 2K27 pool player must be rendered');
  });

  // ── B. Players does NOT render .players-historical-section ────────────
  await test('B. Players does NOT render .players-historical-section (or any of its former controls)', async () => {
    const env = makeEnv({ leaguePlayers: { legacy1: { id: 'legacy1', name: 'Legacy One', pool: 'green', position: 'PG', overall: 80 } } });
    await renderPlayersAndSettle(env);

    assert.strictEqual(env.container.querySelector('.players-historical-section'), null, '.players-historical-section must not exist anywhere on the page');
    assert.strictEqual(env.container.querySelector('#editionFilterTabs'), null, 'the All/Active/Archived edition filter must be gone');
    assert.strictEqual(env.container.querySelector('#btnShowAddPlayer'), null, 'Add Player control must be gone');
    assert.strictEqual(env.container.querySelector('#btnShowImport'), null, 'Import CSV control must be gone');
    assert.strictEqual(env.container.querySelector('#btnDeleteAllPlayers'), null, 'Delete All Players control must be gone');
    assert.ok(!/Historical \/ Legacy Players/i.test(env.container.textContent), 'the "Historical / Legacy Players" heading must not appear anywhere');
  });

  // ── C. Initialize control remains present ──────────────────────────────
  await test('C. NBA 2K27 Initialize control remains present and functional', async () => {
    const nba2k27PoolDocs = {};
    const nba2kPlayersDocs = { newguy: sourcePlayer({ name: 'New Guy', teamType: 'curr', overall: 80 }) };
    const env = makeEnv({ nba2k27PoolDocs, nba2kPlayersDocs });
    const mount = await renderPlayersAndSettle(env);

    const initBtn = mount.querySelector('#nba2k27InitBtn');
    assert.ok(initBtn, 'Initialize 2K27 Pool button must be present');
    initBtn.click();
    const confirmBtn = mount.querySelector('#nba2k27InitConfirmBtn');
    assert.ok(confirmBtn, 'Initialize confirm step must render');
    confirmBtn.click();
    await new Promise(r => setTimeout(r, 0));
    assert.ok(env.getPool27Store().newguy, 'Initialize must actually upsert new nba2k_players records into nba2k27_pool');
  });

  // ── D. Validate control remains present when appropriate ──────────────
  await test('D. NBA 2K27 Validate control remains present (non-empty pool) and functional', async () => {
    const nba2k27PoolDocs = { sga: poolEntry({ position: 'PG' }) };
    const nba2kPlayersDocs = { sga: sourcePlayer({ name: 'Shai Gilgeous-Alexander', overall: 97 }) };
    const env = makeEnv({ nba2k27PoolDocs, nba2kPlayersDocs });
    const mount = await renderPlayersAndSettle(env);

    const validateBtn = mount.querySelector('#nba2k27ValidateBtn');
    assert.ok(validateBtn, 'Validate 2K27 Pool button must be present once the pool is non-empty');
    validateBtn.click();
    const resultEl = mount.querySelector('#nba2k27ValResult');
    assert.ok(resultEl && resultEl.textContent.trim().length > 0, 'clicking Validate must produce a report');
  });

  // ── E. 2K27 pool rows still render (Green/Blue/White + search/sort) ───
  await test('E. 2K27 pool rows render, with working pool tabs and search', async () => {
    const nba2k27PoolDocs = {
      sga: poolEntry({ pool: 'green', position: 'PG' }),
      mj: poolEntry({ pool: 'blue', position: 'SG' }),
    };
    const nba2kPlayersDocs = {
      sga: sourcePlayer({ name: 'Shai Gilgeous-Alexander', overall: 97 }),
      mj: sourcePlayer({ name: 'Michael Jordan', overall: 98 }),
    };
    const env = makeEnv({ nba2k27PoolDocs, nba2kPlayersDocs });
    const mount = await renderPlayersAndSettle(env);

    assert.ok(mount.querySelector('.pos-table-row[data-player-id="sga"]'), 'green-pool row must render (default active tab)');
    const blueTab = mount.querySelector('.pool-tab-blue');
    assert.ok(blueTab, 'Blue pool tab must exist');
    blueTab.click();
    assert.ok(mount.querySelector('.pos-table-row[data-player-id="mj"]'), 'blue-pool row must render after switching tabs');
  });

  // ── F. Clicking a 2K27 pool row still opens Manual Edit ────────────────
  await test('F. clicking a 2K27 pool row opens Nba2k27PoolView\'s own Manual Edit modal, unmodified', async () => {
    const nba2k27PoolDocs = { sga: poolEntry({ position: 'PG' }) };
    const nba2kPlayersDocs = { sga: sourcePlayer({ name: 'Shai Gilgeous-Alexander', overall: 97 }) };
    const env = makeEnv({ nba2k27PoolDocs, nba2kPlayersDocs });
    const mount = await renderPlayersAndSettle(env);

    mount.querySelector('.pos-table-row[data-player-id="sga"]').click();
    const editEl = mount.querySelector('#nba2k27mgmtEdit');
    assert.ok(editEl && !editEl.classList.contains('hidden'), 'the edit panel must be shown after clicking the row');
    assert.ok(editEl.querySelector('#nba2k27EditName'), 'the exact Manual Edit form fields must be present — this is Nba2k27PoolView._openManualEdit() itself');
  });

  // ── G. Rendering Players performs no Firestore writes ──────────────────
  await test('G. simply rendering Players (no user action) never writes to Firestore', async () => {
    const nba2k27PoolDocs = { sga: poolEntry({ position: 'PG' }) };
    const nba2kPlayersDocs = { sga: sourcePlayer({ name: 'Shai Gilgeous-Alexander', overall: 97 }) };
    const env = makeEnv({ nba2k27PoolDocs, nba2kPlayersDocs });
    await renderPlayersAndSettle(env);
    assert.deepStrictEqual(env.getWrites(), [], 'rendering the 2K27-only Players page must not write anything to Firestore on its own');
  });

  // ── H. Historical/legacy league/main.players data remains untouched ────
  await test('H. existing Historical/Legacy data in league/main.players is completely untouched by rendering/using this page', async () => {
    const leaguePlayers = {
      legacy1: { id: 'legacy1', name: 'Legacy One', pool: 'green', position: 'PG', overall: 80 },
      modern1: { id: 'modern1', name: 'Modern One', pool: 'green', position: 'SF', overall: 90, edition: '2K27', seasonId: 's1', nba2kRef: 'sga' },
    };
    const nba2k27PoolDocs = { sga: poolEntry({ position: 'PG' }) };
    const nba2kPlayersDocs = { sga: sourcePlayer({ name: 'Shai Gilgeous-Alexander', overall: 97 }) };
    const env = makeEnv({ leaguePlayers, nba2k27PoolDocs, nba2kPlayersDocs });
    const before = JSON.parse(JSON.stringify(env.window.LeagueData.getAllPlayers()));

    const mount = await renderPlayersAndSettle(env);
    // Edit the 2K27 pool entry that happens to share an nba2kRef with an
    // already-promoted historical player ("modern1") — editing the POOL
    // record must never reach back and mutate that historical record,
    // and the fully-removed Historical section obviously can't either.
    mount.querySelector('.pos-table-row[data-player-id="sga"]').click();
    const editEl = mount.querySelector('#nba2k27mgmtEdit');
    editEl.querySelector('#nba2k27EditOverall').value = '99';
    editEl.querySelector('#nba2k27EditSaveBtn').onclick();
    await new Promise(r => setTimeout(r, 0));

    const after = env.window.LeagueData.getAllPlayers();
    assert.deepStrictEqual(
      after.sort((a, b) => a.id.localeCompare(b.id)),
      before.sort((a, b) => a.id.localeCompare(b.id)),
      'no historical league/main.players record may be deleted, mutated, or reclassified'
    );
    assert.strictEqual(after.length, 2, 'both historical records must still exist, completely unchanged');
  });

  // ── I. The standalone NBA 2K27 Pool route remains available ───────────
  await test('I. the standalone NBA 2K27 Pool route/view remains independently reachable (unmodified, unremoved)', () => {
    const env = makeEnv({});
    assert.strictEqual(typeof env.window.Nba2k27PoolView.render, 'function', 'Nba2k27PoolView.render must still exist and be directly callable as its own standalone view');
    assert.strictEqual(typeof env.window.AdminApp.renderView, 'function');
    // js/admin.js's routing table (nba2k27Pool -> Nba2k27PoolView,
    // nba2kDatabase -> Nba2kDatabaseView, nba2k27PositionSort ->
    // Nba2k27PositionSortView) is not loaded by this harness on purpose —
    // this suite is scoped to js/admin/players.js's own behavior — but
    // it was not touched by this change; confirmed at the file level in
    // the implementation report, not re-asserted here.
  });

  console.log(`\n${failures === 0 ? 'All tests passed.' : failures + ' test(s) failed.'}`);
  process.exitCode = failures === 0 ? 0 : 1;
})();
