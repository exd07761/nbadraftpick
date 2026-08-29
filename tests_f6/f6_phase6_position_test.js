'use strict';
/**
 * Phase 6 test suite — NBA2K position management.
 *
 * Two layers:
 *  1. Pure-function tests (normalizeNba2kPositions / nba2kPositionsEqual /
 *     nba2kPositionStatus) — no DOM, no Firestore.
 *  2. End-to-end tests that load the real js/admin/nba2k-database.js into
 *     a jsdom document, wire up a tiny in-memory Firestore mock, render
 *     the actual detail modal, click the actual checkboxes/buttons, and
 *     assert on the actual DOM + mock Firestore state.
 *
 * Run with: node tests_f6/f6_phase6_position_test.js
 * Requires the `jsdom` package (installed via `npm install --no-save jsdom`).
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const SRC_PATH = path.join(__dirname, '..', 'js', 'admin', 'nba2k-database.js');
const UTILS_PATH = path.join(__dirname, '..', 'js', 'shared-utils.js');
const src = fs.readFileSync(SRC_PATH, 'utf8');
const utilsSrc = fs.readFileSync(UTILS_PATH, 'utf8');

let pass = 0, fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ok - ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL - ${name}`);
    console.log(`         ${e.stack || e.message}`);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok - ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL - ${name}`);
    console.log(`         ${e.stack || e.message}`);
  }
}
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg || 'assertion failed'}: expected ${b}, got ${a}`);
}
function ok(cond, msg) {
  if (!cond) throw new Error(msg || 'expected truthy value');
}

// ─── Mock Firestore ─────────────────────────────────────────────────────
function makeFirestoreMock(initialDocs) {
  const store = new Map(Object.entries(initialDocs).map(([k, v]) => [k, { ...v }]));
  let getCalls = 0, updateCalls = 0;
  let failNextGetWith = null;
  let failNextUpdateWith = null;
  const mock = {
    collection(name) {
      if (name !== 'nba2k_players') throw new Error('unexpected collection ' + name);
      return {
        get: async () => ({
          docs: Array.from(store.entries()).map(([id, data]) => ({ id, data: () => ({ ...data }) })),
        }),
        doc(slug) {
          return {
            get: async () => {
              getCalls++;
              if (failNextGetWith) { const e = failNextGetWith; failNextGetWith = null; throw e; }
              const data = store.get(slug);
              return { exists: !!data, data: () => (data ? { ...data } : undefined) };
            },
            update: async (fields) => {
              updateCalls++;
              if (failNextUpdateWith) { const e = failNextUpdateWith; failNextUpdateWith = null; throw e; }
              if (!store.has(slug)) { const e = new Error('no doc'); e.code = 'not-found'; throw e; }
              store.set(slug, { ...store.get(slug), ...fields });
            },
          };
        },
      };
    },
    _store: store,
    _getCalls: () => getCalls,
    _updateCalls: () => updateCalls,
    _failNextGet: (err) => { failNextGetWith = err; },
    _failNextUpdate: (err) => { failNextUpdateWith = err; },
  };
  return mock;
}

function samplePlayers() {
  return {
    'trae-young': {
      name: 'Trae Young', team: 'Atlanta Hawks', teamType: 'curr', overall: 91,
      positions: ['PG'], attributes: { closeShot: 80 }, badges: { list: [] },
      height: '6\'1"', weight: '164 lbs', wingspan: '6\'3"', build: 'Balanced',
      playerUrl: 'x', playerImage: '', teamImg: '', lastUpdated: 111,
    },
    'kristaps-porzingis': {
      name: 'Kristaps Porzingis', team: 'Boston Celtics', teamType: 'curr', overall: 88,
      positions: ['C', 'PF'], attributes: {}, badges: { list: [] },
      height: '7\'2"', weight: '240 lbs', wingspan: '7\'6"', build: 'Balanced',
      playerUrl: 'x', playerImage: '', teamImg: '', lastUpdated: 111,
    },
    'nique-clifford': {
      name: 'Nique Clifford', team: 'Sacramento Kings', teamType: 'curr', overall: 74,
      positions: ['SG', 'SF'], attributes: {}, badges: { list: [] },
      height: '6\'6"', weight: '210 lbs', wingspan: '6\'9"', build: 'Balanced',
      playerUrl: 'x', playerImage: '', teamImg: '', lastUpdated: 111,
    },
    'classic-1': {
      name: 'Classic Test Player', team: 'Old Team', teamType: 'class', overall: 85,
      positions: ['SF'], attributes: {}, badges: { list: [] },
      playerUrl: 'x', playerImage: '', teamImg: '', lastUpdated: 111,
    },
    'allt-1': {
      name: 'All-Time Test Player', team: 'Legends', teamType: 'allt', overall: 95,
      positions: ['PF', 'C'], attributes: {}, badges: { list: [] },
      playerUrl: 'x', playerImage: '', teamImg: '', lastUpdated: 111,
    },
    'already-promoted-1': {
      name: 'Already Promoted Guy', team: 'Some Team', teamType: 'curr', overall: 80,
      positions: ['C', 'PF'], attributes: {}, badges: { list: [] },
      playerUrl: 'x', playerImage: '', teamImg: '', lastUpdated: 111,
    },
  };
}

function makeSandbox(firestoreMock, leaguePlayers) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://example.test/' });
  const window = dom.window;

  window.firebase = { firestore: () => firestoreMock };
  window.LeagueData = { getAllPlayers: () => leaguePlayers };
  window.AdminActions = { addPlayer: () => { throw new Error('addPlayer should not be called by Phase 6 tests'); } };
  window.AuthBoundary = { requireAuth: () => {} };
  window.showToast = () => {};
  window.normalizePlayerName = (n) => String(n || '').trim().toLowerCase();

  vm.createContext(window);
  vm.runInContext(utilsSrc, window, { filename: 'shared-utils.js' });
  vm.runInContext(src, window, { filename: 'nba2k-database.js' });
  vm.runInContext(
    'this.Nba2kDatabaseView = Nba2kDatabaseView; ' +
    'this.normalizeNba2kPositions = normalizeNba2kPositions; ' +
    'this.nba2kPositionsEqual = nba2kPositionsEqual; ' +
    'this.nba2kPositionStatus = nba2kPositionStatus; ' +
    'this.NBA2K_VALID_POSITIONS = NBA2K_VALID_POSITIONS; ' +
    'this.escapeHtml = escapeHtml;',
    window,
    { filename: 'export.js' }
  );

  return { window, document: window.document };
}

async function run() {
  console.log('Phase 6 — pure function tests');
  {
    const { window } = makeSandbox(makeFirestoreMock({}), []);
    const { normalizeNba2kPositions, nba2kPositionsEqual, nba2kPositionStatus } = window;

    check('dedupes and orders canonically: ["PF","C","PF"] -> ["PF","C"]', () => {
      eq(normalizeNba2kPositions(['PF', 'C', 'PF']), ['PF', 'C']);
    });
    check('dedupes and orders canonically: ["SG","PG"] -> ["PG","SG"]', () => {
      eq(normalizeNba2kPositions(['SG', 'PG']), ['PG', 'SG']);
    });
    check('full canonical ordering: ["PF","PG","C"] -> ["PG","PF","C"]', () => {
      eq(normalizeNba2kPositions(['PF', 'PG', 'C']), ['PG', 'PF', 'C']);
    });
    check('canonical ordering: ["SG","C","PG","PF"] -> ["PG","SG","PF","C"]', () => {
      eq(normalizeNba2kPositions(['SG', 'C', 'PG', 'PF']), ['PG', 'SG', 'PF', 'C']);
    });
    check('rejects invalid values: ["PG","G","XYZ"] -> ["PG"]', () => {
      eq(normalizeNba2kPositions(['PG', 'G', 'XYZ']), ['PG']);
    });
    check('empty/garbage input normalizes to []', () => {
      eq(normalizeNba2kPositions(undefined), []);
      eq(normalizeNba2kPositions(null), []);
      eq(normalizeNba2kPositions('not-an-array'), []);
      eq(normalizeNba2kPositions([]), []);
    });
    check('never produces duplicates even with many repeats', () => {
      eq(normalizeNba2kPositions(['C', 'C', 'C', 'PF', 'PF']), ['PF', 'C']);
    });
    check('nba2kPositionsEqual compares after normalizing both sides', () => {
      ok(nba2kPositionsEqual(['PF', 'C', 'PF'], ['PF', 'C']));
      ok(nba2kPositionsEqual([], []));
      ok(!nba2kPositionsEqual(['PG'], ['SG']));
      ok(!nba2kPositionsEqual(['PG'], []));
    });
    check('nba2kPositionStatus: complete when >=1 position', () => {
      eq(nba2kPositionStatus(['PG']).cls, 'ok');
      eq(nba2kPositionStatus(['PG']).label, 'Position data complete');
    });
    check('nba2kPositionStatus: missing when 0 positions', () => {
      eq(nba2kPositionStatus([]).cls, 'warn');
      eq(nba2kPositionStatus(undefined).cls, 'warn');
      eq(nba2kPositionStatus([]).label, 'Position missing');
    });
  }

  console.log('\nPhase 6 — end-to-end UI + Firestore tests');

  // Helper: fresh view instance per scenario so `_players`/filters never
  // leak between tests (module-level cache is intentionally session-long
  // in the real app, but each test wants an isolated session).
  function freshView(window) {
    // Nba2kDatabaseView is a shared object literal — reset its mutable
    // state exactly like a fresh page load would.
    const V = window.Nba2kDatabaseView;
    V._players = null;
    V._loadPromise = null;
    V._loadError = null;
    V._search = '';
    V._filterPos = '';
    V._filterTeam = '';
    V._filterOvr = '';
    V._filterCategory = '';
    V._sortMode = 'ovr-desc';
    return V;
  }

  async function loadedView({ leaguePlayers = [], firestoreMock } = {}) {
    const fsMock = firestoreMock || makeFirestoreMock(samplePlayers());
    const { window, document } = makeSandbox(fsMock, leaguePlayers);
    const V = freshView(window);
    const container = document.createElement('div');
    document.body.appendChild(container);
    await V._load(container);
    return { window, document, V, container, fsMock };
  }

  function openDetail(window, document, V, container, slug) {
    V._openDetail(container, slug);
    return document.getElementById('nba2kDetailMount');
  }

  function checkboxFor(mount, pos) {
    return Array.from(mount.querySelectorAll('.nba2k-posedit input[type="checkbox"]'))
      .find(c => c.value === pos);
  }

  await checkAsync('1. single-position player: SG -> PG saves correctly', async () => {
    const { window, document, V, container, fsMock } = await loadedView();
    const mount = openDetail(window, document, V, container, 'nique-clifford');
    // starts as ["SG","SF"]; uncheck both, check PG only
    checkboxFor(mount, 'SG').checked = false;
    checkboxFor(mount, 'SF').checked = false;
    checkboxFor(mount, 'PG').checked = true;
    mount.querySelector('#nba2kPosSaveBtn').click();
    mount.querySelector('#nba2kPosConfirmBtn').click();
    await new Promise(r => setTimeout(r, 0));
    eq(fsMock._store.get('nique-clifford').positions, ['PG']);
  });

  await checkAsync('2. multi-position player: [C,PF] -> [PF]', async () => {
    const { window, document, V, container, fsMock } = await loadedView();
    const mount = openDetail(window, document, V, container, 'kristaps-porzingis');
    checkboxFor(mount, 'C').checked = false;
    mount.querySelector('#nba2kPosSaveBtn').click();
    mount.querySelector('#nba2kPosConfirmBtn').click();
    await new Promise(r => setTimeout(r, 0));
    eq(fsMock._store.get('kristaps-porzingis').positions, ['PF']);
  });

  await checkAsync('3. add a position: [PG] -> [PG,SG]', async () => {
    const { window, document, V, container, fsMock } = await loadedView();
    const mount = openDetail(window, document, V, container, 'trae-young');
    checkboxFor(mount, 'SG').checked = true;
    mount.querySelector('#nba2kPosSaveBtn').click();
    mount.querySelector('#nba2kPosConfirmBtn').click();
    await new Promise(r => setTimeout(r, 0));
    eq(fsMock._store.get('trae-young').positions, ['PG', 'SG']);
  });

  await checkAsync('4. remove a position: [PG,SG] -> [PG]', async () => {
    const fsMock = makeFirestoreMock({ ...samplePlayers(), 'trae-young': { ...samplePlayers()['trae-young'], positions: ['PG', 'SG'] } });
    const { window, document, V, container } = await loadedView({ firestoreMock: fsMock });
    const mount = openDetail(window, document, V, container, 'trae-young');
    checkboxFor(mount, 'SG').checked = false;
    mount.querySelector('#nba2kPosSaveBtn').click();
    mount.querySelector('#nba2kPosConfirmBtn').click();
    await new Promise(r => setTimeout(r, 0));
    eq(fsMock._store.get('trae-young').positions, ['PG']);
  });

  await checkAsync('5. duplicate checkbox values never produce duplicates in storage', () => {
    // Structural guarantee: only 5 checkboxes exist (PG/SG/SF/PF/C), each
    // with a distinct value, and normalizeNba2kPositions dedupes via a
    // Set — covered directly at the pure-function layer above. Here we
    // additionally confirm the rendered editor never renders duplicate
    // checkbox values for any player.
    return loadedView().then(({ window, document, V, container }) => {
      const mount = openDetail(window, document, V, container, 'kristaps-porzingis');
      const values = Array.from(mount.querySelectorAll('.nba2k-posedit input[type="checkbox"]')).map(c => c.value);
      eq(values, ['PG', 'SG', 'SF', 'PF', 'C']);
      eq(new Set(values).size, values.length);
    });
  });

  await checkAsync('6. canonical ordering enforced on save: select PF,PG,C -> stored as [PG,PF,C]', async () => {
    const { window, document, V, container, fsMock } = await loadedView();
    const mount = openDetail(window, document, V, container, 'trae-young'); // starts ["PG"]
    checkboxFor(mount, 'PG').checked = true;
    checkboxFor(mount, 'C').checked = true;
    checkboxFor(mount, 'PF').checked = true;
    mount.querySelector('#nba2kPosSaveBtn').click();
    mount.querySelector('#nba2kPosConfirmBtn').click();
    await new Promise(r => setTimeout(r, 0));
    eq(fsMock._store.get('trae-young').positions, ['PG', 'PF', 'C']);
  });

  await checkAsync('7. empty selection is blocked, zero writes', async () => {
    const { window, document, V, container, fsMock } = await loadedView();
    const mount = openDetail(window, document, V, container, 'trae-young');
    checkboxFor(mount, 'PG').checked = false;
    mount.querySelector('#nba2kPosSaveBtn').click();
    ok(mount.querySelector('#nba2kPosResult').textContent.includes('You must select at least one position.'));
    eq(fsMock._updateCalls(), 0);
    eq(fsMock._store.get('trae-young').positions, ['PG']); // unchanged
  });

  await checkAsync('8. invalid position values are rejected and never written', async () => {
    // The rendered editor only ever offers 5 checkboxes (PG/SG/SF/PF/C),
    // so an invalid value like "G" or "XYZ" can only reach the save path
    // via a tampered DOM/request — normalizeNba2kPositions() is the
    // choke point that guarantees it's dropped either way. Exercise the
    // full save flow with a forged extra checkbox to prove the save
    // handler itself (not just the pure function in isolation) drops it.
    const { window, document, V, container, fsMock } = await loadedView();
    const mount = openDetail(window, document, V, container, 'trae-young');
    const forged = document.createElement('input');
    forged.type = 'checkbox';
    forged.value = 'XYZ';
    forged.checked = true;
    mount.querySelector('.nba2k-posedit-checks').appendChild(forged);
    checkboxFor(mount, 'SG').checked = true;
    mount.querySelector('#nba2kPosSaveBtn').click();
    mount.querySelector('#nba2kPosConfirmBtn').click();
    await new Promise(r => setTimeout(r, 0));
    eq(fsMock._store.get('trae-young').positions, ['PG', 'SG'], 'forged "XYZ" checkbox value must never reach storage');
    // And directly at the normalization choke point itself:
    eq(window.normalizeNba2kPositions(['PG', 'G', 'XYZ']), ['PG']);
  });

  await checkAsync('9. no-change save performs zero Firestore writes', async () => {
    const { window, document, V, container, fsMock } = await loadedView();
    const mount = openDetail(window, document, V, container, 'trae-young'); // ["PG"]
    // leave selection identical
    mount.querySelector('#nba2kPosSaveBtn').click();
    ok(mount.querySelector('#nba2kPosResult').textContent.includes('No position changes to save.'));
    eq(fsMock._updateCalls(), 0);
  });

  await checkAsync('10. source data integrity: unrelated fields untouched after a position edit', async () => {
    const { window, document, V, container, fsMock } = await loadedView();
    const before = { ...fsMock._store.get('trae-young') };
    const mount = openDetail(window, document, V, container, 'trae-young');
    checkboxFor(mount, 'SG').checked = true;
    mount.querySelector('#nba2kPosSaveBtn').click();
    mount.querySelector('#nba2kPosConfirmBtn').click();
    await new Promise(r => setTimeout(r, 0));
    const after = fsMock._store.get('trae-young');
    for (const key of ['name', 'team', 'teamType', 'overall', 'attributes', 'badges', 'height', 'weight', 'wingspan', 'build', 'playerUrl', 'playerImage', 'teamImg', 'lastUpdated']) {
      eq(after[key], before[key], `field "${key}" changed`);
    }
  });

  await checkAsync('11/12/13. pool eligibility unaffected by position edits (curr/class/allt)', async () => {
    for (const [slug, teamType] of [['trae-young', 'curr'], ['classic-1', 'class'], ['allt-1', 'allt']]) {
      const { window, document, V, container, fsMock } = await loadedView();
      const mount = openDetail(window, document, V, container, slug);
      // toggle something to force a real change
      const cb = mount.querySelectorAll('.nba2k-posedit input[type="checkbox"]');
      const wasChecked = Array.from(cb).find(c => c.checked);
      const target = Array.from(cb).find(c => !c.checked);
      if (target) target.checked = true;
      else wasChecked.checked = false; // fall back: uncheck one if all were checked (won't happen with sample data)
      mount.querySelector('#nba2kPosSaveBtn').click();
      const confirmBtn = mount.querySelector('#nba2kPosConfirmBtn');
      if (confirmBtn) confirmBtn.click();
      await new Promise(r => setTimeout(r, 0));
      eq(fsMock._store.get(slug).teamType, teamType, `teamType must not change for ${slug}`);
    }
  });

  await checkAsync('14. existing promoted player: source edit does NOT change Draft Pool position', async () => {
    const leaguePlayers = [{ name: 'Already Promoted Guy', position: 'PF', pool: 'green', overall: 80, nba2kRef: 'already-promoted-1' }];
    const { window, document, V, container, fsMock } = await loadedView({ leaguePlayers });
    const mount = openDetail(window, document, V, container, 'already-promoted-1'); // source ["C","PF"]
    checkboxFor(mount, 'C').checked = false; // -> ["PF"] wait that's same as draft pool but different from source
    mount.querySelector('#nba2kPosSaveBtn').click();
    mount.querySelector('#nba2kPosConfirmBtn').click();
    await new Promise(r => setTimeout(r, 0));
    eq(fsMock._store.get('already-promoted-1').positions, ['PF']);
    // The league/main-side object is untouched — this test's leaguePlayers
    // array (standing in for league/main.players) is never written to by
    // Phase 6 code at all.
    eq(leaguePlayers[0].position, 'PF');
    eq(leaguePlayers[0].nba2kRef, 'already-promoted-1');
  });

  await checkAsync('15/16. future promotion dropdown uses corrected positions, still requires explicit choice', async () => {
    const { window, document, V, container, fsMock } = await loadedView();
    let mount = openDetail(window, document, V, container, 'kristaps-porzingis'); // ["C","PF"]
    checkboxFor(mount, 'C').checked = false; // -> ["PF"]
    mount.querySelector('#nba2kPosSaveBtn').click();
    mount.querySelector('#nba2kPosConfirmBtn').click();
    await new Promise(r => setTimeout(r, 0));
    // _openDetail was called again internally after save; re-fetch mount fresh
    mount = document.getElementById('nba2kDetailMount');
    const promoSelect = mount.querySelector('#nba2kPromoPosition');
    const options = Array.from(promoSelect.querySelectorAll('option')).map(o => o.value).filter(Boolean);
    eq(options, ['PF']);
    eq(promoSelect.value, '', 'promotion position must not be auto-selected');
  });

  await checkAsync('17. search/filter regression: position filter reflects updated data', async () => {
    const { window, document, V, container, fsMock } = await loadedView();
    let mount = openDetail(window, document, V, container, 'kristaps-porzingis'); // ["C","PF"]
    checkboxFor(mount, 'C').checked = false; // -> ["PF"]
    mount.querySelector('#nba2kPosSaveBtn').click();
    mount.querySelector('#nba2kPosConfirmBtn').click();
    await new Promise(r => setTimeout(r, 0));

    V._filterPos = 'C';
    let visible = V._getVisiblePlayers().map(p => p.id);
    ok(!visible.includes('kristaps-porzingis'), 'should no longer match position filter C');

    V._filterPos = 'PF';
    visible = V._getVisiblePlayers().map(p => p.id);
    ok(visible.includes('kristaps-porzingis'), 'should match position filter PF');
  });

  await checkAsync('18. category regression: counts unaffected by position edits', async () => {
    const players = {};
    for (let i = 0; i < 528; i++) players[`curr-${i}`] = { name: `Curr ${i}`, teamType: 'curr', overall: 70, positions: ['PG'] };
    for (let i = 0; i < 774; i++) players[`class-${i}`] = { name: `Class ${i}`, teamType: 'class', overall: 70, positions: ['SG'] };
    for (let i = 0; i < 455; i++) players[`allt-${i}`] = { name: `Allt ${i}`, teamType: 'allt', overall: 70, positions: ['C'] };
    const fsMock = makeFirestoreMock(players);
    const { window, document, V, container } = await loadedView({ firestoreMock: fsMock });
    const mount = openDetail(window, document, V, container, 'curr-0');
    checkboxFor(mount, 'SG').checked = true;
    mount.querySelector('#nba2kPosSaveBtn').click();
    mount.querySelector('#nba2kPosConfirmBtn').click();
    await new Promise(r => setTimeout(r, 0));

    const all = V._players;
    eq(all.length, 1757);
    eq(all.filter(p => p.teamType === 'curr').length, 528);
    eq(all.filter(p => p.teamType === 'class').length, 774);
    eq(all.filter(p => p.teamType === 'allt').length, 455);
  });

  await checkAsync('19. attributes/badges regression: detail modal still shows them after edit', async () => {
    const { window, document, V, container } = await loadedView();
    let mount = openDetail(window, document, V, container, 'trae-young');
    checkboxFor(mount, 'SG').checked = true;
    mount.querySelector('#nba2kPosSaveBtn').click();
    mount.querySelector('#nba2kPosConfirmBtn').click();
    await new Promise(r => setTimeout(r, 0));
    mount = document.getElementById('nba2kDetailMount');
    ok(mount.querySelector('.nba2k-attr-groups'), 'attribute groups still render');
    ok(mount.querySelector('.nba2k-badges-section'), 'badges section still renders');
  });

  await checkAsync('20. duplicate-protection regression: name conflict still blocks promotion', async () => {
    const leaguePlayers = [{ name: 'Trae Young', position: 'PG', pool: 'green', overall: 90 }]; // no nba2kRef -> conflict
    const { window, document, V, container } = await loadedView({ leaguePlayers });
    const mount = openDetail(window, document, V, container, 'trae-young');
    ok(mount.textContent.includes('An existing Draft Pool player with this name already exists'));
    ok(!mount.querySelector('#nba2kPromoOpenConfirm'), 'promotion form must not render on name conflict');
  });

  await checkAsync('21. unknown teamType regression: promotion still blocked, position editor still works', async () => {
    const fsMock = makeFirestoreMock({ 'weird-1': { name: 'Weird Guy', teamType: 'wat', overall: 70, positions: ['PG'] } });
    const { window, document, V, container } = await loadedView({ firestoreMock: fsMock });
    const mount = openDetail(window, document, V, container, 'weird-1');
    ok(mount.textContent.includes('Cannot determine pool eligibility'));
    // Position editor is independent of pool determinability.
    ok(mount.querySelector('.nba2k-posedit'), 'position editor should still render');
  });

  await checkAsync('22. permission error surfaces a friendly message', async () => {
    const { window, document, V, container, fsMock } = await loadedView();
    const mount = openDetail(window, document, V, container, 'trae-young');
    checkboxFor(mount, 'SG').checked = true;
    mount.querySelector('#nba2kPosSaveBtn').click();
    const err = new Error('permission denied raw firebase text');
    err.code = 'permission-denied';
    fsMock._failNextGet(err);
    mount.querySelector('#nba2kPosConfirmBtn').click();
    await new Promise(r => setTimeout(r, 0));
    const text = mount.querySelector('#nba2kPosResult').textContent;
    ok(text.includes("don't have permission"), 'should show friendly permission message');
    ok(!text.includes('raw firebase text'), 'must not leak raw Firebase error text');
  });

  await checkAsync('23. network/update failure does not falsely report success', async () => {
    const { window, document, V, container, fsMock } = await loadedView();
    const mount = openDetail(window, document, V, container, 'trae-young');
    checkboxFor(mount, 'SG').checked = true;
    mount.querySelector('#nba2kPosSaveBtn').click();
    const err = new Error('network down');
    fsMock._failNextUpdate(err);
    mount.querySelector('#nba2kPosConfirmBtn').click();
    await new Promise(r => setTimeout(r, 0));
    const text = mount.querySelector('#nba2kPosResult').textContent;
    ok(text.includes('Unable to save positions'), 'should show friendly failure message');
    eq(fsMock._store.get('trae-young').positions, ['PG'], 'stored value must remain unchanged on failure');
  });

  await checkAsync('23b. concurrent edit protection: server changed since editor opened -> blocked', async () => {
    const { window, document, V, container, fsMock } = await loadedView();
    const mount = openDetail(window, document, V, container, 'trae-young'); // opened with ["PG"]
    // Simulate another admin session changing it in the meantime.
    fsMock._store.set('trae-young', { ...fsMock._store.get('trae-young'), positions: ['SG'] });
    checkboxFor(mount, 'PF').checked = true; // local selection now ["PG","PF"]
    mount.querySelector('#nba2kPosSaveBtn').click();
    mount.querySelector('#nba2kPosConfirmBtn').click();
    await new Promise(r => setTimeout(r, 0));
    const text = mount.querySelector('#nba2kPosResult').textContent;
    ok(text.includes('updated elsewhere'), 'should warn about concurrent update');
    eq(fsMock._store.get('trae-young').positions, ['SG'], 'the other session\'s write must survive, not be overwritten');
    eq(fsMock._updateCalls(), 0, 'no update should have been attempted');
  });

  await checkAsync('missing document is handled with a friendly message', async () => {
    const fsMock = makeFirestoreMock({});
    // Load with a players list seeded manually (bypassing collection.get()
    // shape) to simulate a stale in-memory row whose doc has since been
    // deleted server-side.
    const { window, document } = makeSandbox(fsMock, []);
    const V = freshView(window);
    V._players = [{ id: 'ghost-1', name: 'Ghost Player', teamType: 'curr', overall: 70, positions: ['PG'], attributes: {}, badges: { list: [] } }];
    const container = document.createElement('div');
    document.body.appendChild(container);
    V._renderShell(container);
    const mount = openDetail(window, document, V, container, 'ghost-1');
    checkboxFor(mount, 'SG').checked = true;
    mount.querySelector('#nba2kPosSaveBtn').click();
    mount.querySelector('#nba2kPosConfirmBtn').click();
    await new Promise(r => setTimeout(r, 0));
    const text = mount.querySelector('#nba2kPosResult').textContent;
    ok(text.includes('could not be found'));
  });

  await checkAsync('24. zero writes to league/main from position editing', async () => {
    const leaguePlayers = [];
    const originalLeaguePlayers = JSON.stringify(leaguePlayers);
    const { window, document, V, container } = await loadedView({ leaguePlayers });
    const mount = openDetail(window, document, V, container, 'trae-young');
    checkboxFor(mount, 'SG').checked = true;
    mount.querySelector('#nba2kPosSaveBtn').click();
    mount.querySelector('#nba2kPosConfirmBtn').click();
    await new Promise(r => setTimeout(r, 0));
    eq(JSON.stringify(leaguePlayers), originalLeaguePlayers, 'AdminActions.addPlayer must never be invoked by position edits');
  });

  await checkAsync('Data-quality indicator: complete vs missing, never inferred from other fields', async () => {
    const fsMock = makeFirestoreMock({
      'no-pos-1': { name: 'No Position Guy', teamType: 'curr', overall: 99, positions: [], attributes: {}, badges: { list: [] } },
    });
    const { window, document, V, container } = await loadedView({ firestoreMock: fsMock });
    const mount = openDetail(window, document, V, container, 'no-pos-1');
    ok(mount.querySelector('.nba2k-posedit-quality-warn'), 'should flag missing position data even for a 99 OVR player');
    ok(mount.textContent.includes('Position missing'));
  });

  await checkAsync('Position status display distinguishes source vs Draft Pool position', async () => {
    const leaguePlayers = [{ name: 'Already Promoted Guy', position: 'PF', pool: 'green', overall: 80, nba2kRef: 'already-promoted-1' }];
    const { window, document, V, container } = await loadedView({ leaguePlayers });
    const mountUnpromoted = openDetail(window, document, V, container, 'trae-young');
    ok(mountUnpromoted.textContent.includes('Not yet promoted'));
    const mountPromoted = openDetail(window, document, V, container, 'already-promoted-1');
    ok(mountPromoted.textContent.includes('NBA2K Source Positions'));
    ok(mountPromoted.textContent.includes('Draft Pool Position'));
    // Draft pool position (PF) shown distinctly from source ["C","PF"]
    const row = Array.from(mountPromoted.querySelectorAll('.nba2k-posedit-status-row')).find(r => r.textContent.includes('Draft Pool Position'));
    ok(row.textContent.includes('PF'));
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

run();
