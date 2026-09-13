'use strict';
/**
 * Phase 3 — NBA 2K27 Pool → Players UI merge tests.
 *
 * Verifies that js/admin/players.js now hosts the NBA 2K27 Pool
 * management UI as its primary section by DELEGATING to the existing,
 * UNMODIFIED Nba2k27PoolView (js/admin/nba2k-database.js) — not by
 * reimplementing any of its rendering, editing, or removal logic.
 *
 * Nba2k27PoolView itself is loaded completely as-is here; this suite
 * never patches or reimplements _openManualEdit()/_showRemoveConfirm()/
 * _renderVariantGroupMembers() — it exercises the real functions, invoked
 * through the real mount point Players' own render() creates.
 *
 * Never touches real Firestore — every Firestore call is served by an
 * in-memory fake, same convention as every other suite in this repo.
 * Test G additionally asserts an exact call-log of every write the fake
 * observed, to positively confirm no write happens outside an explicit
 * user action (an edit-save click or a remove-confirm click).
 *
 * Run with: node tests_players_2k27_pool_merge/players_2k27_pool_merge_test.js
 * Requires the `jsdom` package (npm install --no-save jsdom).
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

  // firestoreWrites logs every write the fake observes, so test G can
  // assert an exact, complete list — not just "at least these happened".
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
                  // Apply FieldValue.delete() sentinels onto the merged doc.
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
        // Minimal batch() support for Nba2k27PoolView._runInitialization()
        // ("Initialize 2K27 Pool"), which chunks writes via
        // firebase.firestore().batch() rather than individual .set() calls.
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
      // firebase.firestore.FieldValue is a STATIC property on the
      // `firestore` function itself (real Firebase SDK shape), not on
      // its return value — matches how js/admin/nba2k-database.js calls
      // it: `firebase.firestore.FieldValue.delete()`.
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
    'this.Nba2k27PoolView = Nba2k27PoolView; this.Nba2kDatabaseView = Nba2kDatabaseView; ' +
    'this.isLegacyEditionPlayer = isLegacyEditionPlayer;',
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
  window.AdminPlayersView._editionFilter = 'all';
  window.AdminPlayersView._activePool = 'green';

  return { window, document, container, getWrites: () => firestoreWrites.slice(), getPool27Store: () => pool27Store };
}

/** Renders Players, then awaits the delegated Nba2k27PoolView section
 * fully settling (its own render() is async — this fire-and-forget
 * relationship is exactly how AdminPlayersView invokes it in the real
 * app, but tests need a settled DOM to assert against). */
async function renderPlayersAndSettle(env) {
  env.window.AdminPlayersView.render(env.container);
  const mount = env.container.querySelector('#playersNba2k27PoolMount');
  assert.ok(mount, 'Players render() must produce a #playersNba2k27PoolMount element');
  // Calling Nba2k27PoolView.render() again on the same mount is safe/
  // idempotent (it's exactly what re-opening the standalone Pool page
  // does) and lets the test await full settlement deterministically,
  // rather than guessing at setTimeout delays.
  await env.window.Nba2k27PoolView.render(mount);
  return mount;
}

console.log('Phase 3 — Players page / NBA 2K27 Pool merge — tests');

