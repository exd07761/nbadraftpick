'use strict';
/**
 * Phase 10 tests — Bulk Initialize the NBA 2K27 Pool
 * (js/admin/nba2k-database.js: `nba2k27PoolForTeamType`, the White pool
 * addition, and `Nba2k27PoolView._runInitialization`/`_computeInitPreview`).
 *
 * Same vm-sandbox pattern as tests_p7/p8/p9. The fake Firestore here adds
 * a `batch()` implementation (queued `.set()` calls applied on `.commit()`)
 * so the real batched-write / dynamic-chunking code path runs unmodified,
 * plus an optional failure injection to exercise the error-count path.
 *
 * DATASET NOTE: `nba2k-all-players.json` (referenced in the Phase 10 brief
 * and in `js/admin/nba2k-import.js`'s own upload-screen copy) is a file
 * the commissioner uploads through the browser at import time — it is not
 * checked into this repository and was not present in the delivered
 * project, so it cannot be read here. Tests that need "the real ~1,757-
 * player dataset" instead build a synthetic dataset with the documented
 * breakdown (528 Current / 455 All-Time / 774 Classics = 1,757) via
 * `buildDataset()` below, which is dynamically sized (not a hardcoded
 * fixture file) and exercises the exact same code path a real import
 * would. This substitution is called out explicitly per test rather than
 * silently assumed.
 *
 * DOM SCOPE — identical to tests_p8/p9: `querySelector` only resolves
 * `#id` lookups; `querySelectorAll` is a stub returning `[]`.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const srcPath = path.join(__dirname, '..', 'js', 'admin', 'nba2k-database.js');
const src = fs.readFileSync(srcPath, 'utf8');

// ─── Minimal fake DOM (same shape as tests_p8/p9's FakeElement) ─────────
class FakeClassList {
  constructor(el) { this.el = el; }
  add(c) { if (!this.el._classes.includes(c)) this.el._classes.push(c); }
  remove(c) { this.el._classes = this.el._classes.filter(x => x !== c); }
  contains(c) { return this.el._classes.includes(c); }
}
class FakeElement {
  constructor(id, registry) {
    this.id = id || '';
    this._classes = [];
    this._html = '';
    this._registry = registry || new Map();
    if (id) this._registry.set(id, this);
    this.classList = new FakeClassList(this);
    this.onclick = null;
    this.oninput = null;
    this.onchange = null;
    this.disabled = false;
  }
  set innerHTML(html) {
    this._html = html;
    const re = /id="([^"]+)"/g;
    let m;
    while ((m = re.exec(html))) {
      if (!this._registry.has(m[1])) new FakeElement(m[1], this._registry);
    }
  }
  get innerHTML() { return this._html; }
  querySelector(sel) {
    const idMatch = /^#([\w-]+)$/.exec(sel.trim());
    if (idMatch) return this._registry.get(idMatch[1]) || null;
    return null;
  }
  querySelectorAll() { return []; }
  addEventListener() {}
}

function makeSandbox(opts = {}) {
  const firestoreWrites = [];
  const nba2kPlayersDocs = {};
  const nba2k27Docs = {};
  const leagueMainWrites = [];
  const addPlayerCalls = [];
  let batchCallCount = 0;
  const failBatchOnCall = opts.failBatchOnCall || null; // 1-based call index to reject, or null

  function applyWrite(collectionName, id, action, data) {
    if (collectionName === 'league') leagueMainWrites.push({ id, action, data });
    if (collectionName === 'nba2k27_pool') {
      if (action === 'delete') delete nba2k27Docs[id];
      else nba2k27Docs[id] = data;
    }
    if (collectionName === 'nba2k_players') {
      if (action === 'delete') delete nba2kPlayersDocs[id];
      else if (action === 'update') nba2kPlayersDocs[id] = Object.assign({}, nba2kPlayersDocs[id], data);
      else nba2kPlayersDocs[id] = data;
    }
    firestoreWrites.push({ collection: collectionName, id, action, data });
  }

  function makeDocRef(collectionName, id) {
    return {
      id,
      set: (data) => { applyWrite(collectionName, id, 'set', data); return Promise.resolve(); },
      update: (data) => { applyWrite(collectionName, id, 'update', data); return Promise.resolve(); },
      delete: () => { applyWrite(collectionName, id, 'delete', null); return Promise.resolve(); },
    };
  }

  const sandbox = {
    console,
    document: { body: { contains: () => true } },
    escapeHtml: (s) => String(s),
    showToast: () => {},
    normalizePlayerName: (n) => String(n).trim().toLowerCase(),
    AuthBoundary: { requireAuth: () => {} },
    LeagueData: { getAllPlayers: () => [] },
    AdminActions: {
      addPlayer: (...args) => { addPlayerCalls.push(args); return { id: 'pl_fake' }; },
    },
    firebase: {
      firestore: () => ({
        collection: (name) => ({
          get: () => {
            if (name === 'nba2k_players') {
              return Promise.resolve({ docs: Object.keys(nba2kPlayersDocs).map(id => ({ id, data: () => nba2kPlayersDocs[id] })) });
            }
            if (name === 'nba2k27_pool') {
              return Promise.resolve({ docs: Object.keys(nba2k27Docs).map(id => ({ id, data: () => nba2k27Docs[id] })) });
            }
            return Promise.resolve({ docs: [] });
          },
          doc: (id) => makeDocRef(name, id),
        }),
        batch: () => {
          const ops = [];
          return {
            set: (ref, data) => { ops.push({ ref, data }); },
            commit: () => {
              batchCallCount++;
              if (failBatchOnCall && batchCallCount === failBatchOnCall) {
                return Promise.reject(Object.assign(new Error('simulated batch failure'), { code: 'unavailable' }));
              }
              for (const op of ops) op.ref.set(op.data);
              return Promise.resolve();
            },
          };
        },
      }),
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'nba2k-database.js' });
  vm.runInContext(
    'this.Nba2kDatabaseView = Nba2kDatabaseView; this.Nba2k27PoolView = Nba2k27PoolView; ' +
    'this.Nba2k27PoolValidator = Nba2k27PoolValidator; this.nba2kPoolForTeamType = nba2kPoolForTeamType; ' +
    'this.nba2k27PoolForTeamType = nba2k27PoolForTeamType; this.nba2k27PoolValueValid = nba2k27PoolValueValid; ' +
    'this.nba2k27PoolLabel = nba2k27PoolLabel; this.normalizeNba2kPositions = normalizeNba2kPositions; ' +
    'this.NBA2K_VALID_POSITIONS = NBA2K_VALID_POSITIONS;',
    sandbox,
    { filename: 'export.js' }
  );
  return {
    sandbox, firestoreWrites, nba2kPlayersDocs, nba2k27Docs, leagueMainWrites, addPlayerCalls,
    getBatchCallCount: () => batchCallCount,
  };
}

let pass = 0, fail = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { pass++; console.log(`  ok - ${name}`); })
    .catch(e => { fail++; console.log(`  FAIL - ${name}`); console.log(`         ${e.stack || e.message}`); });
}
function assertEqual(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || 'assertion failed'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function assertTruthy(actual, msg) {
  if (!actual) throw new Error(msg || `expected truthy value, got ${JSON.stringify(actual)}`);
}
function assertDeepEqual(actual, expected, msg) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg || 'deep-equal assertion failed'}: expected ${b}, got ${a}`);
}

// Dynamically-sized synthetic source dataset — NOT the real
// nba2k-all-players.json (see file header). Defaults to the documented
// 528/455/774 breakdown (total 1,757) but every count is a parameter, so
// the same builder also produces small fixtures and >500-record datasets
// for the batch-chunking test.
function buildDataset({ curr = 528, allt = 455, classics = 774, unknown = 0, extraFields = {} } = {}) {
  const docs = {};
  for (let i = 0; i < curr; i++) {
    docs[`curr-${i}`] = Object.assign({ name: `Current ${i}`, team: 'Team A', teamType: 'curr', overall: 80, positions: ['PG'] }, extraFields);
  }
  for (let i = 0; i < allt; i++) {
    docs[`allt-${i}`] = Object.assign({ name: `AllTime ${i}`, team: 'Team B', teamType: 'allt', overall: 85, positions: ['C'] }, extraFields);
  }
  for (let i = 0; i < classics; i++) {
    docs[`class-${i}`] = Object.assign({ name: `Classic ${i}`, team: 'Team C', teamType: 'class', overall: 90, positions: ['SG'] }, extraFields);
  }
  for (let i = 0; i < unknown; i++) {
    docs[`unk-${i}`] = Object.assign({ name: `Unknown ${i}`, team: 'Team D', teamType: 'mystery', overall: 70, positions: ['SF'] }, extraFields);
  }
  return docs;
}

console.log('Phase 10 tests');

// ── Mapping ───────────────────────────────────────────────────────────
(async () => {
  const { sandbox } = makeSandbox();
  await check('1. curr -> green', () => assertEqual(sandbox.nba2k27PoolForTeamType('curr'), 'green'));
  await check('2. allt -> blue', () => assertEqual(sandbox.nba2k27PoolForTeamType('allt'), 'blue'));
  await check('3. class -> white', () => assertEqual(sandbox.nba2k27PoolForTeamType('class'), 'white'));
  await check('4. unknown teamType -> null (skipped, never guessed)', () => {
    assertEqual(sandbox.nba2k27PoolForTeamType('mystery'), null);
  });
  await check('5. missing teamType -> null (skipped, never guessed)', () => {
    assertEqual(sandbox.nba2k27PoolForTeamType(undefined), null);
  });
  await check('S4 Draft Pool mapping (nba2kPoolForTeamType) is unchanged by Phase 10', () => {
    assertEqual(sandbox.nba2kPoolForTeamType('curr'), 'green');
    assertEqual(sandbox.nba2kPoolForTeamType('class'), 'blue'); // still Blue for the Draft Pool
    assertEqual(sandbox.nba2kPoolForTeamType('allt'), 'blue');
  });
})();

// ── Full realistic-scale run: 528/455/774, unknown skipped ──────────────
(async () => {
  const dataset = buildDataset({ unknown: 3 }); // 528+455+774+3 = 1,760 total source docs
  const { sandbox, nba2kPlayersDocs, nba2k27Docs, leagueMainWrites, addPlayerCalls, firestoreWrites, getBatchCallCount } =
    makeSandbox();
  Object.assign(nba2kPlayersDocs, dataset);
  const view = sandbox.Nba2k27PoolView;
  const container = new FakeElement('root');
  await view.render(container);

  await check('7. expected dataset breakdown detected dynamically (528/455/774)', () => {
    const preview = view._computeInitPreview();
    assertEqual(preview.total, 1760);
    assertEqual(preview.green, 528);
    assertEqual(preview.blue, 455);
    assertEqual(preview.white, 774);
    assertEqual(preview.unknown, 3);
  });

  await check('6. all real (synthetic, see file header) source records are processed', async () => {
    view._showInitConfirm(container);
    await view._runInitialization(container);
    const r = view._initResult;
    assertEqual(r.created, 1757, 'every determinable-pool record created');
    assertEqual(r.skippedUnknown, 3, 'the 3 unknown-teamType records skipped, not guessed');
    assertEqual(r.errors, 0);
  });

  await check('8. first initialization creates all valid selections', () => {
    assertEqual(Object.keys(nba2k27Docs).length, 1757);
  });

  await check('nba2k27_pool green/blue/white counts match the 528/455/774 breakdown', () => {
    const counts = { green: 0, blue: 0, white: 0 };
    for (const doc of Object.values(nba2k27Docs)) counts[doc.pool] = (counts[doc.pool] || 0) + 1;
    assertEqual(counts.green, 528);
    assertEqual(counts.blue, 455);
    assertEqual(counts.white, 774);
  });

  await check('26. batch processing chunks dynamically at the Firestore 500-op limit', () => {
    // 1,757 writes / 500 per batch = 4 batch.commit() calls (500*3 + 257).
    assertEqual(getBatchCallCount(), 4);
  });

  await check('14. zero league/main writes', () => assertEqual(leagueMainWrites.length, 0));
  await check('15. zero AdminActions.addPlayer() calls', () => assertEqual(addPlayerCalls.length, 0));
  await check('16. zero nba2k_players writes', () => {
    assertEqual(firestoreWrites.filter(w => w.collection === 'nba2k_players').length, 0);
  });
  await check('17. no pl_* IDs created anywhere in nba2k27_pool', () => {
    assertTruthy(Object.keys(nba2k27Docs).every(id => !id.startsWith('pl_')));
  });
  await check('29. nba2k27_pool documents contain only the intended fields', () => {
    for (const doc of Object.values(nba2k27Docs)) {
      assertDeepEqual(Object.keys(doc).sort(), ['nba2kRef', 'pool', 'selectedAt', 'updatedAt'].sort());
    }
  });

  // ── Idempotent second run ──────────────────────────────────────────
  await check('9. second initialization is idempotent (no new docs, no changed pools)', async () => {
    const beforeKeys = Object.keys(nba2k27Docs).length;
    const beforeBatchCalls = getBatchCallCount();
    await view._runInitialization(container);
    const r = view._initResult;
    assertEqual(r.created, 0);
    assertEqual(r.corrected, 0);
    assertEqual(r.alreadyCorrect, 1757);
    assertEqual(Object.keys(nba2k27Docs).length, beforeKeys, '13. no duplicate documents created');
    // Every record was already correct, so the write plan was empty —
    // zero NEW batch.commit() calls should have been issued at all.
    assertEqual(getBatchCallCount(), beforeBatchCalls, '27. re-running performs no redundant writes');
  });

  await check('28. source player attributes/positions remain untouched by initialization', () => {
    assertDeepEqual(nba2kPlayersDocs['curr-0'].positions, ['PG']);
    assertEqual(nba2kPlayersDocs['curr-0'].overall, 80);
  });
})();

// ── Corrections + orphan preservation ───────────────────────────────────
(async () => {
  const { sandbox, nba2kPlayersDocs, nba2k27Docs } = makeSandbox();
  Object.assign(nba2kPlayersDocs, {
    'already-right': { name: 'A', team: 'T', teamType: 'curr', overall: 80, positions: ['PG'] },
    'needs-fix':     { name: 'B', team: 'T', teamType: 'class', overall: 80, positions: ['SG'] }, // should be white
    'brand-new':     { name: 'C', team: 'T', teamType: 'allt', overall: 80, positions: ['C'] },
  });
  Object.assign(nba2k27Docs, {
    'already-right': { nba2kRef: 'already-right', pool: 'green', selectedAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z' },
    'needs-fix': { nba2kRef: 'needs-fix', pool: 'blue', selectedAt: '2024-02-02T00:00:00.000Z', updatedAt: '2024-02-02T00:00:00.000Z' }, // pre-Phase-10 value
    'phantom-slug': { nba2kRef: 'phantom-slug', pool: 'green', selectedAt: 'x', updatedAt: 'x' }, // orphan — no matching source player
  });
  const view = sandbox.Nba2k27PoolView;
  const container = new FakeElement('root');
  await view.render(container);
  view._showInitConfirm(container);
  await view._runInitialization(container);
  const r = view._initResult;

  await check('10. existing correct selections are not rewritten unnecessarily', () => {
    assertEqual(r.alreadyCorrect, 1);
    assertEqual(nba2k27Docs['already-right'].selectedAt, '2024-01-01T00:00:00.000Z', 'untouched, original selectedAt preserved');
  });

  await check('11. existing incorrect pool selections are corrected', () => {
    assertEqual(r.corrected, 1);
    assertEqual(nba2k27Docs['needs-fix'].pool, 'white');
    assertEqual(nba2k27Docs['needs-fix'].selectedAt, '2024-02-02T00:00:00.000Z', 'original selectedAt kept on correction, only updatedAt changes');
  });

  await check('brand-new player is created', () => {
    assertEqual(r.created, 1);
    assertEqual(nba2k27Docs['brand-new'].pool, 'blue');
  });

  await check('12. orphaned pool document is not deleted or modified', () => {
    assertTruthy(nba2k27Docs['phantom-slug'], 'orphan still present');
    assertEqual(nba2k27Docs['phantom-slug'].pool, 'green', 'orphan content untouched — never guessed at or rewritten');
  });

  await check('18. positions are never modified by initialization', () => {
    assertDeepEqual(nba2kPlayersDocs['needs-fix'].positions, ['SG']);
  });
})();

// ── Missing positions never block initialization ────────────────────────
(async () => {
  const { sandbox, nba2kPlayersDocs, nba2k27Docs } = makeSandbox();
  Object.assign(nba2kPlayersDocs, {
    'no-positions': { name: 'No Pos', team: 'T', teamType: 'curr', overall: 75 }, // positions field entirely absent
    'empty-positions': { name: 'Empty Pos', team: 'T', teamType: 'allt', overall: 75, positions: [] },
  });
  const view = sandbox.Nba2k27PoolView;
  const container = new FakeElement('root');
  await view.render(container);
  await view._runInitialization(container);

  await check('19. missing/empty positions do not prevent initialization', () => {
    assertTruthy(nba2k27Docs['no-positions'], 'created despite missing positions');
    assertTruthy(nba2k27Docs['empty-positions'], 'created despite empty positions');
    assertEqual(nba2k27Docs['no-positions'].pool, 'green');
    assertEqual(nba2k27Docs['empty-positions'].pool, 'blue');
  });
})();

// ── Error accounting (partial-batch failure) ────────────────────────────
(async () => {
  const dataset = buildDataset({ curr: 600, allt: 0, classics: 0 }); // 600 -> 2 batches of 500/100
  const { sandbox, nba2kPlayersDocs, nba2k27Docs } = makeSandbox({ failBatchOnCall: 2 });
  Object.assign(nba2kPlayersDocs, dataset);
  const view = sandbox.Nba2k27PoolView;
  const container = new FakeElement('root');
  await view.render(container);
  await view._runInitialization(container);

  await check('a failed batch is accounted for in the error count, not silently dropped', () => {
    const r = view._initResult;
    assertEqual(r.created, 500, 'first batch succeeded');
    assertEqual(r.errors, 100, 'second (failed) batch counted as errors, not silently lost');
    assertTruthy(r.errorMessage, 'an error message is surfaced');
  });
  await check('the successful first batch is still reflected in the cache/collection', () => {
    assertEqual(Object.keys(nba2k27Docs).length, 500);
  });
})();

// ── Phase 8 / Phase 9 integration with White ────────────────────────────
(async () => {
  const { sandbox, nba2kPlayersDocs, nba2k27Docs } = makeSandbox();
  Object.assign(nba2kPlayersDocs, {
    'g1': { name: 'G', team: 'T', teamType: 'curr', overall: 80, positions: ['PG'] },
    'b1': { name: 'B', team: 'T', teamType: 'allt', overall: 80, positions: ['C'] },
    'w1': { name: 'W', team: 'T', teamType: 'class', overall: 80, positions: ['SG'] },
  });
  Object.assign(nba2k27Docs, {
    g1: { nba2kRef: 'g1', pool: 'green' },
    b1: { nba2kRef: 'b1', pool: 'blue' },
    w1: { nba2kRef: 'w1', pool: 'white' },
  });
  const view = sandbox.Nba2k27PoolView;
  const container = new FakeElement('root');
  await view.render(container);

  await check('22. Phase 8 pool counts include White', () => {
    const rows = view._buildRows();
    const counts = view._computeCounts(rows, sandbox.Nba2kDatabaseView._players.length);
    assertEqual(counts.green, 1);
    assertEqual(counts.blue, 1);
    assertEqual(counts.white, 1);
  });

  await check('Phase 8 summary markup renders the White stat', () => {
    assertTruthy(container.innerHTML.includes('⚪ White'));
  });

  await check('23. Phase 9 validator recognizes White as a valid stored pool -> READY', () => {
    const row = view._buildRows().find(r => r.slug === 'w1');
    const c = sandbox.Nba2k27PoolValidator.classify(row);
    assertTruthy(row.poolValid, 'white recognized as a structurally valid stored value');
    assertTruthy(c.ready);
  });

  await check('24. invalid stored pool is still detected', () => {
    const row = view._buildRows().find(r => r.slug === 'g1');
    row.entry.pool = 'purple';
    row.poolValue = 'purple';
    row.poolValid = sandbox.nba2k27PoolValueValid('purple');
    const c = sandbox.Nba2k27PoolValidator.classify(row);
    assertTruthy(c.issues.invalidStoredPool);
  });

  await check('25. pool mismatch is still detected (Classics stored Blue instead of White)', () => {
    const row = { slug: 'w1', entry: {}, player: nba2kPlayersDocs.w1, orphan: false, poolValue: 'blue', poolValid: true, category: 'class' };
    const c = sandbox.Nba2k27PoolValidator.classify(row);
    assertTruthy(c.issues.poolMismatch);
    assertEqual(c.expectedPool, 'white');
  });
})();

// ── Phase 6/7 spot checks (full suites re-run below) ────────────────────
(async () => {
  const { sandbox, nba2kPlayersDocs, nba2k27Docs, firestoreWrites } = makeSandbox();

  await check('20. Phase 6 position whitelist/normalization unchanged', () => {
    assertDeepEqual(sandbox.NBA2K_VALID_POSITIONS, ['PG', 'SG', 'SF', 'PF', 'C']);
    assertDeepEqual(sandbox.normalizeNba2kPositions(['C', 'PG', 'C']), ['PG', 'C']);
  });

  await check('21. Phase 7 individual add uses the new Phase 10 mapping (class -> white)', async () => {
    Object.assign(nba2kPlayersDocs, { 'classic-1': { name: 'Classic One', team: 'T', teamType: 'class', overall: 88, positions: ['SG'] } });
    const view = sandbox.Nba2kDatabaseView;
    view._players = Object.keys(nba2kPlayersDocs).map(id => ({ id, ...nba2kPlayersDocs[id] }));
    view._pool27 = {};
    view._openDetail = () => {};
    view._refreshList = () => {};
    const container = new FakeElement('root');
    const mount = new FakeElement('nba2kDetailMount');
    const player = view._players.find(p => p.id === 'classic-1');
    mount.innerHTML = view._render2k27Section(player);
    view._bind2k27Events(container, mount, player);
    mount.querySelector('#nba2k27AddBtn').onclick();
    await mount.querySelector('#nba2k27ConfirmAddBtn').onclick();
    assertEqual(nba2k27Docs['classic-1'].pool, 'white');
    assertTruthy(firestoreWrites.every(w => w.collection === 'nba2k27_pool'), 'Phase 7 add still writes only nba2k27_pool');
  });
})();

// ── 30. Full regression: Phase 6/7/8/9 suites re-run unmodified ─────────
(async () => {
  const suites = [
    ['tests_p7/p7_test.js', path.join(__dirname, '..', 'tests_p7', 'p7_test.js')],
    ['tests_p8/p8_test.js', path.join(__dirname, '..', 'tests_p8', 'p8_test.js')],
    ['tests_p9/p9_test.js', path.join(__dirname, '..', 'tests_p9', 'p9_test.js')],
  ];
  for (const [label, file] of suites) {
    await check(`30. regression suite ${label} passes`, () => {
      let output;
      try {
        output = execFileSync('node', [file], { encoding: 'utf8' });
      } catch (err) {
        throw new Error(`${label} exited non-zero:\n${err.stdout || err.message}`);
      }
      assertTruthy(!/FAIL/.test(output), `${label} reported a FAIL:\n${output}`);
    });
  }
})();

setTimeout(() => {
  console.log(`\nPhase 10 Tests:\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
}, 3000);
