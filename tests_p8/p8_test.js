'use strict';
/**
 * Phase 8 tests — NBA 2K27 Pool Management view (js/admin/nba2k-database.js,
 * `Nba2k27PoolView`).
 *
 * Same pattern as tests_p7/p7_test.js (itself following tests_f6/f6_test.js
 * for data.js): load the real nba2k-database.js source in a vm sandbox with
 * a minimal fake DOM and an in-memory fake Firestore, so the actual join /
 * count / filter / sort / removal logic runs unmodified.
 *
 * DOM SCOPE — matching the Phase 7 suite's own stated scope: this fake DOM
 * only resolves `#id`-based `querySelector` lookups (built from an id
 * registry populated by scanning `id="..."` attributes on every innerHTML
 * assignment) — exactly like tests_p7's FakeElement. `querySelectorAll` is
 * a stub that always returns `[]`, so the class/attribute-based row and
 * button bindings inside `_refreshList` execute as harmless no-ops here
 * (same as Phase 2's own `_refreshList` row-click wiring, which tests_p7
 * also never exercises for the same reason). What IS exercised: the full
 * join/count/filter/sort logic (all pure, no DOM), and the id-based
 * removal-confirmation flow (`_showRemoveConfirm`), which — like every
 * Phase 3/6/7 confirm card before it — only ever uses `#id` lookups.
 * What is NOT exercised here (needs a real browser, same caveat as
 * tests_p7): CSS, layout, real click/keydown dispatch through row/tab/
 * button class-based listeners, mobile responsiveness.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const srcPath = path.join(__dirname, '..', 'js', 'admin', 'nba2k-database.js');
const src = fs.readFileSync(srcPath, 'utf8');

// ─── Minimal fake DOM (copied/extended from tests_p7's FakeElement) ─────
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
  // Not a real query — see file header "DOM SCOPE". Every Phase 8
  // class/attribute-based binding loop (`.forEach` over this) becomes a
  // harmless no-op, exactly like Phase 2's own row-click wiring under
  // tests_p7's identical FakeElement.
  querySelectorAll() { return []; }
  addEventListener() {}
}

function makeSandbox() {
  const firestoreWrites = [];  // { collection, id, action: 'set'|'delete', data }
  const nba2kPlayersDocs = {}; // in-memory nba2k_players, injected per-test
  const nba2k27Docs = {};      // in-memory nba2k27_pool
  const leagueMainWrites = []; // must stay empty for every Phase 8 scenario
  const addPlayerCalls = [];
  const getCalls = { nba2k_players: 0, nba2k27_pool: 0 };

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
              getCalls.nba2k_players++;
              return Promise.resolve({
                docs: Object.keys(nba2kPlayersDocs).map(id => ({ id, data: () => nba2kPlayersDocs[id] })),
              });
            }
            if (name === 'nba2k27_pool') {
              getCalls.nba2k27_pool++;
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
              if (name === 'nba2k27_pool') nba2k27Docs[id] = data;
              firestoreWrites.push({ collection: name, id, action: 'set', data });
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
    'this.nba2kPoolForTeamType = nba2kPoolForTeamType; this.nba2kCategoryLabel = nba2kCategoryLabel; ' +
    'this.normalizeNba2kPositions = normalizeNba2kPositions;',
    sandbox,
    { filename: 'export.js' }
  );
  return { sandbox, firestoreWrites, nba2kPlayersDocs, nba2k27Docs, leagueMainWrites, addPlayerCalls, getCalls };
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

// Fresh, realistic joined dataset reused across most tests:
//  - 2 curr/green (one selected, one not)
//  - 2 class/blue (one selected, one not)
//  - 1 allt/blue (selected)
//  - 1 orphaned nba2k27_pool doc (no matching nba2k_players record)
//  - 1 selected doc with a corrupted (invalid) pool value
function seedTypical(nba2kPlayersDocs, nba2k27Docs) {
  Object.assign(nba2kPlayersDocs, {
    'trae-young':   { name: 'Trae Young', team: 'Atlanta Hawks', teamType: 'curr', overall: 89, positions: ['PG', 'SG'] },
    'lebron-james': { name: 'LeBron James', team: 'LA Lakers', teamType: 'curr', overall: 96, positions: ['SF', 'PF'] },
    'jordan-classic': { name: 'Michael Jordan', team: 'Chicago Bulls', teamType: 'class', overall: 98, positions: ['SG'] },
    'kobe-classic': { name: 'Kobe Bryant', team: 'LA Lakers', teamType: 'class', overall: 97, positions: ['SG'] },
    'wilt-allt': { name: 'Wilt Chamberlain', team: 'Philadelphia 76ers', teamType: 'allt', overall: 99, positions: ['C'] },
  });
  Object.assign(nba2k27Docs, {
    'trae-young': { nba2kRef: 'trae-young', pool: 'green', selectedAt: 'a', updatedAt: 'a' },
    'jordan-classic': { nba2kRef: 'jordan-classic', pool: 'blue', selectedAt: 'a', updatedAt: 'a' },
    'wilt-allt': { nba2kRef: 'wilt-allt', pool: 'blue', selectedAt: 'a', updatedAt: 'a' },
    'ghost-player': { nba2kRef: 'ghost-player', pool: 'green', selectedAt: 'a', updatedAt: 'a' }, // orphan
    'kobe-classic': { nba2kRef: 'kobe-classic', pool: 'purple', selectedAt: 'a', updatedAt: 'a' }, // invalid pool
  });
}

console.log('Phase 8 tests');

// ── Loading: join + no repeat fetch ─────────────────────────────────────
(async () => {
  const { sandbox, nba2kPlayersDocs, nba2k27Docs, getCalls } = makeSandbox();
  seedTypical(nba2kPlayersDocs, nba2k27Docs);
  const view = sandbox.Nba2k27PoolView;
  const container = new FakeElement('root');

  await check('render() loads nba2k_players', async () => {
    await view.render(container);
    assertTruthy(sandbox.Nba2kDatabaseView._players.some(p => p.id === 'trae-young'));
  });
  await check('render() loads nba2k27_pool', () => {
    assertTruthy(sandbox.Nba2kDatabaseView._pool27['trae-young']);
  });
  await check('joins selections to source players (_buildRows)', () => {
    const rows = view._buildRows();
    const row = rows.find(r => r.slug === 'trae-young');
    assertTruthy(row, 'row exists');
    assertEqual(row.player.name, 'Trae Young');
    assertEqual(row.category, 'curr');
    assertEqual(row.orphan, false);
  });
  await check('does not re-fetch nba2k_players/nba2k27_pool on a second render()', async () => {
    await view.render(new FakeElement('root2'));
    assertEqual(getCalls.nba2k_players, 1, 'nba2k_players fetched exactly once');
    assertEqual(getCalls.nba2k27_pool, 1, 'nba2k27_pool fetched exactly once');
  });
})();

// ── Counts ───────────────────────────────────────────────────────────────
(async () => {
  const { sandbox, nba2kPlayersDocs, nba2k27Docs } = makeSandbox();
  seedTypical(nba2kPlayersDocs, nba2k27Docs);
  const view = sandbox.Nba2k27PoolView;
  await view.render(new FakeElement('root'));
  const rows = view._buildRows();
  const counts = view._computeCounts(rows, sandbox.Nba2kDatabaseView._players.length);

  await check('total selected count includes orphan + invalid-pool entries', () => {
    assertEqual(counts.total, 5, '5 nba2k27_pool docs seeded');
  });
  await check('green count (valid pool only)', () => {
    // trae-young=green; ghost-player=green but orphaned (still counts toward
    // green — pool validity, not source-match, gates this count).
    assertEqual(counts.green, 2);
  });
  await check('blue count (valid pool only)', () => {
    // jordan-classic + wilt-allt; kobe-classic excluded (invalid 'purple').
    assertEqual(counts.blue, 2);
  });
  await check('current category count', () => {
    assertEqual(counts.categoryCounts.curr, 1); // only trae-young has a resolvable curr source
  });
  await check('classics category count', () => {
    assertEqual(counts.categoryCounts.class, 2); // jordan-classic + kobe-classic
  });
  await check('all-time category count', () => {
    assertEqual(counts.categoryCounts.allt, 1); // wilt-allt
  });
  await check('available count = source total - total selected', () => {
    assertEqual(counts.available, 5 - 5); // 5 source players, 5 selections
  });
})();

// ── Filtering ─────────────────────────────────────────────────────────────
(async () => {
  const { sandbox, nba2kPlayersDocs, nba2k27Docs } = makeSandbox();
  seedTypical(nba2kPlayersDocs, nba2k27Docs);
  const view = sandbox.Nba2k27PoolView;
  await view.render(new FakeElement('root'));

  await check('category filter', () => {
    view._filterCategory = 'class';
    view._filterPool = '';
    view._search = '';
    const visible = view._getVisibleRows(view._buildRows());
    assertEqual(visible.length, 2);
    assertTruthy(visible.every(r => r.category === 'class'));
  });
  await check('pool filter', () => {
    view._filterCategory = '';
    view._filterPool = 'blue';
    const visible = view._getVisibleRows(view._buildRows());
    assertEqual(visible.length, 2, 'jordan-classic + wilt-allt; invalid-pool kobe-classic excluded');
    assertTruthy(visible.every(r => r.poolValue === 'blue'));
  });
  await check('search by player name', () => {
    view._filterPool = '';
    view._search = 'jordan';
    const visible = view._getVisibleRows(view._buildRows());
    assertEqual(visible.length, 1);
    assertEqual(visible[0].slug, 'jordan-classic');
  });
  await check('search by team', () => {
    view._search = 'philadelphia';
    const visible = view._getVisibleRows(view._buildRows());
    assertEqual(visible.length, 1);
    assertEqual(visible[0].slug, 'wilt-allt');
  });
  await check('combined filters (category + pool + search)', () => {
    view._filterCategory = 'class';
    view._filterPool = 'blue';
    view._search = 'jordan';
    const visible = view._getVisibleRows(view._buildRows());
    assertEqual(visible.length, 1);
    assertEqual(visible[0].slug, 'jordan-classic');
    // reset for later tests
    view._filterCategory = '';
    view._filterPool = '';
    view._search = '';
  });
})();

// ── Sorting ────────────────────────────────────────────────────────────────
(async () => {
  const { sandbox, nba2kPlayersDocs, nba2k27Docs } = makeSandbox();
  seedTypical(nba2kPlayersDocs, nba2k27Docs);
  const view = sandbox.Nba2k27PoolView;
  await view.render(new FakeElement('root'));

  await check('OVR descending (default)', () => {
    view._sortMode = 'ovr-desc';
    const visible = view._getVisibleRows(view._buildRows());
    const matched = visible.filter(r => r.player);
    for (let i = 1; i < matched.length; i++) {
      assertTruthy(matched[i - 1].player.overall >= matched[i].player.overall, 'non-increasing OVR');
    }
  });
  await check('OVR ascending', () => {
    view._sortMode = 'ovr-asc';
    const visible = view._getVisibleRows(view._buildRows());
    const matched = visible.filter(r => r.player);
    for (let i = 1; i < matched.length; i++) {
      assertTruthy(matched[i - 1].player.overall <= matched[i].player.overall, 'non-decreasing OVR');
    }
  });
  await check('Name A-Z', () => {
    view._sortMode = 'name-asc';
    const visible = view._getVisibleRows(view._buildRows()).filter(r => r.player);
    const names = visible.map(r => r.player.name);
    assertEqual(JSON.stringify(names), JSON.stringify([...names].sort((a, b) => a.localeCompare(b))));
  });
  await check('Name Z-A', () => {
    view._sortMode = 'name-desc';
    const visible = view._getVisibleRows(view._buildRows()).filter(r => r.player);
    const names = visible.map(r => r.player.name);
    assertEqual(JSON.stringify(names), JSON.stringify([...names].sort((a, b) => b.localeCompare(a))));
  });
  await check('Team A-Z', () => {
    view._sortMode = 'team-asc';
    const visible = view._getVisibleRows(view._buildRows()).filter(r => r.player);
    const teams = visible.map(r => r.player.team);
    assertEqual(JSON.stringify(teams), JSON.stringify([...teams].sort((a, b) => a.localeCompare(b))));
  });
  await check('Team Z-A', () => {
    view._sortMode = 'team-desc';
    const visible = view._getVisibleRows(view._buildRows()).filter(r => r.player);
    const teams = visible.map(r => r.player.team);
    assertEqual(JSON.stringify(teams), JSON.stringify([...teams].sort((a, b) => b.localeCompare(a))));
    view._sortMode = 'ovr-desc'; // reset
  });
  await check('rows with no matched source player always sort to the end', () => {
    const visible = view._getVisibleRows(view._buildRows());
    const orphanIndex = visible.findIndex(r => r.orphan);
    assertEqual(orphanIndex, visible.length - 1, 'the one orphan (ghost-player) is last');
  });
})();

// ── Removal ──────────────────────────────────────────────────────────────
(async () => {
  const { sandbox, nba2kPlayersDocs, nba2k27Docs, firestoreWrites, leagueMainWrites, addPlayerCalls } = makeSandbox();
  seedTypical(nba2kPlayersDocs, nba2k27Docs);
  const view = sandbox.Nba2k27PoolView;
  const container = new FakeElement('root');
  await view.render(container);
  // Render the confirm slot into the container (normally done by
  // `_renderShell`, which this harness's `render()` already ran).
  const row = view._buildRows().find(r => r.slug === 'trae-young');

  await check('remove confirmation renders with the required non-effects listed', () => {
    view._showRemoveConfirm(container, row);
    const confirmEl = container.querySelector('#nba2k27mgmtConfirm');
    assertTruthy(confirmEl.innerHTML.includes('Remove from NBA 2K27 Pool?'));
    assertTruthy(confirmEl.innerHTML.includes('nba2k_players'));
    assertTruthy(confirmEl.innerHTML.includes('Draft Pool'));
    assertTruthy(confirmEl.innerHTML.includes('Season 4'));
    assertTruthy(confirmEl.innerHTML.includes('league/main'));
    assertTruthy(confirmEl.innerHTML.includes('roster'));
  });
  await check('cancel removal performs zero writes', () => {
    const confirmEl = container.querySelector('#nba2k27mgmtConfirm');
    const before = firestoreWrites.length;
    confirmEl.querySelector('#nba2k27mgmtCancelRemoveBtn').onclick();
    assertEqual(firestoreWrites.length, before);
    assertTruthy(sandbox.Nba2kDatabaseView._pool27['trae-young'], 'entry still present after cancel');
  });
  await check('confirm removal performs exactly one delete', async () => {
    view._showRemoveConfirm(container, row);
    const confirmEl = container.querySelector('#nba2k27mgmtConfirm');
    const before = firestoreWrites.length;
    await confirmEl.querySelector('#nba2k27mgmtConfirmRemoveBtn').onclick();
    await tick();
    const newWrites = firestoreWrites.slice(before);
    assertEqual(newWrites.length, 1, 'exactly one write op');
    assertEqual(newWrites[0].action, 'delete');
  });
  await check('delete targets only nba2k27_pool/<slug>', () => {
    const del = firestoreWrites[firestoreWrites.length - 1];
    assertEqual(del.collection, 'nba2k27_pool');
    assertEqual(del.id, 'trae-young');
  });
  await check('source nba2k_players/<slug> remains untouched', () => {
    assertTruthy(nba2kPlayersDocs['trae-young'], 'source doc still present');
    assertEqual(nba2kPlayersDocs['trae-young'].name, 'Trae Young', 'source doc unmodified');
  });
  await check('league/main remains untouched', () => {
    assertEqual(leagueMainWrites.length, 0);
  });
  await check('existing Draft Pool remains untouched (AdminActions.addPlayer never called)', () => {
    assertEqual(addPlayerCalls.length, 0);
  });
  await check('local cache reflects the removal immediately', () => {
    assertNull(sandbox.Nba2kDatabaseView._pool27['trae-young'] || null);
  });
})();

// ── Integrity: orphan + invalid pool ────────────────────────────────────
(async () => {
  const { sandbox, nba2kPlayersDocs, nba2k27Docs } = makeSandbox();
  seedTypical(nba2kPlayersDocs, nba2k27Docs);
  const view = sandbox.Nba2k27PoolView;
  await view.render(new FakeElement('root'));

  await check('orphaned selection is displayed safely, not thrown', () => {
    const row = view._buildRows().find(r => r.slug === 'ghost-player');
    assertTruthy(row.orphan);
    const html = view._renderRow(row);
    assertTruthy(html.includes('Source player not found'));
    assertTruthy(html.includes('ghost-player'));
  });
  await check('orphan is not automatically deleted by rendering', () => {
    assertTruthy(sandbox.Nba2kDatabaseView._pool27['ghost-player'], 'orphan doc still present after render/build/renderRow');
  });
  await check('invalid pool value is detected', () => {
    const row = view._buildRows().find(r => r.slug === 'kobe-classic');
    assertEqual(row.poolValid, false);
    assertEqual(row.poolValue, 'purple');
    const html = view._renderRow(row);
    assertTruthy(html.includes('Invalid Pool'));
  });
  await check('invalid pool value is not silently rewritten', () => {
    // Rendering (build + row HTML) must never touch the stored value.
    view._buildRows();
    view._renderRow(view._buildRows().find(r => r.slug === 'kobe-classic'));
    assertEqual(sandbox.Nba2kDatabaseView._pool27['kobe-classic'].pool, 'purple', 'stored value unchanged');
  });
  await check('invalid pool value never matches a specific pool filter', () => {
    view._filterCategory = '';
    view._search = '';
    view._filterPool = 'blue';
    const visible = view._getVisibleRows(view._buildRows());
    assertTruthy(!visible.some(r => r.slug === 'kobe-classic'), 'kobe-classic (invalid pool) excluded from Blue filter');
    view._filterPool = '';
  });
})();

// ── Regression smoke checks (full suites: tests_p6/, tests_p7/, unmodified) ─
(async () => {
  const { sandbox } = makeSandbox();
  await check('Phase 5 pool derivation intact', () => {
    assertEqual(sandbox.nba2kPoolForTeamType('curr'), 'green');
    assertEqual(sandbox.nba2kPoolForTeamType('class'), 'blue');
    assertEqual(sandbox.nba2kPoolForTeamType('allt'), 'blue');
    assertNull(sandbox.nba2kPoolForTeamType('bogus'));
  });
  await check('Phase 6 position normalization intact', () => {
    assertEqual(JSON.stringify(sandbox.normalizeNba2kPositions(['PF', 'C', 'PF'])), JSON.stringify(['PF', 'C']));
    assertEqual(JSON.stringify(sandbox.normalizeNba2kPositions(['bogus'])), JSON.stringify([]));
  });
  await check('Phase 2/7 database view still exposes its filtering entry point', () => {
    assertTruthy(typeof sandbox.Nba2kDatabaseView._getVisiblePlayers === 'function');
  });
})();

// ── Cross-view cache hook: shared modal write refreshes this view ───────
(async () => {
  const { sandbox, nba2kPlayersDocs, nba2k27Docs } = makeSandbox();
  seedTypical(nba2kPlayersDocs, nba2k27Docs);
  const view = sandbox.Nba2k27PoolView;
  const container = new FakeElement('root');
  await view.render(container); // sets Nba2kDatabaseView._onPool27Changed

  await check('_onPool27Changed hook is registered while this view is open', () => {
    assertTruthy(typeof sandbox.Nba2kDatabaseView._onPool27Changed === 'function');
  });
  await check('invoking the hook re-renders this view\'s list without a re-fetch', () => {
    // Mutate the shared cache directly (as Nba2kDatabaseView._bind2k27Events
    // does after its own successful write) and fire the hook.
    sandbox.Nba2kDatabaseView._pool27['lebron-james'] = { nba2kRef: 'lebron-james', pool: 'green', selectedAt: 'x', updatedAt: 'x' };
    sandbox.Nba2kDatabaseView._onPool27Changed();
    const wrap = container.querySelector('#nba2k27mgmtListWrap');
    assertTruthy(wrap.innerHTML.length > 0, 're-render produced list markup');
    assertTruthy(view._buildRows().some(r => r.slug === 'lebron-james'), 'new selection visible via shared cache');
  });
})();

setTimeout(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}, 500);
