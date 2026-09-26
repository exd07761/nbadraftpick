'use strict';
/**
 * NBA 2K27 Live API Update Importer — tests.
 *
 * Exercises Nba2k27LiveImportView (js/admin/nba2k27-live-import.js) in
 * isolation, using an in-memory fake Firestore (never touches the real
 * nbadraftpick project). Loads the real js/shared-utils.js (for
 * escapeHtml/showToast), the real js/admin/nba2k-database.js (for
 * nba2k27PoolForTeamType/NBA2K27_POOL_META/nba2k27PoolLabel — confirmed
 * to have zero top-level side effects, safe to load standalone), and the
 * real js/admin/nba2k27-live-import.js under test — same "load the real
 * source into a sandbox" approach as tests_nba2k27_autoseed/.
 *
 * Run with: node tests_nba2k27_live_import/nba2k27_live_import_test.js
 * Requires the `jsdom` package (npm install --no-save jsdom).
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const { JSDOM } = require('jsdom');

const sharedUtilsSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'shared-utils.js'), 'utf8');
const nba2kDatabaseSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'admin', 'nba2k-database.js'), 'utf8');
const liveImportSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'admin', 'nba2k27-live-import.js'), 'utf8');

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

// ─── Fixture builders ───────────────────────────────────────────────────
function attrs() {
  return { speed: 80, strength: 70 }; // minimal — just needs to be a non-empty object
}

function rawRecord(overrides = {}) {
  return Object.assign(
    {
      slug: 'test-player',
      name: 'Test Player',
      team: 'Test Team',
      teamType: 'curr',
      overall: 80,
      attributes: attrs(),
      positions: ['PG'],
      badges: { legendary: 0, hallOfFame: 0, gold: 1, silver: 0, bronze: 0, total: 1, list: [{ name: 'Badge A', tier: 'Gold', category: 'Playmaking' }] },
    },
    overrides
  );
}

function storedPlayerDoc(overrides = {}) {
  return Object.assign(
    {
      name: 'Test Player',
      team: 'Test Team',
      teamType: 'curr',
      overall: 75,
      positions: ['PG'],
      attributes: attrs(),
      badges: { legendary: 0, hallOfFame: 0, gold: 1, silver: 0, bronze: 0, total: 1, list: [{ name: 'Badge A', tier: 'Gold', category: 'Playmaking' }] },
    },
    overrides
  );
}

function poolDoc(overrides = {}) {
  return Object.assign(
    { nba2kRef: 'test-player', pool: 'green', position: 'UNASSIGNED', selectedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    overrides
  );
}

// ─── Fake Firestore ─────────────────────────────────────────────────────
/**
 * playersDocs / poolDocs are plain mutable objects (slug -> data). The
 * fake batch.commit() mutates them in place, so a second
 * _validateAndPreview() call against the SAME environment sees the
 * post-apply state — exactly what a real rerun would see.
 */
function makeFirebase(playersDocs, poolDocs) {
  const writeLog = { playersUpdates: [], playersSets: [], poolSets: [] };
  const batchSizes = [];

  function makeCollection(name) {
    return {
      get: () => {
        const source = name === 'nba2k_players' ? playersDocs : name === 'nba2k27_pool' ? poolDocs : {};
        const docs = Object.keys(source).map(id => ({ id, data: () => source[id] }));
        return Promise.resolve({ forEach: fn => docs.forEach(fn), docs });
      },
      doc: id => ({ __collection: name, __id: id }),
    };
  }

  const firestoreObj = {
    collection: makeCollection,
    batch: () => {
      const ops = [];
      return {
        update: (ref, data) => ops.push({ type: 'update', ref, data }),
        set: (ref, data, opts) => ops.push({ type: 'set', ref, data, opts }),
        commit: () => {
          batchSizes.push(ops.length);
          for (const op of ops) {
            if (op.ref.__collection === 'nba2k_players') {
              if (op.type === 'update') {
                writeLog.playersUpdates.push({ id: op.ref.__id, data: op.data });
                playersDocs[op.ref.__id] = Object.assign({}, playersDocs[op.ref.__id], op.data);
              } else {
                writeLog.playersSets.push({ id: op.ref.__id, data: op.data });
                playersDocs[op.ref.__id] = op.data;
              }
            } else if (op.ref.__collection === 'nba2k27_pool') {
              writeLog.poolSets.push({ id: op.ref.__id, data: op.data });
              poolDocs[op.ref.__id] = op.data;
            }
          }
          return Promise.resolve();
        },
      };
    },
  };

  function firestoreFn() { return firestoreObj; }
  firestoreFn.FieldValue = {
    serverTimestamp: () => ({ __type: 'server-timestamp' }),
    delete: () => ({ __type: 'delete' }),
  };

  return { firebase: { firestore: firestoreFn }, writeLog, getBatchSizes: () => batchSizes };
}

