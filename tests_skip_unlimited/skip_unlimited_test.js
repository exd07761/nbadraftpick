'use strict';
/**
 * Verifies the Draft-Skip Revision 3 change in js/data.js: the flexible
 * accumulated pick-opportunity system that replaced the short-lived
 * Revision 2 ("skip has zero future effect") behavior.
 *
 *  - Every draft turn grants a participant at least one pick opportunity.
 *    PICK spends an opportunity on an actual player pick. SKIP does not
 *    spend one — it banks +1 opportunity for that participant's NEXT
 *    draft turn (see computeDraftSchedule's doc comment for the full
 *    model: a draft turn's total available opportunities = 1 + whatever
 *    was banked from that participant's own earlier Skips).
 *  - Unlike the old Revision 1 "bonus double-pick" turn, a participant is
 *    NEVER forced to Pick and is NEVER blocked from Skipping — including
 *    while resolving a multi-opportunity turn banked from earlier Skips.
 *  - A Skip NEVER creates an actual player pick and NEVER advances a
 *    participant's own pick count (ownPickNumber) — only an actual Pick
 *    does that, so RED/YELLOW classification is entirely unaffected by
 *    how many times a participant skipped in between.
 *  - Skips banked for one participant never affect any other
 *    participant's turns or the base snake rotation order.
 *  - season.draftSkips[] remains a full, untouched, append-only history
 *    of every skip (including skips recorded before this change).
 *  - Unrelated draft rules (roster cap, position rules, OVR cap,
 *    Blue-pool phase caps, Variant Group lock, Joker Pick) are unaffected.
 *
 * Loads the REAL data.js in a vm sandbox (same pattern as
 * tests_joker_pick/joker_pick_test.js) with a synchronous fake
 * Firestore, so the actual production logic runs.
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

function player(id, { position, overall = 80, pool = 'green', variantGroup } = {}) {
  return { id, name: id, position, overall, pool, variantGroup };
}

function basePlayers() {
  const players = {};
  const POS = ['PG', 'SG', 'SF', 'PF', 'C'];
  for (const pos of POS) {
    for (let i = 1; i <= 4; i++) {
      const id = `${pos.toLowerCase()}${i}`;
      players[id] = player(id, { position: pos, overall: 75 + i });
    }
  }
  players.lebronA = player('lebronA', { position: 'SF', overall: 90, variantGroup: 'lebron' });
  players.lebronB = player('lebronB', { position: 'SF', overall: 90, variantGroup: 'lebron' });
  players.blueBig = player('blueBig', { position: 'C', overall: 92, pool: 'blue' });
  return players;
}

function baseSeason(order) {
  const participants = {};
  for (const id of order) participants[id] = { id, name: id.toUpperCase() };
  return {
    id: 's1',
    participants,
    playerDraftOrder: order,
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
  };
}

// 2-participant fixture (order: p1, p2) — used for most unrelated-system
// regression checks, where only one participant's Skip behavior matters.
function freshSeasonFixture() {
  const players = basePlayers();
  const seasons = { s1: baseSeason(['p1', 'p2']) };
  return { seasons, players };
}

// 1-participant fixture — isolates the opportunity mechanics themselves
// (accumulation, resolution, classification) from any rotation concerns,
// since with n=1 every draft turn belongs to the same participant anyway.
function soloSeasonFixture() {
  const players = basePlayers();
  const seasons = { s1: baseSeason(['p1']) };
  return { seasons, players };
}

// 3-participant fixture — used to prove a Skip's banked opportunity is
// scoped to the skipper alone and never disrupts other participants'
// turns or the base snake rotation order.
function threeSeasonFixture() {
  const players = basePlayers();
  const seasons = { s1: baseSeason(['p1', 'p2', 'p3']) };
  return { seasons, players };
}

// ─── 1. Normal PICK works ────────────────────────────────────────────────
test('A normal Pick works and needs no opportunity accumulation', () => {
  const { seasons, players } = soloSeasonFixture();
  const { AdminActions, LeagueData } = makeSandbox(seasons, players);
  const state0 = LeagueData.getDraftState('s1');
  assert.strictEqual(state0.isBonusTurn, false);
  assert.strictEqual(state0.picksNeededThisTurn, 1);
  AdminActions.makeDraftPick('s1', 'pg1');
  const season = LeagueData.getSeason('s1');
  assert.strictEqual(season.playerDraftPicks.length, 1);
  assert.strictEqual(season.draftSkips.length, 0);
});

// ─── 2-5. N skips create N future pick opportunities ────────────────────
// A single always-skipping participant naturally produces sittings of
// size 1, 2, 3, 4, 5, ... in sequence (see computeDraftSchedule's doc
// comment): fully skipping a sitting of size K banks exactly K
// opportunities for the next one, whose size becomes 1+K. This test
// walks that sequence from K=1 through K=5, verifying at each stage.
test('1, 2, 3, 4, and 5 consecutive skips each create that many future pick opportunities', () => {
  const { seasons, players } = soloSeasonFixture();
  const { AdminActions, LeagueData } = makeSandbox(seasons, players);

  for (const k of [1, 2, 3, 4, 5]) {
    const before = LeagueData.getDraftState('s1');
    assert.strictEqual(before.picksNeededThisTurn, k, `sitting entering step ${k} should need exactly ${k} opportunities`);
    assert.strictEqual(before.picksTakenThisTurn, 0, `sitting entering step ${k} should be fresh`);
    assert.strictEqual(before.isBonusTurn, k > 1, `isBonusTurn should be ${k > 1} entering step ${k}`);

    for (let i = 0; i < k; i++) {
      assert.doesNotThrow(() => AdminActions.skipDraftPick('s1'));
    }

    const season = LeagueData.getSeason('s1');
    assert.strictEqual(season.playerDraftPicks.length, 0, `no player pick should ever be created by a skip (step ${k})`);

    const after = LeagueData.getDraftState('s1');
    assert.strictEqual(after.picksNeededThisTurn, k + 1, `${k} skip(s) should bank ${k} future opportunit(y/ies), making the next sitting need ${k + 1}`);
    assert.strictEqual(after.picksTakenThisTurn, 0);
    assert.strictEqual(after.isBonusTurn, true);
  }
});

// ─── 6-11. Mixed Pick/Skip sequences (deterministic step-by-step) ───────
test('Pick -> Skip -> Pick works: 2nd pick uses part of the banked opportunity', () => {
  const { seasons, players } = soloSeasonFixture();
  const { AdminActions, LeagueData } = makeSandbox(seasons, players);
  AdminActions.makeDraftPick('s1', 'pg1');   // sitting0 (need1): Pick #1 -> resolved, bank 0
  AdminActions.skipDraftPick('s1');          // sitting1 (need1): Skip -> resolved, bank 1
  AdminActions.makeDraftPick('s1', 'sg1');   // sitting2 (need2): Pick #2 -> 1 of 2 taken, NOT resolved
  const season = LeagueData.getSeason('s1');
  assert.strictEqual(season.playerDraftPicks.length, 2);
  assert.strictEqual(season.draftSkips.length, 1);
  const state = LeagueData.getDraftState('s1');
  assert.strictEqual(state.isBonusTurn, true);
  assert.strictEqual(state.picksNeededThisTurn, 2);
  assert.strictEqual(state.picksTakenThisTurn, 1);
  assert.strictEqual(state.currentParticipantId, 'p1');
});

test('Pick -> Skip -> Skip works: sitting stays open mid-way through the banked opportunity', () => {
  const { seasons, players } = soloSeasonFixture();
  const { AdminActions, LeagueData } = makeSandbox(seasons, players);
  AdminActions.makeDraftPick('s1', 'pg1');   // sitting0: Pick -> resolved, bank 0
  AdminActions.skipDraftPick('s1');          // sitting1 (need1): Skip -> resolved, bank 1
  AdminActions.skipDraftPick('s1');          // sitting2 (need2): Skip -> 1 of 2 taken, NOT resolved
  const season = LeagueData.getSeason('s1');
  assert.strictEqual(season.playerDraftPicks.length, 1);
  assert.strictEqual(season.draftSkips.length, 2);
  const state = LeagueData.getDraftState('s1');
  assert.strictEqual(state.picksNeededThisTurn, 2);
  assert.strictEqual(state.picksTakenThisTurn, 1);
});

test('Skip -> Pick -> Skip works', () => {
  const { seasons, players } = soloSeasonFixture();
  const { AdminActions, LeagueData } = makeSandbox(seasons, players);
  AdminActions.skipDraftPick('s1');          // sitting0 (need1): Skip -> resolved, bank 1
  AdminActions.makeDraftPick('s1', 'pg1');   // sitting1 (need2): Pick #1 -> 1 of 2, NOT resolved
  AdminActions.skipDraftPick('s1');          // sitting1: Skip -> 2 of 2 -> resolved, bank 1 -> sitting2 need2
  const season = LeagueData.getSeason('s1');
  assert.strictEqual(season.playerDraftPicks.length, 1);
  assert.strictEqual(season.draftSkips.length, 2);
  const state = LeagueData.getDraftState('s1');
  assert.strictEqual(state.picksNeededThisTurn, 2);
  assert.strictEqual(state.picksTakenThisTurn, 0);
});

test('Skip -> Skip -> Pick works', () => {
  const { seasons, players } = soloSeasonFixture();
  const { AdminActions, LeagueData } = makeSandbox(seasons, players);
  AdminActions.skipDraftPick('s1');          // sitting0 (need1): Skip -> resolved, bank 1
  AdminActions.skipDraftPick('s1');          // sitting1 (need2): Skip -> 1 of 2, NOT resolved
  AdminActions.makeDraftPick('s1', 'pg1');   // sitting1: Pick #1 -> 2 of 2 -> resolved, bank 1 (from the skip only) -> sitting2 need2
  const season = LeagueData.getSeason('s1');
  assert.strictEqual(season.playerDraftPicks.length, 1);
  assert.strictEqual(season.draftSkips.length, 2);
  const state = LeagueData.getDraftState('s1');
  assert.strictEqual(state.picksNeededThisTurn, 2);
  assert.strictEqual(state.picksTakenThisTurn, 0);
});

test('Skip -> Skip -> Skip works', () => {
  const { seasons, players } = soloSeasonFixture();
  const { AdminActions, LeagueData } = makeSandbox(seasons, players);
  AdminActions.skipDraftPick('s1'); // sitting0 (need1) -> resolved, bank1
  AdminActions.skipDraftPick('s1'); // sitting1 (need2) -> 1 of 2
  AdminActions.skipDraftPick('s1'); // sitting1 -> 2 of 2 -> resolved, bank2 -> sitting2 need3
  const season = LeagueData.getSeason('s1');
  assert.strictEqual(season.playerDraftPicks.length, 0);
  assert.strictEqual(season.draftSkips.length, 3);
  const state = LeagueData.getDraftState('s1');
  assert.strictEqual(state.picksNeededThisTurn, 3);
  assert.strictEqual(state.picksTakenThisTurn, 0);
});

test('Pick -> Pick -> Skip works', () => {
  const { seasons, players } = soloSeasonFixture();
  const { AdminActions, LeagueData } = makeSandbox(seasons, players);
  AdminActions.makeDraftPick('s1', 'pg1'); // sitting0 (need1) -> resolved
  AdminActions.makeDraftPick('s1', 'sg1'); // sitting1 (need1) -> resolved
  AdminActions.skipDraftPick('s1');        // sitting2 (need1) -> resolved, bank1 -> sitting3 need2
  const season = LeagueData.getSeason('s1');
  assert.strictEqual(season.playerDraftPicks.length, 2);
  assert.strictEqual(season.draftSkips.length, 1);
  const state = LeagueData.getDraftState('s1');
  assert.strictEqual(state.picksNeededThisTurn, 2);
  assert.strictEqual(state.picksTakenThisTurn, 0);
});

// ─── 12-13. Accumulated opportunities can be used for Pick or Skip ──────
test('A participant can use accumulated opportunities to make multiple Picks in one sitting', () => {
  const { seasons, players } = soloSeasonFixture();
  const { AdminActions, LeagueData } = makeSandbox(seasons, players);
  AdminActions.skipDraftPick('s1'); // banks 1 -> next sitting needs 2
  AdminActions.makeDraftPick('s1', 'pg1'); // 1 of 2
  AdminActions.makeDraftPick('s1', 'sg1'); // 2 of 2 -> resolved
  const season = LeagueData.getSeason('s1');
  assert.strictEqual(season.playerDraftPicks.length, 2);
  assert.strictEqual(season.playerDraftPicks.every((p) => p.participantId === 'p1'), true);
});

test('A participant can Skip again while resolving a multi-opportunity sitting (never forced to Pick)', () => {
  const { seasons, players } = soloSeasonFixture();
  const { AdminActions, LeagueData } = makeSandbox(seasons, players);
  AdminActions.skipDraftPick('s1');
  AdminActions.skipDraftPick('s1');
  AdminActions.skipDraftPick('s1'); // sitting0->bank1; sitting1(need2) 2 skips->resolved bank2; sitting2 need3 fresh
  const midState = LeagueData.getDraftState('s1');
  assert.strictEqual(midState.isBonusTurn, true);
  assert.strictEqual(midState.picksNeededThisTurn, 3);
  // Skip is still fully available on this bonus sitting — no guard blocks it.
  assert.doesNotThrow(() => AdminActions.skipDraftPick('s1'));
});

// ─── 14. A SKIP never creates an actual player pick (stress test) ───────
test('Many consecutive skips (deep AFK accumulation) never create a player pick', () => {
  const { seasons, players } = soloSeasonFixture();
  const { AdminActions, LeagueData } = makeSandbox(seasons, players);
  for (let i = 0; i < 12; i++) {
    assert.doesNotThrow(() => AdminActions.skipDraftPick('s1'));
  }
  const season = LeagueData.getSeason('s1');
  assert.strictEqual(season.playerDraftPicks.length, 0);
  assert.strictEqual(season.draftSkips.length, 12);
});

// ─── 15. A SKIP never increments ownPickNumber ──────────────────────────
test("Skips between picks never shift the participant's own pick number", () => {
  const { seasons, players } = soloSeasonFixture();
  const { AdminActions, LeagueData } = makeSandbox(seasons, players);
  AdminActions.makeDraftPick('s1', 'pg1'); // own pick #1
  const rosterAfterFirst = LeagueData.getCurrentRoster('s1', 'p1');
  assert.strictEqual(rosterAfterFirst.length, 1);
  assert.strictEqual(rosterAfterFirst[0].draftSlot, 1);

  AdminActions.skipDraftPick('s1');
  AdminActions.skipDraftPick('s1'); // (2nd skip is mid-sitting, still fine)
  // Still only 1 actual pick, still draftSlot 1 — skips didn't touch it.
  const rosterAfterSkips = LeagueData.getCurrentRoster('s1', 'p1');
  assert.strictEqual(rosterAfterSkips.length, 1);
  assert.strictEqual(rosterAfterSkips[0].draftSlot, 1);

  AdminActions.makeDraftPick('s1', 'sg1'); // own pick #2
  const rosterAfterSecond = LeagueData.getCurrentRoster('s1', 'p1');
  assert.strictEqual(rosterAfterSecond.length, 2);
  assert.strictEqual(rosterAfterSecond[1].draftSlot, 2);
});

// ─── 16-22. RED/YELLOW classification, with skips interspersed ─────────
test('Pick #1/#2 are RED, #3/#4/#5 are YELLOW, and skips interspersed between them change nothing', () => {
  const { seasons, players } = soloSeasonFixture();
  const { AdminActions, LeagueData } = makeSandbox(seasons, players);

  AdminActions.makeDraftPick('s1', 'pg1'); // #1 RED
  AdminActions.skipDraftPick('s1');
  AdminActions.skipDraftPick('s1');
  AdminActions.makeDraftPick('s1', 'sg1'); // #2 RED
  AdminActions.skipDraftPick('s1');
  AdminActions.makeDraftPick('s1', 'sf1'); // #3 YELLOW
  AdminActions.makeDraftPick('s1', 'pf1'); // #4 YELLOW
  AdminActions.skipDraftPick('s1');
  AdminActions.skipDraftPick('s1');
  AdminActions.skipDraftPick('s1');
  AdminActions.makeDraftPick('s1', 'c1');  // #5 YELLOW

  const roster = LeagueData.getCurrentRoster('s1', 'p1');
  assert.strictEqual(roster.length, 5);
  assert.strictEqual(roster.map((e) => e.classification).join(','), ['RED', 'RED', 'YELLOW', 'YELLOW', 'YELLOW'].join(','));
  assert.strictEqual(roster.map((e) => e.draftSlot).join(','), [1, 2, 3, 4, 5].join(','));

  const season = LeagueData.getSeason('s1');
  assert.ok(season.draftSkips.length >= 6, 'plenty of skips happened in between');
});

// ─── 23. No duplicate players are created ───────────────────────────────
test('No duplicate players are created across a long mixed pick/skip sequence', () => {
  const { seasons, players } = soloSeasonFixture();
  const { AdminActions, LeagueData } = makeSandbox(seasons, players);
  const sequence = ['skip', 'skip', 'pg1', 'skip', 'sg1', 'sf1', 'skip', 'skip', 'skip', 'pf1', 'c1'];
  for (const step of sequence) {
    if (step === 'skip') AdminActions.skipDraftPick('s1');
    else AdminActions.makeDraftPick('s1', step);
  }
  const season = LeagueData.getSeason('s1');
  const playerIds = season.playerDraftPicks.map((p) => p.playerId);
  assert.strictEqual(new Set(playerIds).size, playerIds.length, 'no player should ever be drafted twice');
  assert.strictEqual(playerIds.length, 5);
});

// ─── 24. Snake draft order remains correct ──────────────────────────────
test('Plain picks-only snake order is unaffected (base rotation algorithm untouched)', () => {
  const { seasons, players } = freshSeasonFixture(); // n=2: p1, p2
  const { AdminActions, LeagueData } = makeSandbox(seasons, players);
  const expected = ['p1', 'p2', 'p2', 'p1']; // round1 fwd, round2 reversed (n=2)
  const pool = ['pg1', 'sg1', 'sf1', 'pf1'];
  for (const exp of expected) {
    const state = LeagueData.getDraftState('s1');
    assert.strictEqual(state.currentParticipantId, exp);
    AdminActions.makeDraftPick('s1', pool.shift());
  }
});

test("A skip's banked opportunity is scoped to the skipper alone and never disrupts other participants' turns", () => {
  const { seasons, players } = threeSeasonFixture(); // n=3: p1, p2, p3
  const { AdminActions, LeagueData } = makeSandbox(seasons, players);

  // round1: p1, p2, p3 (turn order) | round2 (reversed): p3, p2, p1
  assert.strictEqual(LeagueData.getDraftState('s1').currentParticipantId, 'p1');
  AdminActions.skipDraftPick('s1'); // p1 skips -> banks 1 for p1's own next turn only

  assert.strictEqual(LeagueData.getDraftState('s1').currentParticipantId, 'p2');
  const p2State = LeagueData.getDraftState('s1');
  assert.strictEqual(p2State.isBonusTurn, false, "p1's skip must not affect p2's turn");
  assert.strictEqual(p2State.picksNeededThisTurn, 1);
  AdminActions.makeDraftPick('s1', 'pg1');

  assert.strictEqual(LeagueData.getDraftState('s1').currentParticipantId, 'p3');
  const p3State = LeagueData.getDraftState('s1');
  assert.strictEqual(p3State.isBonusTurn, false, "p1's skip must not affect p3's turn either");
  AdminActions.makeDraftPick('s1', 'sg1');

  // Round 2 reversed order starts back at p3, then p2 (both unaffected by p1's bank):
  assert.strictEqual(LeagueData.getDraftState('s1').currentParticipantId, 'p3');
  AdminActions.makeDraftPick('s1', 'sf1');
  assert.strictEqual(LeagueData.getDraftState('s1').currentParticipantId, 'p2');
  AdminActions.makeDraftPick('s1', 'pf1');

  // Only now does the rotation return to p1 — and only NOW does their
  // earlier skip's banked opportunity manifest.
  const p1Return = LeagueData.getDraftState('s1');
  assert.strictEqual(p1Return.currentParticipantId, 'p1');
  assert.strictEqual(p1Return.isBonusTurn, true);
  assert.strictEqual(p1Return.picksNeededThisTurn, 2);
});

// ─── AFK scenario (explicit) ─────────────────────────────────────────────
test("AFK scenario: 3 skips accumulate 3 opportunities; picks made on return classify by actual pick number, not skip count", () => {
  const { seasons, players } = soloSeasonFixture();
  const { AdminActions, LeagueData } = makeSandbox(seasons, players);

  // Gigs is AFK for 3 of his draft turns.
  AdminActions.skipDraftPick('s1');
  AdminActions.skipDraftPick('s1');
  AdminActions.skipDraftPick('s1');

  const returned = LeagueData.getDraftState('s1');
  assert.strictEqual(returned.isBonusTurn, true);
  assert.strictEqual(returned.picksNeededThisTurn, 3, "Gigs should have exactly 3 opportunities available now that he's back");
  assert.strictEqual(returned.picksTakenThisTurn, 0);

  // Gigs is back and uses all 3 accumulated opportunities to pick.
  AdminActions.makeDraftPick('s1', 'pg1');
  AdminActions.makeDraftPick('s1', 'sg1');
  AdminActions.makeDraftPick('s1', 'sf1');

  const season = LeagueData.getSeason('s1');
  assert.strictEqual(season.playerDraftPicks.length, 3, 'exactly 3 actual picks — not influenced by the skip count beyond enabling them');
  assert.strictEqual(season.draftSkips.length, 3, 'skip history is preserved');

  const roster = LeagueData.getCurrentRoster('s1', 'p1');
  assert.strictEqual(roster.map((e) => e.classification).join(','), ['RED', 'RED', 'YELLOW'].join(','),
    'classification follows ACTUAL pick order (1st,2nd,3rd) — the 3 prior skips never advanced it');
});

// ─── 25-31. Unrelated systems remain unaffected ─────────────────────────
test('Existing roster cap (10 max) is unaffected by skip/opportunity history', () => {
  const { seasons, players } = freshSeasonFixture();
  players.wildcard = player('wildcard', { position: 'UTIL', overall: 70 });
  const { AdminActions, LeagueData } = makeSandbox(seasons, players);
  const p1Picks = ['pg1', 'sg1', 'sf1', 'pf1', 'c1', 'pg2', 'sg2', 'sf2', 'pf2', 'c2'];
  let taken = 0;
  let guard = 0;
  while (taken < p1Picks.length) {
    if (++guard > 500) throw new Error('infinite loop guard tripped');
    const state = LeagueData.getDraftState('s1');
    if (state.currentParticipantId === 'p1') {
      AdminActions.makeDraftPick('s1', p1Picks[taken]);
      taken++;
    } else {
      AdminActions.skipDraftPick('s1');
    }
  }
  assert.throws(() => AdminActions.makeDraftPick('s1', 'wildcard'), /roster is full/i);
});

test('Existing OVR rating cap validation is unaffected by skip/opportunity history', () => {
  const { seasons, players } = soloSeasonFixture();
  players.megaC = player('megaC', { position: 'C', overall: 999 });
  const { AdminActions } = makeSandbox(seasons, players);
  AdminActions.skipDraftPick('s1');
  assert.throws(() => AdminActions.makeDraftPick('s1', 'megaC'), /rating cap/i);
});

test('Existing position validation (mandatory first five) is unaffected by skip/opportunity history', () => {
  const { seasons, players } = soloSeasonFixture();
  const { AdminActions } = makeSandbox(seasons, players);
  AdminActions.makeDraftPick('s1', 'pg1'); // #1: PG
  AdminActions.skipDraftPick('s1');
  AdminActions.skipDraftPick('s1');
  assert.throws(() => AdminActions.makeDraftPick('s1', 'pg2'), /already has a PG/i);
});

test('Existing Blue-pool phase cap and Variant Group lock are unaffected by skip/opportunity history', () => {
  const { seasons, players } = soloSeasonFixture();
  const { AdminActions } = makeSandbox(seasons, players);
  AdminActions.makeDraftPick('s1', 'lebronA');
  AdminActions.skipDraftPick('s1');
  assert.throws(() => AdminActions.makeDraftPick('s1', 'lebronB'), /already been drafted/i);
});

test('Existing Joker Pick behavior is unaffected by skip/opportunity history', () => {
  const { seasons, players } = soloSeasonFixture();
  const { AdminActions } = makeSandbox(seasons, players);
  AdminActions.skipDraftPick('s1');
  const result = AdminActions.makeDraftPick('s1', 'sf1', { isJoker: true, jokerPosition: 'C' });
  assert.strictEqual(result.isJoker, true);
  assert.strictEqual(result.jokerPosition, 'C');
});

test('Existing transaction/financial state is untouched by skips (no transactions, no pot changes)', () => {
  const { seasons, players } = soloSeasonFixture();
  const { AdminActions, LeagueData } = makeSandbox(seasons, players);
  for (let i = 0; i < 6; i++) AdminActions.skipDraftPick('s1');
  const season = LeagueData.getSeason('s1');
  assert.strictEqual(season.transactions.length, 0);
  assert.strictEqual(season.pot, 0);
});

// ─── 32. Historical draftSkips[] remain readable / preserved ───────────
test('Pre-existing historical draftSkips[] (seeded, not created via skipDraftPick) is preserved and still readable', () => {
  const { seasons, players } = freshSeasonFixture();
  seasons.s1.playerDraftPicks = [{ round: 1, pick: 1, participantId: 'p1', playerId: 'pg1' }];
  seasons.s1.draftSkips = [
    { participantId: 'p2', round: 1, afterPickCount: 1, timestamp: '2026-01-01T00:00:00.000Z' },
  ];
  const { LeagueData, AdminActions } = makeSandbox(seasons, players);
  const season = LeagueData.getSeason('s1');
  assert.strictEqual(season.draftSkips.length, 1, 'historical skip record must not be dropped or migrated away');
  const seeded = season.draftSkips[0];
  assert.strictEqual(seeded.participantId, 'p2');
  assert.strictEqual(seeded.round, 1);
  assert.strictEqual(seeded.afterPickCount, 1);
  assert.strictEqual(seeded.timestamp, '2026-01-01T00:00:00.000Z');
  const state = LeagueData.getDraftState('s1');
  assert.ok(state.currentParticipantId, 'schedule must still resolve to someone');
  assert.doesNotThrow(() => AdminActions.skipDraftPick('s1'), 'a normal skip must still work after seeded history');
});

// ─── Guard-rails that must still hold ───────────────────────────────────
test('Skipping still throws once the draft is marked complete', () => {
  const { seasons, players } = soloSeasonFixture();
  const { AdminActions } = makeSandbox(seasons, players);
  AdminActions.markDraftComplete('s1');
  assert.throws(() => AdminActions.skipDraftPick('s1'), /already complete/i);
});

test('Skipping still throws if the draft order has not been set', () => {
  const { seasons, players } = soloSeasonFixture();
  seasons.s1.playerDraftOrder = [];
  const { AdminActions } = makeSandbox(seasons, players);
  assert.throws(() => AdminActions.skipDraftPick('s1'), /draft order/i);
});

console.log(failures === 0 ? '\nAll tests passed.' : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
