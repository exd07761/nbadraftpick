'use strict';
/**
 * Phase 13 tests — Manual Edit (display overrides) + Variant grouping.
 *
 * Covers js/admin/nba2k-database.js (Nba2k27PoolView._openManualEdit and
 * the new nba2k27EffectiveName/Overall/Team/VariantGroupOf/VariantLabelOf
 * helpers) and js/views/nba2k27.js (the same effective-value/variant
 * fields, read-only).
 *
 * Same vm-sandbox pattern as tests_p7–p12: real source files run
 * unmodified inside a fake DOM + in-memory fake Firestore.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const dbSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'admin', 'nba2k-database.js'), 'utf8');
const publicSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'views', 'nba2k27.js'), 'utf8');
const sharedUtilsSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'shared-utils.js'), 'utf8');

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
    this.dataset = {};
  }
  set innerHTML(html) {
    this._html = html;
    const re = /id="([^"]+)"/g;
    let m;
    while ((m = re.exec(html))) { if (!this._registry.has(m[1])) new FakeElement(m[1], this._registry); }
  }
  get innerHTML() { return this._html; }
  querySelector(sel) {
    const idMatch = /^#([\w-]+)$/.exec(sel.trim());
    if (idMatch) return this._registry.get(idMatch[1]) || null;
    return null;
  }
  querySelectorAll() { return []; }
  addEventListener() {}
  setAttribute() {}
  get value() { return this._value || ''; }
  set value(v) { this._value = v; }
}

function makeAdminSandbox() {
  const nba2kPlayersDocs = {};
  const nba2k27Docs = {};
  const nba2kPlayersWrites = [];
  const leagueMainWrites = [];

  function makeDocRef(collectionName, id) {
    return {
      id,
      set: (data, options) => {
        const merge = !!(options && options.merge);
        if (collectionName === 'nba2k_players') { nba2kPlayersWrites.push({ id, data }); return Promise.resolve(); }
        if (collectionName === 'league') { leagueMainWrites.push({ id, data }); return Promise.resolve(); }
        if (collectionName === 'nba2k27_pool') {
          const del = 'DELETE_SENTINEL';
          const existing = nba2k27Docs[id] || {};
          const merged = merge ? { ...existing } : {};
          Object.keys(data).forEach(k => {
            if (data[k] === del) delete merged[k]; else merged[k] = data[k];
          });
          nba2k27Docs[id] = merged;
        }
        return Promise.resolve();
      },
      delete: () => { delete nba2k27Docs[id]; return Promise.resolve(); },
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
    AdminActions: { addPlayer: () => { throw new Error('should never be called'); } },
    NBA2K_OVERALL_FILTERS: [],
    CORE_POSITIONS: ['PG', 'SG', 'SF', 'PF', 'C'],
    firebase: {
      firestore: () => ({
        collection: (name) => ({
          get: () => {
            if (name === 'nba2k_players') return Promise.resolve({ docs: Object.keys(nba2kPlayersDocs).map(id => ({ id, data: () => nba2kPlayersDocs[id] })) });
            if (name === 'nba2k27_pool') return Promise.resolve({ docs: Object.keys(nba2k27Docs).map(id => ({ id, data: () => nba2k27Docs[id] })) });
            return Promise.resolve({ docs: [] });
          },
          doc: (id) => makeDocRef(name, id),
        }),
        batch: () => ({ set() {}, commit() { return Promise.resolve(); } }),
      }),
    },
  };
  sandbox.firebase.firestore.FieldValue = { delete: () => 'DELETE_SENTINEL' };
  vm.createContext(sandbox);
  vm.runInContext(sharedUtilsSrc, sandbox, { filename: 'shared-utils.js' });
  vm.runInContext(dbSrc, sandbox, { filename: 'nba2k-database.js' });
  vm.runInContext('this.Nba2k27PoolView = Nba2k27PoolView;', sandbox, { filename: 'export.js' });
  return { sandbox, nba2kPlayersDocs, nba2k27Docs, nba2kPlayersWrites, leagueMainWrites };
}

function makePublicSandbox() {
  const nba2kPlayersDocs = {};
  const nba2k27Docs = {};
  const writes = [];
  const sandbox = {
    console,
    document: { body: { contains: () => true } },
    escapeHtml: (s) => String(s),
    CORE_POSITIONS: ['PG', 'SG', 'SF', 'PF', 'C'],
    firebase: {
      firestore: () => ({
        collection: (name) => ({
          get: () => name === 'nba2k27_pool'
            ? Promise.resolve({ docs: Object.keys(nba2k27Docs).map(id => ({ id, data: () => nba2k27Docs[id] })) })
            : Promise.resolve({ docs: [] }),
          where: (fp, op, values) => ({
            get: () => Promise.resolve({ docs: values.filter(id => nba2kPlayersDocs[id]).map(id => ({ id, data: () => nba2kPlayersDocs[id] })) }),
          }),
          doc: (id) => ({
            set: (d) => { writes.push({ collection: name, id, data: d }); return Promise.resolve(); },
            update: (d) => { writes.push({ collection: name, id, data: d }); return Promise.resolve(); },
            delete: () => { writes.push({ collection: name, id, action: 'delete' }); return Promise.resolve(); },
          }),
        }),
      }),
    },
  };
  sandbox.firebase.firestore.FieldPath = { documentId: () => '__ID__' };
  vm.createContext(sandbox);
  vm.runInContext(sharedUtilsSrc, sandbox, { filename: 'shared-utils.js' });
  vm.runInContext(publicSrc, sandbox, { filename: 'nba2k27.js' });
  vm.runInContext('this.PublicNba2k27View = PublicNba2k27View;', sandbox, { filename: 'export.js' });
  return { sandbox, nba2kPlayersDocs, nba2k27Docs, writes };
}

let pass = 0, fail = 0;
function check(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { pass++; console.log(`  ok - ${name}`); })
    .catch(e => { fail++; console.log(`  FAIL - ${name}`); console.log(`         ${e.stack || e.message}`); });
}
function assertEqual(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || 'assertion failed'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function assertTruthy(actual, msg) { if (!actual) throw new Error(msg || `expected truthy, got ${JSON.stringify(actual)}`); }

console.log('Phase 13 tests — Manual Edit + Variant grouping');

// Helper: drive Manual Edit's save handler directly against a rendered form.
async function saveManualEdit(view, container, slug, { name = '', overall = '', team = '', position, variantGroup = '', variantLabel = '' }) {
  view._openManualEdit(container, slug);
  const editEl = container.querySelector('#nba2k27mgmtEdit');
  editEl.querySelector('#nba2k27EditName').value = name;
  editEl.querySelector('#nba2k27EditOverall').value = overall;
  editEl.querySelector('#nba2k27EditTeam').value = team;
  const posSelect = editEl.querySelector('#nba2k27EditPosition');
  posSelect.value = position !== undefined ? position : posSelect.value;
  editEl.querySelector('#nba2k27EditVariantGroup').value = variantGroup;
  editEl.querySelector('#nba2k27EditVariantLabel').value = variantLabel;
  await editEl.querySelector('#nba2k27EditSaveBtn').onclick();
  return editEl;
}

// ── Override fallback behavior + validation ──────────────────────────────
(async () => {
  const { sandbox, nba2kPlayersDocs, nba2k27Docs } = makeAdminSandbox();
  Object.assign(nba2kPlayersDocs, {
    'player-a': { name: 'Player A', team: 'LAL', teamType: 'curr', overall: 95 },
  });
  Object.assign(nba2k27Docs, {
    'player-a': { nba2kRef: 'player-a', pool: 'green', position: 'PG', selectedAt: 'x', updatedAt: 'x' },
  });
  const view = sandbox.Nba2k27PoolView;
  const container = new FakeElement('root');
  await view.render(container);

  await check('no override yet: effective values equal source values', () => {
    const row = view._buildRows().find(r => r.slug === 'player-a');
    assertEqual(row.effectiveName, 'Player A');
    assertEqual(row.effectiveOverall, 95);
    assertEqual(row.effectiveTeam, 'LAL');
  });

  await saveManualEdit(view, container, 'player-a', { name: 'Corrected Name', overall: '97', team: 'BOS', position: 'SG' });

  await check('override saved: nba2k27_pool carries the override fields', () => {
    assertEqual(nba2k27Docs['player-a'].nameOverride, 'Corrected Name');
    assertEqual(nba2k27Docs['player-a'].overallOverride, 97);
    assertEqual(nba2k27Docs['player-a'].teamOverride, 'BOS');
  });
  await check('override saved: source nba2k_players is untouched', () => {
    assertEqual(nba2kPlayersDocs['player-a'].name, 'Player A');
    assertEqual(nba2kPlayersDocs['player-a'].overall, 95);
    assertEqual(nba2kPlayersDocs['player-a'].team, 'LAL');
  });
  await check('pool preserved: editing overrides never changes the derived pool', () => {
    assertEqual(nba2k27Docs['player-a'].pool, 'green');
  });
  await check('position is the intentional field being edited here, and is exactly what was chosen', () => {
    assertEqual(nba2k27Docs['player-a'].position, 'SG');
  });
  await check('effective values now reflect the override', () => {
    const row = view._buildRows().find(r => r.slug === 'player-a');
    assertEqual(row.effectiveName, 'Corrected Name');
    assertEqual(row.effectiveOverall, 97);
    assertEqual(row.effectiveTeam, 'BOS');
  });

  // Clear the overrides — empty fields should remove them, falling back to source.
  await saveManualEdit(view, container, 'player-a', { name: '', overall: '', team: '', position: 'SG' });
  await check('empty override fields remove the override (FieldValue.delete)', () => {
    assertEqual(Object.prototype.hasOwnProperty.call(nba2k27Docs['player-a'], 'nameOverride'), false);
    assertEqual(Object.prototype.hasOwnProperty.call(nba2k27Docs['player-a'], 'overallOverride'), false);
    assertEqual(Object.prototype.hasOwnProperty.call(nba2k27Docs['player-a'], 'teamOverride'), false);
  });
  await check('after clearing, effective values fall back to source again', () => {
    const row = view._buildRows().find(r => r.slug === 'player-a');
    assertEqual(row.effectiveName, 'Player A');
    assertEqual(row.effectiveOverall, 95);
    assertEqual(row.effectiveTeam, 'LAL');
  });

  // Validation
  const editEl1 = view._openManualEdit(container, 'player-a') || container.querySelector('#nba2k27mgmtEdit');
  const editEl = container.querySelector('#nba2k27mgmtEdit');
  editEl.querySelector('#nba2k27EditOverall').value = '150';
  editEl.querySelector('#nba2k27EditPosition').value = 'PG';
  await editEl.querySelector('#nba2k27EditSaveBtn').onclick();
  await check('validation: overall out of 0-99 range is rejected, not saved', () => {
    assertEqual(Object.prototype.hasOwnProperty.call(nba2k27Docs['player-a'], 'overallOverride'), false);
    assertTruthy(editEl.querySelector('#nba2k27EditError').innerHTML.length > 0, 'error message shown');
  });

  editEl.querySelector('#nba2k27EditOverall').value = '';
  editEl.querySelector('#nba2k27EditVariantLabel').value = '1996';
  editEl.querySelector('#nba2k27EditVariantGroup').value = '';
  await editEl.querySelector('#nba2k27EditSaveBtn').onclick();
  await check('validation: a variant label without a group ID is rejected', () => {
    assertEqual(Object.prototype.hasOwnProperty.call(nba2k27Docs['player-a'], 'variantLabel'), false);
  });
})();

// ── Variant grouping: creation, multiple members, removal ────────────────
(async () => {
  const { sandbox, nba2kPlayersDocs, nba2k27Docs } = makeAdminSandbox();
  Object.assign(nba2kPlayersDocs, {
    'mj-96': { name: 'Michael Jordan', team: 'CHI', teamType: 'class', overall: 98 },
    'mj-98': { name: 'Michael Jordan', team: 'CHI', teamType: 'class', overall: 97 },
    'mj-wiz': { name: 'Michael Jordan', team: 'WAS', teamType: 'class', overall: 85 },
    'unrelated': { name: 'Someone Else', team: 'BOS', teamType: 'curr', overall: 80 },
  });
  Object.assign(nba2k27Docs, {
    'mj-96': { nba2kRef: 'mj-96', pool: 'white', position: 'SG', selectedAt: 'x', updatedAt: 'x' },
    'mj-98': { nba2kRef: 'mj-98', pool: 'white', position: 'SG', selectedAt: 'x', updatedAt: 'x' },
    'mj-wiz': { nba2kRef: 'mj-wiz', pool: 'white', position: 'SF', selectedAt: 'x', updatedAt: 'x' },
    'unrelated': { nba2kRef: 'unrelated', pool: 'green', position: 'PG', selectedAt: 'x', updatedAt: 'x' },
  });
  const view = sandbox.Nba2k27PoolView;
  const container = new FakeElement('root');
  await view.render(container);

  await saveManualEdit(view, container, 'mj-96', { position: 'SG', variantGroup: 'michael-jordan', variantLabel: '1996' });
  await saveManualEdit(view, container, 'mj-98', { position: 'SG', variantGroup: 'michael-jordan', variantLabel: '1998' });
  await saveManualEdit(view, container, 'mj-wiz', { position: 'SF', variantGroup: 'michael-jordan', variantLabel: 'Wizards' });

  await check('variant grouping: all three assigned the same variantGroupId', () => {
    assertEqual(nba2k27Docs['mj-96'].variantGroupId, 'michael-jordan');
    assertEqual(nba2k27Docs['mj-98'].variantGroupId, 'michael-jordan');
    assertEqual(nba2k27Docs['mj-wiz'].variantGroupId, 'michael-jordan');
  });
  await check('multiple variants in one group: each keeps its own label', () => {
    assertEqual(nba2k27Docs['mj-96'].variantLabel, '1996');
    assertEqual(nba2k27Docs['mj-98'].variantLabel, '1998');
    assertEqual(nba2k27Docs['mj-wiz'].variantLabel, 'Wizards');
  });
  await check('every player remains a SEPARATE record — three distinct nba2k27_pool docs, not merged', () => {
    assertEqual(Object.keys(nba2k27Docs).filter(k => nba2k27Docs[k].variantGroupId === 'michael-jordan').length, 3);
    assertTruthy(nba2kPlayersDocs['mj-96'] && nba2kPlayersDocs['mj-98'] && nba2kPlayersDocs['mj-wiz'], 'all three source records still exist independently');
  });
  await check('a variant group does not change pool or position beyond what was explicitly chosen', () => {
    assertEqual(nba2k27Docs['mj-96'].pool, 'white');
    assertEqual(nba2k27Docs['mj-wiz'].pool, 'white');
  });
  await check('players without a variant group are completely unaffected', () => {
    assertEqual(Object.prototype.hasOwnProperty.call(nba2k27Docs['unrelated'], 'variantGroupId'), false);
    const row = view._buildRows().find(r => r.slug === 'unrelated');
    assertEqual(row.variantGroupId, null);
  });
  await check('_renderVariantGroupMembers surfaces the OTHER group members, not the player themself', () => {
    const row = view._buildRows().find(r => r.slug === 'mj-96');
    const html = view._renderVariantGroupMembers(row);
    assertTruthy(html.includes('1998') || html.includes('Michael Jordan'), 'lists a sibling');
    assertTruthy(!html.includes('No other players'), 'siblings do exist, so this message should not show');
  });

  // Remove mj-wiz from the group by clearing the field.
  await saveManualEdit(view, container, 'mj-wiz', { position: 'SF', variantGroup: '', variantLabel: '' });
  await check('variant removal: clearing the group ID removes membership', () => {
    assertEqual(Object.prototype.hasOwnProperty.call(nba2k27Docs['mj-wiz'], 'variantGroupId'), false);
  });
  await check('variant removal: the OTHER two members remain grouped, untouched', () => {
    assertEqual(nba2k27Docs['mj-96'].variantGroupId, 'michael-jordan');
    assertEqual(nba2k27Docs['mj-98'].variantGroupId, 'michael-jordan');
  });
  await check('variant removal never deletes the player record itself', () => {
    assertTruthy(nba2k27Docs['mj-wiz'], 'doc still exists');
    assertTruthy(nba2kPlayersDocs['mj-wiz'], 'source record still exists');
  });
})();

// ── Existing 744-style curated positions must survive untouched ──────────
(async () => {
  const { sandbox, nba2kPlayersDocs, nba2k27Docs } = makeAdminSandbox();
  // Simulate a realistic slice of the already-migrated pool: many players
  // with real curated positions, none touched by this feature.
  const N = 50; // representative sample; the logic is per-document and does not change with N
  for (let i = 0; i < N; i++) {
    const slug = `legacy-${i}`;
    nba2kPlayersDocs[slug] = { name: `Legacy Player ${i}`, team: 'T', teamType: 'curr', overall: 70 + (i % 25) };
    nba2k27Docs[slug] = { nba2kRef: slug, pool: 'green', position: ['PG', 'SG', 'SF', 'PF', 'C'][i % 5], selectedAt: `sel-${i}`, updatedAt: `upd-${i}` };
  }
  const snapshotBefore = JSON.parse(JSON.stringify(nba2k27Docs));

  const view = sandbox.Nba2k27PoolView;
  const container = new FakeElement('root');
  await view.render(container);

  // Edit exactly ONE of the 50 — a display-name override only.
  await saveManualEdit(view, container, 'legacy-0', { name: 'Corrected', position: nba2k27Docs['legacy-0'].position });

  await check('9. the 49 untouched legacy positions are byte-for-byte identical to before', () => {
    for (let i = 1; i < N; i++) {
      const slug = `legacy-${i}`;
      assertEqual(JSON.stringify(nba2k27Docs[slug]), JSON.stringify(snapshotBefore[slug]), `${slug} must be untouched`);
    }
  });
  await check('the edited player kept its existing position exactly (merge-only write)', () => {
    assertEqual(nba2k27Docs['legacy-0'].position, snapshotBefore['legacy-0'].position);
    assertEqual(nba2k27Docs['legacy-0'].selectedAt, snapshotBefore['legacy-0'].selectedAt);
    assertEqual(nba2k27Docs['legacy-0'].pool, snapshotBefore['legacy-0'].pool);
  });
})();

// ── No modification to nba2k_players or league/main, anywhere ────────────
(async () => {
  const { sandbox, nba2kPlayersDocs, nba2k27Docs, nba2kPlayersWrites, leagueMainWrites } = makeAdminSandbox();
  Object.assign(nba2kPlayersDocs, { 'p1': { name: 'P1', team: 'T', teamType: 'curr', overall: 80 } });
  Object.assign(nba2k27Docs, { 'p1': { nba2kRef: 'p1', pool: 'green', position: 'PG', selectedAt: 'x', updatedAt: 'x' } });
  const view = sandbox.Nba2k27PoolView;
  const container = new FakeElement('root');
  await view.render(container);
  await saveManualEdit(view, container, 'p1', { name: 'Edited', overall: '90', team: 'NEW', position: 'SG', variantGroup: 'g1', variantLabel: 'v1' });

  await check('10. zero writes to nba2k_players from Manual Edit', () => {
    assertEqual(nba2kPlayersWrites.length, 0);
  });
  await check('zero writes to league/main from Manual Edit', () => {
    assertEqual(leagueMainWrites.length, 0);
  });
})();

// ── Public page: effective values + variant display, strictly read-only ──
(async () => {
  const { sandbox, nba2kPlayersDocs, nba2k27Docs, writes } = makePublicSandbox();
  Object.assign(nba2kPlayersDocs, {
    'mj-96': { name: 'Michael Jordan', team: 'CHI', teamType: 'class', overall: 98, positions: ['SG'] },
    'mj-98': { name: 'Michael Jordan', team: 'CHI', teamType: 'class', overall: 97, positions: ['SG'] },
    'plain': { name: 'Plain Player', team: 'BOS', teamType: 'curr', overall: 80, positions: ['PG'] },
  });
  Object.assign(nba2k27Docs, {
    'mj-96': { nba2kRef: 'mj-96', pool: 'white', position: 'SG', nameOverride: 'MJ (Corrected)', overallOverride: 99, variantGroupId: 'mj', variantLabel: '1996', selectedAt: 'x', updatedAt: 'x' },
    'mj-98': { nba2kRef: 'mj-98', pool: 'white', position: 'SG', variantGroupId: 'mj', variantLabel: '1998', selectedAt: 'x', updatedAt: 'x' },
    'plain': { nba2kRef: 'plain', pool: 'green', position: 'PG', selectedAt: 'x', updatedAt: 'x' },
  });
  const view = sandbox.PublicNba2k27View;
  const container = new FakeElement('root');
  await view.render(container);
  await view._ensureLoaded();

  await check('public page: shows the effective (overridden) name and overall, not the raw source values', () => {
    const row = view._buildRows().find(r => r.slug === 'mj-96');
    assertEqual(row.effectiveName, 'MJ (Corrected)');
    assertEqual(row.effectiveOverall, 99);
  });
  await check('public page: a player with no override shows the plain source values', () => {
    const row = view._buildRows().find(r => r.slug === 'plain');
    assertEqual(row.effectiveName, 'Plain Player');
    assertEqual(row.variantGroupId, null);
  });
  await check('public page: variant grouping is visible (variantGroupId/variantLabel surfaced on the row)', () => {
    const row96 = view._buildRows().find(r => r.slug === 'mj-96');
    const row98 = view._buildRows().find(r => r.slug === 'mj-98');
    assertEqual(row96.variantGroupId, 'mj');
    assertEqual(row98.variantGroupId, 'mj');
    assertEqual(row96.variantLabel, '1996');
  });
  await check('11. the public page performs ZERO writes of any kind, even with override/variant fields present', () => {
    assertEqual(writes.length, 0);
  });
  await check('curated 2K27 position in the modal path is still nba2k27_pool.position, never nba2k_players.positions', () => {
    const row = view._buildRows().find(r => r.slug === 'mj-96');
    assertEqual(row.curatedPosition, 'SG');
    assertTruthy(Array.isArray(row.player.positions)); // source eligibility array still present, separately, untouched
  });
})();

setTimeout(() => {
  console.log(`\nPhase 13 Tests:\n${pass}/${pass + fail} passed`);
  process.exitCode = fail > 0 ? 1 : 0;
}, 50);