function makeEnv(playersDocs = {}, poolDocs = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="c"></div></body></html>');
  const window = dom.window;
  const { firebase, writeLog, getBatchSizes } = makeFirebase(playersDocs, poolDocs);
  window.firebase = firebase;
  window.AuthBoundary = { requireAuth: () => {} };
  window.toasts = [];
  window.showToast = (msg, type) => window.toasts.push({ msg, type });

  vm.createContext(window);
  vm.runInContext(sharedUtilsSrc, window, { filename: 'shared-utils.js' });
  // showToast must survive shared-utils.js's own load (see autoseed test's
  // comment on load order) — reinstall the mock after, before loading
  // anything that might reference it at call time (it's only referenced
  // inside functions here, so order is less strict, but keep the same
  // convention as the rest of this repo's tests).
  window.showToast = (msg, type) => window.toasts.push({ msg, type });
  vm.runInContext(nba2kDatabaseSrc, window, { filename: 'nba2k-database.js' });
  vm.runInContext(liveImportSrc, window, { filename: 'nba2k27-live-import.js' });
  // Top-level `const` declarations don't attach to the vm context's
  // global object automatically (unlike `var`/function declarations) —
  // same explicit-export trick tests_nba2k27_autoseed/ already uses.
  vm.runInContext(
    'this.Nba2k27LiveImportView = Nba2k27LiveImportView; ' +
    'this.Nba2kDatabaseView = Nba2kDatabaseView;',
    window,
    { filename: 'export.js' }
  );

  const container = window.document.getElementById('c');
  window.Nba2k27LiveImportView.render(container);

  return { window, container, playersDocs, poolDocs, writeLog, getBatchSizes };
}

async function preview(env, records) {
  await env.window.Nba2k27LiveImportView._validateAndPreview(env.container, records, []);
}
async function apply(env) {
  await env.window.Nba2k27LiveImportView._runApply(env.container);
}

