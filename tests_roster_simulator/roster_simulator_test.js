'use strict';
/**
 * Roster Simulator (Phase 1 + 1.1) — regression tests.
 * Phase 1.1 adds: informational rating-budget display against the season cap
 * (875 by default) and a Joker sandbox — see the "Phase 1.1" sections below.
 *
 * Covers js/views/roster-simulator.js (`PublicRosterSimulatorView`).
 *
 * Same vm-sandbox pattern as tests_public_old_season_roster: the REAL
 * js/data.js + js/shared-utils.js + the view are loaded into one context,
 * a realistic season is built through the real AdminActions, and every
 * write path (FirebaseSync.save / saveAndConfirm / the raw Firestore
 * `set`) is instrumented so "no database writes" is measured, not assumed.
 *
 * Fixture (see below): Alpha has a full 6-player roster with RED, YELLOW,
 * colorless and a PINK Joker; Bravo has a manually replaced slot (tag
 * anchored to the vacated slot) and a swapped-out RED player now in the
 * pool; Charlie has an already-empty slot.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const dataSrc = fs.readFileSync(path.join(root, 'js', 'data.js'), 'utf8');
const sharedUtilsSrc = fs.readFileSync(path.join(root, 'js', 'shared-utils.js'), 'utf8');
const simPath = path.join(root, 'js', 'views', 'roster-simulator.js');
const simSrc = fs.readFileSync(simPath, 'utf8');

// ─── Minimal fake DOM ────────────────────────────────────────────────────
// Captures innerHTML and the listeners the view registers on its root, so
// the real _bind() code path can be exercised without a browser.
class FakeRoot {
  constructor() { this.handlers = {}; }
  addEventListener(type, fn) { (this.handlers[type] = this.handlers[type] || []).push(fn); }
  fire(type, evt) { (this.handlers[type] || []).forEach((fn) => fn(evt)); }
}
class FakeContainer {
  constructor() { this._html = ''; this.root = null; this.renders = 0; }
  set innerHTML(html) {
    this._html = html;
    this.renders++;
    this.root = html.includes('class="rsim-view"') ? new FakeRoot() : null;
  }
  get innerHTML() { return this._html; }
  querySelector(sel) {
    if (sel === '.rsim-view') return this.root;
    return null;
  }
}
// A clickable element: `closest` resolves to itself for [data-rsim-action].
function el(action, dataset = {}, extra = {}) {
  const e = { dataset: { rsimAction: action, ...dataset }, disabled: false, ...extra };
  e.closest = (sel) => (sel === '[data-rsim-action]' ? e : null);
  return e;
}

function makeSandbox() {
  const counters = { rawSet: 0, save: 0, saveAndConfirm: 0 };
  const sandbox = {
    console,
    firebase: {
      firestore: () => ({
        collection: () => ({
          doc: () => ({ onSnapshot: () => {}, set: () => { counters.rawSet++; return Promise.resolve(); } }),
        }),
      }),
    },
    showToast: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(dataSrc, sandbox, { filename: 'data.js' });
  vm.runInContext(sharedUtilsSrc, sandbox, { filename: 'shared-utils.js' });
  vm.runInContext(simSrc, sandbox, { filename: 'roster-simulator.js' });
  vm.runInContext(
    'this.LeagueData = LeagueData; this.AdminActions = AdminActions; ' +
    'this.FirebaseSync = FirebaseSync; this.getDefaultData = getDefaultData; ' +
    'this.PublicRosterSimulatorView = PublicRosterSimulatorView; ' +
    'this.classificationBadge = classificationBadge; ' +
    'this.validateRatingCap = validateRatingCap; this.getEffectivePosition = getEffectivePosition; ' +
    'this.CORE_POSITIONS = CORE_POSITIONS;',
    sandbox, { filename: 'export.js' }
  );

  let cache = sandbox.getDefaultData();
  sandbox.FirebaseSync.getCache = () => cache;
  sandbox.FirebaseSync.save = (data) => { cache = data; counters.save++; };
  sandbox.FirebaseSync.saveAndConfirm = (data) => { counters.saveAndConfirm++; return Promise.resolve(data); };
  sandbox._counters = counters;
  sandbox._cacheJson = () => JSON.stringify(cache);
  return sandbox;
}

// Phase 1.1 fixture: ONE manager with a full 10-man roster totalling exactly 861 (BEFORE 861 / 875),
// plus pool players with the ratings needed to land on 857, 874, 875, 876 and 890 precisely.
function buildBudgetEnv({ cap } = {}) {
  const b = makeSandbox();
  const A = b.AdminActions, S = b.PublicRosterSimulatorView;
  const season = A.createSeason('Budget Season'); const sid = season.id;
  const m = A.addParticipant(sid, 'Budgeter');
  const POS = ['PG', 'SG', 'SF', 'PF', 'C'];
  const ovrs = [95, 92, 90, 88, 86, 85, 84, 82, 80, 79];                       // sum = 861
  const roster = ovrs.map((o, i) => A.addPlayer({ name: `Budget ${i + 1}`, position: POS[i % 5], overall: o, pool: 'green' }));
  const pool = {};
  [50, 60, 78, 89, 92, 93, 94, 99].forEach((o) => { pool[o] = A.addPlayer({ name: `Pool ${o}`, position: POS[o % 5], overall: o, pool: 'green' }); });
  { const cache = b.FirebaseSync.getCache(); const st = cache.seasons[sid];
    st.playerDraftPicks = roster.map((p, i) => ({ round: i + 1, pick: 1, participantId: m.id, playerId: p.id }));
    st.playerDraftOrder = [m.id]; st.draftComplete = true; b.FirebaseSync.save(cache); }
  A.initializeRostersFromDraft(sid); A.assignNBATeam(sid, m.id, 'LAL'); A.setCurrentSeason(sid);
  if (cap) A.setRatingCap(sid, cap);
  b._counters.rawSet = b._counters.save = b._counters.saveAndConfirm = 0;      // instrument from here on
  const c = new FakeContainer(); S.render(c); S.selectManager(m.id); S.render(c);
  return { b, S, c, sid, m, roster, pool, ovrs };
}
// What the OVR AFTER / BEFORE tile actually shows, read back from the rendered HTML.
function tile(html, which) {
  const re = new RegExp(`OVR ${which}</div>\\s*<div class="rsim-stat-line"><div class="rsim-stat-num">(\\d+)</div>(?:<div class="rsim-stat-cap">/ (\\d+)</div>)?</div>\\s*(?:<div class="rsim-budget( is-over)?" id="rsimBudget\\w+"[^>]*>([^<]*)</div>)?`);
  const m = html.match(re);
  return m ? { total: Number(m[1]), cap: m[2] ? Number(m[2]) : null, over: !!m[3], text: m[4] || '' } : null;
}
const countOf = (h, needle) => h.split(needle).length - 1;

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log(`  ok - ${name}`); }
  catch (e) { fail++; console.log(`  FAIL - ${name}`); console.log(`         ${e.message}`); }
}
function assertTruthy(v, msg) { if (!v) throw new Error(msg || `expected truthy, got ${JSON.stringify(v)}`); }
function assertFalsy(v, msg) { if (v) throw new Error(msg || `expected falsy, got ${JSON.stringify(v)}`); }
function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(`${msg || 'assertion failed'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function assertJsonEqual(a, b, msg) {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error(`${msg || 'assertion failed'}:\n           expected ${y}\n           got      ${x}`);
}
function assertIncludes(h, n, msg) { if (!h.includes(n)) throw new Error(msg || `expected output to include ${JSON.stringify(n)}`); }
function assertNotIncludes(h, n, msg) { if (h.includes(n)) throw new Error(msg || `expected output NOT to include ${JSON.stringify(n)}`); }
function assertThrows(fn, msg) {
  let threw = false;
  try { fn(); } catch (_) { threw = true; }
  if (!threw) throw new Error(msg || 'expected function to throw');
}

console.log('Roster Simulator (Phase 1) tests:');

const sandbox = makeSandbox();
const { AdminActions, LeagueData, PublicRosterSimulatorView: sim, FirebaseSync, classificationBadge } = sandbox;

// ─── Fixture ─────────────────────────────────────────────────────────────
const season = AdminActions.createSeason('Simulator Season');
const seasonId = season.id;
const alpha = AdminActions.addParticipant(seasonId, 'Alpha');
const bravo = AdminActions.addParticipant(seasonId, 'Bravo');
const charlie = AdminActions.addParticipant(seasonId, 'Charlie');

const mk = (name, position, overall, pool = 'green', extra = {}) =>
  AdminActions.addPlayer({ name, position, overall, pool, ...extra });

// Alpha: 6 own picks -> #1,#2 RED, #3,#4,#5 YELLOW, #6 colorless
const A1 = mk('Alpha One', 'PG', 90);
const A2 = mk('Alpha Two', 'SG', 88);
const A3 = mk('Alpha Three', 'SF', 86);
const A4 = mk('Alpha Four', 'PF', 84);
const A5 = mk('Alpha Five', 'C', 82);
const A6 = mk('Alpha Six', 'PG', 80);
const B1 = mk('Bravo One', 'C', 89);
const B2 = mk('Bravo Two', 'PF', 87);
const C1 = mk('Charlie One', 'SG', 85);
const C2 = mk('Charlie Two', 'SF', 83);
// Undrafted pool: three pools, plus two same-name variants and an HTML-ish name
const P_GREEN_STAR = mk('Pool Star', 'PF', 91, 'green', { variantGroup: 'pool-star' });
const P_BLUE_STAR = mk('Pool Star', 'PF', 93, 'blue', { variantGroup: 'pool-star' });
const P_GREEN_MID = mk('Pool Mid', 'PG', 78, 'green');
const P_WHITE = mk('Pool Classic', 'C', 80, 'white');
const P_XSS = mk('<img src=x onerror=alert(1)>', 'SG', 77, 'green');

{
  const cache = FirebaseSync.getCache();
  const s = cache.seasons[seasonId];
  s.playerDraftPicks = [
    { round: 1, pick: 1, participantId: alpha.id, playerId: A1.id },
    { round: 1, pick: 2, participantId: bravo.id, playerId: B1.id },
    { round: 1, pick: 3, participantId: charlie.id, playerId: C1.id },
    { round: 2, pick: 1, participantId: alpha.id, playerId: A2.id },
    { round: 2, pick: 2, participantId: bravo.id, playerId: B2.id },
    { round: 2, pick: 3, participantId: charlie.id, playerId: C2.id },
    { round: 3, pick: 1, participantId: alpha.id, playerId: A3.id },
    { round: 4, pick: 1, participantId: alpha.id, playerId: A4.id },
    { round: 5, pick: 1, participantId: alpha.id, playerId: A5.id },
    { round: 6, pick: 1, participantId: alpha.id, playerId: A6.id },
  ];
  s.playerDraftOrder = [alpha.id, bravo.id, charlie.id];
  s.draftComplete = true;
  FirebaseSync.save(cache);
}
AdminActions.initializeRostersFromDraft(seasonId);
AdminActions.assignNBATeam(seasonId, alpha.id, 'LAL');
AdminActions.assignNBATeam(seasonId, bravo.id, 'BOS');
AdminActions.assignNBATeam(seasonId, charlie.id, 'MIA');
AdminActions.designateJoker(seasonId, alpha.id, A2.id, 'C');                // Alpha's Joker -> PINK
AdminActions.manualReplacePlayerOnRoster(seasonId, bravo.id, B2.id, P_GREEN_MID.id); // slot keeps B2's RED; B2 -> pool
AdminActions.manualRemovePlayerFromRoster(seasonId, charlie.id, C2.id);     // Charlie: an already-EMPTY slot
AdminActions.setCurrentSeason(seasonId);

assertEqual(LeagueData.getCurrentSeasonId(), seasonId, 'fixture sanity: season is current');
const realSummary = () => LeagueData.getRosterSummary(seasonId);
const realOf = (pid) => realSummary().find((s) => s.participant.id === pid);
const idxOfPlayer = (entries, playerId) => entries.findIndex((e) => e.playerId === playerId);
const snapshotOfReal = () => JSON.stringify(realSummary());

// Instrument from here on: any write attempted by the simulator is counted.
sandbox._counters.rawSet = sandbox._counters.save = sandbox._counters.saveAndConfirm = 0;
const realBefore = snapshotOfReal();
const cacheBefore = sandbox._cacheJson();

// ─── 1. Selecting a manager ──────────────────────────────────────────────
check('1. Rendering with no manager selected shows the picker and no roster', () => {
  const c = new FakeContainer();
  sim._seasonId = null; sim._participantId = null;
  sim.render(c);
  assertIncludes(c.innerHTML, 'Roster Simulator');
  assertIncludes(c.innerHTML, '— Select manager —');
  assertIncludes(c.innerHTML, 'Pick a manager to start');
  assertNotIncludes(c.innerHTML, 'rsim-grid');
  // every real manager is offered, in draft order
  ['Alpha', 'Bravo', 'Charlie'].forEach((n) => assertIncludes(c.innerHTML, `>${n}</option>`));
});

check('1b. Selecting a manager via the real change handler loads them', () => {
  const c = new FakeContainer();
  sim.render(c);
  c.root.fire('change', { target: { id: 'rsimManagerSelect', value: alpha.id } });
  assertEqual(sim._participantId, alpha.id);
  assertIncludes(c.innerHTML, 'BEFORE');
  assertIncludes(c.innerHTML, 'Actual Current Roster');
  assertIncludes(c.innerHTML, 'AFTER');
  assertIncludes(c.innerHTML, 'Your Simulated Roster');
  assertIncludes(c.innerHTML, `value="${alpha.id}" selected`);
});

// ─── 2. Loading the real roster ──────────────────────────────────────────
check('2. BEFORE mirrors the real roster exactly (order, tags, Joker, positions, OVR)', () => {
  sim.selectManager(alpha.id);
  const real = realOf(alpha.id);
  assertEqual(sim._before.length, real.rosterEntries.length, 'slot count');
  real.rosterEntries.forEach((e, i) => {
    const b = sim._before[i];
    assertEqual(b.playerId, e.playerId, `slot ${i} player`);
    assertEqual(b.draftSlot, e.draftSlot, `slot ${i} draftSlot`);
    assertEqual(b.classification, e.classification, `slot ${i} classification`);
    assertEqual(b.isJoker, !!e.isJoker, `slot ${i} isJoker`);
    assertEqual(b.effectivePosition, e.effectivePosition, `slot ${i} effectivePosition`);
    assertEqual(b.player.overall, e.player.overall, `slot ${i} overall`);
  });
  assertEqual(sim.getDiff().ovrBefore, real.totalRating, 'BEFORE OVR equals the existing getRosterSummary total');
});

check('2b. AFTER starts as an exact clone of BEFORE (no changes detected)', () => {
  sim.selectManager(alpha.id);
  assertJsonEqual(sim._after, sim._before);
  const d = sim.getDiff();
  assertEqual(d.removed.length, 0); assertEqual(d.added.length, 0); assertEqual(d.ovrChange, 0);
});

// ─── 3. Removing a player ────────────────────────────────────────────────
check('3. Removing a player opens a slot (slot number kept) and reports it as REMOVED', () => {
  sim.selectManager(alpha.id);
  const i = idxOfPlayer(sim._after, A3.id);
  assertTruthy(sim.removeAt(i));
  assertEqual(sim._after[i].player, null, 'slot is now open');
  assertEqual(sim._after[i].draftSlot, sim._before[i].draftSlot, 'slot label preserved');
  const d = sim.getDiff();
  assertJsonEqual(d.removed.map((e) => e.playerId), [A3.id]);
  assertEqual(d.added.length, 0);
  assertEqual(d.ovrChange, -86);
  // second remove on the same (already open) slot is a no-op
  assertFalsy(sim.removeAt(i));
});

// ─── 4. Adding a player ──────────────────────────────────────────────────
check('4. Adding a pool player fills the open slot and reports it as ADDED', () => {
  sim.selectManager(alpha.id);
  const i = idxOfPlayer(sim._after, A3.id);
  sim.removeAt(i);
  const res = sim.placePlayerAt(i, P_GREEN_STAR.id);
  assertTruthy(res.ok, `placePlayerAt failed: ${res.reason}`);
  assertEqual(sim._after[i].playerId, P_GREEN_STAR.id);
  assertEqual(sim._after[i].draftSlot, sim._before[i].draftSlot);
  const d = sim.getDiff();
  assertJsonEqual(d.removed.map((e) => e.playerId), [A3.id]);
  assertJsonEqual(d.added.map((e) => e.playerId), [P_GREEN_STAR.id]);
  assertEqual(d.ovrChange, 91 - 86);
});

check('4b. A full roster has no "Add player" button until a slot is opened', () => {
  const c = new FakeContainer();
  sim.selectManager(alpha.id);
  sim.render(c);
  assertNotIncludes(c.innerHTML, '>Add player<');
  sim.removeAt(idxOfPlayer(sim._after, A4.id));
  sim.render(c);
  assertIncludes(c.innerHTML, '>Add player<');
  assertIncludes(c.innerHTML, 'Open slot — removed Alpha Four');
});

check('4c. An already-empty real slot is an open slot in AFTER from the start (no invented slots)', () => {
  const c = new FakeContainer();
  sim.selectManager(charlie.id);
  const emptyIdx = sim._before.findIndex((e) => !e.player);
  assertTruthy(emptyIdx >= 0, 'fixture sanity: Charlie has an empty slot');
  sim.render(c);
  assertIncludes(c.innerHTML, 'EMPTY — draft slot vacated'); // BEFORE renders like the real page
  assertIncludes(c.innerHTML, '>Add player<');               // AFTER offers it
  assertTruthy(sim.placePlayerAt(emptyIdx, P_WHITE.id).ok);
  assertEqual(sim._after.length, sim._before.length, 'slot count never changes');
});

// ─── 5. Replacing a player ───────────────────────────────────────────────
check('5. Replace = remove + add in one step, detected as one REMOVED + one ADDED', () => {
  sim.selectManager(alpha.id);
  const i = idxOfPlayer(sim._after, A6.id);
  assertTruthy(sim.placePlayerAt(i, P_BLUE_STAR.id).ok);
  const d = sim.getDiff();
  assertJsonEqual(d.removed.map((e) => e.playerId), [A6.id]);
  assertJsonEqual(d.added.map((e) => e.playerId), [P_BLUE_STAR.id]);
  assertEqual(d.ovrChange, 93 - 80);
});

check('5b. Repeated remove -> add -> remove -> replace -> reset cycles stay consistent', () => {
  sim.selectManager(alpha.id);
  const i = idxOfPlayer(sim._after, A5.id);
  sim.removeAt(i);
  sim.placePlayerAt(i, P_GREEN_MID.id + '-nope'); // unknown id: rejected, slot stays open
  assertEqual(sim._after[i].player, null);
  sim.placePlayerAt(i, P_WHITE.id);
  sim.removeAt(i);
  sim.placePlayerAt(i, P_GREEN_STAR.id);
  sim.placePlayerAt(i, P_BLUE_STAR.id);           // replace the replacement
  const d = sim.getDiff();
  assertJsonEqual(d.added.map((e) => e.playerId), [P_BLUE_STAR.id], 'only the final occupant is ADDED');
  assertJsonEqual(d.removed.map((e) => e.playerId), [A5.id]);
  sim.reset();
  assertEqual(sim.getDiff().ovrChange, 0);
});

check('5c. Guards: same player cannot be on the AFTER roster twice; other managers\' players are not offered', () => {
  sim.selectManager(alpha.id);
  const i = idxOfPlayer(sim._after, A6.id);
  const j = idxOfPlayer(sim._after, A5.id);
  sim.removeAt(i); sim.removeAt(j);
  assertTruthy(sim.placePlayerAt(i, P_WHITE.id).ok);
  assertEqual(sim.placePlayerAt(j, P_WHITE.id).reason, 'already-on-roster');
  assertEqual(sim.placePlayerAt(j, B1.id).reason, 'not-available', "Bravo's rostered player is a Phase 2 trade, not a Phase 1 add");
  sim.reset();
});

check('5d. Removing then re-adding the same player is detected as no net change', () => {
  sim.selectManager(alpha.id);
  const i = idxOfPlayer(sim._after, A1.id);
  sim.removeAt(i);
  assertTruthy(sim.placePlayerAt(i, A1.id).ok);
  const d = sim.getDiff();
  assertEqual(d.removed.length, 0); assertEqual(d.added.length, 0); assertEqual(d.ovrChange, 0);
});

// ─── 6. OVR before / after / change ──────────────────────────────────────
check('6. OVR BEFORE / AFTER / CHANGE render with sign and are computed from the simulated roster', () => {
  const c = new FakeContainer();
  sim.selectManager(alpha.id);
  sim.render(c);
  const total = realOf(alpha.id).totalRating;
  assertIncludes(c.innerHTML, 'OVR BEFORE'); assertIncludes(c.innerHTML, 'OVR AFTER'); assertIncludes(c.innerHTML, 'OVR CHANGE');
  assertIncludes(c.innerHTML, 'id="rsimOvrChange">0</div>');
  // +5: replace Alpha Three (86) with Pool Star (91)
  sim.placePlayerAt(idxOfPlayer(sim._after, A3.id), P_GREEN_STAR.id);
  sim.render(c);
  assertIncludes(c.innerHTML, `<div class="rsim-stat-num">${total}</div>`);
  assertIncludes(c.innerHTML, `<div class="rsim-stat-num">${total + 5}</div>`);
  assertIncludes(c.innerHTML, 'id="rsimOvrChange">+5</div>');
  assertIncludes(c.innerHTML, 'OVR CHANGE: <strong class="rsim-pos">+5</strong>');
  // -86: just remove
  sim.reset();
  sim.removeAt(idxOfPlayer(sim._after, A3.id));
  sim.render(c);
  assertIncludes(c.innerHTML, 'id="rsimOvrChange">-86</div>');
  sim.reset();
});

check('6b. Phase 1.1: the cap is informational only — nothing is blocked or disabled, no transaction classification', () => {
  // (Phase 1 asserted the cap was NOT shown at all; Phase 1.1 deliberately reverses that. What still holds:
  //  no trade/swap/release/sign wording, and nothing is ever refused or disabled because of the cap.)
  const c = new FakeContainer();
  sim.selectManager(alpha.id);
  sim.placePlayerAt(idxOfPlayer(sim._after, A3.id), P_BLUE_STAR.id);
  sim.render(c);
  assertIncludes(c.innerHTML, 'id="rsimBudgetAfter"', 'the budget line is now shown');
  assertFalsy(/\b(trade|swap|release|signing|signed)\b/i.test(c.innerHTML.replace('Transaction builder coming next', '')),
    'UI must not label the change as a trade/swap/release/signing');
  assertFalsy(/data-rsim-action="(open-picker|remove|toggle-joker)"[^>]*disabled/.test(c.innerHTML), 'no editing action is ever disabled by the cap');
  sim.reset();
});

// ─── 7. Classification / color display ───────────────────────────────────
check('7. BEFORE shows RED, YELLOW, colorless and PINK exactly like the existing roster page', () => {
  const c = new FakeContainer();
  sim.selectManager(alpha.id);
  sim.render(c);
  const red = classificationBadge('RED'), yellow = classificationBadge('YELLOW'), pink = classificationBadge('PINK'), none = classificationBadge(null);
  assertIncludes(c.innerHTML, red); assertIncludes(c.innerHTML, yellow); assertIncludes(c.innerHTML, pink); assertIncludes(c.innerHTML, none);
  // per-slot parity with the existing helper, using the existing `isJoker ? 'PINK' : classification` expression
  const real = realOf(alpha.id).rosterEntries;
  real.forEach((e) => {
    const expected = e.isJoker ? 'PINK' : e.classification;
    const b = sim._before.find((x) => x.playerId === e.playerId);
    assertEqual(b.isJoker ? 'PINK' : b.classification, expected, `${e.player.name} tag`);
  });
  // spot-check the fixture's known tags so a silent all-null can't pass
  const tag = (pid) => { const e = sim._before.find((x) => x.playerId === pid); return e.isJoker ? 'PINK' : e.classification; };
  assertEqual(tag(A1.id), 'RED'); assertEqual(tag(A3.id), 'YELLOW'); assertEqual(tag(A6.id), null); assertEqual(tag(A2.id), 'PINK');
  assertIncludes(c.innerHTML, '🃏');
});

check('7b. Pool players show the classification the EXISTING helper reports for them', () => {
  const c = new FakeContainer();
  sim.selectManager(bravo.id);
  sim.openPicker(0);
  sim.render(c);
  // B2 was Bravo's original 2nd pick, swapped out: still RED in the pool
  const viaHelper = LeagueData.getPlayerClassification(seasonId, B2.id).classification;
  assertEqual(viaHelper, 'RED', 'fixture sanity');
  const cand = sim._candidates.find((x) => x.id === B2.id);
  assertEqual(cand.classification, viaHelper, 'candidate tag === LeagueData.getPlayerClassification');
  assertIncludes(c.innerHTML, classificationBadge('RED'));
  // undrafted pool players are colorless per the existing helper
  assertEqual(sim._candidates.find((x) => x.id === P_GREEN_STAR.id).classification,
    LeagueData.getPlayerClassification(seasonId, P_GREEN_STAR.id).classification);
  sim.closePicker();
});

check('7c. After adding a pool player, the AFTER row carries the same tag the helper gives that player', () => {
  const c = new FakeContainer();
  sim.selectManager(alpha.id);
  const i = idxOfPlayer(sim._after, A6.id);
  sim.placePlayerAt(i, B2.id); // Bravo's swapped-out RED
  assertEqual(sim._after[i].classification, LeagueData.getPlayerClassification(seasonId, B2.id).classification);
  sim.render(c);
  assertIncludes(c.innerHTML, classificationBadge('RED'));
  // a colorless pool player must stay colorless (guards against any hard-coded tag)
  const j = idxOfPlayer(sim._after, A5.id);
  sim.placePlayerAt(j, P_GREEN_STAR.id);
  assertEqual(sim._after[j].classification, LeagueData.getPlayerClassification(seasonId, P_GREEN_STAR.id).classification);
  assertEqual(sim._after[j].classification, null, 'undrafted pool player is colorless');
  sim.reset();
});

check('7d. A real-roster Joker who is removed and re-added comes back as the Joker (PINK, Joker position)', () => {
  sim.selectManager(alpha.id);
  const i = idxOfPlayer(sim._after, A2.id);
  const before = sim._before[i];
  assertTruthy(before.isJoker);
  sim.removeAt(i);
  assertTruthy(sim.placePlayerAt(i, A2.id).ok);
  assertJsonEqual(sim._after[i], before);
  assertEqual(sim._after[i].effectivePosition, 'C', 'Joker-assigned position preserved');
});

check('7e. A slot-anchored real tag (manual replace) is shown as the real roster shows it', () => {
  sim.selectManager(bravo.id);
  const e = sim._before.find((x) => x.playerId === P_GREEN_MID.id);
  assertEqual(e.classification, 'RED', 'Pool Mid inherits the RED of the slot Bravo Two vacated (existing rule)');
  assertEqual(e.classification, realOf(bravo.id).rosterEntries.find((x) => x.playerId === P_GREEN_MID.id).classification);
});

check('7f. The simulator contains NO classification thresholds of its own', () => {
  assertFalsy(/classifyPickNumber|getPlayerClassificationInfo|ownPickNumber|originalPick/.test(simSrc.replace(/\/\*[\s\S]*?\*\//g, '')),
    'classification must come from the existing helper only');
  assertFalsy(/['"](RED|YELLOW)['"]/.test(simSrc.replace(/\/\*[\s\S]*?\*\//g, '')),
    "no 'RED'/'YELLOW' literals (only 'PINK' is used, mirroring views/roster.js)");
});

// ─── 8. Reset ────────────────────────────────────────────────────────────
check('8. Reset restores AFTER to exactly BEFORE and clears the change list', () => {
  const c = new FakeContainer();
  sim.selectManager(alpha.id);
  sim.removeAt(idxOfPlayer(sim._after, A3.id));
  sim.placePlayerAt(idxOfPlayer(sim._after, A6.id), P_BLUE_STAR.id);
  sim.render(c);
  assertIncludes(c.innerHTML, 'REMOVED');
  assertIncludes(c.innerHTML, 'ADDED');
  // via the real click handler
  c.root.fire('click', { target: el('reset') });
  assertJsonEqual(sim._after, sim._before);
  assertEqual(sim.getDiff().ovrChange, 0);
  assertIncludes(c.innerHTML, 'No changes yet');
  assertIncludes(c.innerHTML, 'id="rsimReset" disabled');
});

// ─── 9. Real roster completely unchanged ─────────────────────────────────
check('9. BEFORE is read-only: frozen, and AFTER is a separate object graph', () => {
  sim.selectManager(alpha.id);
  assertTruthy(Object.isFrozen(sim._before) && Object.isFrozen(sim._before[0]) && Object.isFrozen(sim._before[0].player));
  assertThrows(() => { sim._before[0].classification = 'X'; }, 'writing to BEFORE must throw');
  assertThrows(() => { sim._before[0].player.overall = 1; }, 'writing to a BEFORE player must throw');
  assertThrows(() => { sim._before.push({}); }, 'growing BEFORE must throw');
  assertTruthy(sim._after[0] !== sim._before[0], 'AFTER entries are clones');
  sim._after[0].classification = 'X';                      // mutate AFTER aggressively...
  assertEqual(sim._before[0].classification, 'RED', '...BEFORE is untouched');
  sim.reset();
});

check('9b. Live league player objects are never frozen or held (only view-owned copies are)', () => {
  sim.selectManager(alpha.id);
  assertFalsy(Object.isFrozen(LeagueData.getPlayer(A1.id)), 'live player must not be frozen');
  assertTruthy(sim._before[0].player !== LeagueData.getPlayer(sim._before[0].playerId), 'BEFORE holds a copy, not the live object');
});

check('9c. After a long experiment session, the real rosters and the whole data cache are byte-identical', () => {
  const c = new FakeContainer();
  [alpha.id, bravo.id, charlie.id].forEach((pid) => {
    sim.selectManager(pid);
    sim.render(c);
    sim._before.forEach((e, i) => { if (e.player) sim.removeAt(i); });   // remove everyone
    sim._after.forEach((e, i) => {                                       // fill from the pool
      const cand = sim._buildCandidates(seasonId, realSummary()).find((x) => !sim._after.some((a) => a.playerId === x.id));
      if (cand) sim.placePlayerAt(i, cand.id);
    });
    sim.render(c);
    sim.reset();
  });
  assertEqual(snapshotOfReal(), realBefore, 'getRosterSummary output unchanged');
  assertEqual(sandbox._cacheJson(), cacheBefore, 'entire in-memory league state unchanged');
});

// ─── 10. No database writes ──────────────────────────────────────────────
check('10. Zero writes across every write path during a full simulator session', () => {
  const c = new FakeContainer();
  sim.render(c);
  c.root.fire('change', { target: { id: 'rsimManagerSelect', value: alpha.id } });
  c.root.fire('click', { target: el('remove', { slot: '2' }) });
  c.root.fire('click', { target: el('open-picker', { slot: '2' }) });
  c.root.fire('input', { target: { id: 'rsimPickerSearch', value: 'pool' } });
  c.root.fire('change', { target: { id: 'rsimPickerPool', value: 'blue' } });
  c.root.fire('click', { target: el('pick-player', { playerId: P_BLUE_STAR.id }) });
  c.root.fire('click', { target: el('reset') });
  assertEqual(sandbox._counters.save, 0, 'FirebaseSync.save calls');
  assertEqual(sandbox._counters.saveAndConfirm, 0, 'FirebaseSync.saveAndConfirm calls');
  assertEqual(sandbox._counters.rawSet, 0, 'raw Firestore set() calls');
});

check('10b. Static guard: the simulator source references no write/persistence API', () => {
  // `byId.set(` is a local in-memory JS Map (candidate de-dupe in _buildCandidates), not a
  // Firestore/Supabase write, so it is the one `.set(` allowed; any other `.set(` still fails.
  const code = simSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/\bbyId\.set\(/g, '');
  ['AdminActions', 'FirebaseSync', 'saveData', 'saveAndConfirm', '.set(', '.update(', '.insert(', '.upsert(',
    '.delete(', 'firebase.', 'Supabase', 'supabase', 'fetch(', 'XMLHttpRequest', 'localStorage', 'sessionStorage']
    .forEach((bad) => assertFalsy(code.includes(bad), `simulator source must not contain ${bad}`));
});

// ─── Picker behaviour ────────────────────────────────────────────────────
check('P1. Picker offers pool + own removed players; excludes other managers\' and already-added players', () => {
  sim.selectManager(alpha.id);
  const i = idxOfPlayer(sim._after, A6.id);
  sim.removeAt(i);
  sim.openPicker(i);
  const ids = () => sim._filterCandidates(sim._candidates, sim._after, sim._picker).map((x) => x.id);
  assertTruthy(ids().includes(A6.id), 'the removed player can be added back');
  assertTruthy(ids().includes(P_GREEN_STAR.id) && ids().includes(P_BLUE_STAR.id) && ids().includes(P_WHITE.id) && ids().includes(B2.id));
  assertFalsy(ids().includes(B1.id), "Bravo's rostered player is not offered");
  assertFalsy(ids().includes(A1.id), 'a player still on AFTER is not offered');
  sim.placePlayerAt(i, P_WHITE.id);
  assertFalsy(ids().includes(P_WHITE.id), 'a player already added is no longer offered');
  sim.closePicker(); sim.reset();
});

check('P2. Same-name variants are separate, id-keyed candidates (pool label disambiguates)', () => {
  sim.selectManager(alpha.id);
  sim.openPicker(0);
  const stars = sim._candidates.filter((x) => x.name === 'Pool Star');
  assertEqual(stars.length, 2);
  assertEqual(new Set(stars.map((x) => x.id)).size, 2);
  const c = new FakeContainer(); sim.render(c);
  assertIncludes(c.innerHTML, 'Green'); assertIncludes(c.innerHTML, 'Blue');
  sim.closePicker();
});

check('P3. Search matches name or position (case-insensitive) and the pool filter narrows', () => {
  sim.selectManager(alpha.id);
  sim.openPicker(0);
  const names = (o) => sim._filterCandidates(sim._candidates, sim._after, o).map((x) => x.id);
  assertJsonEqual(names({ query: 'CLASSIC' }), [P_WHITE.id]);
  assertTruthy(names({ query: 'pf' }).includes(P_GREEN_STAR.id));
  assertJsonEqual(names({ pool: 'white' }), [P_WHITE.id]);
  assertJsonEqual(names({ query: 'zzzz' }), []);
  sim.closePicker();
});

check('P4. Picker list is sorted by OVR (desc) and the picker wiring (search/pool/Escape/backdrop/close) works', () => {
  const c = new FakeContainer();
  sim.selectManager(alpha.id);
  sim.render(c);
  c.root.fire('click', { target: el('open-picker', { slot: '0' }) });
  assertTruthy(sim._picker && sim._picker.slotIndex === 0);
  const ovrs = sim._candidates.map((x) => x.overall);
  assertJsonEqual(ovrs, [...ovrs].sort((a, b) => b - a), 'sorted by OVR desc');
  c.root.fire('input', { target: { id: 'rsimPickerSearch', value: 'classic' } });
  assertEqual(sim._picker.query, 'classic');
  c.root.fire('change', { target: { id: 'rsimPickerPool', value: 'white' } });
  assertEqual(sim._picker.pool, 'white');
  c.root.fire('keydown', { key: 'Escape' });
  assertEqual(sim._picker, null, 'Escape closes the picker');
  c.root.fire('click', { target: el('open-picker', { slot: '0' }) });
  c.root.fire('click', { target: { dataset: { rsimBackdrop: '1' }, closest: () => null } });
  assertEqual(sim._picker, null, 'backdrop click closes the picker');
  c.root.fire('click', { target: el('open-picker', { slot: '0' }) });
  c.root.fire('click', { target: el('close-picker') });
  assertEqual(sim._picker, null, 'close button closes the picker');
  assertJsonEqual(sim._after, sim._before, 'cancelling never changes AFTER');
});

check('P5. Picking through the click handler replaces the player and closes the picker', () => {
  const c = new FakeContainer();
  sim.selectManager(alpha.id);
  sim.render(c);
  const i = idxOfPlayer(sim._after, A4.id);
  c.root.fire('click', { target: el('open-picker', { slot: String(i) }) });
  assertIncludes(c.innerHTML, 'Replace Alpha Four');
  c.root.fire('click', { target: el('pick-player', { playerId: P_GREEN_STAR.id }) });
  assertEqual(sim._picker, null);
  assertEqual(sim._after[i].playerId, P_GREEN_STAR.id);
  assertIncludes(c.innerHTML, 'rsim-row-new');
  sim.reset();
});

// ─── Change list + Discord placeholder ───────────────────────────────────
check('C1. CHANGES lists removed/added as "Name — POS — OVR" plus the OVR change', () => {
  const c = new FakeContainer();
  sim.selectManager(alpha.id);
  sim.placePlayerAt(idxOfPlayer(sim._after, A3.id), P_GREEN_STAR.id);
  sim.render(c);
  assertIncludes(c.innerHTML, 'REMOVED'); assertIncludes(c.innerHTML, 'ADDED');
  assertIncludes(c.innerHTML, 'Alpha Three</span> — SF — 86');
  assertIncludes(c.innerHTML, 'Pool Star</span> — PF — 91');
  assertIncludes(c.innerHTML, 'OVR CHANGE: <strong class="rsim-pos">+5</strong>');
  sim.reset();
});

check('C2. "Copy Transaction to Discord" is a disabled placeholder and does nothing', () => {
  const c = new FakeContainer();
  sim.selectManager(alpha.id);
  sim.removeAt(0);
  sim.render(c);
  assertIncludes(c.innerHTML, 'id="rsimCopyDiscord"');
  assertTruthy(/<button[^>]*disabled[^>]*id="rsimCopyDiscord"|<button[^>]*id="rsimCopyDiscord"[^>]*disabled/.test(c.innerHTML), 'button is disabled');
  assertIncludes(c.innerHTML, 'Transaction builder coming next');
  sim.reset();
});

// ─── Safety / robustness ─────────────────────────────────────────────────
check('S1. Player names are HTML-escaped everywhere they render', () => {
  const c = new FakeContainer();
  sim.selectManager(alpha.id);
  const i = idxOfPlayer(sim._after, A6.id);
  sim.placePlayerAt(i, P_XSS.id);
  sim.openPicker(i);
  sim.render(c);
  assertNotIncludes(c.innerHTML, '<img src=x');
  assertIncludes(c.innerHTML, '&lt;img src=x onerror=alert(1)&gt;');
  sim.closePicker(); sim.reset();
});

check('S2. Switching managers discards the old simulation and loads the new real roster', () => {
  sim.selectManager(alpha.id);
  sim.removeAt(0);
  sim.selectManager(bravo.id);
  assertEqual(sim._participantId, bravo.id);
  assertJsonEqual(sim._after, sim._before);
  assertJsonEqual(sim._before.map((e) => e.playerId), realOf(bravo.id).rosterEntries.map((e) => e.playerId));
  sim.selectManager('');
  assertEqual(sim._participantId, null); assertEqual(sim._before, null);
});

check('S3. Manager select survives a re-render (e.g. the router\'s remote-change refresh) with edits intact', () => {
  const c = new FakeContainer();
  sim.selectManager(alpha.id);
  sim.removeAt(1);
  sim.render(c);
  sim.render(c); // router re-renders on FirebaseSync remote changes
  assertEqual(sim._participantId, alpha.id);
  assertEqual(sim._after[1].player, null, 'the simulation survives a re-render');
  sim.reset();
});

check('S4. Empty states: no season / no teams do not crash', () => {
  const s2 = makeSandbox();
  const c = new FakeContainer();
  s2.PublicRosterSimulatorView.render(c);
  assertIncludes(c.innerHTML, 'No Active Season');
  const sn = s2.AdminActions.createSeason('Empty');
  s2.AdminActions.setCurrentSeason(sn.id);
  s2.PublicRosterSimulatorView.render(c);
  assertIncludes(c.innerHTML, 'No Teams Yet');
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 1.1 — rating budget (informational) against the season cap
// ═══════════════════════════════════════════════════════════════════════════
check('B1. budget maths: 857/875 -> 18 remaining; exactly 875 -> 0 remaining (not over); 890/875 -> 15 over; singular at +/-1', () => {
  const g = (t, cap = 875) => sim._budget(t, cap);
  assertJsonEqual([g(857).remaining, g(857).isOverCap, g(857).text], [18, false, '18 ratings remaining']);
  assertJsonEqual([g(875).remaining, g(875).isOverCap, g(875).text], [0, false, '0 ratings remaining']);
  assertJsonEqual([g(890).remaining, g(890).isOverCap, g(890).text], [-15, true, '15 ratings over cap']);
  assertEqual(g(874).text, '1 rating remaining'); assertEqual(g(876).text, '1 rating over cap');
  assertJsonEqual(sim._budget(861, undefined), { total: 861, cap: null, remaining: null, isOverCap: false, text: '' }, 'no cap known -> number only, no invented 875');
});

check('B2. BEFORE 861 / 875 renders with "14 ratings remaining", and getBudget() agrees', () => {
  const e = buildBudgetEnv(); const h = e.c.innerHTML;
  assertEqual(e.ovrs.reduce((a, v) => a + v, 0), 861, 'fixture sanity');
  assertJsonEqual(tile(h, 'BEFORE'), { total: 861, cap: 875, over: false, text: '14 ratings remaining' });
  assertJsonEqual(tile(h, 'AFTER'), { total: 861, cap: 875, over: false, text: '14 ratings remaining' }, 'a fresh AFTER equals BEFORE');
  const gb = e.S.getBudget();
  assertJsonEqual([gb.cap, gb.before.remaining, gb.after.remaining], [875, 14, 14]);
});

check('B3. AFTER 857 / 875 -> "18 ratings remaining" (replace an 82 with a 78)', () => {
  const e = buildBudgetEnv(); const i = e.roster.findIndex((p) => p.overall === 82);
  assertTruthy(e.S.placePlayerAt(i, e.pool[78].id).ok);
  e.S.render(e.c);
  assertJsonEqual(tile(e.c.innerHTML, 'AFTER'), { total: 857, cap: 875, over: false, text: '18 ratings remaining' });
  assertJsonEqual(tile(e.c.innerHTML, 'BEFORE'), { total: 861, cap: 875, over: false, text: '14 ratings remaining' }, 'BEFORE unaffected');
});

check('B4. rating usage AT 875 -> "0 ratings remaining", not flagged over cap (replace a 79 with a 93)', () => {
  const e = buildBudgetEnv(); const i = e.roster.findIndex((p) => p.overall === 79);
  assertTruthy(e.S.placePlayerAt(i, e.pool[93].id).ok); e.S.render(e.c);
  assertJsonEqual(tile(e.c.innerHTML, 'AFTER'), { total: 875, cap: 875, over: false, text: '0 ratings remaining' });
});

check('B5. OVER the cap -> "890 / 875", "15 ratings over cap", styled over — and NOTHING is blocked', () => {
  const e = buildBudgetEnv();
  const i79 = e.roster.findIndex((p) => p.overall === 79), i80 = e.roster.findIndex((p) => p.overall === 80);
  assertTruthy(e.S.placePlayerAt(i79, e.pool[99].id).ok, 'add refused at/over cap?');   // +20 -> 881
  assertTruthy(e.S.placePlayerAt(i80, e.pool[89].id).ok, 'replace refused over cap?');  // +9  -> 890
  e.S.render(e.c);
  assertJsonEqual(tile(e.c.innerHTML, 'AFTER'), { total: 890, cap: 875, over: true, text: '15 ratings over cap' });
  assertFalsy(/data-rsim-action="(open-picker|remove|toggle-joker)"[^>]*disabled/.test(e.c.innerHTML), 'no action disabled while over cap');
  assertTruthy(e.S.openPicker(0), 'the picker still opens while over the cap'); e.S.closePicker();
  assertEqual(e.S.getDiff().added.length, 2, 'both over-cap additions are kept in AFTER');
  assertTruthy(e.S.reset()); e.S.render(e.c);
  assertEqual(tile(e.c.innerHTML, 'AFTER').text, '14 ratings remaining', 'reset always works');
});

check('B6. live updates through the REAL click handlers: remove -> add -> replace -> reset each update the tile immediately', () => {
  const e = buildBudgetEnv(); const c = e.c;
  const i79 = e.roster.findIndex((p) => p.overall === 79), i95 = e.roster.findIndex((p) => p.overall === 95);
  const after = () => tile(c.innerHTML, 'AFTER');
  c.root.fire('click', { target: el('remove', { slot: String(i79) }) });
  assertJsonEqual([after().total, after().text], [782, '93 ratings remaining']);
  c.root.fire('click', { target: el('open-picker', { slot: String(i79) }) });
  c.root.fire('click', { target: el('pick-player', { playerId: e.pool[93].id }) });
  assertJsonEqual([after().total, after().text], [875, '0 ratings remaining']);
  c.root.fire('click', { target: el('open-picker', { slot: String(i95) }) });
  c.root.fire('click', { target: el('pick-player', { playerId: e.pool[60].id }) });
  assertJsonEqual([after().total, after().text], [840, '35 ratings remaining']);
  c.root.fire('click', { target: el('reset') });
  assertJsonEqual([after().total, after().text], [861, '14 ratings remaining']);
});

check('B7. singular wording at the boundary: 874 -> "1 rating remaining", 876 -> "1 rating over cap"', () => {
  const e = buildBudgetEnv(); const i = e.roster.findIndex((p) => p.overall === 79);
  e.S.placePlayerAt(i, e.pool[92].id); e.S.render(e.c);
  assertEqual(tile(e.c.innerHTML, 'AFTER').text, '1 rating remaining');
  e.S.placePlayerAt(i, e.pool[94].id); e.S.render(e.c);
  assertJsonEqual([tile(e.c.innerHTML, 'AFTER').total, tile(e.c.innerHTML, 'AFTER').text], [876, '1 rating over cap']);
});

check('B8. parity with the EXISTING logic: an unmodified AFTER equals getRosterSummary; edited states agree with existing validateRatingCap on the 875 boundary', () => {
  // (a) unmodified: the tile numbers are exactly getRosterSummary's totalRating / ratingCap / remaining / isOverCap, all managers
  [alpha.id, bravo.id, charlie.id].forEach((pid) => {
    sim.selectManager(pid);
    const real = realOf(pid), gb = sim.getBudget();
    assertJsonEqual([gb.before.total, gb.cap, gb.before.remaining, gb.before.isOverCap], [real.totalRating, real.ratingCap, real.remaining, real.isOverCap], 'BEFORE vs getRosterSummary');
    assertJsonEqual([gb.after.total, gb.after.remaining, gb.after.isOverCap], [real.totalRating, real.remaining, real.isOverCap], 'clone AFTER vs getRosterSummary');
  });
  // (b) 861, 874, 875, 876, 890: the existing Rule-G validator says "valid" exactly when the budget says "not over"
  const e = buildBudgetEnv(); const i79 = e.roster.findIndex((p) => p.overall === 79);
  const cases = [[null, 861], [92, 874], [93, 875], [94, 876], [99, 881]];
  cases.forEach(([ovr, total]) => {
    if (ovr) e.S.placePlayerAt(i79, e.pool[ovr].id);
    const gb = e.S.getBudget(), entries = e.S._after.filter((x) => x.player), byId = {};
    entries.forEach((x) => { byId[x.playerId] = x.player; });
    const oracle = sandbox.validateRatingCap(entries, byId, gb.cap);
    assertEqual(gb.after.total, total, `total for ${ovr}`);
    assertEqual(oracle.valid, !gb.after.isOverCap, `validateRatingCap.valid vs !isOverCap at ${total}`);
  });
});

check('B9. the cap comes from the SEASON (season.ratingCap), not a hardcoded 875', () => {
  const e = buildBudgetEnv({ cap: 900 });
  const i = e.roster.findIndex((p) => p.overall === 82);
  e.S.placePlayerAt(i, e.pool[78].id); e.S.render(e.c);
  assertJsonEqual(tile(e.c.innerHTML, 'AFTER'), { total: 857, cap: 900, over: false, text: '43 ratings remaining' });
  assertJsonEqual(tile(e.c.innerHTML, 'BEFORE'), { total: 861, cap: 900, over: false, text: '39 ratings remaining' });
});

check('B10. getBudget() is null with no manager selected', () => {
  const e = buildBudgetEnv(); e.S.selectManager(''); assertEqual(e.S.getBudget(), null);
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 1.1 — Joker sandbox (AFTER-only; BEFORE and the real league never touched)
// ═══════════════════════════════════════════════════════════════════════════
const pinkBadge = () => classificationBadge('PINK');
const jokerBtnPressed = (h) => countOf(h, 'aria-pressed="true"');

check('J1. a simulated player can be marked Joker: PINK + Joker marker, base tag kept, natural position to start, BEFORE untouched', () => {
  const c = new FakeContainer(); sim.selectManager(alpha.id); sim.render(c);
  const i = idxOfPlayer(sim._after, A3.id);
  const beforeEntry = JSON.stringify(sim._before[i]);
  assertEqual(sim._after[i].isJoker, false, 'fixture sanity: Alpha Three is not the Joker');
  const r = sim.toggleJoker(i);
  assertJsonEqual([r.ok, r.isJoker], [true, true]);
  const a = sim._after[i];
  assertJsonEqual([a.isJoker, a.classification, a.baseClassification, a.jokerPosition], [true, 'PINK', 'YELLOW', 'SF']);
  assertEqual(a.effectivePosition, sandbox.getEffectivePosition({ isJoker: true, jokerPosition: 'SF' }, a.player), 'effective position comes from the existing rule');
  assertEqual(JSON.stringify(sim._before[i]), beforeEntry, 'BEFORE entry byte-identical');
  assertEqual(sim._before[i].isJoker, false);
  sim.render(c);
  assertEqual(countOf(c.innerHTML, pinkBadge()), 4, 'PINK badges: BEFORE Joker + AFTER 2 Jokers + the JOKER change line');
  assertEqual(jokerBtnPressed(c.innerHTML), 2, 'two AFTER rows show the Joker toggle as pressed');
  const d = sim.getDiff();
  assertJsonEqual(d.jokerChanges.map((x) => [x.kind, x.after.player.name]), [['marked', 'Alpha Three']]);
  assertJsonEqual([d.removed.length, d.added.length, d.ovrChange], [0, 0, 0], 'a Joker change is not an add/remove and does not touch OVR');
  assertIncludes(c.innerHTML, 'now Joker at SF');
  assertFalsy(/id="rsimReset" disabled/.test(c.innerHTML), 'Reset is available because AFTER differs');
  sim.reset();
});

check('J2. a simulated Joker can be un-marked — even the REAL one — and gets the existing helper\'s base tag back', () => {
  const c = new FakeContainer(); sim.selectManager(alpha.id);
  const i = idxOfPlayer(sim._after, A2.id);
  assertTruthy(sim._before[i].isJoker && sim._before[i].classification === 'PINK', 'fixture sanity: Alpha Two is the real Joker (PINK)');
  assertTruthy(sim.toggleJoker(i).ok);
  const a = sim._after[i];
  const helper = LeagueData.getPlayerClassification(seasonId, A2.id);
  assertEqual(helper.classification, 'PINK', 'the real roster still says PINK');
  assertJsonEqual([a.isJoker, a.jokerPosition, a.classification], [false, undefined, helper.baseClassification]);
  assertEqual(a.classification, 'RED', 'Alpha Two was his 2nd pick -> RED once the Joker overlay is gone');
  assertEqual(a.effectivePosition, 'SG', 'back to his natural position');
  assertJsonEqual([sim._before[i].isJoker, sim._before[i].classification, sim._before[i].effectivePosition], [true, 'PINK', 'C'], 'BEFORE still shows the real Joker at C');
  sim.render(c);
  assertJsonEqual(sim.getDiff().jokerChanges.map((x) => x.kind), ['unmarked']);
  assertIncludes(c.innerHTML, 'no longer Joker (back to SG)');
  assertEqual(jokerBtnPressed(c.innerHTML), 0, 'no AFTER row is a Joker any more');
  sim.reset();
});

check('J3. Joker position: any of the existing CORE_POSITIONS; invalid / non-Joker / empty slots are rejected without effect', () => {
  const c = new FakeContainer(); sim.selectManager(alpha.id);
  const i2 = idxOfPlayer(sim._after, A2.id), i1 = idxOfPlayer(sim._after, A1.id);
  assertTruthy(sim.setJokerPosition(i2, 'PF').ok);
  assertJsonEqual([sim._after[i2].jokerPosition, sim._after[i2].effectivePosition], ['PF', 'PF']);
  assertEqual(sim._after[i2].effectivePosition, sandbox.getEffectivePosition({ isJoker: true, jokerPosition: 'PF' }, sim._after[i2].player));
  assertJsonEqual(sim.getDiff().jokerChanges.map((x) => [x.kind, x.before.effectivePosition, x.after.effectivePosition]), [['moved', 'C', 'PF']]);
  assertEqual(sim.setJokerPosition(i2, 'XX').reason, 'invalid-position');
  assertEqual(sim.setJokerPosition(i1, 'C').reason, 'not-joker');
  sim.removeAt(idxOfPlayer(sim._after, A6.id)); assertEqual(sim.setJokerPosition(idxOfPlayer(sim._after, null), 'C').reason, 'no-player');
  assertEqual(sim._after[i2].jokerPosition, 'PF', 'rejected calls changed nothing');
  sim.render(c);
  assertEqual(countOf(c.innerHTML, 'class="rsim-jpos"'), 1, 'exactly one Joker position picker, in AFTER only');
  assertTruthy(/<option value="PF" selected>PF<\/option>/.test(c.innerHTML), 'picker shows the chosen position');
  assertJsonEqual([...c.innerHTML.matchAll(/<option value="(PG|SG|SF|PF|C)"/g)].map((m) => m[1]), sandbox.CORE_POSITIONS, 'options are exactly the existing CORE_POSITIONS');
  assertIncludes(c.innerHTML, 'Joker position C → PF');
  sim.reset();
});

check('J4. toggling on/off is a clean round trip; re-marking the real Joker restores his real Joker position', () => {
  sim.selectManager(alpha.id);
  const i3 = idxOfPlayer(sim._after, A3.id), i2 = idxOfPlayer(sim._after, A2.id);
  sim.toggleJoker(i3); sim.toggleJoker(i3);
  assertJsonEqual(sim._after, sim._before, 'mark then un-mark = back to BEFORE');
  assertEqual(sim.getDiff().jokerChanges.length, 0);
  sim.setJokerPosition(i2, 'PF'); sim.toggleJoker(i2); sim.toggleJoker(i2);
  assertJsonEqual(sim._after[i2], sim._before[i2], 'real Joker off then on = his real state again (position C, PINK)');
  assertEqual(sim._after[i2].jokerPosition, 'C');
  sim.reset();
});

check('J5. sandbox freedom: any number of Jokers, any position, any player (incl. added ones), over the cap — nothing is refused', () => {
  sim.selectManager(alpha.id);
  [A1, A3, A4].forEach((p) => assertTruthy(sim.toggleJoker(idxOfPlayer(sim._after, p.id)).ok, `mark ${p.name}`));   // now FOUR Jokers with Alpha Two
  [A1, A3, A4].forEach((p) => assertTruthy(sim.setJokerPosition(idxOfPlayer(sim._after, p.id), 'C').ok));            // all at C: no position limit applied
  assertEqual(sim._after.filter((e) => e.isJoker).length, 4);
  const i6 = idxOfPlayer(sim._after, A6.id);
  assertTruthy(sim.placePlayerAt(i6, P_GREEN_STAR.id).ok);
  const r = sim.toggleJoker(i6);                                                                                      // an ADDED player can be Joker
  assertJsonEqual([r.ok, sim._after[i6].isJoker, sim._after[i6].classification, sim._after[i6].baseClassification, sim._after[i6].jokerPosition], [true, true, 'PINK', null, 'PF']);
  sim.toggleJoker(i6);
  assertEqual(sim._after[i6].classification, LeagueData.getPlayerClassification(seasonId, P_GREEN_STAR.id).classification, 'un-marking an added player returns the existing helper\'s tag (colorless)');
  sim.removeAt(i6); assertEqual(sim.toggleJoker(i6).reason, 'no-player', 'no Joker on an open slot');
  assertEqual(sim.getDiff().jokerChanges.filter((x) => x.kind === 'marked').length, 3);
  sim.reset();
});

check('J6. isolation: Joker experiments never touch BEFORE, the real roster, the real Joker designation, the league data, or live player objects', () => {
  sim.selectManager(alpha.id);
  const jokerBefore = JSON.stringify(LeagueData.getJoker(seasonId, alpha.id));
  const beforeJson = JSON.stringify(sim._before), realJson = snapshotOfReal(), cacheJson = sandbox._cacheJson();
  const liveJson = JSON.stringify([A1, A2, A3].map((p) => LeagueData.getPlayer(p.id)));
  const i1 = idxOfPlayer(sim._after, A1.id), i2 = idxOfPlayer(sim._after, A2.id), i3 = idxOfPlayer(sim._after, A3.id);
  sim.toggleJoker(i1); sim.toggleJoker(i2); sim.toggleJoker(i3); sim.setJokerPosition(i3, 'C'); sim.setJokerPosition(i1, 'PF'); sim.toggleJoker(i2); sim.toggleJoker(i2);
  assertEqual(JSON.stringify(sim._before), beforeJson, 'BEFORE byte-identical');
  assertEqual(snapshotOfReal(), realJson, 'getRosterSummary byte-identical');
  assertEqual(JSON.stringify(LeagueData.getJoker(seasonId, alpha.id)), jokerBefore, 'the REAL Joker designation is unchanged');
  assertEqual(sandbox._cacheJson(), cacheJson, 'entire league document byte-identical');
  assertEqual(JSON.stringify([A1, A2, A3].map((p) => LeagueData.getPlayer(p.id))), liveJson, 'live player objects unchanged');
  assertFalsy(Object.isFrozen(LeagueData.getPlayer(A2.id)), 'live player is not frozen either');
  assertThrows(() => { sim._before[i2].isJoker = false; }, 'BEFORE Joker flag is read-only');
  assertThrows(() => { sim._before[i1].isJoker = true; }, 'BEFORE cannot be made a Joker');
  assertTruthy(sim._after[i2] !== sim._before[i2] && sim._after[i1] !== sim._before[i1], 'AFTER entries are separate objects');
  sim.reset();
});

check('J7. Reset restores the ORIGINAL Joker state exactly', () => {
  const c = new FakeContainer(); sim.selectManager(alpha.id); sim.render(c);
  const i2 = idxOfPlayer(sim._after, A2.id);
  sim.toggleJoker(i2);                                                          // un-mark the real Joker
  sim.toggleJoker(idxOfPlayer(sim._after, A3.id)); sim.toggleJoker(idxOfPlayer(sim._after, A4.id));
  sim.setJokerPosition(idxOfPlayer(sim._after, A3.id), 'C');
  sim.removeAt(idxOfPlayer(sim._after, A5.id));
  sim.render(c); assertTruthy(sim.getDiff().jokerChanges.length > 0);
  c.root.fire('click', { target: el('reset') });
  assertJsonEqual(sim._after, sim._before);
  assertJsonEqual([sim._after[i2].isJoker, sim._after[i2].jokerPosition, sim._after[i2].classification, sim._after[i2].effectivePosition], [true, 'C', 'PINK', 'C'], 'Alpha Two is the Joker at C again');
  assertEqual(sim.getDiff().jokerChanges.length, 0);
  assertIncludes(c.innerHTML, 'id="rsimReset" disabled');
  assertIncludes(c.innerHTML, 'No changes yet');
});

check('J8. wiring through the REAL handlers: Joker button toggles, position picker changes, BEFORE has no controls, open slots have no Joker button', () => {
  const c = new FakeContainer(); sim.selectManager(alpha.id); sim.render(c);
  const i = idxOfPlayer(sim._after, A3.id);
  const afterCard = () => c.innerHTML.slice(c.innerHTML.indexOf('rsim-card--after'));
  assertEqual(countOf(c.innerHTML.slice(0, c.innerHTML.indexOf('rsim-card--after')), 'toggle-joker'), 0, 'BEFORE card has no Joker control');
  assertEqual(countOf(afterCard(), 'data-rsim-action="toggle-joker"'), 6, 'one Joker button per filled AFTER row');
  c.root.fire('click', { target: el('toggle-joker', { slot: String(i) }) });
  assertEqual(sim._after[i].isJoker, true); assertEqual(jokerBtnPressed(c.innerHTML), 2);
  c.root.fire('change', { target: { id: '', value: 'C', dataset: { slot: String(i) }, classList: { contains: (k) => k === 'rsim-jpos' } } });
  assertJsonEqual([sim._after[i].jokerPosition, sim._after[i].effectivePosition], ['C', 'C']);
  assertTruthy(/<option value="C" selected>C<\/option>/.test(c.innerHTML));
  c.root.fire('click', { target: el('toggle-joker', { slot: String(i) }) });
  assertEqual(sim._after[i].isJoker, false);
  c.root.fire('click', { target: el('remove', { slot: String(i) }) });
  assertEqual(countOf(afterCard(), 'data-rsim-action="toggle-joker"'), 5, 'the open slot offers no Joker button');
  sim.reset();
});

check('J9. the Joker sandbox reuses the existing rules instead of copying them (static)', () => {
  const code = simSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/.*$/gm, '');
  ['getEffectivePosition(', 'getPlayerClassification(', 'CORE_POSITIONS', "'PINK'"].forEach((needle) => assertTruthy(code.includes(needle), `expected the view to use ${needle}`));
  assertFalsy(/['"](PG|SG|SF|PF|C)['"]/.test(code), 'no hard-coded position list — positions come from CORE_POSITIONS / player data');
  assertFalsy(/isJoker\s*&&\s*[a-z.]*jokerPosition\s*\?/.test(code), 'effective-position rule is not re-implemented');
});

check('J10. with Joker changes on screen the UI still has no transaction wording and the Discord button stays a disabled placeholder', () => {
  const c = new FakeContainer(); sim.selectManager(alpha.id);
  sim.toggleJoker(idxOfPlayer(sim._after, A3.id)); sim.setJokerPosition(idxOfPlayer(sim._after, A2.id), 'PF');
  sim.placePlayerAt(idxOfPlayer(sim._after, A6.id), P_BLUE_STAR.id); sim.render(c);
  assertIncludes(c.innerHTML, 'JOKER'); assertIncludes(c.innerHTML, 'REMOVED'); assertIncludes(c.innerHTML, 'ADDED');
  assertFalsy(/\b(trade|swap|release|signing|signed)\b/i.test(c.innerHTML.replace('Transaction builder coming next', '')));
  assertTruthy(/<button[^>]*disabled[^>]*id="rsimCopyDiscord"|<button[^>]*id="rsimCopyDiscord"[^>]*disabled/.test(c.innerHTML));
  sim.reset();
});

check('J11. ZERO writes across a full budget + Joker session (all write paths), and no league state changed', () => {
  const c = new FakeContainer(); sim.render(c);
  const beforeWrites = [sandbox._counters.save, sandbox._counters.saveAndConfirm, sandbox._counters.rawSet];
  c.root.fire('change', { target: { id: 'rsimManagerSelect', value: alpha.id } });
  const i2 = idxOfPlayer(sim._after, A2.id), i3 = idxOfPlayer(sim._after, A3.id);
  c.root.fire('click', { target: el('toggle-joker', { slot: String(i3) }) });
  c.root.fire('change', { target: { id: '', value: 'PF', dataset: { slot: String(i3) }, classList: { contains: (k) => k === 'rsim-jpos' } } });
  c.root.fire('click', { target: el('toggle-joker', { slot: String(i2) }) });
  c.root.fire('click', { target: el('remove', { slot: String(idxOfPlayer(sim._after, A4.id)) }) });
  c.root.fire('click', { target: el('open-picker', { slot: String(idxOfPlayer(sim._after, null)) }) });
  c.root.fire('click', { target: el('pick-player', { playerId: P_BLUE_STAR.id }) });
  c.root.fire('click', { target: el('reset') });
  assertJsonEqual([sandbox._counters.save, sandbox._counters.saveAndConfirm, sandbox._counters.rawSet], beforeWrites, 'no save / saveAndConfirm / raw Firestore set');
  assertEqual(sandbox._counters.save + sandbox._counters.saveAndConfirm + sandbox._counters.rawSet, 0);
  assertEqual(snapshotOfReal(), realBefore, 'real rosters identical to the start of the whole test run');
  assertEqual(sandbox._cacheJson(), cacheBefore, 'league document identical to the start of the whole test run');
  // and the same for the 10-man budget fixture
  const e = buildBudgetEnv(); const cacheB = e.b._cacheJson();
  e.c.root.fire('click', { target: el('toggle-joker', { slot: '0' }) });
  e.c.root.fire('click', { target: el('open-picker', { slot: '9' }) });
  e.c.root.fire('click', { target: el('pick-player', { playerId: e.pool[99].id }) });
  e.c.root.fire('click', { target: el('reset') });
  assertEqual(e.b._counters.save + e.b._counters.saveAndConfirm + e.b._counters.rawSet, 0, 'budget fixture: zero writes');
  assertEqual(e.b._cacheJson(), cacheB, 'budget fixture: league document unchanged');
});

// ─── Last: a REAL change made by an admin while someone is simulating ────
check('R1. If the real roster changes mid-simulation, BEFORE follows the truth and AFTER resets with a notice', () => {
  const c = new FakeContainer();
  sim.selectManager(alpha.id);
  sim.removeAt(idxOfPlayer(sim._after, A3.id));
  sim.render(c);
  assertIncludes(c.innerHTML, 'Open slot — removed Alpha Three');
  // an admin swaps a player out (this write is the TEST's, via AdminActions, not the simulator's)
  AdminActions.manualReplacePlayerOnRoster(seasonId, alpha.id, A6.id, P_WHITE.id);
  sim.render(c); // what the router does on FirebaseSync.onRemoteChange
  assertTruthy(sim._before.some((e) => e.playerId === P_WHITE.id), 'BEFORE reflects the new real roster');
  assertFalsy(sim._before.some((e) => e.playerId === A6.id));
  assertJsonEqual(sim._after, sim._before, 'AFTER was reset to the new truth');
  assertIncludes(c.innerHTML, 'The real roster changed, so your simulation was reset');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
