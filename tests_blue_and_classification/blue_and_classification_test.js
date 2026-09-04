'use strict';
/**
 * Verifies:
 *  - The new phased Blue Pool draft rule (max 3 Blue in own picks 1-5,
 *    max 2 ADDITIONAL Blue in own picks 6-10, 5 total max) in
 *    AdminActions.makeDraftPick.
 *  - Complete removal of the old 10th-pick Blue rule/fee (Rule D).
 *  - Blue+Joker interaction: a Blue Joker counts as one Blue; a Green
 *    Joker never affects the Blue count; Joker itself adds no fee.
 *  - RED/YELLOW classification persistence: a player's ORIGINAL
 *    classification survives being swapped back into the available pool,
 *    and evaluateSwap/commitSwap enforce "RED only swaps with RED,
 *    YELLOW only with YELLOW" using each player's BASE classification
 *    (ignoring any Joker/PINK overlay).
 *
 * Loads the REAL js/data.js in a vm sandbox (same pattern as the other
 * data.js-backed suites in this repo).
 *
 * Turn-order note: for a 2-participant season, computeDraftSchedule's
 * snake turn assignment for global pick index K (0-based) is p1 exactly
 * when K % 4 is 0 or 3, and p2 otherwise — this repeats every 4 picks.
 * Crucially, WHO is recorded on a prior playerDraftPicks entry never
 * affects whose turn is next — only the array's LENGTH does — so
 * directly seeding arbitrary prior history (with participantId set to
 * whichever participant we want their own counts to reflect) is a valid,
 * and far simpler, way to set up an exact precondition than driving every
 * setup pick through a real makeDraftPick call.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'data.js'), 'utf8');

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

function makeSandbox(seasonData, playersData) {
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
  vm.runInContext(src, sandbox, { filename: 'data.js' });
  vm.runInContext('this.FirebaseSync = FirebaseSync; this.LeagueData = LeagueData; this.AdminActions = AdminActions;', sandbox, { filename: 'export.js' });
  sandbox.FirebaseSync.init();
  return { LeagueData: sandbox.LeagueData, AdminActions: sandbox.AdminActions };
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

// Whether global pick index `count` (0-based, i.e. playerDraftPicks.length
// so far) is p1's turn in a 2-participant snake draft — see file header.
function isP1Turn(count) {
  const r = count % 4;
  return r === 0 || r === 3;
}

// Seeds `p1PlayerIds` (p1's own picks, in order) directly into
// playerDraftPicks, padding with arbitrary p2 filler entries so the NEXT
// pick (after this seed) lands exactly on p1's turn.
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
// BLUE POOL — new phased rule
// ═══════════════════════════════════════════════════════════════════════

test('1. A team can draft Blue normally', () => {
  const { seasons, players } = freshSeasonFixture();
  players.blue1 = player('blue1', { position: 'PG', overall: 85, pool: 'blue' });
  const { AdminActions } = makeSandbox(seasons, players);
  const r = AdminActions.makeDraftPick('s1', 'blue1');
  assert.strictEqual(r.participantId, 'p1');
});

test('2/3. Maximum 3 Blue during picks 1-5; a 4th Blue in picks 1-5 is rejected', () => {
  const { seasons, players } = freshSeasonFixture();
  players.b0 = player('b0', { position: 'PG', overall: 85, pool: 'blue' });
  players.b1 = player('b1', { position: 'SG', overall: 85, pool: 'blue' });
  players.b2 = player('b2', { position: 'SF', overall: 85, pool: 'blue' });
  players.b3 = player('b3', { position: 'PF', overall: 85, pool: 'blue' });
  players.green0 = player('green0', { position: 'PF', overall: 80, pool: 'green' });
  seasons.s1.playerDraftPicks = seedForP1Turn(players, ['b0', 'b1', 'b2']); // p1 has 3 Blue (picks 1-3, phase 1)
  const { AdminActions } = makeSandbox(seasons, players);
  assert.throws(
    () => AdminActions.makeDraftPick('s1', 'b3'), // p1's 4th own pick, still phase 1
    /already has 3 Blue players in their first 5 picks/
  );
  const r = AdminActions.makeDraftPick('s1', 'green0'); // Green is unaffected by the Blue cap
  assert.strictEqual(r.participantId, 'p1');
});

test('4/5. Picks 6-10: up to 2 additional Blue allowed (1st of phase 2)', () => {
  const { seasons, players } = freshSeasonFixture();
  ['b0', 'b1', 'b2'].forEach((id, i) => { players[id] = player(id, { position: ['PG', 'SG', 'SF'][i], overall: 85, pool: 'blue' }); });
  players.g0 = player('g0', { position: 'PF', overall: 80, pool: 'green' });
  players.g1 = player('g1', { position: 'C', overall: 80, pool: 'green' });
  players.b3 = player('b3', { position: 'PG', overall: 85, pool: 'blue' });
  // p1's first 5 own picks: 3 Blue + 2 Green (phase 1 complete, mandatory five done).
  seasons.s1.playerDraftPicks = seedForP1Turn(players, ['b0', 'b1', 'b2', 'g0', 'g1']);
  const { AdminActions } = makeSandbox(seasons, players);
  const r = AdminActions.makeDraftPick('s1', 'b3'); // p1's 6th own pick, 4th total Blue — 1st of phase 2
  assert.strictEqual(r.participantId, 'p1');
});

test('6. A 6th total Blue (3rd of phase 2) is rejected', () => {
  const { seasons, players } = freshSeasonFixture();
  ['b0', 'b1', 'b2'].forEach((id, i) => { players[id] = player(id, { position: ['PG', 'SG', 'SF'][i], overall: 85, pool: 'blue' }); });
  players.g0 = player('g0', { position: 'PF', overall: 80, pool: 'green' });
  players.g1 = player('g1', { position: 'C', overall: 80, pool: 'green' });
  players.b3 = player('b3', { position: 'PG', overall: 85, pool: 'blue' });
  players.b4 = player('b4', { position: 'SG', overall: 85, pool: 'blue' });
  players.b5 = player('b5', { position: 'SF', overall: 85, pool: 'blue' });
  // p1's first 7 own picks: 3 Blue + 2 Green (phase 1) + 2 more Blue (phase 2, at its cap).
  seasons.s1.playerDraftPicks = seedForP1Turn(players, ['b0', 'b1', 'b2', 'g0', 'g1', 'b3', 'b4']);
  const { AdminActions } = makeSandbox(seasons, players);
  assert.throws(
    () => AdminActions.makeDraftPick('s1', 'b5'), // p1's 8th own pick — 3rd phase-2 Blue attempt
    /already has 2 additional Blue players in picks 6-10/
  );
});

test('7. Exactly 5 total Blue is accepted', () => {
  const { seasons, players } = freshSeasonFixture();
  ['b0', 'b1', 'b2'].forEach((id, i) => { players[id] = player(id, { position: ['PG', 'SG', 'SF'][i], overall: 85, pool: 'blue' }); });
  players.g0 = player('g0', { position: 'PF', overall: 80, pool: 'green' });
  players.g1 = player('g1', { position: 'C', overall: 80, pool: 'green' });
  players.b3 = player('b3', { position: 'PG', overall: 85, pool: 'blue' });
  players.b4 = player('b4', { position: 'SG', overall: 85, pool: 'blue' });
  seasons.s1.playerDraftPicks = seedForP1Turn(players, ['b0', 'b1', 'b2', 'g0', 'g1', 'b3']);
  const { AdminActions, LeagueData } = makeSandbox(seasons, players);
  const r = AdminActions.makeDraftPick('s1', 'b4'); // 5th total Blue
  assert.strictEqual(r.participantId, 'p1');
  const season = LeagueData.getSeason('s1');
  const p1BlueCount = season.playerDraftPicks.filter((p) => p.participantId === 'p1' && players[p.playerId]?.pool === 'blue').length;
  assert.strictEqual(p1BlueCount, 5);
});

test('8. Blue count is tracked per participant, not globally', () => {
  const { seasons, players } = freshSeasonFixture();
  players.b0 = player('b0', { position: 'PG', overall: 85, pool: 'blue' });
  players.b1 = player('b1', { position: 'SG', overall: 85, pool: 'blue' });
  players.b2 = player('b2', { position: 'SF', overall: 85, pool: 'blue' });
  players.p2blueA = player('p2blueA', { position: 'PG', overall: 85, pool: 'blue' });
  players.p2blueB = player('p2blueB', { position: 'SG', overall: 85, pool: 'blue' });
  players.p2blueC = player('p2blueC', { position: 'SF', overall: 85, pool: 'blue' });
  players.p2blueD = player('p2blueD', { position: 'PF', overall: 85, pool: 'blue' });
  const picks = [
    { round: 1, pick: 1, participantId: 'p1', playerId: 'b0' },
    { round: 1, pick: 2, participantId: 'p2', playerId: 'p2blueA' },
    { round: 2, pick: 3, participantId: 'p2', playerId: 'p2blueB' },
    { round: 2, pick: 4, participantId: 'p1', playerId: 'b1' },
  ];
  // p2 has 4 Blue already (well beyond p1's own 3-max) — must not affect p1's own cap.
  ['p2blueC', 'p2blueD'].forEach((pid) => picks.push({ round: 3, pick: picks.length + 1, participantId: 'p2', playerId: pid }));
  let fillerN = 0;
  while (!isP1Turn(picks.length)) {
    const fid = `__filler2_${fillerN++}`;
    players[fid] = player(fid, { position: 'PG', overall: 50 });
    picks.push({ round: 3, pick: picks.length + 1, participantId: 'p2', playerId: fid });
  }
  seasons.s1.playerDraftPicks = picks;
  const { AdminActions } = makeSandbox(seasons, players);
  const r = AdminActions.makeDraftPick('s1', 'b2'); // p1's 3rd Blue — must be allowed despite p2's 4 Blue
  assert.strictEqual(r.participantId, 'p1');
});

test('9. Green picks interspersed with Blue do not inflate the Blue count', () => {
  const { seasons, players } = freshSeasonFixture();
  players.b0 = player('b0', { position: 'PG', overall: 85, pool: 'blue' });
  players.g0 = player('g0', { position: 'SG', overall: 80, pool: 'green' });
  players.b1 = player('b1', { position: 'SF', overall: 85, pool: 'blue' });
  players.g1 = player('g1', { position: 'PF', overall: 80, pool: 'green' });
  players.b2 = player('b2', { position: 'C', overall: 85, pool: 'blue' });
  players.b3 = player('b3', { position: 'PG', overall: 85, pool: 'blue' });
  // p1's first 5 own picks interleave Blue/Green: B,G,B,G,B — still only 3 Blue.
  seasons.s1.playerDraftPicks = seedForP1Turn(players, ['b0', 'g0', 'b1', 'g1', 'b2']);
  const { AdminActions } = makeSandbox(seasons, players);
  const r = AdminActions.makeDraftPick('s1', 'b3'); // 4th total Blue (1st of phase 2) — must be allowed
  assert.strictEqual(r.participantId, 'p1');
});

test('12/13/14/15. No special 10th-pick Blue restriction, no fee, no transaction — old Rule D fully removed', () => {
  const { seasons, players } = freshSeasonFixture();
  const positions = ['PG', 'SG', 'SF', 'PF', 'C', 'PG', 'SG', 'SF', 'PF'];
  const ids = positions.map((pos, i) => { const id = `p1_${i}`; players[id] = player(id, { position: pos, overall: 50 }); return id; });
  players.blueHigh = player('blueHigh', { position: 'C', overall: 99, pool: 'blue' }); // deliberately over the old 94 cap
  seasons.s1.playerDraftPicks = seedForP1Turn(players, ids); // p1's 10th own pick is next
  const { AdminActions, LeagueData } = makeSandbox(seasons, players);
  const r = AdminActions.makeDraftPick('s1', 'blueHigh');
  assert.strictEqual(r.participantId, 'p1');
  assert.strictEqual('tenthPickBlueFeeCharged' in r, false);
  assert.strictEqual('tenthPickBlueFee' in r, false);
  const season = LeagueData.getSeason('s1');
  assert.strictEqual(season.pot, 0, 'no fee for any 10th pick, Blue or not');
  assert.strictEqual(season.transactions.length, 0, 'no transaction created for the removed Blue fee');
});

test('Old Rule D constants and executable logic are gone from the source', () => {
  assert(!/MAX_TENTH_PICK_BLUE_RATING/.test(src), 'MAX_TENTH_PICK_BLUE_RATING must be fully removed');
  assert(!/const TENTH_PICK_BLUE_FEE/.test(src), 'the TENTH_PICK_BLUE_FEE constant must be fully removed');
  assert(!/tenthPickBlueFeeCharged = true/.test(src), 'the old fee-charging code path must be gone');
  assert(/MAX_BLUE_DRAFT_PHASE1\s*=\s*3/.test(src), 'expected the new phase-1 Blue cap constant');
  assert(/MAX_BLUE_DRAFT_PHASE2_ADDITIONAL\s*=\s*2/.test(src), 'expected the new phase-2 additional-Blue cap constant');
});

// ═══════════════════════════════════════════════════════════════════════
// BLUE + JOKER interaction
// ═══════════════════════════════════════════════════════════════════════

test('10. A Blue Joker counts as one Blue toward the Blue limits', () => {
  const { seasons, players } = freshSeasonFixture();
  players.b0 = player('b0', { position: 'PG', overall: 85, pool: 'blue' });
  players.b1 = player('b1', { position: 'SG', overall: 85, pool: 'blue' });
  players.blueJokerCandidate = player('blueJokerCandidate', { position: 'SF', overall: 90, pool: 'blue' });
  players.b3 = player('b3', { position: 'PF', overall: 85, pool: 'blue' });
  seasons.s1.playerDraftPicks = seedForP1Turn(players, ['b0', 'b1']); // p1: 2 Blue so far
  const { AdminActions } = makeSandbox(seasons, players);
  const r = AdminActions.makeDraftPick('s1', 'blueJokerCandidate', { isJoker: true, jokerPosition: 'C' }); // 3rd Blue via Joker
  assert.strictEqual(r.isJoker, true);

  // Fresh sandbox reflecting the same facts (2 Blue + 1 Blue-Joker for p1),
  // to test that a 4th Blue in phase 1 is now correctly rejected.
  const { seasons: seasons2, players: players2 } = freshSeasonFixture();
  Object.assign(players2, players);
  seasons2.s1.playerDraftPicks = seedForP1Turn(players2, ['b0', 'b1', 'blueJokerCandidate']);
  seasons2.s1.playerDraftPicks[2].isJoker = true;
  seasons2.s1.playerDraftPicks[2].jokerPosition = 'C';
  const { AdminActions: AdminActions2 } = makeSandbox(seasons2, players2);
  assert.throws(
    () => AdminActions2.makeDraftPick('s1', 'b3'),
    /already has 3 Blue players in their first 5 picks/
  );
});

test('11. A Green Joker does not affect the Blue count', () => {
  const { seasons, players } = freshSeasonFixture();
  players.b0 = player('b0', { position: 'PG', overall: 85, pool: 'blue' });
  players.b1 = player('b1', { position: 'SG', overall: 85, pool: 'blue' });
  players.greenJokerCandidate = player('greenJokerCandidate', { position: 'SF', overall: 85, pool: 'green' });
  players.b3 = player('b3', { position: 'PF', overall: 85, pool: 'blue' });
  seasons.s1.playerDraftPicks = seedForP1Turn(players, ['b0', 'b1', 'greenJokerCandidate']);
  seasons.s1.playerDraftPicks[2].isJoker = true;
  seasons.s1.playerDraftPicks[2].jokerPosition = 'C';
  const { AdminActions } = makeSandbox(seasons, players);
  const r = AdminActions.makeDraftPick('s1', 'b3'); // 3rd Blue (Green Joker didn't use a slot) — must succeed
  assert.strictEqual(r.participantId, 'p1');
});

// ═══════════════════════════════════════════════════════════════════════
// COLOR CLASSIFICATION PERSISTENCE
// ═══════════════════════════════════════════════════════════════════════

// playerDraftPicks (immutable history) records EVERY original pick,
// including 3 players — redPoolGuy, yellowPoolGuy, greenPoolGuy — who are
// deliberately ABSENT from currentRosters below, simulating that they were
// already swapped out to the pool before this fixture's starting point.
function classificationFixture() {
  const players = {
    lebron: player('lebron', { position: 'SF', overall: 95 }),        // p1 pick1 -> RED
    p1b: player('p1b', { position: 'SG', overall: 80 }),              // p1 pick2 -> RED
    yellowGuy: player('yellowGuy', { position: 'PG', overall: 90 }),  // p1 pick3 -> YELLOW
    p1c: player('p1c', { position: 'PF', overall: 80 }),              // p1 pick4 -> YELLOW
    p1d: player('p1d', { position: 'C', overall: 80 }),               // p1 pick5 -> YELLOW
    p2a: player('p2a', { position: 'SG', overall: 80 }),              // p2 pick1 -> RED
    redPoolGuy: player('redPoolGuy', { position: 'SF', overall: 92 }), // p2 pick2 -> RED (currently in the pool)
    p2fillerA: player('p2fillerA', { position: 'PF', overall: 80 }),  // p2 pick3 -> YELLOW
    yellowPoolGuy: player('yellowPoolGuy', { position: 'PG', overall: 88 }), // p2 pick4 -> YELLOW (in pool)
    p2fillerB: player('p2fillerB', { position: 'C', overall: 80 }),   // p2 pick5 -> YELLOW
    p2fillerC: player('p2fillerC', { position: 'PG', overall: 80 }),  // p2 pick6 -> unclassified
    greenPoolGuy: player('greenPoolGuy', { position: 'C', overall: 85 }), // p2 pick7 -> unclassified (in pool)
  };
  const seasons = {
    s1: {
      id: 's1',
      participants: { p1: { id: 'p1', name: 'P1' }, p2: { id: 'p2', name: 'P2' } },
      playerDraftOrder: ['p1', 'p2'],
      playerDraftPicks: [
        { round: 1, pick: 1, participantId: 'p1', playerId: 'lebron' },
        { round: 1, pick: 2, participantId: 'p2', playerId: 'p2a' },
        { round: 2, pick: 3, participantId: 'p2', playerId: 'redPoolGuy' },
        { round: 2, pick: 4, participantId: 'p1', playerId: 'p1b' },
        { round: 3, pick: 5, participantId: 'p1', playerId: 'yellowGuy' },
        { round: 3, pick: 6, participantId: 'p2', playerId: 'p2fillerA' },
        { round: 4, pick: 7, participantId: 'p2', playerId: 'yellowPoolGuy' },
        { round: 4, pick: 8, participantId: 'p1', playerId: 'p1c' },
        { round: 5, pick: 9, participantId: 'p1', playerId: 'p1d' },
        { round: 5, pick: 10, participantId: 'p2', playerId: 'p2fillerB' },
        { round: 6, pick: 11, participantId: 'p2', playerId: 'p2fillerC' },
        { round: 6, pick: 12, participantId: 'p2', playerId: 'greenPoolGuy' },
      ],
      draftSkips: [],
      bonusPicks: {},
      transactions: [],
      pot: 0,
      currentSeasonDay: 1,
      ratingCap: 875,
      draftComplete: true,
      rostersInitialized: true,
      currentRosters: {
        // redPoolGuy, yellowPoolGuy, greenPoolGuy deliberately excluded —
        // they're "currently in the pool" for this fixture's starting point.
        p1: [
          { playerId: 'lebron', source: 'draft', draftSlot: 1 },
          { playerId: 'p1b', source: 'draft', draftSlot: 2 },
          { playerId: 'yellowGuy', source: 'draft', draftSlot: 3 },
          { playerId: 'p1c', source: 'draft', draftSlot: 4 },
          { playerId: 'p1d', source: 'draft', draftSlot: 5 },
        ],
        p2: [
          { playerId: 'p2a', source: 'draft', draftSlot: 1 },
          { playerId: 'p2fillerA', source: 'draft', draftSlot: 3 },
          { playerId: 'p2fillerB', source: 'draft', draftSlot: 5 },
          { playerId: 'p2fillerC', source: 'draft', draftSlot: 6 },
        ],
      },
    },
  };
  return { seasons, players };
}

test('26/30. Originally RED player remains RED when swapped back into the pool, and the pool exposes it', () => {
  const { seasons, players } = classificationFixture();
  const { AdminActions, LeagueData } = makeSandbox(seasons, players);
  AdminActions.commitSwap('s1', { participantId: 'p1', outgoingPlayerId: 'lebron', incomingPlayerId: 'redPoolGuy' });
  const pool = LeagueData.getSwapEligibleReplacements('s1', '');
  const lebronInPool = pool.find((p) => p.id === 'lebron');
  assert(lebronInPool, 'LeBron should now be in the available pool');
  assert.strictEqual(lebronInPool.classification, 'RED', 'LeBron must remain RED in the pool, not revert to unclassified/Green');
});

test('27. Originally YELLOW player remains YELLOW when swapped back into the pool', () => {
  const { seasons, players } = classificationFixture();
  const { AdminActions, LeagueData } = makeSandbox(seasons, players);
  AdminActions.commitSwap('s1', { participantId: 'p1', outgoingPlayerId: 'yellowGuy', incomingPlayerId: 'yellowPoolGuy' });
  const pool = LeagueData.getSwapEligibleReplacements('s1', '');
  const found = pool.find((p) => p.id === 'yellowGuy');
  assert(found, 'yellowGuy should now be in the available pool');
  assert.strictEqual(found.classification, 'YELLOW');
});

test('28. RED can only swap with RED — an unclassified replacement for a RED player is rejected', () => {
  const { seasons, players } = classificationFixture();
  const { AdminActions } = makeSandbox(seasons, players);
  assert.throws(
    () => AdminActions.commitSwap('s1', { participantId: 'p1', outgoingPlayerId: 'lebron', incomingPlayerId: 'greenPoolGuy' }),
    /is RED — only another RED player may replace them/
  );
});

test('29. YELLOW can only swap with YELLOW — a RED-pool replacement for a YELLOW player is rejected', () => {
  const { seasons, players } = classificationFixture();
  const { AdminActions } = makeSandbox(seasons, players);
  assert.throws(
    () => AdminActions.commitSwap('s1', { participantId: 'p1', outgoingPlayerId: 'yellowGuy', incomingPlayerId: 'redPoolGuy' }),
    /is YELLOW — only another YELLOW player may replace them/
  );
});

test('An unclassified (6th+ pick) player carries no RED/YELLOW restriction', () => {
  const { seasons, players } = classificationFixture();
  const { AdminActions } = makeSandbox(seasons, players);
  const r = AdminActions.commitSwap('s1', { participantId: 'p2', outgoingPlayerId: 'p2fillerC', incomingPlayerId: 'redPoolGuy' });
  assert(r);
});

test('31. classificationSourcePlayerId chaining still exists; baseClassification is a new, additive field', () => {
  assert(/classificationSourcePlayerId/.test(src), 'classificationSourcePlayerId mechanism must still exist');
  assert(/baseClassification/.test(src), 'the new baseClassification field must exist');
});

test('32. Joker/PINK classification does not destroy the underlying RED/YELLOW classification needed by swap rules', () => {
  const { seasons, players } = classificationFixture();
  seasons.s1.currentRosters.p1[0].isJoker = true; // LeBron (RED) is currently p1's Joker -> displays PINK
  seasons.s1.currentRosters.p1[0].jokerPosition = 'SF';
  const { AdminActions } = makeSandbox(seasons, players);
  assert.throws(
    () => AdminActions.commitSwap('s1', { participantId: 'p1', outgoingPlayerId: 'lebron', incomingPlayerId: 'greenPoolGuy' }),
    /is RED — only another RED player may replace them/
  );
  const r = AdminActions.commitSwap('s1', { participantId: 'p1', outgoingPlayerId: 'lebron', incomingPlayerId: 'redPoolGuy' });
  assert(r);
});

// ═══════════════════════════════════════════════════════════════════════
// COMPATIBILITY
// ═══════════════════════════════════════════════════════════════════════

test('33/34. Normal draft picks still work; an old-style season with no Blue-phase history loads and drafts fine', () => {
  const { seasons, players } = freshSeasonFixture();
  players.g0 = player('g0', { position: 'PG', overall: 80, pool: 'green' });
  const { AdminActions } = makeSandbox(seasons, players);
  const r = AdminActions.makeDraftPick('s1', 'g0');
  assert.strictEqual(r.playerId, 'g0');
});

test('35/36. Existing trades/swaps and post-draft Joker designation still work', () => {
  const { seasons, players } = classificationFixture();
  const { AdminActions, LeagueData } = makeSandbox(seasons, players);
  AdminActions.designateJoker('s1', 'p1', 'p1b', 'PG');
  const joker = LeagueData.getJoker('s1', 'p1');
  assert.strictEqual(joker.playerId, 'p1b');
});

test('37. Existing post-draft Joker Swap fee (300) still works', () => {
  const { seasons, players } = classificationFixture();
  const { AdminActions, LeagueData } = makeSandbox(seasons, players);
  const before = LeagueData.getSeason('s1').pot;
  AdminActions.commitSwap('s1', { participantId: 'p2', outgoingPlayerId: 'p2fillerC', incomingPlayerId: 'greenPoolGuy', isJokerSwap: true, jokerPosition: 'SF' });
  const after = LeagueData.getSeason('s1').pot;
  assert.strictEqual(after - before, 300, 'Joker Swap fee must remain 300');
});

console.log(failures === 0 ? '\nAll tests passed.' : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
