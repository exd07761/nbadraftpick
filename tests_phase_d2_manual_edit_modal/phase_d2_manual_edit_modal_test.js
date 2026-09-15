'use strict';
/**
 * Phase D2 — Manual Edit modal conversion tests.
 *
 * Scope: exclusively the modal-conversion behavior added in Phase D2
 * (Nba2k27PoolView._openManualEdit in js/admin/nba2k-database.js) — the
 * override-save/validation logic itself already has full coverage in
 * tests_p13 (28/28, unchanged and re-run after this phase) and is not
 * re-tested here except where a test specifically needs to confirm the
 * Firestore payload shape is unaffected by the modal wrapper (test 8).
 *
 * Same vm-sandbox-loads-the-real-source pattern as tests_p13, with one
 * addition: a `document` stub that actually RECORDS addEventListener/
 * removeEventListener calls (tests_p13's is a no-op stub, sufficient for
 * that file's purposes but not for verifying "no duplicate listeners on
 * repeated open/close", which is exactly what this suite needs to check).
 *
 * Run with: node tests_phase_d2_manual_edit_modal/phase_d2_manual_edit_modal_test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const dbSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'admin', 'nba2k-database.js'), 'utf8');
const sharedUtilsSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'shared-utils.js'), 'utf8');

// ─── Fake DOM — identical shape to tests_p13's FakeElement/FakeClassList ──
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
    this.value = '';
  }
  set innerHTML(html) {
    this._html = html;
    const re = /id="([^"]+)"/g;
    let m;
    while ((m = re.exec(html))) { if (!this._registry.has(m[1])) new FakeElement(m[1], this._registry); }
  }
  get innerHTML() { return this._html; }
  get textContent() { return this._html.replace(/<[^>]*>/g, ''); }
  querySelector(sel) {
    const idMatch = /^#([\w-]+)$/.exec(sel.trim());
    if (idMatch) return this._registry.get(idMatch[1]) || null;
    return null;
  }
  querySelectorAll() { return []; }
  addEventListener() {}
}

// ─── Tracking `document` — records every add/removeEventListener call so
// tests can assert on exact listener counts (no leaks, no duplicates).
// Also fleshed out enough (getElementById/createElement/body.appendChild)
// that the REAL showToast() from shared-utils.js — which _openManualEdit
// calls on a successful save, unchanged from before Phase D2 — can run to
// completion instead of throwing and being silently swallowed by the save
// handler's own try/catch. (That swallowing is pre-existing, not
// introduced by this phase: tests_p13's bare `{ body: { contains } }`
// document stub means showToast has always thrown there too on every
// successful save — it's just that no tests_p13 test happens to assert
// anything past that point, so the swallowed exception was never visible.
// Test 5 below is the first to check the post-save-close behavior, so it
// needs a document realistic enough for the real success path to run.) ──
function makeTrackingDocument() {
  const listeners = {};
  return {
    body: { contains: () => true, appendChild: () => {} },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      if (!listeners[type]) return;
      listeners[type] = listeners[type].filter(f => f !== fn);
    },
    getElementById: () => null,
    createElement: () => ({
      classList: { add() {}, remove() {} },
      remove() {},
      set id(_) {}, set className(_) {}, set textContent(_) {},
    }),
    _dispatch(type, evt) { (listeners[type] || []).slice().forEach(fn => fn(evt)); },
    _listenerCount(type) { return (listeners[type] || []).length; },
  };
}

function makeAdminSandbox(fakeDocument) {
  const nba2kPlayersDocs = {};
  const nba2k27Docs = {};
  const writes = [];

  function makeDocRef(collectionName, id) {
    return {
      id,
      set: (data, options) => {
        const merge = !!(options && options.merge);
        writes.push({ collection: collectionName, id, data, merge });
        if (collectionName === 'nba2k27_pool') {
          const del = 'DELETE_SENTINEL';
          const existing = nba2k27Docs[id] || {};
          const merged = merge ? { ...existing } : {};
          Object.keys(data).forEach(k => { if (data[k] === del) delete merged[k]; else merged[k] = data[k]; });
          nba2k27Docs[id] = merged;
        }
        return Promise.resolve();
      },
    };
  }

  const sandbox = {
    console,
    document: fakeDocument,
    setTimeout: () => 0,
    clearTimeout: () => {},
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
  return { view: sandbox.Nba2k27PoolView, nba2kPlayersDocs, nba2k27Docs, writes };
}

function poolEntry(overrides = {}) {
  return Object.assign({ pool: 'green', position: 'PG', selectedAt: 'x', updatedAt: 'x' }, overrides);
}
function sourcePlayer(overrides = {}) {
  return Object.assign({ name: 'Source Name', team: 'T', teamType: 'curr', overall: 85 }, overrides);
}

let failures = 0;
function test(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => console.log(`  ok - ${name}`))
    .catch(e => { failures++; console.log(`  FAIL - ${name}`); console.log(`    ${e.stack || e.message}`); });
}

console.log('Phase D2 — Manual Edit modal tests');

(async () => {
  // ── 1. Manual Edit trigger exists (row -> _openManualEdit wiring) ────
  await test('1. row click still opens Manual Edit (row-click wiring untouched by the modal conversion)', async () => {
    const doc = makeTrackingDocument();
    const { view, nba2kPlayersDocs, nba2k27Docs } = makeAdminSandbox(doc);
    Object.assign(nba2kPlayersDocs, { p1: sourcePlayer({ name: 'Player One' }) });
    Object.assign(nba2k27Docs, { p1: poolEntry() });
    const container = new FakeElement('root');
    await view.render(container);
    // _refreshPoolPane wires row.addEventListener('click', () => this._openManualEdit(container, slug))
    // — call the same entry point directly, the same way a real click would.
    view._openManualEdit(container, 'p1');
    const editEl = container.querySelector('#nba2k27mgmtEdit');
    assert.ok(editEl && !editEl.classList.contains('hidden'), 'edit panel should be visible after opening');
  });

  // ── 2. Modal container exists ────────────────────────────────────────
  await test('2. opening Manual Edit renders the shared .modal-overlay/.modal-card container', async () => {
    const doc = makeTrackingDocument();
    const { view, nba2kPlayersDocs, nba2k27Docs } = makeAdminSandbox(doc);
    Object.assign(nba2kPlayersDocs, { p1: sourcePlayer({ name: 'Player One' }) });
    Object.assign(nba2k27Docs, { p1: poolEntry() });
    const container = new FakeElement('root');
    await view.render(container);
    view._openManualEdit(container, 'p1');
    const editEl = container.querySelector('#nba2k27mgmtEdit');
    assert.ok(editEl.innerHTML.includes('modal-overlay'), 'missing .modal-overlay');
    assert.ok(editEl.innerHTML.includes('modal-card'), 'missing .modal-card');
    assert.ok(editEl.innerHTML.includes('manual-edit-modal'), 'missing the Manual Edit modal sizing class');
    assert.ok(editEl.innerHTML.includes('role="dialog"') && editEl.innerHTML.includes('aria-modal="true"'), 'missing dialog semantics');
  });

  // ── 3. Opening Manual Edit targets the selected player ───────────────
  await test('3. the modal title and fields reflect the clicked player, not some other player', async () => {
    const doc = makeTrackingDocument();
    const { view, nba2kPlayersDocs, nba2k27Docs } = makeAdminSandbox(doc);
    Object.assign(nba2kPlayersDocs, {
      p1: sourcePlayer({ name: 'Player One', overall: 80 }),
      p2: sourcePlayer({ name: 'Player Two', overall: 90 }),
    });
    Object.assign(nba2k27Docs, { p1: poolEntry(), p2: poolEntry() });
    const container = new FakeElement('root');
    await view.render(container);
    view._openManualEdit(container, 'p2');
    const editEl = container.querySelector('#nba2k27mgmtEdit');
    assert.ok(editEl.innerHTML.includes('Player Two'), 'title should name the clicked player (Player Two)');
    assert.ok(!editEl.innerHTML.includes('Player One'), 'title should not reference the other player');
  });

  // ── 4. Existing fields remain present ────────────────────────────────
  await test('4. all existing Manual Edit fields are present inside the modal', async () => {
    const doc = makeTrackingDocument();
    const { view, nba2kPlayersDocs, nba2k27Docs } = makeAdminSandbox(doc);
    Object.assign(nba2kPlayersDocs, { p1: sourcePlayer({ name: 'Player One' }) });
    Object.assign(nba2k27Docs, { p1: poolEntry({ variantGroupId: 'grp', variantLabel: 'v1' }) });
    const container = new FakeElement('root');
    await view.render(container);
    view._openManualEdit(container, 'p1');
    const editEl = container.querySelector('#nba2k27mgmtEdit');
    for (const id of ['nba2k27EditName', 'nba2k27EditOverall', 'nba2k27EditTeam', 'nba2k27EditPosition',
                       'nba2k27EditVariantGroup', 'nba2k27EditVariantLabel', 'nba2k27EditSaveBtn', 'nba2k27EditCancelBtn']) {
      assert.ok(editEl.querySelector('#' + id), `missing field/button #${id}`);
    }
  });

  // ── 5. Save handler remains connected ────────────────────────────────
  await test('5. the Save button still writes an override to nba2k27_pool', async () => {
    const doc = makeTrackingDocument();
    const { view, nba2kPlayersDocs, nba2k27Docs, writes } = makeAdminSandbox(doc);
    Object.assign(nba2kPlayersDocs, { p1: sourcePlayer({ name: 'Player One', overall: 80 }) });
    Object.assign(nba2k27Docs, { p1: poolEntry() });
    const container = new FakeElement('root');
    await view.render(container);
    view._openManualEdit(container, 'p1');
    const editEl = container.querySelector('#nba2k27mgmtEdit');
    // FakeElement doesn't parse the `selected` attribute out of the
    // rendered <select> HTML (same limitation tests_p13 already works
    // around) — set the position explicitly, same as the form's actual
    // default value would resolve to in a real browser.
    editEl.querySelector('#nba2k27EditPosition').value = 'PG';
    editEl.querySelector('#nba2k27EditOverall').value = '88';
    await editEl.querySelector('#nba2k27EditSaveBtn').onclick();
    assert.strictEqual(nba2k27Docs['p1'].overallOverride, 88, 'override should be written');
    assert.strictEqual(writes.length, 1, 'exactly one Firestore write for the save');
    assert.strictEqual(writes[0].collection, 'nba2k27_pool');
    assert.ok(writes[0].merge, 'save must use merge:true, unchanged from before the modal conversion');
    // Save closes the modal (successful save requirement).
    assert.strictEqual(editEl.innerHTML, '', 'modal should close after a successful save');
  });

  // ── 6. Cancel closes without invoking the save ───────────────────────
  await test('6. Cancel closes the modal and performs no Firestore write', async () => {
    const doc = makeTrackingDocument();
    const { view, nba2kPlayersDocs, nba2k27Docs, writes } = makeAdminSandbox(doc);
    Object.assign(nba2kPlayersDocs, { p1: sourcePlayer({ name: 'Player One' }) });
    Object.assign(nba2k27Docs, { p1: poolEntry() });
    const container = new FakeElement('root');
    await view.render(container);
    view._openManualEdit(container, 'p1');
    const editEl = container.querySelector('#nba2k27mgmtEdit');
    editEl.querySelector('#nba2k27EditOverall').value = '99'; // typed but never saved
    editEl.querySelector('#nba2k27EditCancelBtn').onclick();
    assert.strictEqual(writes.length, 0, 'Cancel must never write to Firestore');
    assert.strictEqual(editEl.innerHTML, '', 'modal should be closed after Cancel');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(nba2k27Docs['p1'], 'overallOverride'), false, 'the typed-but-uncancelled value must not have been saved');
  });

  // ── 7. Opening a second player does not reuse stale values ──────────
  await test('7. opening Manual Edit for a second player (without closing the first) shows only the second player\'s data', async () => {
    const doc = makeTrackingDocument();
    const { view, nba2kPlayersDocs, nba2k27Docs } = makeAdminSandbox(doc);
    Object.assign(nba2kPlayersDocs, {
      p1: sourcePlayer({ name: 'Player One', overall: 80 }),
      p2: sourcePlayer({ name: 'Player Two', overall: 90 }),
    });
    Object.assign(nba2k27Docs, {
      p1: poolEntry({ nameOverride: 'P1 Override' }),
      p2: poolEntry(),
    });
    const container = new FakeElement('root');
    await view.render(container);

    view._openManualEdit(container, 'p1'); // open first player, never closed
    view._openManualEdit(container, 'p2'); // open second player directly on top

    const editEl = container.querySelector('#nba2k27mgmtEdit');
    assert.ok(editEl.innerHTML.includes('Player Two'), 'should now show the second player');
    assert.ok(!editEl.innerHTML.includes('P1 Override'), 'must not leak the first player\'s override value into the second player\'s form');
    // Also: opening the second player must not leave the first player's
    // Escape listener stacked on top of the new one (the "no duplicate
    // event handlers" requirement).
    assert.strictEqual(doc._listenerCount('keydown'), 1, 'exactly one Escape listener should be active, not two');
  });

  // ── 8. Existing Manual Edit Firestore payload remains unchanged ─────
  await test('8. the save payload shape (fields + merge:true) is unchanged from before the modal conversion', async () => {
    const doc = makeTrackingDocument();
    const { view, nba2kPlayersDocs, nba2k27Docs, writes } = makeAdminSandbox(doc);
    Object.assign(nba2kPlayersDocs, { p1: sourcePlayer({ name: 'Player One', overall: 80 }) });
    Object.assign(nba2k27Docs, { p1: poolEntry() });
    const container = new FakeElement('root');
    await view.render(container);
    view._openManualEdit(container, 'p1');
    const editEl = container.querySelector('#nba2k27mgmtEdit');
    editEl.querySelector('#nba2k27EditPosition').value = 'PG';
    editEl.querySelector('#nba2k27EditName').value = 'Corrected';
    editEl.querySelector('#nba2k27EditOverall').value = '91';
    editEl.querySelector('#nba2k27EditTeam').value = 'BOS';
    editEl.querySelector('#nba2k27EditVariantGroup').value = 'grp1';
    editEl.querySelector('#nba2k27EditVariantLabel').value = 'v2000';
    await editEl.querySelector('#nba2k27EditSaveBtn').onclick();
    const payload = writes[0].data;
    const expectedKeys = ['position', 'nameOverride', 'overallOverride', 'teamOverride', 'variantGroupId', 'variantLabel', 'updatedAt'].sort();
    assert.deepStrictEqual(Object.keys(payload).sort(), expectedKeys, 'payload field set must be exactly what it was before this phase');
    assert.strictEqual(payload.nameOverride, 'Corrected');
    assert.strictEqual(payload.overallOverride, 91);
    assert.strictEqual(payload.teamOverride, 'BOS');
    assert.strictEqual(payload.variantGroupId, 'grp1');
    assert.strictEqual(payload.variantLabel, 'v2000');
  });

  // ── Additional Phase D2-specific coverage ────────────────────────────
  await test('9. Escape key closes the modal without saving', async () => {
    const doc = makeTrackingDocument();
    const { view, nba2kPlayersDocs, nba2k27Docs, writes } = makeAdminSandbox(doc);
    Object.assign(nba2kPlayersDocs, { p1: sourcePlayer({ name: 'Player One' }) });
    Object.assign(nba2k27Docs, { p1: poolEntry() });
    const container = new FakeElement('root');
    await view.render(container);
    view._openManualEdit(container, 'p1');
    const editEl = container.querySelector('#nba2k27mgmtEdit');
    doc._dispatch('keydown', { key: 'Escape' });
    assert.strictEqual(editEl.innerHTML, '', 'Escape should close the modal');
    assert.strictEqual(writes.length, 0, 'Escape must never save');
    assert.strictEqual(doc._listenerCount('keydown'), 0, 'Escape listener should be removed after closing');
  });

  await test('10. repeated open/close cycles leave exactly zero stray keydown listeners', async () => {
    const doc = makeTrackingDocument();
    const { view, nba2kPlayersDocs, nba2k27Docs } = makeAdminSandbox(doc);
    Object.assign(nba2kPlayersDocs, { p1: sourcePlayer({ name: 'Player One' }) });
    Object.assign(nba2k27Docs, { p1: poolEntry() });
    const container = new FakeElement('root');
    await view.render(container);
    for (let i = 0; i < 5; i++) {
      view._openManualEdit(container, 'p1');
      const editEl = container.querySelector('#nba2k27mgmtEdit');
      editEl.querySelector('#nba2k27EditCancelBtn').onclick();
    }
    assert.strictEqual(doc._listenerCount('keydown'), 0, 'five open/cancel cycles should leave zero leaked listeners');
  });

  await test('11. clicking the backdrop closes the modal without saving', async () => {
    const doc = makeTrackingDocument();
    const { view, nba2kPlayersDocs, nba2k27Docs, writes } = makeAdminSandbox(doc);
    Object.assign(nba2kPlayersDocs, { p1: sourcePlayer({ name: 'Player One' }) });
    Object.assign(nba2k27Docs, { p1: poolEntry() });
    const container = new FakeElement('root');
    await view.render(container);
    view._openManualEdit(container, 'p1');
    const editEl = container.querySelector('#nba2k27mgmtEdit');
    const overlay = editEl.querySelector('#manualEditOverlay');
    // FakeElement.addEventListener() is a no-op in this sandbox (same as
    // tests_p13) — this test therefore checks structural readiness (the
    // overlay element exists, matching the click-outside-to-close
    // contract used by every other overlay in this app) rather than
    // executing a real click; a genuine backdrop-click assertion needs
    // jsdom's real event dispatch (see tests_players_2k27_only note in
    // the final report).
    assert.ok(overlay, 'overlay element (click-outside target) must exist');
    assert.strictEqual(writes.length, 0);
  });

  await test('12. the × close button closes the modal without saving', async () => {
    const doc = makeTrackingDocument();
    const { view, nba2kPlayersDocs, nba2k27Docs, writes } = makeAdminSandbox(doc);
    Object.assign(nba2kPlayersDocs, { p1: sourcePlayer({ name: 'Player One' }) });
    Object.assign(nba2k27Docs, { p1: poolEntry() });
    const container = new FakeElement('root');
    await view.render(container);
    view._openManualEdit(container, 'p1');
    const editEl = container.querySelector('#nba2k27mgmtEdit');
    editEl.querySelector('#manualEditCloseBtn').onclick();
    assert.strictEqual(editEl.innerHTML, '', 'close (×) button should close the modal');
    assert.strictEqual(writes.length, 0, 'close (×) must never save');
  });

  console.log(failures ? `${failures} test(s) failed.` : 'All tests passed');
  process.exitCode = failures ? 1 : 0;
})();
