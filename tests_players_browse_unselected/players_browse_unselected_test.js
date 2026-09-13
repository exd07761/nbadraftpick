'use strict';
/**
 * Phase A — "Browse Unselected Players" tests.
 *
 * Verifies that the Players page (which mounts the existing, unmodified
 * `Nba2k27PoolView`) can now browse raw NBA 2K27 source players that are
 * NOT yet in `nba2k27_pool`, inspect one via the existing shared detail
 * modal, and add it to the pool — all while:
 *
 *   - introducing ZERO additional Firestore reads (the shared
 *     `Nba2kDatabaseView._ensureLoaded()` cache, already loaded once by
 *     Players/Nba2k27PoolView, is reused as-is — see test F);
 *   - never touching `_filterPool` (which must remain exactly one of
 *     'green'|'blue'|'white' — see test D);
 *   - never touching the legacy `_renderRow`/`_groupRows` (still
 *     exercised by tests_p8/tests_p12, untouched by this feature);
 *   - reusing the existing `Nba2kDatabaseView._openDetail()` modal and
 *     its existing `_bind2k27Events()` Add-to-Pool workflow verbatim —
 *     no second modal, no new write schema, no new write path;
 *   - writing ONLY `nba2k27_pool/<slug>` — never `/league/main`, never
 *     `nba2k_players` (see tests H/I/J);
 *   - leaving every existing Green/Blue/White pool behavior intact
 *     (see test L).
 *
 * Run with: node tests_players_browse_unselected/players_browse_unselected_test.js
 * Requires the `jsdom` package (same as tests_players_2k27_only and other
 * jsdom-based suites in this repo). Per the Phase A instructions, this
 * run does NOT install jsdom or modify package.json/package-lock.json to
 * obtain it — if jsdom isn't present, `require('jsdom')` below throws and
 * this file cannot execute at runtime in this environment. The
 * implementation report notes this file was syntax-checked with
 * `node --check` instead.
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
  // F. Read-count tracking — the whole point of this suite's read-safety
  // assertion is that opening/searching/browsing Browse Unselected must
  // cause ZERO additional `.get()` calls against either collection,
  // beyond the one `_ensureLoaded()` pass Players/Nba2k27PoolView already
  // makes on first render.
  const getCalls = { nba2k_players: 0, nba2k27_pool: 0 };
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
              get: () => {
                getCalls.nba2k27_pool++;
                return Promise.resolve({
                  size: Object.keys(pool27Store).length,
                  docs: Object.keys(pool27Store).map(id => ({ id, data: () => pool27Store[id] })),
                });
              },
              doc: (slug) => ({
                _collection: 'nba2k27_pool',
                _slug: slug,
                set: (payload) => {
                  firestoreWrites.push({ collection: 'nba2k27_pool', doc: slug, op: 'set', payload });
                  pool27Store[slug] = Object.assign({}, payload);
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
            return {
              get: () => {
                getCalls.nba2k_players++;
                return Promise.resolve({ docs: Object.keys(nba2kPlayersDocs).map(id => ({ id, data: () => nba2kPlayersDocs[id] })) });
              },
            };
          }
          return { get: () => Promise.resolve({ docs: [] }) };
        },
        enablePersistence: () => Promise.resolve(),
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

  return {
    window, document, container,
    getWrites: () => firestoreWrites.slice(),
    getPool27Store: () => pool27Store,
    getReadCalls: () => Object.assign({}, getCalls),
  };
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

console.log('Phase A — Players: Browse Unselected NBA 2K27 Players — tests');

(async () => {
  // ── A. Players still mounts Nba2k27PoolView ────────────────────────────
  await test('A. Players still mounts the existing, unmodified Nba2k27PoolView', async () => {
    const env = makeEnv({
      nba2k27PoolDocs: { sga: poolEntry() },
      nba2kPlayersDocs: { sga: sourcePlayer({ name: 'Shai Gilgeous-Alexander', overall: 97 }) },
    });
    const mount = await renderPlayersAndSettle(env);
    assert.ok(env.container.querySelector('.players-nba2k27-primary'), 'Players page primary section must be present');
    assert.ok(mount.querySelector('.pool-tabs'), 'the existing Green/Blue/White pool tabs must still render inside Players');
  });

  // ── B. Browse Unselected UI is present ─────────────────────────────────
  await test('B. Browse Unselected toggle is present on the Players-mounted pool view', async () => {
    const env = makeEnv({
      nba2k27PoolDocs: { sga: poolEntry() },
      nba2kPlayersDocs: {
        sga: sourcePlayer({ name: 'Shai Gilgeous-Alexander', overall: 97 }),
        newguy: sourcePlayer({ name: 'New Guy', overall: 70 }),
      },
    });
    const mount = await renderPlayersAndSettle(env);
    const btn = mount.querySelector('#nba2k27ShowUnselectedBtn');
    assert.ok(btn, 'Browse Unselected Players toggle button must exist');
    assert.ok(/Browse Unselected Players/.test(btn.textContent), 'button label must read Browse Unselected Players');
    assert.ok(/1/.test(btn.textContent), 'the unselected count badge should show 1 (only "New Guy" is unselected)');
  });

  // ── C. Unselected players are determined by absence from _pool27 ──────
  await test('C. clicking Browse Unselected lists exactly the source players absent from nba2k27_pool', async () => {
    const env = makeEnv({
      nba2k27PoolDocs: { sga: poolEntry() },
      nba2kPlayersDocs: {
        sga: sourcePlayer({ name: 'Shai Gilgeous-Alexander', overall: 97 }),
        newguy: sourcePlayer({ name: 'New Guy', overall: 70 }),
        another: sourcePlayer({ name: 'Another Guy', overall: 65 }),
      },
    });
    const mount = await renderPlayersAndSettle(env);
    mount.querySelector('#nba2k27ShowUnselectedBtn').click();

    const rows = mount.querySelectorAll('#nba2k27UnselectedListWrap [data-slug]');
    const slugs = Array.from(rows).map(r => r.dataset.slug).sort();
    assert.deepStrictEqual(slugs, ['another', 'newguy'], 'only players without a nba2k27_pool entry must appear');
    assert.ok(!mount.querySelector('#nba2k27UnselectedListWrap [data-slug="sga"]'), 'a player already in the pool must NOT appear in Browse Unselected');
  });

  // ── D. _filterPool remains limited to green/blue/white ─────────────────
  await test('D. _filterPool is untouched by this feature — stays exactly green/blue/white', async () => {
    const env = makeEnv({
      nba2k27PoolDocs: { sga: poolEntry({ pool: 'green' }) },
      nba2kPlayersDocs: {
        sga: sourcePlayer({ name: 'Shai Gilgeous-Alexander', overall: 97 }),
        newguy: sourcePlayer({ name: 'New Guy', overall: 70 }),
      },
    });
    const mount = await renderPlayersAndSettle(env);
    assert.strictEqual(env.window.Nba2k27PoolView._filterPool, 'green', 'default _filterPool must remain "green"');

    mount.querySelector('#nba2k27ShowUnselectedBtn').click();
    assert.ok(['green', 'blue', 'white'].includes(env.window.Nba2k27PoolView._filterPool),
      '_filterPool must never become "unselected" or any other 4th value');
    assert.strictEqual(mount.querySelectorAll('.pool-tab').length, 3, 'exactly 3 pool tabs (green/blue/white) must still exist — no 4th tab added');
  });

  // ── E. Searching the unselected list is client-side ────────────────────
  await test('E. searching Browse Unselected filters client-side and does not touch the existing pool search', async () => {
    const env = makeEnv({
      nba2k27PoolDocs: {},
      nba2kPlayersDocs: {
        a: sourcePlayer({ name: 'Alpha Alpha', overall: 80 }),
        b: sourcePlayer({ name: 'Bravo Bravo', overall: 75 }),
      },
    });
    const mount = await renderPlayersAndSettle(env);
    mount.querySelector('#nba2k27ShowUnselectedBtn').click();

    const search = mount.querySelector('#nba2k27UnselectedSearch');
    assert.ok(search, 'Browse Unselected must have its own search input');
    search.value = 'alpha';
    search.dispatchEvent(new env.window.Event('input'));

    const rows = mount.querySelectorAll('#nba2k27UnselectedListWrap [data-slug]');
    assert.strictEqual(rows.length, 1, 'search should narrow the unselected list to matching players only');
    assert.strictEqual(rows[0].dataset.slug, 'a');

    // The existing pool search box (_search) must be independent and untouched.
    assert.strictEqual(env.window.Nba2k27PoolView._search, '', 'typing in the unselected search must not touch the existing pool search state');
  });

  // ── F. No second Firestore load is introduced ──────────────────────────
  await test('F. opening/searching Browse Unselected causes zero additional Firestore reads', async () => {
    const env = makeEnv({
      nba2k27PoolDocs: { sga: poolEntry() },
      nba2kPlayersDocs: {
        sga: sourcePlayer({ name: 'Shai Gilgeous-Alexander', overall: 97 }),
        newguy: sourcePlayer({ name: 'New Guy', overall: 70 }),
      },
    });
    const mount = await renderPlayersAndSettle(env);
    const afterInitialLoad = env.getReadCalls();
    assert.strictEqual(afterInitialLoad.nba2k_players, 1, 'exactly one nba2k_players read for the whole page load');
    assert.strictEqual(afterInitialLoad.nba2k27_pool, 1, 'exactly one nba2k27_pool read for the whole page load');

    mount.querySelector('#nba2k27ShowUnselectedBtn').click();
    const search = mount.querySelector('#nba2k27UnselectedSearch');
    search.value = 'new';
    search.dispatchEvent(new env.window.Event('input'));
    mount.querySelector('#nba2k27ShowUnselectedBtn').click(); // hide
    mount.querySelector('#nba2k27ShowUnselectedBtn').click(); // show again

    const afterBrowsing = env.getReadCalls();
    assert.deepStrictEqual(afterBrowsing, afterInitialLoad, 'opening/searching/toggling Browse Unselected must not cause any additional .get() calls');
  });

  // ── G. Clicking an unselected player reuses _openDetail() ──────────────
  await test('G. clicking an unselected player opens the existing shared detail modal', async () => {
    const env = makeEnv({
      nba2k27PoolDocs: {},
      nba2kPlayersDocs: { newguy: sourcePlayer({ name: 'New Guy', overall: 70 }) },
    });
    const mount = await renderPlayersAndSettle(env);
    mount.querySelector('#nba2k27ShowUnselectedBtn').click();
    mount.querySelector('#nba2k27UnselectedListWrap [data-slug="newguy"]').click();

    const detailMount = mount.querySelector('#nba2kDetailMount');
    assert.ok(detailMount && detailMount.querySelector('.nba2k-detail-modal'), 'the existing shared detail modal must open');
    assert.ok(detailMount.querySelector('#nba2k27AddBtn'), 'the existing Add to 2K27 Pool button must be present in the modal');
    assert.ok(detailMount.querySelector('.nba2k-detail-name').textContent.includes('New Guy'), 'the modal must show the clicked player');
  });

  // ── H/I/J. Add-to-Pool write target and non-targets ─────────────────────
  await test('H/I/J. Add to 2K27 Pool from Browse Unselected writes only nba2k27_pool/<slug>', async () => {
    const env = makeEnv({
      nba2k27PoolDocs: {},
      nba2kPlayersDocs: { newguy: sourcePlayer({ name: 'New Guy', teamType: 'curr', overall: 70 }) },
    });
    const mount = await renderPlayersAndSettle(env);
    mount.querySelector('#nba2k27ShowUnselectedBtn').click();
    mount.querySelector('#nba2k27UnselectedListWrap [data-slug="newguy"]').click();

    mount.querySelector('#nba2k27AddBtn').click();
    const confirmBtn = mount.querySelector('#nba2k27ConfirmAddBtn');
    assert.ok(confirmBtn, 'the existing confirm-add step must appear, unchanged');
    confirmBtn.click();
    await new Promise(r => setTimeout(r, 0));

    const writes = env.getWrites();
    assert.strictEqual(writes.length, 1, 'exactly one write must occur');
    assert.strictEqual(writes[0].collection, 'nba2k27_pool');
    assert.strictEqual(writes[0].doc, 'newguy');
    assert.strictEqual(writes[0].op, 'set');
    assert.ok(!writes.some(w => w.collection === 'league'), '/league/main must never be written by this flow');
    // nba2k_players is read-only in this suite (no .set/.doc().set stub
    // exists for it at all) — if the implementation tried to write it,
    // this test's fake would throw a TypeError, which the surrounding
    // `test()` wrapper would report as a failure.
  });

  // ── K. Successful Add-to-Pool updates the cache/callback path ──────────
  await test('K. after adding, the player disappears from Browse Unselected without a reload', async () => {
    const env = makeEnv({
      nba2k27PoolDocs: {},
      nba2kPlayersDocs: {
        newguy: sourcePlayer({ name: 'New Guy', teamType: 'curr', overall: 70 }),
        other: sourcePlayer({ name: 'Other Guy', teamType: 'curr', overall: 60 }),
      },
    });
    const mount = await renderPlayersAndSettle(env);
    mount.querySelector('#nba2k27ShowUnselectedBtn').click();
    assert.strictEqual(mount.querySelectorAll('#nba2k27UnselectedListWrap [data-slug]').length, 2);

    mount.querySelector('#nba2k27UnselectedListWrap [data-slug="newguy"]').click();
    mount.querySelector('#nba2k27AddBtn').click();
    mount.querySelector('#nba2k27ConfirmAddBtn').click();
    await new Promise(r => setTimeout(r, 0));

    assert.ok(env.getPool27Store().newguy, 'the in-memory pool27 cache must reflect the new entry');
    const remainingRows = mount.querySelectorAll('#nba2k27UnselectedListWrap [data-slug]');
    assert.strictEqual(remainingRows.length, 1, 'the added player must disappear from Browse Unselected immediately');
    assert.strictEqual(remainingRows[0].dataset.slug, 'other');
    assert.strictEqual(env.getReadCalls().nba2k27_pool, 1, 'the refresh after adding must not cause a second nba2k27_pool read');

    // The now-populated Green pool tab (teamType 'curr' -> green) should
    // also reflect the addition, proving the existing _onPool27Changed /
    // _refreshPoolPane path still runs unmodified.
    const greenCount = mount.querySelector('.pool-tab-green .pool-tab-count');
    assert.ok(greenCount && greenCount.textContent.trim() === '1', 'the existing Green pool tab count must update via the existing callback path');
  });

  // ── L. Existing Green/Blue/White pool functionality remains intact ─────
  await test('L. existing pool tabs, search, sort, and pool counts still work unmodified', async () => {
    const env = makeEnv({
      nba2k27PoolDocs: {
        sga: poolEntry({ pool: 'green', position: 'PG' }),
        mj: poolEntry({ pool: 'blue', position: 'SG' }),
      },
      nba2kPlayersDocs: {
        sga: sourcePlayer({ name: 'Shai Gilgeous-Alexander', overall: 97 }),
        mj: sourcePlayer({ name: 'Michael Jordan', overall: 99, teamType: 'allt' }),
      },
    });
    const mount = await renderPlayersAndSettle(env);

    assert.ok(mount.querySelector('.pool-tab-green.active'), 'Green pool tab is the default active tab, unchanged');
    assert.ok(mount.textContent.includes('Shai Gilgeous-Alexander'), 'Green pool player must render as before');

    mount.querySelector('.pool-tab-blue').click();
    assert.ok(mount.querySelector('.pool-tab-blue.active'), 'switching to Blue pool tab must still work');
    assert.ok(mount.textContent.includes('Michael Jordan'), 'Blue pool player must render as before');

    const search = mount.querySelector('#nba2k27mgmtSearch');
    search.value = 'jordan';
    search.dispatchEvent(new env.window.Event('input'));
    assert.ok(mount.textContent.includes('Michael Jordan'), 'existing pool search must still work');

    assert.ok(mount.querySelector('#nba2k27ValidateBtn'), 'Validate control must remain present');
    assert.ok(mount.querySelector('#nba2k27InitBtn'), 'Initialize control must remain present');
  });

  console.log(`\n${failures === 0 ? 'All tests passed.' : failures + ' test(s) failed.'}`);
  process.exitCode = failures === 0 ? 0 : 1;
})();
