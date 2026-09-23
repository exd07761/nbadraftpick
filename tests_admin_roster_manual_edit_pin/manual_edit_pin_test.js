'use strict';
/**
 * Manual Roster Edit PIN-verification regression tests.
 *
 * BUG (found during production Roster-editor diagnosis, pre-existing
 * before this test): js/admin/roster.js's Manual Roster Edit PIN step
 * reads `_DELETE_ALL_PLAYERS_PIN` via shared global script scope, but
 * that constant was deleted from js/admin/players.js by commit 75f3fe0
 * ("feat: make Players page NBA 2K27-only") without anyone updating
 * roster.js's dependency on it. Every PIN submission — correct or
 * incorrect — threw an uncaught ReferenceError, so Manual Roster Edit
 * could never be unlocked at all. Fixed by restoring the constant (same
 * original value, '7761', recovered from git history) to
 * js/admin/players.js. This file locks that fix in place and would have
 * caught the original regression had it existed beforehand.
 *
 * Scope: exclusively the PIN-verification step
 * (AdminRosterView._openManualEditPinStep) and the resulting
 * locked/unlocked control visibility in _renderRosterCard. Nothing about
 * manualAddPlayerToRoster/manualReplacePlayerOnRoster's own logic,
 * Firebase, Supabase, or the draft system is touched or exercised here.
 *
 * Same vm-sandbox-loads-the-real-source pattern as tests_f6/*, with the
 * tracking FakeElement/FakeClassList DOM stub from
 * tests_phase_d2_manual_edit_modal (same shape, copied rather than
 * imported to keep this suite self-contained and isolated).
 *
 * Run with: node tests_admin_roster_manual_edit_pin/manual_edit_pin_test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const playersSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'admin', 'players.js'), 'utf8');
const rosterSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'admin', 'roster.js'), 'utf8');
const sharedUtilsSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'shared-utils.js'), 'utf8');

// ─── Fake DOM — identical shape to tests_phase_d2_manual_edit_modal's
// FakeElement/FakeClassList, with one shared registry so an overlay's
// innerHTML-created child ids resolve via document.getElementById exactly
// as they do in a real browser. ─────────────────────────────────────────
class FakeClassList {
  constructor(el) { this.el = el; }
  add(c) { if (!this.el._classes.includes(c)) this.el._classes.push(c); }
  remove(c) { this.el._classes = this.el._classes.filter(x => x !== c); }
  contains(c) { return this.el._classes.includes(c); }
}
class FakeElement {
  constructor(id, registry) {
    this._registry = registry || new Map();
    this.id = id || ''; // via the setter below, so registration happens either way
    this._classes = [];
    this._html = '';
    this.classList = new FakeClassList(this);
    this.dataset = {};
    this.value = '';
  }
  // _openManualEditPinStep creates a bare element then assigns .id
  // afterward (`overlay.id = 'manualEditPinOverlay'`) rather than passing
  // it to createElement — register on assignment too, not just at
  // construction, so a later getElementById() call finds it.
  set id(v) { this._id = v; if (v) this._registry.set(v, this); }
  get id() { return this._id; }
  set innerHTML(html) {
    this._html = html;
    const re = /id="([^"]+)"/g;
    let m;
    while ((m = re.exec(html))) { if (!this._registry.has(m[1])) new FakeElement(m[1], this._registry); }
  }
  get innerHTML() { return this._html; }
  set textContent(v) { this._html = String(v); }
  get textContent() { return this._html; }
  querySelector(sel) {
    const idMatch = /^#([\w-]+)$/.exec(sel.trim());
    if (idMatch) return this._registry.get(idMatch[1]) || null;
    return null;
  }
  querySelectorAll() { return []; }
  addEventListener() {}
  remove() {}
  focus() {}
}

function makeFakeDocument() {
  const registry = new Map();
  return {
    _registry: registry,
    getElementById: (id) => registry.get(id) || null,
    createElement: (tag) => new FakeElement(null, registry),
    body: { appendChild: () => {}, contains: () => true },
  };
}

// ─── Sandbox — loads the real source files, admin.html's exact order
// (players.js before roster.js), sharing one global scope. ─────────────
function makeSandbox(fakeDocument) {
  const sandbox = {
    console,
    document: fakeDocument,
    LeagueData: {
      getJokerEligiblePlayers: () => [], // only called when unlocked; empty is sufficient here
      getNBATeam: () => null, // teamBadge (shared-utils.js) falls back to the abbreviation alone when null
    },
    AdminApp: { renderView: () => {} },
    setTimeout: () => {}, // showToast (shared-utils.js) schedules a fade-in; timing itself isn't under test
  };
  vm.createContext(sandbox);
  vm.runInContext(sharedUtilsSrc, sandbox, { filename: 'shared-utils.js' }); // real escapeHtml/poolLabel/teamBadge/showToast
  vm.runInContext(playersSrc, sandbox, { filename: 'players.js' });
  vm.runInContext(rosterSrc, sandbox, { filename: 'roster.js' });
  // `const` declarations at vm top-level are lexical, not properties of
  // the sandbox object — export explicitly, same as tests_f6/*.
  vm.runInContext('this.AdminRosterView = AdminRosterView;', sandbox, { filename: 'export.js' });
  return sandbox;
}

let passed = 0;
function check(label, condition) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ FAILED: ${label}`);
    process.exitCode = 1;
  }
}

console.log('Manual Roster Edit PIN-verification regression tests\n');

// ── Test 1: incorrect PIN stays locked, shows the existing error ───────
{
  const doc = makeFakeDocument();
  const sandbox = makeSandbox(doc);
  const view = sandbox.AdminRosterView;

  view._openManualEditPinStep({});
  const overlay = doc.getElementById('manualEditPinOverlay');
  const pinInput = doc.getElementById('manualEditPinInput');
  const submitBtn = doc.getElementById('manualEditPinSubmitBtn');
  const errorEl = doc.getElementById('manualEditPinError');

  check('PIN modal opens (overlay exists)', !!overlay);
  pinInput.value = '0000';
  submitBtn.onclick();

  check('incorrect PIN leaves _manualEditUnlocked === false', view._manualEditUnlocked === false);
  check('incorrect PIN shows "Incorrect PIN." error text', errorEl.textContent === 'Incorrect PIN.');
  check('PIN input is cleared after a failed attempt', pinInput.value === '');
}

// ── Test 2: correct PIN ('7761') unlocks manual editing ─────────────────
{
  const doc = makeFakeDocument();
  const sandbox = makeSandbox(doc);
  const view = sandbox.AdminRosterView;

  view._openManualEditPinStep({});
  const pinInput = doc.getElementById('manualEditPinInput');
  const submitBtn = doc.getElementById('manualEditPinSubmitBtn');

  check('starts locked', view._manualEditUnlocked === false);
  pinInput.value = '7761';
  submitBtn.onclick();

  check('correct PIN sets _manualEditUnlocked === true', view._manualEditUnlocked === true);
}

// ── Test 3: manual-edit controls hidden while locked, shown once
//    unlocked — via _renderRosterCard directly, no full render()/
//    LeagueData season plumbing needed (kept isolated, per the fix
//    request's "minimal test change" instruction). ──────────────────────
{
  const doc = makeFakeDocument();
  const sandbox = makeSandbox(doc);
  const view = sandbox.AdminRosterView;

  const fakeSummary = {
    participant: { id: 'p1', name: 'Test Team' },
    rosterEntries: [
      { source: 'draft', draftSlot: 1, player: { id: 'pl1', name: 'Test Player', pool: 'green', overall: 80, position: 'PG' }, classification: 'RED', isJoker: false },
    ],
    totalRating: 80,
    remaining: 795,
    isOverCap: false,
  };

  view._manualEditUnlocked = false;
  const lockedHtml = view._renderRosterCard(fakeSummary, 875, 'LAL', 'season1');
  check('locked: no "+ Add Player" control rendered', !lockedHtml.includes('data-manual-action="openAdd"'));
  check('locked: no Replace control rendered', !lockedHtml.includes('data-manual-action="replace"'));
  check('locked: no Remove control rendered', !lockedHtml.includes('data-manual-action="remove"'));

  view._manualEditUnlocked = true;
  const unlockedHtml = view._renderRosterCard(fakeSummary, 875, 'LAL', 'season1');
  check('unlocked: "+ Add Player" control is rendered', unlockedHtml.includes('data-manual-action="openAdd"'));
  check('unlocked: Replace control is rendered', unlockedHtml.includes('data-manual-action="replace"'));
  check('unlocked: Remove control is rendered', unlockedHtml.includes('data-manual-action="remove"'));
}

console.log(`\n${passed} check(s) passed.`);
if (process.exitCode) {
  console.error('SOME CHECKS FAILED.');
} else {
  console.log('ALL CHECKS PASSED.');
}
