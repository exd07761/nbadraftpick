'use strict';
/**
 * Verifies the fix for: the Draft UI locking a player out of selection
 * entirely because their NATURAL position was already filled/full, even
 * though the commissioner might want to draft them as a Joker at a
 * DIFFERENT effective position.
 *
 *  - UI layer (js/shared-utils.js positionPoolGrid/_positionPoolRow, and
 *    js/admin/draft.js's search dropdown): a 'position-locked' or
 *    'no-position' status (both derived from natural position) must no
 *    longer prevent the row from being open-able in draft mode — only
 *    'drafted' and 'variant-locked' remain truly blocking. The "Locked"/
 *    "No Position" tag must still render, unchanged, for a normal pick.
 *  - Data layer (js/data.js AdminActions.makeDraftPick): unchanged from
 *    the prior Joker Pick work — effectivePosition (jokerPosition for a
 *    Joker Pick, otherwise player.position) is confirmed to still govern
 *    the mandatory-five rule and the max-2-per-position cap, and a normal
 *    pick of a naturally-locked player is still correctly rejected.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const dataSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'data.js'), 'utf8');
const utilsSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'shared-utils.js'), 'utf8');

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok - ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL - ${name}`);
    console.log(`    ${e.stack || e.message}`);
  }
}

function makeDataSandbox(seasonData, playersData) {
  const dataDoc = { exists: true, data: () => ({ seasons: seasonData, players: playersData || {}, settings: {} }), metadata: { hasPendingWrites: false } };
  const sandbox = {
    console,
    firebase: {
      firestore: () => ({
        collection: () => ({
          doc: () => ({
            onSnapshot: (onNext) => { onNext(dataDoc); return () => {}; },
            set: () => Promise.resolve(),
          }),
        }),
        enablePersistence: () => Promise.resolve(),
      }),
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(dataSrc, sandbox, { filename: 'data.js' });
  vm.runInContext('this.FirebaseSync = FirebaseSync; this.LeagueData = LeagueData; this.AdminActions = AdminActions;', sandbox, { filename: 'export.js' });
  sandbox.FirebaseSync.init();
  return { LeagueData: sandbox.LeagueData, AdminActions: sandbox.AdminActions };
}

function makeUiSandbox() {
  const sandbox = { console };
  vm.createContext(sandbox);
  // shared-utils.js relies on CORE_POSITIONS, a global defined in data.js
  // (loaded before it on every real page — admin.html/index.html both
  // load data.js first) — load it here too so positionPoolGrid works
  // standalone in this sandbox.
  vm.runInContext(dataSrc, sandbox, { filename: 'data.js' });
  vm.runInContext(utilsSrc, sandbox, { filename: 'shared-utils.js' });
  vm.runInContext('this.positionPoolGrid = positionPoolGrid;', sandbox, { filename: 'export.js' });
  return sandbox.positionPoolGrid;
}

function player(id, { position, overall, pool = 'green' } = {}) {
  return { id, name: id, position, overall, pool };
}

function freshSeasonFixture() {
  const players = {};
  const seasons = {
    s1: {
      id: 's1',
      participants: { p1: { id: 'p1', name: 'P1' }, p2: { id: 'p2', name: 'P2' } },
      playerDraftOrder: ['p1', 'p2'],
      playerDraftPicks: [],
      draftSkips: [],
      bonusPicks: {},
      transactions: [],
      pot: 0,
      currentSeasonDay: 1,
      ratingCap: 875,
      draftComplete: false,
      rostersInitialized: false,
      currentRosters: {},
    },
  };
  return { seasons, players };
}

function isP1Turn(count) {
  const r = count % 4;
  return r === 0 || r === 3;
}

// Direct-seeds p1's own picks (turn order is purely count-derived — see
// the Joker/Blue test suites' notes on this pattern) so the next real
// makeDraftPick call lands on p1's turn.
function seedForP1Turn(players, p1PlayerIds) {
  const picks = p1PlayerIds.map((pid, i) => ({ round: 1, pick: i + 1, participantId: 'p1', playerId: pid }));
  let count = picks.length;
  let fillerN = 0;
  while (!isP1Turn(count)) {
    const fid = `__filler_p2_${fillerN}`;
    players[fid] = player(fid, { position: 'PG', overall: 50 });
    picks.push({ round: 1, pick: picks.length + 1, participantId: 'p2', playerId: fid });
    count++;
    fillerN++;
  }
  return picks;
}

// ═══════════════════════════════════════════════════════════════════════
// UI LAYER — the actual locking bug
// ═══════════════════════════════════════════════════════════════════════

test('6. UI: a natural-C player with status "position-locked" is still open-able (has data-action="selectPlayer") in draft mode', () => {
  const positionPoolGrid = makeUiSandbox();
  const entries = [{ player: player('candC', { position: 'C', overall: 85 }), status: 'position-locked' }];
  const html = positionPoolGrid(entries, 'green', { mode: 'draft' });
  assert(html.includes('data-action="selectPlayer"'), 'a position-locked player must still be selectable in draft mode');
  assert(html.includes('Locked'), 'the "Locked" tag must still be shown, unchanged, for a normal-pick understanding');
});

test('UI: a "no-position" player is also still open-able in draft mode (same natural-position-derived status)', () => {
  const positionPoolGrid = makeUiSandbox();
  const entries = [{ player: player('noPos', { position: 'UTIL', overall: 80 }), status: 'no-position' }];
  const html = positionPoolGrid(entries, 'green', { mode: 'draft' });
  assert(html.includes('data-action="selectPlayer"'), 'a no-position player must still be selectable in draft mode');
});

test('UI: an already-drafted player remains truly non-selectable', () => {
  const positionPoolGrid = makeUiSandbox();
  const entries = [{ player: player('taken', { position: 'C', overall: 85 }), status: 'drafted' }];
  const html = positionPoolGrid(entries, 'green', { mode: 'draft' });
  assert(!html.includes('data-action="selectPlayer"'), 'an already-drafted player must never be selectable');
});

test('UI: a variant-locked player remains truly non-selectable', () => {
  const positionPoolGrid = makeUiSandbox();
  const entries = [{ player: player('variantTaken', { position: 'C', overall: 85 }), status: 'variant-locked' }];
  const html = positionPoolGrid(entries, 'green', { mode: 'draft' });
  assert(!html.includes('data-action="selectPlayer"'), 'a variant-locked player must never be selectable');
});

test('UI: view/manage modes (public/admin Players pages) are completely unaffected — never selectable regardless of status', () => {
  const positionPoolGrid = makeUiSandbox();
  const entries = [{ player: player('candC', { position: 'C', overall: 85 }), status: 'position-locked' }];
  const viewHtml = positionPoolGrid(entries, 'green', { mode: 'view' });
  const manageHtml = positionPoolGrid(entries, 'green', { mode: 'manage' });
  assert(!viewHtml.includes('data-action="selectPlayer"'));
  assert(!manageHtml.includes('data-action="selectPlayer"'));
});

// ═══════════════════════════════════════════════════════════════════════
// DATA LAYER — confirms effectivePosition governs Joker legality, and
// normal picks remain fully protected (unchanged from the prior Joker
// Pick implementation, verified again here for this exact bug's scenarios)
// ═══════════════════════════════════════════════════════════════════════

test('1. Natural C -> Joker-PF is allowed when only one C exists (effective position is PF, not C)', () => {
  const { seasons, players } = freshSeasonFixture();
  players.existingC = player('existingC', { position: 'C', overall: 80 });
  players.candidateC = player('candidateC', { position: 'C', overall: 85 });
  players.pg0 = player('pg0', { position: 'PG', overall: 80 });
  players.sg0 = player('sg0', { position: 'SG', overall: 80 });
  players.sf0 = player('sf0', { position: 'SF', overall: 80 });
  // p1's first 5 own picks complete the mandatory five: PG,SG,SF,PF(Joker'd from a natural C? simpler: just use existingC as C, and a plain PF)
  players.pf0 = player('pf0', { position: 'PF', overall: 80 });
  seasons.s1.playerDraftPicks = seedForP1Turn(players, ['pg0', 'sg0', 'sf0', 'pf0', 'existingC']);
  const { AdminActions } = makeDataSandbox(seasons, players);
  const r = AdminActions.makeDraftPick('s1', 'candidateC', { isJoker: true, jokerPosition: 'PF' });
  assert.strictEqual(r.isJoker, true);
  assert.strictEqual(r.jokerPosition, 'PF');
});

test('2. Natural C -> Joker-SF is allowed when SF is legal', () => {
  const { seasons, players } = freshSeasonFixture();
  players.existingC = player('existingC', { position: 'C', overall: 80 });
  players.candidateC = player('candidateC', { position: 'C', overall: 85 });
  players.pg0 = player('pg0', { position: 'PG', overall: 80 });
  players.sg0 = player('sg0', { position: 'SG', overall: 80 });
  players.pf0 = player('pf0', { position: 'PF', overall: 80 });
  players.sf0 = player('sf0', { position: 'SF', overall: 80 });
  seasons.s1.playerDraftPicks = seedForP1Turn(players, ['pg0', 'sg0', 'sf0', 'pf0', 'existingC']);
  const { AdminActions } = makeDataSandbox(seasons, players);
  const r = AdminActions.makeDraftPick('s1', 'candidateC', { isJoker: true, jokerPosition: 'SF' });
  assert.strictEqual(r.jokerPosition, 'SF');
});

test('3. Natural C + Joker-C results in exactly 2 effective Centers — allowed', () => {
  const { seasons, players } = freshSeasonFixture();
  players.existingC = player('existingC', { position: 'C', overall: 80 });
  players.candidateC = player('candidateC', { position: 'C', overall: 85 });
  players.pg0 = player('pg0', { position: 'PG', overall: 80 });
  players.sg0 = player('sg0', { position: 'SG', overall: 80 });
  players.sf0 = player('sf0', { position: 'SF', overall: 80 });
  players.pf0 = player('pf0', { position: 'PF', overall: 80 });
  seasons.s1.playerDraftPicks = seedForP1Turn(players, ['pg0', 'sg0', 'sf0', 'pf0', 'existingC']);
  const { AdminActions, LeagueData } = makeDataSandbox(seasons, players);
  const r = AdminActions.makeDraftPick('s1', 'candidateC', { isJoker: true, jokerPosition: 'C' });
  assert.strictEqual(r.isJoker, true);
  const posState = LeagueData.getPositionState('s1', 'p1');
  assert.strictEqual(posState.filled.C, true);
});

test('4. A third effective Center (via Joker-C) is rejected', () => {
  const { seasons, players } = freshSeasonFixture();
  players.c1 = player('c1', { position: 'C', overall: 80 });
  players.c2 = player('c2', { position: 'C', overall: 80 });
  players.candidateC = player('candidateC', { position: 'C', overall: 85 });
  players.pg0 = player('pg0', { position: 'PG', overall: 80 });
  players.sg0 = player('sg0', { position: 'SG', overall: 80 });
  players.sf0 = player('sf0', { position: 'SF', overall: 80 });
  players.pf0 = player('pf0', { position: 'PF', overall: 80 });
  seasons.s1.playerDraftPicks = seedForP1Turn(players, ['pg0', 'sg0', 'sf0', 'pf0', 'c1', 'c2']);
  const { AdminActions } = makeDataSandbox(seasons, players);
  assert.throws(
    () => AdminActions.makeDraftPick('s1', 'candidateC', { isJoker: true, jokerPosition: 'C' }),
    /already has 2 players at C/
  );
});

test('5. Natural C does not block a legal Joker-PF pick when PF count stays within the max-2 rule', () => {
  const { seasons, players } = freshSeasonFixture();
  players.existingC = player('existingC', { position: 'C', overall: 80 });
  players.existingPF = player('existingPF', { position: 'PF', overall: 80 });
  players.candidateC = player('candidateC', { position: 'C', overall: 85 });
  players.pg0 = player('pg0', { position: 'PG', overall: 80 });
  players.sg0 = player('sg0', { position: 'SG', overall: 80 });
  players.sf0 = player('sf0', { position: 'SF', overall: 80 });
  seasons.s1.playerDraftPicks = seedForP1Turn(players, ['pg0', 'sg0', 'sf0', 'existingPF', 'existingC']);
  const { AdminActions } = makeDataSandbox(seasons, players);
  const r = AdminActions.makeDraftPick('s1', 'candidateC', { isJoker: true, jokerPosition: 'PF' }); // PF would become 2 — allowed
  assert.strictEqual(r.jokerPosition, 'PF');
});

test('7. A normal pick of a naturally-locked candidate is still rejected by the data layer (position-cap protection intact)', () => {
  const { seasons, players } = freshSeasonFixture();
  players.c1 = player('c1', { position: 'C', overall: 80 });
  players.c2 = player('c2', { position: 'C', overall: 80 });
  players.candidateC = player('candidateC', { position: 'C', overall: 85 });
  players.pg0 = player('pg0', { position: 'PG', overall: 80 });
  players.sg0 = player('sg0', { position: 'SG', overall: 80 });
  players.sf0 = player('sf0', { position: 'SF', overall: 80 });
  players.pf0 = player('pf0', { position: 'PF', overall: 80 });
  seasons.s1.playerDraftPicks = seedForP1Turn(players, ['pg0', 'sg0', 'sf0', 'pf0', 'c1', 'c2']);
  const { AdminActions } = makeDataSandbox(seasons, players);
  // Normal pick (no Joker) — must be rejected: 2 Centers already at the cap.
  assert.throws(
    () => AdminActions.makeDraftPick('s1', 'candidateC'),
    /already has 2 players at C/
  );
  // The SAME candidate, same state, as a Joker Pick at a different (legal) position — must succeed.
  const r = AdminActions.makeDraftPick('s1', 'candidateC', { isJoker: true, jokerPosition: 'PG' });
  assert.strictEqual(r.isJoker, true);
});

test('8. Data layer remains authoritative: an illegal Joker effective position is still rejected even though the UI would allow opening the modal', () => {
  const { seasons, players } = freshSeasonFixture();
  players.pf1 = player('pf1', { position: 'PF', overall: 80 });
  players.pf2 = player('pf2', { position: 'PF', overall: 80 });
  players.candidateC = player('candidateC', { position: 'C', overall: 85 });
  players.pg0 = player('pg0', { position: 'PG', overall: 80 });
  players.sg0 = player('sg0', { position: 'SG', overall: 80 });
  players.sf0 = player('sf0', { position: 'SF', overall: 80 });
  players.c0 = player('c0', { position: 'C', overall: 80 });
  seasons.s1.playerDraftPicks = seedForP1Turn(players, ['pg0', 'sg0', 'sf0', 'pf1', 'c0', 'pf2']);
  const { AdminActions } = makeDataSandbox(seasons, players);
  assert.throws(
    () => AdminActions.makeDraftPick('s1', 'candidateC', { isJoker: true, jokerPosition: 'PF' }), // would make 3 effective PF
    /already has 2 players at PF/
  );
});

console.log(failures === 0 ? '\nAll tests passed.' : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