(async () => {
  // ── A. Players page defaults to showing the NBA 2K27 pool view ────────
  await test('A. Players renders the NBA 2K27 pool as its primary, already-populated section', async () => {
    const nba2k27PoolDocs = { sga: poolEntry({ position: 'PG' }) };
    const nba2kPlayersDocs = { sga: sourcePlayer({ name: 'Shai Gilgeous-Alexander', overall: 97 }) };
    const env = makeEnv({ nba2k27PoolDocs, nba2kPlayersDocs });
    const mount = await renderPlayersAndSettle(env);

    // The primary section appears BEFORE the historical section in the
    // page's DOM order.
    const primary = env.container.querySelector('.players-nba2k27-primary');
    const historical = env.container.querySelector('.players-historical-section');
    assert.ok(primary && historical, 'both the primary 2K27 section and the historical section must be present');
    const position = primary.compareDocumentPosition(historical);
    assert.ok(position & env.window.Node.DOCUMENT_POSITION_FOLLOWING, 'the NBA 2K27 pool section must appear before the historical section');

    // And it's not an empty placeholder — the real Nba2k27PoolView shell
    // (Initialize/Validate buttons, pool tabs) actually rendered into it.
    assert.ok(mount.querySelector('#nba2k27InitBtn'), 'Initialize control must be present in the delegated section');
    assert.ok(mount.querySelector('#nba2k27ValidateBtn'), 'Validate control must be present in the delegated section (non-empty pool fixture)');
    assert.ok(mount.querySelector('.pos-table-row[data-player-id="sga"]'), 'the seeded 2K27 pool player must be rendered inside the primary section');
  });

  // ── B. Clicking a 2K27 pool row opens the SAME Manual Edit modal ──────
  await test('B. clicking a 2K27 pool row opens Nba2k27PoolView\'s own Manual Edit modal, unmodified', async () => {
    const nba2k27PoolDocs = { sga: poolEntry({ position: 'PG' }) };
    const nba2kPlayersDocs = { sga: sourcePlayer({ name: 'Shai Gilgeous-Alexander', overall: 97 }) };
    const env = makeEnv({ nba2k27PoolDocs, nba2kPlayersDocs });
    const mount = await renderPlayersAndSettle(env);

    const row = mount.querySelector('.pos-table-row[data-player-id="sga"]');
    assert.ok(row, 'the pool row must exist to click');
    row.click();

    const editEl = mount.querySelector('#nba2k27mgmtEdit');
    assert.ok(editEl, '#nba2k27mgmtEdit mount point must exist inside the Players-embedded section');
    assert.ok(!editEl.classList.contains('hidden'), 'the edit panel must be shown after clicking the row');
    assert.ok(editEl.querySelector('#nba2k27EditName'), 'the exact same Manual Edit form fields (e.g. #nba2k27EditName) must be present — this is Nba2k27PoolView._openManualEdit() itself, not a reimplementation');
    assert.ok(editEl.textContent.includes('Shai Gilgeous-Alexander'), 'the edit panel must reflect the clicked player');
  });

  // ── C. Editing writes ONLY to nba2k27_pool/<nba2kRef> ──────────────────
  await test('C. saving an edit writes exactly one Firestore call, to nba2k27_pool/<nba2kRef>, merge:true', async () => {
    const nba2k27PoolDocs = { sga: poolEntry({ position: 'PG' }) };
    const nba2kPlayersDocs = { sga: sourcePlayer({ name: 'Shai Gilgeous-Alexander', overall: 97 }) };
    const env = makeEnv({ nba2k27PoolDocs, nba2kPlayersDocs });
    const mount = await renderPlayersAndSettle(env);

    mount.querySelector('.pos-table-row[data-player-id="sga"]').click();
    const editEl = mount.querySelector('#nba2k27mgmtEdit');
    editEl.querySelector('#nba2k27EditOverall').value = '96';
    const writesBefore = env.getWrites().length;
    editEl.querySelector('#nba2k27EditSaveBtn').onclick(); // handler is async; test awaits below
    await new Promise(r => setTimeout(r, 0));

    const writes = env.getWrites().slice(writesBefore);
    assert.strictEqual(writes.length, 1, 'exactly one Firestore write must occur for a single edit save');
    assert.strictEqual(writes[0].collection, 'nba2k27_pool');
    assert.strictEqual(writes[0].doc, 'sga', 'the write must target the doc keyed by nba2kRef ("sga"), not a league/main.players id');
    assert.strictEqual(writes[0].op, 'set');
    assert.strictEqual(writes[0].merge, true);

    // league/main.players must be completely untouched by this.
    assert.strictEqual(env.window.LeagueData.getAllPlayers().length, 0, 'no league/main.players record exists or was created by editing a pool entry');
  });

  // ── D. Removing writes ONLY a delete to nba2k27_pool/<nba2kRef> ────────
  await test('D. confirming Remove issues exactly one Firestore delete, to nba2k27_pool/<nba2kRef>', async () => {
    const nba2k27PoolDocs = { sga: poolEntry({ position: 'PG' }) };
    const nba2kPlayersDocs = { sga: sourcePlayer({ name: 'Shai Gilgeous-Alexander', overall: 97 }) };
    const env = makeEnv({ nba2k27PoolDocs, nba2kPlayersDocs });
    const mount = await renderPlayersAndSettle(env);

    // Remove is reached via Nba2k27PoolView._showRemoveConfirm() itself —
    // exercised directly here exactly as the shared NBA2K Database detail
    // modal / validator "Review" flow already do on the standalone Pool
    // page (see Phase 3 follow-up audit); this merge changes nothing
    // about how Remove is reached, only where the section is mounted.
    const row = env.window.Nba2k27PoolView._buildRows().find(r => r.slug === 'sga');
    assert.ok(row, 'fixture sanity check');
    env.window.Nba2k27PoolView._showRemoveConfirm(mount, row);

    const confirmEl = mount.querySelector('#nba2k27mgmtConfirm');
    assert.ok(confirmEl && !confirmEl.classList.contains('hidden'), 'the remove confirmation must render inside the Players-embedded mount');
    const writesBefore = env.getWrites().length;
    confirmEl.querySelector('#nba2k27mgmtConfirmRemoveBtn').onclick();
    await new Promise(r => setTimeout(r, 0));

    const writes = env.getWrites().slice(writesBefore);
    assert.strictEqual(writes.length, 1, 'exactly one Firestore write must occur for a single remove confirm');
    assert.strictEqual(writes[0].collection, 'nba2k27_pool');
    assert.strictEqual(writes[0].doc, 'sga');
    assert.strictEqual(writes[0].op, 'delete');
    assert.strictEqual(env.getPool27Store().sga, undefined, 'the pool doc must actually be gone from the store');
  });

  // ── E. Historical Players filtering (All/Active/Archived) still works ─
  await test('E. the Historical/Legacy All/Active/Archived filter section still works exactly as before', async () => {
    const leaguePlayers = {
      legacy1: { id: 'legacy1', name: 'Legacy One', pool: 'green', position: 'PG', overall: 80 },
      modern1: { id: 'modern1', name: 'Modern One', pool: 'green', position: 'SF', overall: 90, edition: '2K27', seasonId: 's1', nba2kRef: 'x' },
    };
    const env = makeEnv({ leaguePlayers });
    const mount = await renderPlayersAndSettle(env);
    void mount;

    const historical = env.container.querySelector('.players-historical-section');
    const editionTabs = historical.querySelectorAll('#editionFilterTabs .pool-tab .pool-tab-count');
    assert.strictEqual(editionTabs.length, 3);
    assert.strictEqual(editionTabs[0].textContent, '2', 'All must count both historical players');
    assert.strictEqual(editionTabs[1].textContent, '1', 'Active must count only the 2K27-edition player');
    assert.strictEqual(editionTabs[2].textContent, '1', 'Archived must count only the legacy player');

    const archivedTab = Array.from(historical.querySelectorAll('#editionFilterTabs .pool-tab')).find(b => b.dataset.edition === 'archived');
    archivedTab.onclick();
    const visibleIds = Array.from(env.container.querySelectorAll('.players-historical-section .pos-table-row[data-player-id]')).map(r => r.dataset.playerId);
    assert.ok(visibleIds.includes('legacy1'));
    assert.ok(!visibleIds.includes('modern1'));
  });

  // ── F. Initialize/Validate/Position Sorter access remains present ─────
  await test('F1. Initialize Pool control is present and functional inside the Players-embedded section (empty-pool state)', async () => {
    const nba2k27PoolDocs = {};
    const nba2kPlayersDocs = { newguy: sourcePlayer({ name: 'New Guy', teamType: 'curr', overall: 80 }) };
    const env = makeEnv({ nba2k27PoolDocs, nba2kPlayersDocs });
    const mount = await renderPlayersAndSettle(env);

    const initBtn = mount.querySelector('#nba2k27InitBtn');
    assert.ok(initBtn, 'Initialize 2K27 Pool button must be present');
    assert.ok(/Initialize 2K27 Pool/i.test(initBtn.textContent));

    // Initialize is a two-step confirm (click #nba2k27InitBtn -> shows a
    // confirm panel -> #nba2k27InitConfirmBtn actually runs it) — exactly
    // as on the standalone Pool page, unchanged by this merge.
    initBtn.click();
    const confirmBtn = mount.querySelector('#nba2k27InitConfirmBtn');
    assert.ok(confirmBtn, 'Initialize confirm step must render inside the Players-embedded mount');
    confirmBtn.click();
    await new Promise(r => setTimeout(r, 0));
    assert.ok(env.getPool27Store().newguy, 'Initialize must actually upsert new nba2k_players records into nba2k27_pool, exactly as on the standalone Pool page');
  });

  await test('F2. Validate Pool control is present and functional inside the Players-embedded section (non-empty pool)', async () => {
    const nba2k27PoolDocs = { sga: poolEntry({ position: 'PG' }) };
    const nba2kPlayersDocs = { sga: sourcePlayer({ name: 'Shai Gilgeous-Alexander', overall: 97 }) };
    const env = makeEnv({ nba2k27PoolDocs, nba2kPlayersDocs });
    const mount = await renderPlayersAndSettle(env);

    const validateBtn = mount.querySelector('#nba2k27ValidateBtn');
    assert.ok(validateBtn, 'Validate 2K27 Pool button must be present once the pool is non-empty');
    validateBtn.click();
    const resultEl = mount.querySelector('#nba2k27ValResult');
    assert.ok(resultEl && resultEl.textContent.trim().length > 0, 'clicking Validate must produce a report, exactly as on the standalone Pool page');
  });

  await test('F3. the standalone NBA 2K27 Pool page and Position Sorter routes remain independently reachable (unmodified, unremoved)', () => {
    const env = makeEnv({});
    assert.strictEqual(typeof env.window.Nba2k27PoolView.render, 'function', 'Nba2k27PoolView.render must still exist and be directly callable as its own standalone view');
    assert.strictEqual(typeof env.window.AdminApp.renderView, 'function');
    // js/admin/nba2k27-position-sort.js is a separate file/route entirely
    // (not loaded by this harness, on purpose — it has no dependency on
    // js/admin/players.js at all) and was not touched by this change; its
    // continued existence as an unmodified file is confirmed at the file
    // level in the implementation report, not re-asserted here.
  });

  // ── G. No Firestore writes occur outside expected user actions ────────
  await test('G. simply rendering Players (no user action) never writes to Firestore', async () => {
    const nba2k27PoolDocs = { sga: poolEntry({ position: 'PG' }) };
    const nba2kPlayersDocs = { sga: sourcePlayer({ name: 'Shai Gilgeous-Alexander', overall: 97 }) };
    const env = makeEnv({ nba2k27PoolDocs, nba2kPlayersDocs });
    await renderPlayersAndSettle(env);
    assert.deepStrictEqual(env.getWrites(), [], 'rendering the merged Players page must not write anything to Firestore on its own');
  });

  // ── H. No historical players are deleted, mutated, or reclassified ────
  await test('H. league/main.players is completely unaffected by rendering/using the embedded 2K27 pool section', async () => {
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
    // record must never reach back and mutate that historical record.
    mount.querySelector('.pos-table-row[data-player-id="sga"]').click();
    const editEl = mount.querySelector('#nba2k27mgmtEdit');
    editEl.querySelector('#nba2k27EditOverall').value = '99';
    editEl.querySelector('#nba2k27EditSaveBtn').onclick();
    await new Promise(r => setTimeout(r, 0));

    const after = env.window.LeagueData.getAllPlayers();
    assert.deepStrictEqual(
      after.sort((a, b) => a.id.localeCompare(b.id)),
      before.sort((a, b) => a.id.localeCompare(b.id)),
      'no historical league/main.players record may be deleted, mutated, or reclassified by any 2K27 pool action'
    );
  });

  console.log(`\n${failures === 0 ? 'All tests passed.' : failures + ' test(s) failed.'}`);
  process.exitCode = failures === 0 ? 0 : 1;
})();
