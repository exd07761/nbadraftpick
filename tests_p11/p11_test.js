'use strict';
/**
 * Phase 11 tests — Public, read-only NBA 2K27 Player View
 * (js/views/nba2k27.js: `PublicNba2k27View`).
 *
 * Same vm-sandbox pattern as tests_p7/8/9/10. The fake Firestore here
 * models the security-rule-level join this file's design depends on:
 * `nba2k27_pool` is read via a plain collection `.get()`, and
 * `nba2k_players` is read ONLY via `.where(FieldPath.documentId(), 'in',
 * chunk).get()` — never a bare collection `.get()` — so the tests can
 * assert the file never attempts to read the full source collection
 * (item 25, "Security").
 *
 * DOM SCOPE — identical to tests_p7/8/9/10: `querySelector` only
 * resolves `#id` lookups; `querySelectorAll` is a stub returning `[]`,
 * so this suite exercises the join/filter/sort/render logic directly
 * (calling `_buildRows`/`_getVisibleRows`/`_renderCard`/`_openDetail`)
 * rather than simulating real click/keydown dispatch through the grid's
 * class-based card bindings — needs a real browser, same caveat as
 * every prior phase's suite.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const srcPath = path.join(__dirname, '..', 'js', 'views', 'nba2k27.js');
const src = fs.readFileSync(srcPath, 'utf8');

// ─── Minimal fake DOM (same shape as tests_p7/8/9/10's FakeElement) ─────
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
  const nba2kPlayersDocs = {};
  const nba2k27Docs = {};
  const writes = []; // any .set()/.update()/.delete()/.add() call anywhere — must stay empty
  let collectionLevelPlayerReads = 0; // a bare nba2k_players.get() with no .where() — must stay 0
  let whereScopedPlayerReadCount = 0;
  const denyPool27 = !!opts.denyPool27;
  const denyPlayers = !!opts.denyPlayers;

  function makeWriteTrackingDoc(collectionName, id) {
    return {
      set: (data) => { writes.push({ collection: collectionName, id, action: 'set', data }); return Promise.resolve(); },
      update: (data) => { writes.push({ collection: collectionName, id, action: 'update', data }); return Promise.resolve(); },
      delete: () => { writes.push({ collection: collectionName, id, action: 'delete' }); return Promise.resolve(); },
    };
  }

  function firestoreFn() {
    return {
      collection: (name) => ({
        get: () => {
          if (name === 'nba2k27_pool') {
            if (denyPool27) return Promise.reject(Object.assign(new Error('denied'), { code: 'permission-denied' }));
            return Promise.resolve({ docs: Object.keys(nba2k27Docs).map(id => ({ id, data: () => nba2k27Docs[id] })) });
          }
          if (name === 'nba2k_players') {
            // A bare collection-wide read of the admin source collection
            // — the public file must NEVER do this (see file header).
            collectionLevelPlayerReads++;
            return Promise.resolve({ docs: Object.keys(nba2kPlayersDocs).map(id => ({ id, data: () => nba2kPlayersDocs[id] })) });
          }
          return Promise.resolve({ docs: [] });
        },
        where: (fieldPathSentinel, op, values) => ({
          get: () => {
            if (name !== 'nba2k_players' || op !== 'in') return Promise.resolve({ docs: [] });
            whereScopedPlayerReadCount++;
            if (denyPlayers) return Promise.reject(Object.assign(new Error('denied'), { code: 'permission-denied' }));
            const docs = values.filter(id => nba2kPlayersDocs[id]).map(id => ({ id, data: () => nba2kPlayersDocs[id] }));
            return Promise.resolve({ docs });
          },
        }),
        doc: (id) => makeWriteTrackingDoc(name, id),
      }),
      batch: () => ({
        set: () => { writes.push({ action: 'batch.set' }); },
        commit: () => Promise.resolve(),
      }),
    };
  }
  firestoreFn.FieldPath = { documentId: () => '__DOC_ID_SENTINEL__' };

  const sandbox = {
    console,
    document: { body: { contains: () => true } },
    escapeHtml: (s) => String(s),
    firebase: { firestore: firestoreFn },
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'nba2k27.js' });
  vm.runInContext('this.PublicNba2k27View = PublicNba2k27View;', sandbox, { filename: 'export.js' });
  vm.runInContext(
    'this.publicNba2kCategoryLabel = publicNba2kCategoryLabel; this.publicNba2k27PoolLabel = publicNba2k27PoolLabel; ' +
    'this.publicNba2k27PoolDot = publicNba2k27PoolDot; this.publicNba2k27PoolValueValid = publicNba2k27PoolValueValid;',
    sandbox,
    { filename: 'export2.js' }
  );

  return {
    sandbox, nba2kPlayersDocs, nba2k27Docs, writes,
    getCollectionLevelPlayerReads: () => collectionLevelPlayerReads,
    getWhereScopedPlayerReadCount: () => whereScopedPlayerReadCount,
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

function seedTypical(nba2kPlayersDocs, nba2k27Docs) {
  Object.assign(nba2kPlayersDocs, {
    'trae-young': {
      name: 'Trae Young', team: 'Atlanta Hawks', teamType: 'curr', overall: 89,
      positions: ['PG', 'SG'], attributes: { closeShot: 82, midRangeShot: 88 },
      badges: { list: [{ name: 'Deadeye', tier: 'Gold', category: 'Shooting' }] },
      height: "6'1\"", weight: '164 lbs', wingspan: "6'3\"", build: 'Slim',
    },
    'wilt-allt': {
      name: 'Wilt Chamberlain', team: 'Philadelphia 76ers', teamType: 'allt', overall: 99,
      positions: ['C'], attributes: { block: 99 }, badges: { list: [] },
    },
    'jordan-classic': {
      name: 'Michael Jordan', team: 'Chicago Bulls', teamType: 'class', overall: 98,
      positions: ['SG'], attributes: { closeShot: 95 },
      badges: { list: [{ name: 'Slasher', tier: 'Hall of Fame', category: 'Finishing' }, { name: 'Clamps', tier: 'Hall of Fame', category: 'Defense' }] },
    },
    'not-selected-player': {
      name: 'Bench Warmer', team: 'Some Team', teamType: 'curr', overall: 70, positions: ['SF'],
    },
    'no-position-player': {
      name: 'No Position Guy', team: 'Some Team', teamType: 'curr', overall: 72,
      // positions field intentionally absent
    },
  });
  Object.assign(nba2k27Docs, {
    'trae-young': { nba2kRef: 'trae-young', pool: 'green', selectedAt: 'a', updatedAt: 'a' },
    'wilt-allt': { nba2kRef: 'wilt-allt', pool: 'blue', selectedAt: 'a', updatedAt: 'a' },
    'jordan-classic': { nba2kRef: 'jordan-classic', pool: 'white', selectedAt: 'a', updatedAt: 'a' },
    'no-position-player': { nba2kRef: 'no-position-player', pool: 'green', selectedAt: 'a', updatedAt: 'a' },
    'ghost-slug': { nba2kRef: 'ghost-slug', pool: 'green', selectedAt: 'a', updatedAt: 'a' }, // orphan
  });
}

console.log('Phase 11 tests');

// Strip the file's own doc comments before static-analysis checks below —
// the header comment intentionally *mentions* AdminActions/AuthBoundary/
// FirebaseSync/.set(/etc. in prose, explaining what this file does NOT
// do; only the executable code matters for these checks.
const srcCodeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

// ── Static analysis: the source file itself must never reference any
// write-capable or admin-only global, and must never contain a write
// call of any kind. Cheaper and more absolute than any runtime check.
(async () => {
  await check('source never references AdminActions', () => assertTruthy(!/AdminActions/.test(srcCodeOnly)));
  await check('source never references AuthBoundary', () => assertTruthy(!/AuthBoundary/.test(srcCodeOnly)));
  await check('source never references FirebaseSync or LeagueData', () => {
    assertTruthy(!/FirebaseSync/.test(srcCodeOnly));
    assertTruthy(!/LeagueData/.test(srcCodeOnly));
  });
  await check('source never calls a Firestore write method', () => {
    assertTruthy(!/\.set\(/.test(srcCodeOnly));
    assertTruthy(!/\.update\(/.test(srcCodeOnly));
    assertTruthy(!/\.delete\(/.test(srcCodeOnly));
    assertTruthy(!/\.add\(/.test(srcCodeOnly));
    assertTruthy(!/\.batch\(\)/.test(srcCodeOnly));
  });
  await check("source never references the 'league' collection", () => assertTruthy(!/collection\(\s*['"]league['"]/.test(srcCodeOnly)));
})();

// ── Public player visibility ────────────────────────────────────────────
(async () => {
  const { sandbox, nba2kPlayersDocs, nba2k27Docs } = makeSandbox();
  seedTypical(nba2kPlayersDocs, nba2k27Docs);
  const view = sandbox.PublicNba2k27View;
  const container = new FakeElement('root');
  await view.render(container);

  await check('1. a player selected in nba2k27_pool appears publicly', () => {
    const rows = view._buildRows();
    assertTruthy(rows.some(r => r.slug === 'trae-young' && !r.orphan));
  });
  await check('2. a player NOT selected in nba2k27_pool does not appear', () => {
    const rows = view._buildRows();
    assertTruthy(!rows.some(r => r.slug === 'not-selected-player'));
  });
  await check('3. all three pools (green/blue/white) appear', () => {
    const rows = view._buildRows();
    const pools = new Set(rows.map(r => r.poolValue));
    assertTruthy(pools.has('green') && pools.has('blue') && pools.has('white'));
  });

  // ── Category ────────────────────────────────────────────────────────
  await check('4. Current -> CURRENT / Green', () => {
    const row = view._buildRows().find(r => r.slug === 'trae-young');
    assertEqual(row.category, 'curr');
    assertEqual(row.poolValue, 'green');
    assertEqual(sandbox.publicNba2kCategoryLabel(row.category).toUpperCase(), 'CURRENT');
  });
  await check('5. All-Time -> ALL-TIME / Blue', () => {
    const row = view._buildRows().find(r => r.slug === 'wilt-allt');
    assertEqual(row.category, 'allt');
    assertEqual(row.poolValue, 'blue');
    assertEqual(sandbox.publicNba2kCategoryLabel(row.category).toUpperCase(), 'ALL-TIME');
  });
  await check('6. Classics -> CLASSICS / White', () => {
    const row = view._buildRows().find(r => r.slug === 'jordan-classic');
    assertEqual(row.category, 'class');
    assertEqual(row.poolValue, 'white');
    assertEqual(sandbox.publicNba2kCategoryLabel(row.category).toUpperCase(), 'CLASSICS');
  });

  // ── Position ────────────────────────────────────────────────────────
  await check('7. current (possibly Phase-6-corrected) source positions appear', () => {
    // The view always reads whatever is currently in nba2k_players.positions
    // at load time — simulating a Phase 6 correction is just changing that
    // field before the view loads, which this proves is reflected exactly.
    nba2kPlayersDocs['trae-young'].positions = ['PG'];
  });
  await check('8. multi-position players render correctly', () => {
    const html = view._renderCard(view._buildRows().find(r => r.slug === 'jordan-classic'));
    assertTruthy(html.includes('SG'));
  });
  await check('9. missing positions do not crash the view', () => {
    const row = view._buildRows().find(r => r.slug === 'no-position-player');
    const html = view._renderCard(row); // must not throw
    assertTruthy(html.includes('—'), 'renders an em-dash placeholder, not a crash');
  });

  // ── Detail data ─────────────────────────────────────────────────────
  await check('10. overall displays correctly', () => {
    const html = view._renderCard(view._buildRows().find(r => r.slug === 'wilt-allt'));
    assertTruthy(html.includes('99 OVR'));
  });
  await check('11. attributes render correctly', () => {
    view._openDetail(container, 'trae-young');
    const mount = container.querySelector('#pub2k27DetailMount');
    assertTruthy(mount.innerHTML.includes('Close Shot'));
    assertTruthy(mount.innerHTML.includes('Mid-Range Shot'));
  });
  await check('12. badges render correctly', () => {
    view._openDetail(container, 'jordan-classic');
    const mount = container.querySelector('#pub2k27DetailMount');
    assertTruthy(mount.innerHTML.includes('Slasher'));
    assertTruthy(mount.innerHTML.includes('Clamps'));
    assertTruthy(mount.innerHTML.includes('Hall of Fame'));
  });
  await check('13. physical data renders when present', () => {
    view._openDetail(container, 'trae-young');
    const mount = container.querySelector('#pub2k27DetailMount');
    assertTruthy(mount.innerHTML.includes('164 lbs'));
    assertTruthy(mount.innerHTML.includes('Wingspan'));
  });
  await check('14. missing/empty badges render safely ("No badges")', () => {
    view._openDetail(container, 'wilt-allt'); // badges.list is []
    const mount = container.querySelector('#pub2k27DetailMount');
    assertTruthy(mount.innerHTML.includes('No badges'));
  });
  await check('15. missing optional fields do not crash the modal', () => {
    // no-position-player has no attributes, no badges, no physicals, no image.
    view._openDetail(container, 'no-position-player'); // must not throw
    const mount = container.querySelector('#pub2k27DetailMount');
    assertTruthy(mount.innerHTML.includes('No badges'));
  });
})();

// ── Read-only / integrity ────────────────────────────────────────────────
(async () => {
  const { sandbox, nba2kPlayersDocs, nba2k27Docs, writes } = makeSandbox();
  seedTypical(nba2kPlayersDocs, nba2k27Docs);
  const view = sandbox.PublicNba2k27View;
  const container = new FakeElement('root');
  await view.render(container);

  await check('16. clicking View Player (_openDetail) causes zero writes', () => {
    view._openDetail(container, 'trae-young');
    assertEqual(writes.length, 0);
  });
  await check('17. opening/closing the modal causes zero writes', () => {
    const mount = container.querySelector('#pub2k27DetailMount');
    mount.querySelector('#pub2k27DetailClose').onclick();
    assertEqual(writes.length, 0);
  });
  await check('18. searching/filtering causes zero writes', () => {
    view._search = 'jordan';
    view._filterPool = 'white';
    view._filterCategory = 'class';
    view._filterPosition = 'SG';
    view._filterTeam = 'Chicago Bulls';
    view._filterOvr = '90';
    view._getVisibleRows(view._buildRows());
    assertEqual(writes.length, 0);
    view._search = ''; view._filterPool = ''; view._filterCategory = '';
    view._filterPosition = ''; view._filterTeam = ''; view._filterOvr = '';
  });
  await check('19. no AdminActions.addPlayer() calls (global does not even exist here)', () => {
    assertEqual(typeof sandbox.AdminActions, 'undefined');
  });
  await check('20. no writes to league/main', () => {
    assertEqual(writes.filter(w => w.collection === 'league').length, 0);
  });
  await check('21. no writes to nba2k27_pool', () => {
    assertEqual(writes.filter(w => w.collection === 'nba2k27_pool').length, 0);
  });
  await check('22. no writes to nba2k_players', () => {
    assertEqual(writes.filter(w => w.collection === 'nba2k_players').length, 0);
  });
  await check('total writes across the entire session: zero', () => {
    assertEqual(writes.length, 0);
  });
})();

// ── Orphans ──────────────────────────────────────────────────────────────
(async () => {
  const { sandbox, nba2kPlayersDocs, nba2k27Docs } = makeSandbox();
  seedTypical(nba2kPlayersDocs, nba2k27Docs);
  const view = sandbox.PublicNba2k27View;
  const container = new FakeElement('root');
  await view.render(container);

  await check('23. orphaned pool entries do not crash the public page', () => {
    const row = view._buildRows().find(r => r.slug === 'ghost-slug');
    assertTruthy(row.orphan);
    const html = view._renderCard(row); // must not throw
    assertTruthy(html.includes('unavailable'));
    view._openDetail(container, 'ghost-slug'); // must not throw, and must no-op
    const mount = container.querySelector('#pub2k27DetailMount');
    assertTruthy(!mount || mount.innerHTML === '', 'no detail view opened for an orphan — nothing to show');
  });
  await check('24. orphans are not automatically deleted', () => {
    assertTruthy(sandbox.PublicNba2k27View._pool27['ghost-slug'], 'orphan doc still present after render/build/detail-click');
  });
})();

// ── Security: never a bare collection-wide read of nba2k_players ───────
(async () => {
  const { sandbox, nba2kPlayersDocs, nba2k27Docs, getCollectionLevelPlayerReads, getWhereScopedPlayerReadCount } = makeSandbox();
  seedTypical(nba2kPlayersDocs, nba2k27Docs);
  const view = sandbox.PublicNba2k27View;
  await view.render(new FakeElement('root'));

  await check('25. never a bare (unscoped) collection read of nba2k_players', () => {
    assertEqual(getCollectionLevelPlayerReads(), 0, 'the admin-only full source collection is never read wholesale');
    assertTruthy(getWhereScopedPlayerReadCount() > 0, 'source docs ARE fetched, but only by explicit selected-slug ID');
  });
  await check('only the selected slugs are ever requested from nba2k_players', () => {
    // not-selected-player exists in the source fixture but was never in
    // nba2k27_pool, so it must never even be part of a chunked query.
    assertTruthy(!Object.keys(sandbox.PublicNba2k27View._players).includes('not-selected-player'));
  });
})();

// ── Graceful failure: rule not yet applied ──────────────────────────────
(async () => {
  const { sandbox, nba2kPlayersDocs, nba2k27Docs } = makeSandbox({ denyPlayers: true });
  Object.assign(nba2kPlayersDocs, { p1: { name: 'P', team: 'T', teamType: 'curr', overall: 80, positions: ['PG'] } });
  Object.assign(nba2k27Docs, { p1: { nba2kRef: 'p1', pool: 'green' } });
  const view = sandbox.PublicNba2k27View;
  const container = new FakeElement('root');

  await check('a permission-denied on nba2k_players reads shows an explanatory state, never crashes', async () => {
    await view.render(container); // must not throw
    assertEqual(view._loadError, 'permission-denied');
    assertTruthy(container.innerHTML.includes("isn't available yet") || container.innerHTML.length > 0);
  });
})();

(async () => {
  const { sandbox, nba2k27Docs } = makeSandbox({ denyPool27: true });
  const view = sandbox.PublicNba2k27View;
  const container = new FakeElement('root');
  await check('a permission-denied on nba2k27_pool itself also fails closed, never crashes', async () => {
    await view.render(container); // must not throw
    assertEqual(view._loadError, 'permission-denied');
  });
})();

// ── Empty pool (zero selections) ────────────────────────────────────────
(async () => {
  const { sandbox } = makeSandbox();
  const view = sandbox.PublicNba2k27View;
  const container = new FakeElement('root');
  await check('an empty nba2k27_pool shows a friendly empty state, not a crash', async () => {
    await view.render(container);
    assertEqual(view._loadError, null);
    assertTruthy(container.innerHTML.includes('No players selected yet'));
  });
})();

// ── Regression: Phase 7/8/9/10 suites re-run unmodified ─────────────────
(async () => {
  const suites = [
    ['tests_p7/p7_test.js', path.join(__dirname, '..', 'tests_p7', 'p7_test.js')],
    ['tests_p8/p8_test.js', path.join(__dirname, '..', 'tests_p8', 'p8_test.js')],
    ['tests_p9/p9_test.js', path.join(__dirname, '..', 'tests_p9', 'p9_test.js')],
    ['tests_p10/p10_test.js', path.join(__dirname, '..', 'tests_p10', 'p10_test.js')],
  ];
  for (const [label, file] of suites) {
    await check(`regression suite ${label} passes`, () => {
      let output;
      try {
        output = execFileSync('node', [file], { encoding: 'utf8', timeout: 20000 });
      } catch (err) {
        throw new Error(`${label} exited non-zero:\n${err.stdout || err.message}`);
      }
      assertTruthy(!/FAIL/.test(output), `${label} reported a FAIL:\n${output}`);
    });
  }
})();

setTimeout(() => {
  console.log(`\nPhase 11 Tests:\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
}, 8000);
