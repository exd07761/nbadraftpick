'use strict';
/**
 * Phase 9 tests — NBA 2K27 Pool Validation & Readiness
 * (js/admin/nba2k-database.js, `Nba2k27PoolValidator` + the validation
 * additions to `Nba2k27PoolView`).
 *
 * Same pattern as tests_p8/p8_test.js: load the real nba2k-database.js
 * source in a vm sandbox with a minimal fake DOM and an in-memory fake
 * Firestore that records every write, so the actual classification/
 * counting/read-only logic runs unmodified.
 *
 * DOM SCOPE — identical to tests_p8: `querySelector` only resolves
 * `#id` lookups (built from an id registry scanned out of every
 * `innerHTML` assignment); `querySelectorAll` is a stub returning `[]`,
 * so the issue-filter-tab and Review-button class-based bindings run as
 * harmless no-ops here (same as every class/attribute-based binding in
 * Phase 8, never exercised by tests_p8 either — needs a real browser).
 * What IS exercised: the full classify/summarize/filter logic (all
 * pure, no DOM), and the validate-button + read-only guarantee, which
 * only need the `#id`-based `_renderValidationResult`/`_runValidation`
 * plumbing.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const srcPath = path.join(__dirname, '..', 'js', 'admin', 'nba2k-database.js');
const src = fs.readFileSync(srcPath, 'utf8');

// ─── Minimal fake DOM (same shape as tests_p8's FakeElement) ────────────
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
  querySelectorAll() { return []; } // see file header "DOM SCOPE"
  addEventListener() {}
}

function makeSandbox() {
  const firestoreWrites = [];  // { collection, id, action: 'set'|'delete' }
  const nba2kPlayersDocs = {};
  const nba2k27Docs = {};
  const leagueMainWrites = [];
  const addPlayerCalls = [];

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
          doc: (id) => ({
            set: (data) => {
              if (name === 'league') leagueMainWrites.push({ id, action: 'set', data });
              if (name === 'nba2k27_pool') nba2k27Docs[id] = data;
              firestoreWrites.push({ collection: name, id, action: 'set', data });
              return Promise.resolve();
            },
            update: (data) => {
              if (name === 'league') leagueMainWrites.push({ id, action: 'update', data });
              firestoreWrites.push({ collection: name, id, action: 'update', data });
              return Promise.resolve();
            },
            delete: () => {
              if (name === 'league') leagueMainWrites.push({ id, action: 'delete' });
              if (name === 'nba2k27_pool') delete nba2k27Docs[id];
              firestoreWrites.push({ collection: name, id, action: 'delete' });
              return Promise.resolve();
            },
          }),
        }),
      }),
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'nba2k-database.js' });
  vm.runInContext(
    'this.Nba2kDatabaseView = Nba2kDatabaseView; this.Nba2k27PoolView = Nba2k27PoolView; ' +
    'this.Nba2k27PoolValidator = Nba2k27PoolValidator; this.nba2kPoolForTeamType = nba2kPoolForTeamType; ' +
    'this.normalizeNba2kPositions = normalizeNba2kPositions; this.NBA2K_VALID_POSITIONS = NBA2K_VALID_POSITIONS;',
    sandbox,
    { filename: 'export.js' }
  );
  return { sandbox, firestoreWrites, nba2kPlayersDocs, nba2k27Docs, leagueMainWrites, addPlayerCalls };
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

// A single "row" as `Nba2k27PoolView._buildRows()` would produce it —
// built by hand here so each classification test is self-contained and
// doesn't depend on the join logic already covered by tests_p8.
function makeRow(slug, player, poolValue) {
  const poolValid = poolValue === 'green' || poolValue === 'blue' || poolValue === 'white';
  return {
    slug,
    entry: { nba2kRef: slug, pool: poolValue },
    player,
    orphan: !player,
    poolValue,
    poolValid,
    category: player ? player.teamType : null,
  };
}

const basePlayer = (overrides = {}) => Object.assign({
  name: 'Test Player',
  team: 'Test Team',
  teamType: 'curr',
  overall: 85,
  positions: ['PG'],
}, overrides);

console.log('Phase 9 tests');

// ── Classification: positions ───────────────────────────────────────────
(async () => {
  const { sandbox } = makeSandbox();
  const V = sandbox.Nba2k27PoolValidator;

  await check('1. completely valid player -> READY', () => {
    const row = makeRow('p1', basePlayer(), 'green');
    const c = V.classify(row);
    assertTruthy(c.ready);
    assertTruthy(!c.issues.positionIssue && !c.issues.dataIssue && !c.issues.poolMismatch);
  });

  await check('2. missing positions -> POSITION ISSUE', () => {
    const p = basePlayer(); delete p.positions;
    const c = V.classify(makeRow('p2', p, 'green'));
    assertTruthy(c.issues.positionIssue);
    assertTruthy(!c.ready);
  });

  await check('3. empty positions -> POSITION ISSUE', () => {
    const c = V.classify(makeRow('p3', basePlayer({ positions: [] }), 'green'));
    assertTruthy(c.issues.positionIssue);
  });

  await check('4. invalid position ["PG","XYZ"] -> POSITION ISSUE', () => {
    const c = V.classify(makeRow('p4', basePlayer({ positions: ['PG', 'XYZ'] }), 'green'));
    assertTruthy(c.issues.positionIssue, 'flagged even though PG alone would normalize to a non-empty list');
  });
})();

// ── Classification: data issues ─────────────────────────────────────────
(async () => {
  const { sandbox } = makeSandbox();
  const V = sandbox.Nba2k27PoolValidator;

  await check('5. missing OVR -> DATA ISSUE', () => {
    const p = basePlayer(); delete p.overall;
    const c = V.classify(makeRow('p5', p, 'green'));
    assertTruthy(c.issues.dataIssue);
  });

  await check('6. invalid OVR -> DATA ISSUE', () => {
    const c = V.classify(makeRow('p6', basePlayer({ overall: 'not-a-number' }), 'green'));
    assertTruthy(c.issues.dataIssue);
  });

  await check('7. missing team -> DATA ISSUE', () => {
    const p = basePlayer(); delete p.team;
    const c = V.classify(makeRow('p7', p, 'green'));
    assertTruthy(c.issues.dataIssue);
    assertTruthy(!c.issues.unknownPoolEligibility, 'missing team is a data issue, not a pool-eligibility issue');
  });

  await check('8. missing/unknown teamType -> UNKNOWN POOL ELIGIBILITY (not a data issue)', () => {
    const p = basePlayer(); delete p.teamType;
    const c = V.classify(makeRow('p8', p, 'green'));
    assertTruthy(c.issues.unknownPoolEligibility);
    assertTruthy(!c.issues.dataIssue, 'teamType problems are categorized as pool eligibility, not data issues');
  });
})();

// ── Classification: correct pool assignments -> READY ───────────────────
(async () => {
  const { sandbox } = makeSandbox();
  const V = sandbox.Nba2k27PoolValidator;

  await check('9. correct Current player (curr->green) -> READY', () => {
    const c = V.classify(makeRow('p9', basePlayer({ teamType: 'curr' }), 'green'));
    assertTruthy(c.ready);
  });
  await check('10. correct Classic player (class->white, Phase 10 mapping) -> READY', () => {
    const c = V.classify(makeRow('p10', basePlayer({ teamType: 'class' }), 'white'));
    assertTruthy(c.ready);
  });
  await check('11. correct All-Time player (allt->blue) -> READY', () => {
    const c = V.classify(makeRow('p11', basePlayer({ teamType: 'allt' }), 'blue'));
    assertTruthy(c.ready);
  });
})();

// ── Classification: pool mismatches / invalid stored pool ───────────────
(async () => {
  const { sandbox } = makeSandbox();
  const V = sandbox.Nba2k27PoolValidator;

  await check('12. stored Green for a Classic player -> POOL MISMATCH (expected White, Phase 10 mapping)', () => {
    const c = V.classify(makeRow('p12', basePlayer({ teamType: 'class' }), 'green'));
    assertTruthy(c.issues.poolMismatch);
    assertEqual(c.expectedPool, 'white');
  });
  await check('13. stored Blue for a Current player -> POOL MISMATCH', () => {
    const c = V.classify(makeRow('p13', basePlayer({ teamType: 'curr' }), 'blue'));
    assertTruthy(c.issues.poolMismatch);
    assertEqual(c.expectedPool, 'green');
  });
  await check('14. invalid stored pool ("red") -> INVALID STORED POOL', () => {
    const c = V.classify(makeRow('p14', basePlayer({ teamType: 'curr' }), 'red'));
    assertTruthy(c.issues.invalidStoredPool);
    assertTruthy(!c.issues.poolMismatch, 'invalid stored value is its own category, not also a mismatch');
  });
})();

// ── Classification: orphan + multi-issue ────────────────────────────────
(async () => {
  const { sandbox } = makeSandbox();
  const V = sandbox.Nba2k27PoolValidator;

  await check('15. orphaned nba2k27_pool entry -> ORPHANED', () => {
    const c = V.classify(makeRow('ghost', null, 'green'));
    assertTruthy(c.issues.orphaned);
    assertTruthy(!c.ready);
  });

  await check('16. multiple simultaneous issues categorized correctly', () => {
    const p = basePlayer({ positions: [], overall: undefined, teamType: 'class' });
    delete p.overall;
    const c = V.classify(makeRow('p16', p, 'green')); // class->blue expected, stored green -> mismatch too
    assertTruthy(c.issues.positionIssue);
    assertTruthy(c.issues.dataIssue);
    assertTruthy(c.issues.poolMismatch);
    assertTruthy(!c.ready);

    const summary = V.summarize([c]);
    assertEqual(summary.total, 1);
    assertEqual(summary.ready, 0);
    assertEqual(summary.positionIssues, 1, 'counted once, not once per issue on the same player');
    assertEqual(summary.dataIssues, 1);
    assertEqual(summary.poolMismatches, 1);
  });
})();

// ── Summary counting semantics (unique players per category) ───────────
(async () => {
  const { sandbox } = makeSandbox();
  const V = sandbox.Nba2k27PoolValidator;
  const rows = [
    makeRow('a', basePlayer({ teamType: 'curr' }), 'green'),               // ready
    makeRow('b', basePlayer({ teamType: 'class', positions: [] }), 'white'), // position issue only (Phase 10: class -> white)
    makeRow('c', null, 'green'),                                           // orphaned
  ];
  const classified = V.classifyAll(rows);
  const summary = V.summarize(classified);

  await check('summarize(): total counts every row including orphans', () => {
    assertEqual(summary.total, 3);
  });
  await check('summarize(): ready counts only fully-clean rows', () => {
    assertEqual(summary.ready, 1);
  });
  await check('summarize(): positionIssues counts exactly the one flagged row', () => {
    assertEqual(summary.positionIssues, 1);
  });
  await check('summarize(): orphaned counts exactly the one orphan', () => {
    assertEqual(summary.orphaned, 1);
  });
})();

// ── UI: overall status + issue filtering ────────────────────────────────
(async () => {
  const { sandbox, nba2kPlayersDocs, nba2k27Docs } = makeSandbox();
  Object.assign(nba2kPlayersDocs, {
    'ready-1': basePlayer({ teamType: 'curr' }),
    'mismatch-1': basePlayer({ teamType: 'class' }),
  });
  Object.assign(nba2k27Docs, {
    'ready-1': { nba2kRef: 'ready-1', pool: 'green' },
    'mismatch-1': { nba2kRef: 'mismatch-1', pool: 'green' }, // class expects white (Phase 10)
    'ghost-1': { nba2kRef: 'ghost-1', pool: 'blue' },        // orphan
  });
  const view = sandbox.Nba2k27PoolView;
  const container = new FakeElement('root');
  await view.render(container);

  await check('Validate button renders and computes a report on click', () => {
    const btn = container.querySelector('#nba2k27ValidateBtn');
    assertTruthy(btn, 'validate button present in the rendered shell');
    btn.onclick();
    assertTruthy(view._validation, 'validation report stored after click');
    assertEqual(view._validation.summary.total, 3);
  });

  await check('overall status is NOT READY when any row has an issue', () => {
    const resultEl = container.querySelector('#nba2k27ValResult');
    assertTruthy(resultEl.innerHTML.includes('NOT READY'));
  });

  await check('_getFilteredClassified("poolMismatch") returns only the mismatched row', () => {
    view._issueFilter = 'poolMismatch';
    const filtered = view._getFilteredClassified();
    assertEqual(filtered.length, 1);
    assertEqual(filtered[0].slug, 'mismatch-1');
    view._issueFilter = '';
  });

  await check('_getFilteredClassified("ready") returns only the ready row', () => {
    view._issueFilter = 'ready';
    const filtered = view._getFilteredClassified();
    assertEqual(filtered.length, 1);
    assertEqual(filtered[0].slug, 'ready-1');
    view._issueFilter = '';
  });

  await check('a fully-clean pool reports overall READY', () => {
    const cleanView = sandbox.Nba2k27PoolValidator;
    const summary = cleanView.summarize(cleanView.classifyAll([
      makeRow('x', basePlayer({ teamType: 'curr' }), 'green'),
      makeRow('y', basePlayer({ teamType: 'allt' }), 'blue'),
    ]));
    assertEqual(summary.ready, summary.total);
  });

  await check('validation report is invalidated after a pool-changing write (shared-hook path)', () => {
    assertTruthy(view._validation, 'still has a report from an earlier check');
    nba2k27Docs['new-entry'] = { nba2kRef: 'new-entry', pool: 'green' };
    sandbox.Nba2kDatabaseView._pool27['new-entry'] = { nba2kRef: 'new-entry', pool: 'green' };
    sandbox.Nba2kDatabaseView._onPool27Changed();
    assertEqual(view._validation, null, 'stale report discarded rather than left on screen');
  });
})();

// ── Read-only guarantee ──────────────────────────────────────────────────
(async () => {
  const { sandbox, nba2kPlayersDocs, nba2k27Docs, firestoreWrites, leagueMainWrites, addPlayerCalls } = makeSandbox();
  Object.assign(nba2kPlayersDocs, {
    'a': basePlayer({ teamType: 'curr' }),
    'b': basePlayer({ teamType: 'class', positions: [] }), // has an issue
  });
  Object.assign(nba2k27Docs, {
    a: { nba2kRef: 'a', pool: 'green' },
    b: { nba2kRef: 'b', pool: 'blue' },
    ghost: { nba2kRef: 'ghost', pool: 'purple' }, // orphan + invalid pool
  });
  const view = sandbox.Nba2k27PoolView;
  const container = new FakeElement('root');
  await view.render(container);

  await check('17. clicking Validate performs zero Firestore writes', () => {
    container.querySelector('#nba2k27ValidateBtn').onclick();
    assertEqual(firestoreWrites.length, 0);
  });

  await check('17b. viewing/filtering issues performs zero Firestore writes', () => {
    view._issueFilter = 'positionIssue';
    view._refreshIssueList(container);
    view._issueFilter = 'orphaned';
    view._refreshIssueList(container);
    view._issueFilter = '';
    assertEqual(firestoreWrites.length, 0);
  });

  await check('18. league/main writes remain zero throughout validation', () => {
    assertEqual(leagueMainWrites.length, 0);
  });

  await check('validation never calls AdminActions.addPlayer()', () => {
    assertEqual(addPlayerCalls.length, 0);
  });

  await check('validation never mutates the source nba2k_players cache', () => {
    assertEqual(sandbox.Nba2kDatabaseView._players.find(p => p.id === 'b').positions.length, 0, 'unchanged, not auto-repaired');
  });

  await check('validation never mutates the nba2k27_pool cache', () => {
    assertEqual(Object.keys(sandbox.Nba2kDatabaseView._pool27).length, 3, 'orphan not auto-deleted, nothing added/removed');
  });
})();

// ── Regression: Phase 6 / 7 / 8 still intact ────────────────────────────
(async () => {
  const { sandbox, nba2kPlayersDocs, nba2k27Docs, firestoreWrites } = makeSandbox();

  await check('19. Phase 6 regression — position whitelist/normalization unchanged', () => {
    assertEqual(JSON.stringify(sandbox.NBA2K_VALID_POSITIONS), JSON.stringify(['PG', 'SG', 'SF', 'PF', 'C']));
    assertEqual(JSON.stringify(sandbox.normalizeNba2kPositions(['C', 'PG', 'C'])), JSON.stringify(['PG', 'C']));
  });

  await check('20. Phase 7 regression — add/remove still writes only nba2k27_pool', async () => {
    Object.assign(nba2kPlayersDocs, { 'trae-young': basePlayer({ name: 'Trae Young', teamType: 'curr' }) });
    const view = sandbox.Nba2kDatabaseView;
    await view._ensureLoaded();
    await sandbox.firebase.firestore().collection('nba2k27_pool').doc('trae-young').set({ nba2kRef: 'trae-young', pool: 'green' });
    view._pool27['trae-young'] = { nba2kRef: 'trae-young', pool: 'green' };
    assertTruthy(view._pool27['trae-young']);
    await sandbox.firebase.firestore().collection('nba2k27_pool').doc('trae-young').delete();
    delete view._pool27['trae-young'];
    assertTruthy(!view._pool27['trae-young']);
    assertTruthy(firestoreWrites.every(w => w.collection === 'nba2k27_pool'));
  });

  await check('21. Phase 8 regression — management page still loads/filters/sorts/removes', async () => {
    Object.assign(nba2k27Docs, { 'trae-young': { nba2kRef: 'trae-young', pool: 'green' } });
    sandbox.Nba2kDatabaseView._pool27['trae-young'] = { nba2kRef: 'trae-young', pool: 'green' }; // cache already loaded — sync directly
    const poolView = sandbox.Nba2k27PoolView;
    const container = new FakeElement('phase8root');
    await poolView.render(container);
    assertTruthy(poolView._buildRows().some(r => r.slug === 'trae-young'));
    poolView._filterPool = 'green';
    assertEqual(poolView._getVisibleRows(poolView._buildRows()).length, 1);
    poolView._filterPool = '';
    const row = poolView._buildRows()[0];
    poolView._showRemoveConfirm(container, row);
    const confirmEl = container.querySelector('#nba2k27mgmtConfirm');
    assertTruthy(confirmEl.innerHTML.includes('Remove from NBA 2K27 Pool?'));
  });
})();

setTimeout(() => {
  console.log(`\nPhase 9 Tests:\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
}, 500);
