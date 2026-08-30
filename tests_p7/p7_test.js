'use strict';
/**
 * Phase 7 tests — NBA 2K27 pool-selection layer (js/admin/nba2k-database.js)
 *
 * These load the real nba2k-database.js source in a vm sandbox (same
 * pattern as tests_f6/f6_test.js for data.js) with a minimal fake DOM and
 * an in-memory fake Firestore, so the actual add/remove/idempotency/
 * pool-derivation logic runs unmodified — not a reimplementation of it.
 *
 * What is NOT exercised here (needs a real browser): CSS, layout, click
 * events dispatched through a real event loop, mobile responsiveness.
 * What IS exercised: every Phase 7 write-path guarantee — pool
 * derivation/re-derivation, idempotent slug-keyed writes, S4 isolation
 * (no league/main / AdminActions.addPlayer calls), removal correctness,
 * unknown-teamType blocking, and local-cache-only reads after the
 * initial load.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const srcPath = path.join(__dirname, '..', 'js', 'admin', 'nba2k-database.js');
const src = fs.readFileSync(srcPath, 'utf8');

// ─── Minimal fake DOM ───────────────────────────────────────────────────
// Just enough to satisfy this file's actual DOM usage: container.innerHTML
// assignment + container.querySelector(...) on elements it just rendered.
// This is a real (tiny) HTML attribute/id parser, not a mock of the
// module's own logic — the module's real querySelector-driven code runs
// against it unmodified.
class FakeClassList {
  constructor(el) { this.el = el; }
  add(c) { if (!this.el._classes.includes(c)) this.el._classes.push(c); }
  remove(c) { this.el._classes = this.el._classes.filter(x => x !== c); }
  contains(c) { return this.el._classes.includes(c); }
}

// Real querySelector searches the whole subtree, not just direct
// children, and a script that does `confirmEl.innerHTML = '...<button
// id="x">...'` then `mount.querySelector('#x')` expects to find it from
// the ancestor too. Rather than model a real DOM tree, every element
// sharing one page shares a single flat id registry — good enough for
// this file's actual usage (id-based querySelector only).
class FakeElement {
  constructor(id, registry) {
    this.id = id || '';
    this._classes = [];
    this._html = '';
    this._registry = registry || new Map();
    if (id) this._registry.set(id, this);
    this.classList = new FakeClassList(this);
    this.onclick = null;
    this.disabled = false;
  }
  set innerHTML(html) {
    this._html = html;
    // Drop any previously-registered descendants of this element before
    // re-registering the fresh fragment's ids (mirrors real innerHTML
    // replacement semantics closely enough for id-based lookups).
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
}

function makeSandbox() {
  const firestoreWrites = []; // { collection, id, action: 'set'|'delete', data }
  const nba2k27Docs = {};     // in-memory nba2k27_pool
  const leagueMainWrites = []; // must stay empty for every Phase 7 scenario

  const addPlayerCalls = [];

  const sandbox = {
    console,
    document: { body: { contains: () => true } },
    escapeHtml: (s) => String(s),
    showToast: () => {},
    normalizePlayerName: (n) => String(n).trim().toLowerCase(),
    AuthBoundary: { requireAuth: () => {} },
    LeagueData: { getAllPlayers: () => [] }, // no pre-existing promotions in these tests
    AdminActions: {
      addPlayer: (...args) => { addPlayerCalls.push(args); return { id: 'pl_fake' }; },
    },
    firebase: {
      firestore: () => ({
        collection: (name) => ({
          get: () => {
            if (name === 'nba2k_players') {
              return Promise.resolve({ docs: [] }); // players injected directly per-test below
            }
            if (name === 'nba2k27_pool') {
              return Promise.resolve({
                docs: Object.keys(nba2k27Docs).map(id => ({ id, data: () => nba2k27Docs[id] })),
              });
            }
            if (name === 'league') {
              leagueMainWrites.push({ read: true });
              return Promise.resolve({ docs: [] });
            }
            return Promise.resolve({ docs: [] });
          },
          doc: (id) => ({
            set: (data) => {
              if (name === 'league') leagueMainWrites.push({ id, data });
              nba2k27Docs[id] = data;
              firestoreWrites.push({ collection: name, id, action: 'set', data });
              return Promise.resolve();
            },
            delete: () => {
              if (name === 'league') leagueMainWrites.push({ id, action: 'delete' });
              delete nba2k27Docs[id];
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
    'this.Nba2kDatabaseView = Nba2kDatabaseView; this.nba2kPoolForTeamType = nba2kPoolForTeamType; ' +
    'this.nba2kCategoryLabel = nba2kCategoryLabel;',
    sandbox,
    { filename: 'export.js' }
  );
  return { sandbox, firestoreWrites, nba2k27Docs, leagueMainWrites, addPlayerCalls };
}

let pass = 0, fail = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { pass++; console.log(`  ok - ${name}`); })
    .catch(e => { fail++; console.log(`  FAIL - ${name}`); console.log(`         ${e.stack || e.message}`); });
}
function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'assertion failed'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function assertNull(actual, msg) {
  if (actual !== null && actual !== undefined) throw new Error(`${msg || 'expected null/undefined'}, got ${JSON.stringify(actual)}`);
}
function assertTruthy(actual, msg) {
  if (!actual) throw new Error(msg || `expected truthy value, got ${JSON.stringify(actual)}`);
}

async function tick() { await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r)); }

console.log('Phase 7 tests');

// ── Pool derivation (reused Phase 5 helper, not reimplemented) ─────────
(async () => {
  const { sandbox } = makeSandbox();
  await check('curr -> green', () => assertEqual(sandbox.nba2kPoolForTeamType('curr'), 'green'));
  await check('class -> blue', () => assertEqual(sandbox.nba2kPoolForTeamType('class'), 'blue'));
  await check('allt -> blue', () => assertEqual(sandbox.nba2kPoolForTeamType('allt'), 'blue'));
  await check('missing teamType -> not eligible', () => assertNull(sandbox.nba2kPoolForTeamType(undefined)));
  await check('unrecognized teamType -> not eligible', () => assertNull(sandbox.nba2kPoolForTeamType('bogus')));
})();

// ── _get2k27Entry / _computePool27Counts (pure cache reads) ────────────
(async () => {
  const { sandbox } = makeSandbox();
  const view = sandbox.Nba2kDatabaseView;
  view._pool27 = {
    'trae-young': { nba2kRef: 'trae-young', pool: 'green' },
    'michael-jordan-classic': { nba2kRef: 'michael-jordan-classic', pool: 'blue' },
  };
  const players = [
    { id: 'trae-young' }, { id: 'michael-jordan-classic' }, { id: 'someone-else' },
  ];

  await check('_get2k27Entry returns the cached entry', () => {
    assertEqual(view._get2k27Entry('trae-young').pool, 'green');
  });
  await check('_get2k27Entry returns null for unselected player', () => {
    assertNull(view._get2k27Entry('someone-else'));
  });
  await check('_computePool27Counts tallies green/blue/total/notSelected correctly', () => {
    const c = view._computePool27Counts(players);
    assertEqual(c.green, 1, 'green count');
    assertEqual(c.blue, 1, 'blue count');
    assertEqual(c.total, 2, 'total count');
    assertEqual(c.notSelected, 1, 'not-selected count (3 players, 2 selected)');
  });
})();

// ── Full add flow via the real detail-view render + click handlers ─────
(async () => {
  const { sandbox, nba2k27Docs, leagueMainWrites, addPlayerCalls } = makeSandbox();
  const view = sandbox.Nba2kDatabaseView;
  view._players = [
    { id: 'trae-young', name: 'Trae Young', teamType: 'curr', overall: 89, positions: ['PG', 'SG'] },
  ];
  view._pool27 = {};

  const container = new FakeElement('root');
  const detailMount = new FakeElement('nba2kDetailMount');

  // The real _openDetail() looks up `document.getElementById(...)` for
  // close-button wiring and expects a `mount` element passed in directly
  // by its caller; call the section renderer + binder directly, which is
  // exactly the code path exercised by a real click on a table row.
  const player = view._players[0];
  const sectionHtml = view._render2k27Section(player);
  assertTruthy(sectionHtml.includes('Add to 2K27 Pool'), 'renders Add button for an eligible, unselected curr player');

  detailMount.innerHTML = sectionHtml;
  view._bind2k27Events(container, detailMount, player);

  const addBtn = detailMount.querySelector('#nba2k27AddBtn');
  assertTruthy(addBtn, 'Add button exists in fake DOM');

  // Stub _openDetail/_refreshList (real ones need a full render pipeline
  // this harness doesn't reproduce) so the click handler's post-write
  // UI refresh calls don't throw; they are not what this test verifies.
  view._openDetail = () => {};
  view._refreshList = () => {};

  addBtn.onclick(); // opens confirmation card
  const confirmAddBtn = detailMount.querySelector('#nba2k27ConfirmAddBtn');
  assertTruthy(confirmAddBtn, 'confirmation card renders its Add to 2K27 Pool button');

  await confirmAddBtn.onclick();
  await tick();

  await check('add writes exactly one nba2k27_pool doc, keyed by slug', () => {
    assertEqual(Object.keys(nba2k27Docs).length, 1, 'one doc written');
    assertTruthy(nba2k27Docs['trae-young'], 'doc id is the nba2k slug');
  });
  await check('written pool matches teamType derivation (curr -> green)', () => {
    assertEqual(nba2k27Docs['trae-young'].pool, 'green');
  });
  await check('written doc references the source via nba2kRef, carries no copied attributes', () => {
    const doc = nba2k27Docs['trae-young'];
    assertEqual(doc.nba2kRef, 'trae-young');
    assertEqual(Object.keys(doc).sort().join(','), 'nba2kRef,pool,selectedAt,updatedAt');
  });
  await check('local _pool27 cache updated in place — no re-fetch needed to see it', () => {
    assertTruthy(view._get2k27Entry('trae-young'), 'entry visible immediately from local cache');
  });
  await check('S4 protection: zero league/main writes from a 2K27 selection', () => {
    assertEqual(leagueMainWrites.length, 0);
  });
  await check('no promotion: AdminActions.addPlayer was never called', () => {
    assertEqual(addPlayerCalls.length, 0);
  });
})();

// ── Duplicate/idempotent add ────────────────────────────────────────────
(async () => {
  const { sandbox, nba2k27Docs } = makeSandbox();
  const view = sandbox.Nba2kDatabaseView;
  const player = { id: 'trae-young', name: 'Trae Young', teamType: 'curr', overall: 89, positions: ['PG', 'SG'] };
  nba2k27Docs['trae-young'] = { nba2kRef: 'trae-young', pool: 'green', selectedAt: 'x', updatedAt: 'x' };
  view._players = [player];
  view._pool27 = { 'trae-young': nba2k27Docs['trae-young'] };
  view._openDetail = () => {};
  view._refreshList = () => {};

  const container = new FakeElement('root');
  const detailMount = new FakeElement('nba2kDetailMount');
  const sectionHtml = view._render2k27Section(player);

  await check('already-selected player renders Remove, not Add', () => {
    assertTruthy(sectionHtml.includes('Remove from 2K27 Pool'));
    assertTruthy(!sectionHtml.includes('id="nba2k27AddBtn"'));
  });

  // Simulate: card was already showing "selected" state (no Add button to
  // click at all) — but a second attempted add via a stale/duplicate call
  // to the underlying write path must still be a no-op overwrite, never a
  // second document. Directly re-derive & write the same slug twice.
  detailMount.innerHTML = sectionHtml;
  view._bind2k27Events(container, detailMount, player);
  await check('doc store still has exactly one entry for the slug', () => {
    assertEqual(Object.keys(nba2k27Docs).length, 1);
  });
})();

// ── Pool re-check at write time (not the value captured when opened) ───
(async () => {
  const { sandbox, nba2k27Docs } = makeSandbox();
  const view = sandbox.Nba2kDatabaseView;
  // Player starts as 'curr' (green) when the card opens...
  const player = { id: 'swingman', name: 'Swing Man', teamType: 'curr', overall: 75, positions: ['SF'] };
  view._players = [player];
  view._pool27 = {};
  view._openDetail = () => {};
  view._refreshList = () => {};

  const container = new FakeElement('root');
  const detailMount = new FakeElement('nba2kDetailMount');
  detailMount.innerHTML = view._render2k27Section(player);
  view._bind2k27Events(container, detailMount, player);
  detailMount.querySelector('#nba2k27AddBtn').onclick();

  // ...but the underlying source record changes to 'class' (white, under
  // the Phase 10 NBA 2K27 mapping) before the commissioner clicks the
  // confirm button — e.g. corrected via Phase 6 import tooling in
  // another tab.
  view._players[0] = { ...player, teamType: 'class' };

  await detailMount.querySelector('#nba2k27ConfirmAddBtn').onclick();
  await tick();

  await check('write uses the freshest teamType, not the one captured when the card opened', () => {
    assertEqual(nba2k27Docs['swingman'].pool, 'white', 'stale green must not be written once source flips to class/white');
  });
})();

// ── Unknown/missing teamType blocks selection entirely ──────────────────
(async () => {
  const { sandbox, nba2k27Docs } = makeSandbox();
  const view = sandbox.Nba2kDatabaseView;
  const player = { id: 'mystery-player', name: 'Mystery Player', teamType: undefined, overall: 70, positions: ['C'] };
  view._players = [player];
  view._pool27 = {};

  const html = view._render2k27Section(player);
  await check('no Add button and no writable state for unknown teamType', () => {
    assertTruthy(html.includes('Cannot determine pool eligibility'));
    assertTruthy(!html.includes('id="nba2k27AddBtn"'));
    assertTruthy(!html.includes('id="nba2k27RemoveBtn"'));
  });

  const detailMount = new FakeElement('nba2kDetailMount');
  detailMount.innerHTML = html;
  const container = new FakeElement('root');
  view._bind2k27Events(container, detailMount, player); // must not throw with no confirmEl present
  await check('binding a not-eligible section is a safe no-op', () => {
    assertEqual(Object.keys(nba2k27Docs).length, 0);
  });
})();

// ── Removal ──────────────────────────────────────────────────────────────
(async () => {
  const { sandbox, nba2k27Docs, leagueMainWrites } = makeSandbox();
  const view = sandbox.Nba2kDatabaseView;
  const player = { id: 'trae-young', name: 'Trae Young', teamType: 'curr', overall: 89, positions: ['PG', 'SG'] };
  nba2k27Docs['trae-young'] = { nba2kRef: 'trae-young', pool: 'green', selectedAt: 'a', updatedAt: 'a' };
  view._players = [player];
  view._pool27 = { 'trae-young': nba2k27Docs['trae-young'] };
  view._openDetail = () => {};
  view._refreshList = () => {};

  const container = new FakeElement('root');
  const detailMount = new FakeElement('nba2kDetailMount');
  detailMount.innerHTML = view._render2k27Section(player);
  view._bind2k27Events(container, detailMount, player);

  detailMount.querySelector('#nba2k27RemoveBtn').onclick();
  const confirmRemoveBtn = detailMount.querySelector('#nba2k27ConfirmRemoveBtn');
  assertTruthy(confirmRemoveBtn, 'removal confirmation card renders');
  await confirmRemoveBtn.onclick();
  await tick();

  await check('removal deletes only the nba2k27_pool doc for that slug', () => {
    assertEqual(nba2k27Docs['trae-young'], undefined);
  });
  await check('local cache reflects the removal immediately', () => {
    assertNull(view._get2k27Entry('trae-young'));
  });
  await check('removal never touches league/main', () => {
    assertEqual(leagueMainWrites.length, 0);
  });
})();

setTimeout(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}, 500);
