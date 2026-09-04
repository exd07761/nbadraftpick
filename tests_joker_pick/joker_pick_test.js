'use strict';
/**
 * Verifies the Joker Pick (live draft) feature added to js/data.js:
 *  - AdminActions.makeDraftPick(seasonId, playerId, { isJoker, jokerPosition })
 *  - computePositionState (effective-position aware)
 *  - AdminActions.initializeRostersFromDraft (carries Joker metadata)
 *  - LeagueData.getCurrentRoster pre-initialization fallback
 *
 * Loads the REAL data.js in a vm sandbox (same pattern as
 * cumulative_stage2_test.js) with a synchronous fake Firestore, so the
 * actual production logic runs — this is not a reimplementation of it.
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

function player(id, { position, overall, pool = 'green', variantGroup } = {}) {
  return { id, name: id, position, overall, pool, variantGroup };
}

// ─── Fixture builder ────────────────────────────────────────────────────
// One season, two participants (p1, p2), a small pool of players covering
// green/blue, all 5 positions, and one variant-group pair.
function freshSeasonFixture() {
  const players = {
    pg1: player('pg1', { position: 'PG', overall: 80 }),
    sg1: player('sg1', { position: 'SG', overall: 80 }),
    sf1: player('sf1', { position: 'SF', overall: 82 }), // will be drafted as Joker-C
    pf1: player('pf1', { position: 'PF', overall: 80 }),
    c1: player('c1', { position: 'C', overall: 80 }),
    sf2: player('sf2', { position: 'SF', overall: 80 }),
    sf3: player('sf3', { position: 'SF', overall: 80 }),
    pg2: player('pg2', { position: 'PG', overall: 80 }),
    sg2: player('sg2', { position: 'SG', overall: 80 }),
    sf4: player('sf4', { position: 'SF', overall: 80 }),
    pf2: player('pf2', { position: 'PF', overall: 80 }),
    c2: player('c2', { position: 'C', overall: 80 }),
    c3: player('c3', { position: 'C', overall: 85 }),
    lebronA: player('lebronA', { position: 'SF', overall: 90, variantGroup: 'lebron' }),
    lebronB: player('lebronB', { position: 'SF', overall: 90, variantGroup: 'lebron' }),
    blueBig: player('blueBig', { position: 'C', overall: 92, pool: 'blue' }),
  };
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

test('1. A Green Pool player can be drafted as Joker', () => {
  const { seasons, players } = freshSeasonFixture();
  const { AdminActions } = makeSandbox(seasons, players);
  const result = AdminActions.makeDraftPick('s1', 'sf1', { isJoker: true, jokerPosition: 'C' });
  assert.strictEqual(result.isJoker, true);
  assert.strictEqual(result.jokerPosition, 'C');
});

test('2. A Blue Pool player can be drafted as Joker (no special Blue-only restriction)', () => {
  const { seasons, players } = freshSeasonFixture();
  const { AdminActions } = makeSandbox(seasons, players);
  const result = AdminActions.makeDraftPick('s1', 'blueBig', { isJoker: true, jokerPosition: 'PG' });
  assert.strictEqual(result.isJoker, true);
  assert.strictEqual(result.jokerPosition, 'PG');
});

test('3/4/6. Natural SF drafted as Joker-C: fills C immediately, natural SF unaffected', () => {
  const { seasons, players } = freshSeasonFixture();
  const { AdminActions, LeagueData } = makeSandbox(seasons, players);
  AdminActions.makeDraftPick('s1', 'sf1', { isJoker: true, jokerPosition: 'C' });
  const posState = LeagueData.getPositionState('s1', 'p1');
  assert.strictEqual(posState.filled.C, true, 'C should be filled by the Joker Pick');
  assert.strictEqual(posState.filled.SF, false, 'SF should NOT be filled — the pick is effectively C, not SF');
  assert.strictEqual(posState.missing.slice().sort().join(','), ['PF', 'PG', 'SF', 'SG'].sort().join(','));
});

test('5. Max-2-per-position uses designated Joker position, not natural position', () => {
  const { seasons, players } = freshSeasonFixture();
  players.p2a = player('p2a', { position: 'PG', overall: 50 });
  players.p2b = player('p2b', { position: 'SG', overall: 50 });
  players.p2c = player('p2c', { position: 'SF', overall: 50 });
  players.p2d = player('p2d', { position: 'PF', overall: 50 });
  players.p2e = player('p2e', { position: 'C', overall: 50 });
  players.p2f = player('p2f', { position: 'PG', overall: 50 });
  players.c4 = player('c4', { position: 'C', overall: 50 }); // natural C, used for the rejected 3rd-effective-C attempt
  // Turn order for a 2-participant season is derived purely from
  // playerDraftPicks.length (see computeDraftSchedule's baseTurnParticipant),
  // never from what's actually recorded in prior entries — so directly
  // seeding the setup history below is valid, and only the picks actually
  // under test go through the real makeDraftPick. n=2's snake pattern is
  // [p1,p2,p2,p1] repeating every 4 turns, and (as it happens) the last
  // turn of one repeat and the first of the next are BOTH p1 — so indices
  // 11 and 12 below are two consecutive p1 turns.
  seasons.s1.playerDraftPicks = [
    { round: 1, pick: 1, participantId: 'p1', playerId: 'pg1' },              // idx0: p1 own#1 PG
    { round: 1, pick: 2, participantId: 'p2', playerId: 'p2a' },              // idx1: p2
    { round: 2, pick: 3, participantId: 'p2', playerId: 'p2b' },              // idx2: p2
    { round: 2, pick: 4, participantId: 'p1', playerId: 'sg1' },              // idx3: p1 own#2 SG
    { round: 3, pick: 5, participantId: 'p1', playerId: 'pf1' },              // idx4: p1 own#3 PF
    { round: 3, pick: 6, participantId: 'p2', playerId: 'p2c' },              // idx5: p2
    { round: 4, pick: 7, participantId: 'p2', playerId: 'p2d' },              // idx6: p2
    { round: 4, pick: 8, participantId: 'p1', playerId: 'sf1', isJoker: true, jokerPosition: 'C' }, // idx7: p1 own#4 Joker-C (1st effective C)
    { round: 5, pick: 9, participantId: 'p1', playerId: 'sf2' },              // idx8: p1 own#5 SF — completes mandatory five
    { round: 5, pick: 10, participantId: 'p2', playerId: 'p2e' },             // idx9: p2
    { round: 6, pick: 11, participantId: 'p2', playerId: 'p2f' },             // idx10: p2
  ];
  const { AdminActions } = makeSandbox(seasons, players);
  // idx11 (p1's turn): natural C — 2nd effective C, cap is 2, must be ALLOWED.
  const r1 = AdminActions.makeDraftPick('s1', 'c1');
  assert.strictEqual(r1.participantId, 'p1');
  // idx12 (p1's turn again — consecutive, see comment above): a 3rd effective
  // C (this time via a plain natural-C pick, to isolate the position-cap
  // rejection from the separate ONE-Joker rule) must be REJECTED.
  assert.throws(
    () => AdminActions.makeDraftPick('s1', 'c4'),
    /already has 2 players at C/
  );
});

test('7. An invalid designated position is rejected at the data layer', () => {
  const { seasons, players } = freshSeasonFixture();
  const { AdminActions } = makeSandbox(seasons, players);
  assert.throws(
    () => AdminActions.makeDraftPick('s1', 'sf1', { isJoker: true, jokerPosition: 'ZZ' }),
    /valid designated position/
  );
});

test('8. A Joker Pick with no designated position is rejected at the data layer', () => {
  const { seasons, players } = freshSeasonFixture();
  const { AdminActions } = makeSandbox(seasons, players);
  assert.throws(
    () => AdminActions.makeDraftPick('s1', 'sf1', { isJoker: true }),
    /valid designated position/
  );
});

test('9. A second Joker Pick by the same participant is rejected (data-layer enforced)', () => {
  const { seasons, players } = freshSeasonFixture();
  players.p2a = player('p2a', { position: 'PG', overall: 50 });
  players.p2b = player('p2b', { position: 'SG', overall: 50 });
  seasons.s1.playerDraftPicks = [
    { round: 1, pick: 1, participantId: 'p1', playerId: 'sf1', isJoker: true, jokerPosition: 'C' }, // idx0: p1's Joker
    { round: 1, pick: 2, participantId: 'p2', playerId: 'p2a' }, // idx1: p2
    { round: 2, pick: 3, participantId: 'p2', playerId: 'p2b' }, // idx2: p2
  ];
  const { AdminActions } = makeSandbox(seasons, players);
  // idx3: p1's turn again. A different position (PG, which p1 doesn't have
  // yet) isolates this from any position-cap conflict — this must fail
  // purely because p1 already has a Joker.
  assert.throws(
    () => AdminActions.makeDraftPick('s1', 'pg1', { isJoker: true, jokerPosition: 'PG' }),
    /already made their Joker Pick/
  );
});

test('10. A different participant can still make their own Joker Pick', () => {
  const { seasons, players } = freshSeasonFixture();
  const { AdminActions } = makeSandbox(seasons, players);
  AdminActions.makeDraftPick('s1', 'sf1', { isJoker: true, jokerPosition: 'C' });
  const r2 = AdminActions.makeDraftPick('s1', 'pg2', { isJoker: true, jokerPosition: 'PG' });
  assert.strictEqual(r2.isJoker, true);
});

test('11/12. Undoing the latest Joker Pick lets the participant Joker again', () => {
  const { seasons, players } = freshSeasonFixture();
  const { AdminActions } = makeSandbox(seasons, players);
  AdminActions.makeDraftPick('s1', 'sf1', { isJoker: true, jokerPosition: 'C' });
  AdminActions.undoLastDraftPick('s1');
  const r = AdminActions.makeDraftPick('s1', 'sf1', { isJoker: true, jokerPosition: 'PF' });
  assert.strictEqual(r.isJoker, true);
  assert.strictEqual(r.jokerPosition, 'PF');
});

test('13. A Draft Joker Pick creates no fee/transaction and does not touch season.pot', () => {
  const { seasons, players } = freshSeasonFixture();
  const { AdminActions, LeagueData } = makeSandbox(seasons, players);
  AdminActions.makeDraftPick('s1', 'sf1', { isJoker: true, jokerPosition: 'C' });
  const season = LeagueData.getSeason('s1');
  assert.strictEqual(season.pot, 0, 'pot must be untouched by a Draft Joker Pick');
  assert.strictEqual(season.transactions.length, 0, 'no transaction should be created for a Draft Joker Pick');
});

test('14. The existing post-draft Joker Swap fee logic is untouched', () => {
  assert(/const JOKER_SWAP_FEE = 300;/.test(src), 'JOKER_SWAP_FEE must still be 300');
  assert(
    src.includes('? { playerId: incomingPlayerId, source: "swap", isJoker: true, jokerPosition }'),
    "Joker Swap's own isJoker-setting logic must be unchanged"
  );
});

test('15. A 10th-pick Blue Joker drafts normally — no special 10th-pick restriction, no fee, no transaction (old Rule D removed)', () => {
  const { seasons, players } = freshSeasonFixture();
  // p1's own picks #1-9: PG,SG,SF,PF,C once each (mandatory five), then
  // PG,SG,SF,PF a 2nd time each (9 total, all Green — no Blue used yet).
  // 10 p2 filler entries pad the turn count so the 20th overall pick
  // (p1's 10th own) lands on p1's turn (see test 5's comment on why
  // direct-seeding prior history is valid here).
  const p1Positions = ['PG', 'SG', 'SF', 'PF', 'C', 'PG', 'SG', 'SF', 'PF'];
  const picks = [];
  for (let i = 0; i < 9; i++) {
    const pos = p1Positions[i];
    players[`p1_${i}`] = player(`p1_${i}`, { position: pos, overall: 50 });
    picks.push({ round: 1, pick: picks.length + 1, participantId: 'p1', playerId: `p1_${i}` });
  }
  for (let i = 0; i < 10; i++) {
    players[`p2_${i}`] = player(`p2_${i}`, { position: 'PG', overall: 50 });
    picks.push({ round: 1, pick: picks.length + 1, participantId: 'p2', playerId: `p2_${i}` });
  }
  seasons.s1.playerDraftPicks = picks; // 19 entries — the 20th (index 19) is p1's turn
  players.blue10 = player('blue10', { position: 'PG', overall: 99, pool: 'blue' }); // deliberately HIGH OVR — the old 94-cap no longer applies
  const { AdminActions, LeagueData } = makeSandbox(seasons, players);
  const result = AdminActions.makeDraftPick('s1', 'blue10', { isJoker: true, jokerPosition: 'C' });
  assert.strictEqual(result.participantId, 'p1');
  assert.strictEqual(result.isJoker, true);
  assert.strictEqual('tenthPickBlueFeeCharged' in result, false, 'the old Rule D field must no longer exist on the return value');
  assert.strictEqual('tenthPickBlueFee' in result, false, 'the old Rule D field must no longer exist on the return value');
  const season = LeagueData.getSeason('s1');
  assert.strictEqual(season.pot, 0, 'no fee of any kind for a 10th-pick Blue — the old Rule D fee is gone');
  assert.strictEqual(season.transactions.length, 0, 'no transaction should be created — tenthPickBlueFee is no longer generated');
});

test('16. Joker does not discount OVR — the real rating still counts toward the cap', () => {
  const { seasons, players } = freshSeasonFixture();
  seasons.s1.ratingCap = 100; // artificially low, for this test only
  players.p2x = player('p2x', { position: 'PG', overall: 50 });
  players.p2y = player('p2y', { position: 'SG', overall: 50 });
  // Direct-seed (see test 5's comment on why this is valid): p1's Joker-C
  // (82 OVR) at idx0, two p2 fillers at idx1/2 so idx3 lands back on p1.
  seasons.s1.playerDraftPicks = [
    { round: 1, pick: 1, participantId: 'p1', playerId: 'sf1', isJoker: true, jokerPosition: 'C' },
    { round: 1, pick: 2, participantId: 'p2', playerId: 'p2x' },
    { round: 2, pick: 3, participantId: 'p2', playerId: 'p2y' },
  ];
  const { AdminActions } = makeSandbox(seasons, players);
  // idx3: p1's turn. pg1 (80 OVR, natural PG — still a needed position, so
  // this doesn't trip the mandatory-five rule) pushes p1's total to
  // 82 + 80 = 162, over the 100 cap — the Joker pick's real 82 OVR must
  // still count in full, with no discount.
  assert.throws(
    () => AdminActions.makeDraftPick('s1', 'pg1'),
    /rating cap/
  );
});

test('17. Variant-group lock still blocks a Joker Pick of an already-drafted variant', () => {
  const { seasons, players } = freshSeasonFixture();
  const { AdminActions } = makeSandbox(seasons, players);
  AdminActions.makeDraftPick('s1', 'lebronA');
  AdminActions.makeDraftPick('s1', 'pg2');
  assert.throws(
    () => AdminActions.makeDraftPick('s1', 'lebronB', { isJoker: true, jokerPosition: 'C' }),
    /Another variant/
  );
});

test('18. An already-drafted player cannot be drafted again as a Joker', () => {
  const { seasons, players } = freshSeasonFixture();
  const { AdminActions } = makeSandbox(seasons, players);
  AdminActions.makeDraftPick('s1', 'pg1');
  AdminActions.makeDraftPick('s1', 'pg2');
  assert.throws(
    () => AdminActions.makeDraftPick('s1', 'pg1', { isJoker: true, jokerPosition: 'C' }),
    /already drafted/
  );
});

test('19. Draft history preserves round/pick/participantId/playerId, plus Joker fields only on the Joker pick', () => {
  const { seasons, players } = freshSeasonFixture();
  const { AdminActions, LeagueData } = makeSandbox(seasons, players);
  AdminActions.makeDraftPick('s1', 'pg1'); // p1, normal
  AdminActions.makeDraftPick('s1', 'sf1', { isJoker: true, jokerPosition: 'C' }); // p2, Joker
  const season = LeagueData.getSeason('s1');
  assert.strictEqual(season.playerDraftPicks.length, 2);
  const [pick1, pick2] = season.playerDraftPicks;
  assert.strictEqual(pick1.round, 1);
  assert.strictEqual(pick1.pick, 1);
  assert.strictEqual(pick1.participantId, 'p1');
  assert.strictEqual(pick1.playerId, 'pg1');
  assert.deepStrictEqual(Object.keys(pick1).sort(), ['participantId', 'pick', 'playerId', 'round'], 'a normal pick must keep the exact original 4-key shape');
  assert.strictEqual(pick2.participantId, 'p2');
  assert.strictEqual(pick2.isJoker, true);
  assert.strictEqual(pick2.jokerPosition, 'C');
});

test('20. initializeRostersFromDraft carries isJoker/jokerPosition into currentRosters', () => {
  const { seasons, players } = freshSeasonFixture();
  const { AdminActions, LeagueData } = makeSandbox(seasons, players);
  AdminActions.makeDraftPick('s1', 'sf1', { isJoker: true, jokerPosition: 'C' });
  AdminActions.makeDraftPick('s1', 'pg2');
  AdminActions.markDraftComplete('s1');
  AdminActions.initializeRostersFromDraft('s1');
  const rostersSeason = LeagueData.getSeason('s1');
  const p1Entry = rostersSeason.currentRosters.p1.find((e) => e.playerId === 'sf1');
  assert.strictEqual(p1Entry.isJoker, true);
  assert.strictEqual(p1Entry.jokerPosition, 'C');
  assert.strictEqual(p1Entry.draftSlot, 1);
  const p2Entry = rostersSeason.currentRosters.p2.find((e) => e.playerId === 'pg2');
  assert.strictEqual(p2Entry.isJoker, undefined, 'a normal pick must not gain isJoker after roster init');
});

test('21. getCurrentRoster (pre-initialization fallback) reflects the Joker effective position immediately', () => {
  const { seasons, players } = freshSeasonFixture();
  const { AdminActions, LeagueData } = makeSandbox(seasons, players);
  AdminActions.makeDraftPick('s1', 'sf1', { isJoker: true, jokerPosition: 'C' });
  const roster = LeagueData.getCurrentRoster('s1', 'p1'); // rostersInitialized still false
  const entry = roster.find((e) => e.playerId === 'sf1');
  assert.strictEqual(entry.effectivePosition, 'C', "pre-init fallback must show the Joker's designated position, not natural SF");
  assert.strictEqual(entry.isJoker, true);
  assert.strictEqual(entry.jokerPosition, 'C');
  assert.strictEqual(entry.classification, 'PINK', 'pre-init fallback must classify a Joker Pick as PINK immediately');
});

test('22. An old-style season (no Joker options ever passed) still drafts normally', () => {
  const { seasons, players } = freshSeasonFixture();
  const { AdminActions, LeagueData } = makeSandbox(seasons, players);
  const r = AdminActions.makeDraftPick('s1', 'pg1');
  assert.strictEqual(r.isJoker, false);
  assert.strictEqual(r.jokerPosition, undefined);
  const posState = LeagueData.getPositionState('s1', 'p1');
  assert.strictEqual(posState.filled.PG, true);
});

test('23. Existing normal draft picks keep the exact original 4-key shape (no Joker keys leak in)', () => {
  const { seasons, players } = freshSeasonFixture();
  const { AdminActions, LeagueData } = makeSandbox(seasons, players);
  AdminActions.makeDraftPick('s1', 'pg1');
  const season = LeagueData.getSeason('s1');
  assert.deepStrictEqual(Object.keys(season.playerDraftPicks[0]).sort(), ['participantId', 'pick', 'playerId', 'round']);
});

test('Backward compatibility: makeDraftPick(seasonId, playerId) with no 3rd argument still works', () => {
  const { seasons, players } = freshSeasonFixture();
  const { AdminActions } = makeSandbox(seasons, players);
  const r = AdminActions.makeDraftPick('s1', 'pg1');
  assert.strictEqual(r.round, 1);
  assert.strictEqual(r.pick, 1);
  assert.strictEqual(r.participantId, 'p1');
  assert.strictEqual(r.playerId, 'pg1');
});

console.log(failures === 0 ? '\nAll tests passed.' : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