// ─── Tests ──────────────────────────────────────────────────────────────
(async () => {
  await test('1. existing 73 OVR player updated to 74 — batch.update, not set', async () => {
    const env = makeEnv({ 'p73': storedPlayerDoc({ overall: 73 }) }, {});
    await preview(env, [rawRecord({ slug: 'p73', overall: 74 })]);
    assert.strictEqual(env.window.Nba2k27LiveImportView._lastParsed.existingUpdates.length, 1);
    await apply(env);
    assert.strictEqual(env.writeLog.playersUpdates.length, 1);
    assert.strictEqual(env.writeLog.playersSets.length, 0, 'existing player must never be .set()');
    assert.strictEqual(env.writeLog.playersUpdates[0].data.overall, 74);
    assert.strictEqual(env.playersDocs.p73.overall, 74);
  });

  await test('2. existing 74 OVR player updated to 73 — still updates (no floor on existing)', async () => {
    const env = makeEnv({ 'p74': storedPlayerDoc({ overall: 74 }) }, {});
    await preview(env, [rawRecord({ slug: 'p74', overall: 73 })]);
    assert.strictEqual(env.window.Nba2k27LiveImportView._lastParsed.existingUpdates.length, 1);
    await apply(env);
    assert.strictEqual(env.playersDocs.p74.overall, 73);
  });

  await test('3. existing player identical overall+badges (list reordered) — zero writes', async () => {
    const badgesA = { legendary: 0, hallOfFame: 0, gold: 1, silver: 1, bronze: 0, total: 2, list: [
      { name: 'Alpha', tier: 'Gold', category: 'X' },
      { name: 'Beta', tier: 'Silver', category: 'Y' },
    ] };
    const badgesReordered = { legendary: 0, hallOfFame: 0, gold: 1, silver: 1, bronze: 0, total: 2, list: [
      { name: 'Beta', tier: 'Silver', category: 'Y' },
      { name: 'Alpha', tier: 'Gold', category: 'X' },
    ] };
    const env = makeEnv({ 'same': storedPlayerDoc({ overall: 80, badges: badgesA }) }, {});
    await preview(env, [rawRecord({ slug: 'same', overall: 80, badges: badgesReordered })]);
    const p = env.window.Nba2k27LiveImportView._lastParsed;
    assert.strictEqual(p.existingUpdates.length, 0);
    assert.strictEqual(p.unchanged, 1);
    assert.strictEqual(p.ratingChanges, 0);
    assert.strictEqual(p.badgeChanges, 0);
    await apply(env);
    assert.strictEqual(env.writeLog.playersUpdates.length, 0);
  });

  await test('4. existing player pool position survives untouched', async () => {
    const env = makeEnv(
      { 'sorted': storedPlayerDoc({ overall: 70 }) },
      { 'sorted': poolDoc({ position: 'SF', pool: 'green' }) }
    );
    await preview(env, [rawRecord({ slug: 'sorted', overall: 85 })]); // rating change
    await apply(env);
    assert.strictEqual(env.writeLog.poolSets.length, 0, 'no pool write for an existing player');
    assert.strictEqual(env.poolDocs.sorted.position, 'SF');
  });

  await test('5. existing player pool overrides survive untouched', async () => {
    const overriddenPool = poolDoc({
      position: 'SG',
      nameOverride: 'Custom Name',
      overallOverride: 91,
      teamOverride: 'Custom Team',
      variantGroupId: 'group-x',
      variantLabel: '1999',
    });
    const env = makeEnv(
      { 'ov': storedPlayerDoc({ overall: 60 }) },
      { 'ov': overriddenPool }
    );
    await preview(env, [rawRecord({ slug: 'ov', overall: 61 })]); // rating + still below 74, but EXISTING so update still applies
    await apply(env);
    assert.strictEqual(env.writeLog.poolSets.length, 0);
    assert.deepStrictEqual(env.poolDocs.ov, overriddenPool, 'every override field must be byte-identical after apply');
  });

  await test('6. new slug, overall 74 — creates both docs with exact required pool shape', async () => {
    const env = makeEnv({}, {});
    await preview(env, [rawRecord({ slug: 'brand-new', teamType: 'curr', overall: 74, name: 'Brand New' })]);
    const p = env.window.Nba2k27LiveImportView._lastParsed;
    assert.strictEqual(p.newEligible, 1);
    assert.strictEqual(p.newPlayerCreates.length, 1);
    assert.strictEqual(p.newPoolCreates.length, 1);
    await apply(env);
    assert.strictEqual(env.writeLog.playersSets.length, 1);
    assert.strictEqual(env.writeLog.poolSets.length, 1);
    assert.ok(env.playersDocs['brand-new'], 'nba2k_players doc must exist');
    assert.strictEqual(env.playersDocs['brand-new'].overall, 74);
    assert.strictEqual(env.playersDocs['brand-new'].name, 'Brand New');
    const pool = env.poolDocs['brand-new'];
    assert.deepStrictEqual(Object.keys(pool).sort(), ['nba2kRef', 'pool', 'position', 'selectedAt', 'updatedAt'].sort());
    assert.strictEqual(pool.nba2kRef, 'brand-new');
    assert.strictEqual(pool.pool, 'green'); // curr -> green
    assert.strictEqual(pool.position, 'UNASSIGNED');
    assert.strictEqual(typeof pool.selectedAt, 'string');
    assert.strictEqual(typeof pool.updatedAt, 'string');
  });

  await test('6b. pool mapping — allt -> blue, class -> white', async () => {
    const env = makeEnv({}, {});
    await preview(env, [
      rawRecord({ slug: 'allt-guy', teamType: 'allt', overall: 90 }),
      rawRecord({ slug: 'class-guy', teamType: 'class', overall: 90 }),
    ]);
    await apply(env);
    assert.strictEqual(env.poolDocs['allt-guy'].pool, 'blue');
    assert.strictEqual(env.poolDocs['class-guy'].pool, 'white');
  });

  await test('7. new slug, overall 73 — neither doc created', async () => {
    const env = makeEnv({}, {});
    await preview(env, [rawRecord({ slug: 'too-low', overall: 73 })]);
    const p = env.window.Nba2k27LiveImportView._lastParsed;
    assert.strictEqual(p.newEligible, 0);
    assert.strictEqual(p.newSkippedLowOverall, 1);
    assert.strictEqual(p.newPlayerCreates.length, 0);
    assert.strictEqual(p.newPoolCreates.length, 0);
    await apply(env);
    assert.strictEqual(env.playersDocs['too-low'], undefined);
    assert.strictEqual(env.poolDocs['too-low'], undefined);
  });

  await test('8. existing player with no pool doc at all — apply creates nothing in nba2k27_pool', async () => {
    const env = makeEnv({ 'orphanish': storedPlayerDoc({ overall: 96 }) }, {}); // no pool doc for this slug
    await preview(env, [rawRecord({ slug: 'orphanish', overall: 97 })]);
    await apply(env);
    assert.strictEqual(env.writeLog.poolSets.length, 0);
    assert.strictEqual(env.poolDocs['orphanish'], undefined, 'pool doc must remain absent for an existing player');
  });

  await test('9. rerun — same file imported twice produces zero writes the second time', async () => {
    const env = makeEnv({}, {});
    const records = [
      rawRecord({ slug: 'rerun-existing-src', overall: 80 }), // will become existing after run 1
      rawRecord({ slug: 'rerun-new', overall: 90 }),
    ];
    // Seed one "existing" player identical to what run 1 would apply, to
    // also exercise the unchanged-on-rerun path for an existing slug.
    env.playersDocs['rerun-existing-src'] = storedPlayerDoc({ overall: 79, badges: rawRecord().badges });

    await preview(env, records);
    await apply(env);
    const firstRunPlayerSets = env.writeLog.playersSets.length;
    const firstRunPoolSets = env.writeLog.poolSets.length;
    assert.ok(firstRunPlayerSets >= 1 && firstRunPoolSets >= 1, 'first run must have created the new player');

    // Reset the write log by rebuilding preview/apply against the SAME
    // mutated playersDocs/poolDocs (i.e. the state after run 1).
    env.writeLog.playersUpdates.length = 0;
    env.writeLog.playersSets.length = 0;
    env.writeLog.poolSets.length = 0;

    await preview(env, records);
    const p2 = env.window.Nba2k27LiveImportView._lastParsed;
    assert.strictEqual(p2.existingUpdates.length, 0, 'rerun: no existing player should need an update');
    assert.strictEqual(p2.newPlayerCreates.length, 0, 'rerun: the new player from run 1 is no longer new');
    assert.strictEqual(p2.newPoolCreates.length, 0, 'rerun: no new pool doc should be queued');
    await apply(env);
    assert.strictEqual(env.writeLog.playersUpdates.length, 0);
    assert.strictEqual(env.writeLog.playersSets.length, 0);
    assert.strictEqual(env.writeLog.poolSets.length, 0);
  });

  await test('10. duplicate slug across combined files — first occurrence wins, second excluded', async () => {
    const env = makeEnv({}, {});
    await preview(env, [
      rawRecord({ slug: 'dup', name: 'First One', overall: 90, teamType: 'curr' }),
      rawRecord({ slug: 'dup', name: 'Second One', overall: 50, teamType: 'class' }),
    ]);
    const p = env.window.Nba2k27LiveImportView._lastParsed;
    assert.strictEqual(p.duplicateCount, 1);
    assert.strictEqual(p.newPlayerCreates.length, 1);
    await apply(env);
    assert.strictEqual(env.playersDocs.dup.name, 'First One');
    assert.strictEqual(env.playersDocs.dup.overall, 90);
    assert.strictEqual(env.poolDocs.dup.pool, 'green'); // from first record's teamType ('curr'), not the second's
  });

  await test('11. unknown teamType — existing player still updates; new player creates nothing', async () => {
    const env = makeEnv({ 'weird-existing': storedPlayerDoc({ overall: 50, teamType: 'weird' }) }, {});
    await preview(env, [
      rawRecord({ slug: 'weird-existing', teamType: 'weird', overall: 55 }),
      rawRecord({ slug: 'weird-new', teamType: 'weird', overall: 99 }),
    ]);
    const p = env.window.Nba2k27LiveImportView._lastParsed;
    assert.strictEqual(p.existingUpdates.length, 1);
    assert.strictEqual(p.newSkippedUnknownTeamType, 1);
    assert.strictEqual(p.newPlayerCreates.length, 0);
    await apply(env);
    assert.strictEqual(env.playersDocs['weird-existing'].overall, 55);
    assert.strictEqual(env.playersDocs['weird-new'], undefined);
    assert.strictEqual(env.poolDocs['weird-new'], undefined);
  });

  await test('12. 500-op batching — 501 existing updates split into batches of 500 + 1', async () => {
    const players = {};
    const records = [];
    for (let i = 0; i < 501; i++) {
      const slug = `bulk-${i}`;
      players[slug] = storedPlayerDoc({ overall: 60 });
      records.push(rawRecord({ slug, overall: 61 }));
    }
    const env = makeEnv(players, {});
    await preview(env, records);
    assert.strictEqual(env.window.Nba2k27LiveImportView._lastParsed.existingUpdates.length, 501);
    await apply(env);
    const sizes = env.getBatchSizes();
    assert.strictEqual(sizes.length, 2, 'must commit exactly 2 batches for 501 ops');
    assert.strictEqual(sizes[0], 500);
    assert.strictEqual(sizes[1], 1);
  });

  await test('13. preview performs zero writes', async () => {
    const env = makeEnv({}, {});
    await preview(env, [
      rawRecord({ slug: 'preview-only-new', overall: 90 }),
      rawRecord({ slug: 'preview-only-existing', overall: 90 }),
    ]);
    assert.strictEqual(env.writeLog.playersUpdates.length, 0);
    assert.strictEqual(env.writeLog.playersSets.length, 0);
    assert.strictEqual(env.writeLog.poolSets.length, 0);
  });

  await test('14. invalid records (missing required fields) are excluded, not processed', async () => {
    const env = makeEnv({}, {});
    await preview(env, [
      { slug: 'no-name', team: 'T', teamType: 'curr', overall: 90, attributes: attrs() }, // missing name
      { name: 'No Slug', team: 'T', teamType: 'curr', overall: 90, attributes: attrs() }, // missing slug
      rawRecord({ slug: 'good-one', overall: 90 }),
    ]);
    const p = env.window.Nba2k27LiveImportView._lastParsed;
    assert.strictEqual(p.invalidCount, 2);
    assert.strictEqual(p.newPlayerCreates.length, 1);
  });

  console.log(`\n${failures === 0 ? 'All tests passed.' : failures + ' test(s) failed.'}`);
  process.exitCode = failures === 0 ? 0 : 1;
})();
