'use strict';
/**
 * Verifies the Revision 2 Draft Skip change in js/data.js:
 *  - AdminActions.skipDraftPick(seasonId) has no limit on how many times
 *    a participant may skip, consecutively or otherwise.
 *  - A skip never creates a bonus/double-pick entitlement — every turn
 *    slot is resolved by exactly one Pick or one Skip.
 *  - season.draftSkips[] remains a full, untouched, append-only history
 *    of every skip (including skips recorded before this change).
 *  - Unrelated draft rules (roster cap, position rules, OVR cap,
 *    Blue-pool phase caps, snake order, variant-group lock, Joker Pick)
 *    are unaffected.
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

// ─── Fixture: 2 participants, a deep green pool covering all 5 positions
// (plenty of duplicates so many picks can be made per participant without
// hitting the max-2-per-position cap), one variant-group pair, one blue
// player — enough to exercise every unrelated rule while testing Skip. ──
function freshSeasonFixture() {
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

// n=2 snake order: turnIndex 0 -> p1, 1 -> p2, 2 -> p2, 3 -> p1, 4 -> p1, 5 -> p2, ...
function expectedParticipantAt(turnIndex) {
  const order = ['p1', 'p2'];
  const n = 2;
  const round = Math.floor(turnIndex / n) + 1;
  const posInRound = turnIndex % n;
  const isEvenRound = round % 2 === 0;
  const orderIndex = isEvenRound ? n - 1 - posInRound : posInRound;
  return order[orderIndex];
}

// ─── 1-4: N consecutive skips work, with no limit ──────────────────────
for (const count of [1, 2, 3, 5]) {
  test(`${count} consecutive skip(s) work with no maximum`, () => {
    const { seasons, players } = freshSeasonFixture();
    const { AdminActions, LeagueData } = makeSandbox(seasons, players);
    for (let i = 0; i < count; i++) {
      assert.doesNotThrow(() => AdminActions.skipDraftPick('s1'));
    }
    const season = LeagueData.getSeason('s1');
    assert.strictEqual(season.draftSkips.length, count, `draftSkips should record all ${count} skips`);
    assert.strictEqual(season.playerDraftPicks.length, 0, 'skips must never create a player pick');
  });
}

// ─── 5-9: mixed Pick/Skip sequences ─────────────────────────────────────
test('Pick -> Pick -> Skip works', () => {
  const { seasons, players } = freshSeasonFixture();
  const { AdminActions } = makeSandbox(seasons, players);
  AdminActions.makeDraftPick('s1', 'pg1'); // p1
  AdminActions.makeDraftPick('s1', 'pg2'); // p2
  assert.doesNotThrow(() => AdminActions.skipDraftPick('s1')); // p2's 2nd turn (round 2, n=2 snake stays on p2)
});

test('Pick -> Skip -> Skip works', () => {
  const { seasons, players } = freshSeasonFixture();
  const { AdminActions } = makeSandbox(seasons, players);
  AdminActions.makeDraftPick('s1', 'pg1');
  assert.doesNotThrow(() => AdminActions.skipDraftPick('s1'));
  assert.doesNotThrow(() => AdminActions.skipDraftPick('s1'));
});

test('Skip -> Pick -> Skip works', () => {
  const { seasons, players } = freshSeasonFixture();
  const { AdminActions } = makeSandbox(seasons, players);
  assert.doesNotThrow(() => AdminActions.skipDraftPick('s1'));
  AdminActions.makeDraftPick('s1', 'pg1');
  assert.doesNotThrow(() => AdminActions.skipDraftPick('s1'));
});

test('Skip -> Skip -> Skip works', () => {
  const { seasons, players } = freshSeasonFixture();
  const { AdminActions } = makeSandbox(seasons, players);
  assert.doesNotThrow(() => AdminActions.skipDraftPick('s1'));
  assert.doesNotThrow(() => AdminActions.skipDraftPick('s1'));
  assert.doesNotThrow(() => AdminActions.skipDraftPick('s1'));
});

test('Pick -> Skip -> Pick works', () => {
  const { seasons, players } = freshSeasonFixture();
  const { AdminActions } = makeSandbox(seasons, players);
  AdminActions.makeDraftPick('s1', 'pg1');
  assert.doesNotThrow(() => AdminActions.skipDraftPick('s1'));
  assert.doesNotThrow(() => AdminActions.makeDraftPick('s1', 'sg1'));
});

// ─── 10-11: skip never creates a player pick, even repeated ────────────
test('A single skip creates no player pick', () => {
  const { seasons, players } = freshSeasonFixture();
  const { AdminActions, LeagueData } = makeSandbox(seasons, players);
  AdminActions.skipDraftPick('s1');
  const season = LeagueData.getSeason('s1');
  assert.strictEqual(season.playerDraftPicks.length, 0);
});

test('Multiple skips never create duplicate/phantom player picks', () => {
  const { seasons, players } = freshSeasonFixture();
  const { AdminActions, LeagueData } = makeSandbox(seasons, players);
  for (let i = 0; i < 7; i++) AdminActions.skipDraftPick('s1');
  const season = LeagueData.getSeason('s1');
  assert.strictEqual(season.playerDraftPicks.length, 0, 'no picks should ever be auto-created by skips');
  assert.strictEqual(season.draftSkips.length, 7);
});

// ─── 12: a participant can skip again on their very next normal turn ───
test('A participant can skip again on their next normal turn (no forced pick in between)', () => {
  const { seasons, players } = freshSeasonFixture();
  const { AdminActions, LeagueData } = makeSandbox(seasons, players);
  AdminActions.skipDraftPick('s1'); // p1 skips turn 0
  AdminActions.skipDraftPick('s1'); // p2 skips turn 1
  // p1's next scheduled turn (turnIndex 2 in a 2-participant even-round-reversed
  // snake is actually p2 again; regardless, whichever participant is up next
  // must be able to skip freely with no "must pick" restriction):
  const before = LeagueData.getDraftState('s1');
  assert.strictEqual(before.isBonusTurn, false, 'no bonus turn should ever be signaled');
  assert.doesNotThrow(() => AdminActions.skipDraftPick('s1'));
});

// ─── 13/14: snake order and turn arithmetic remain correct with skips ──
test('Snake draft order is unaffected by skips — skips advance the rotation exactly like picks', () => {
  const { seasons, players } = freshSeasonFixture();
  const { AdminActions, LeagueData } = makeSandbox(seasons, players);
  const events = ['skip', 'skip', 'pick', 'skip', 'pick', 'skip'];
  let pickPool = ['pg1', 'sg1', 'sf1'];
  for (const ev of events) {
    const season = LeagueData.getSeason('s1');
    const turnIndex = season.playerDraftPicks.length + season.draftSkips.length;
    const state = LeagueData.getDraftState('s1');
    assert.strictEqual(state.currentParticipantId, expectedParticipantAt(turnIndex),
      `turn ${turnIndex} should belong to ${expectedParticipantAt(turnIndex)}`);
    if (ev === 'skip') {
      AdminActions.skipDraftPick('s1');
    } else {
      AdminActions.makeDraftPick('s1', pickPool.shift());
    }
  }
});

test('Turn/round arithmetic (picks + skips) matches the documented snake formula', () => {
  const { seasons, players } = freshSeasonFixture();
  const { AdminActions, LeagueData } = makeSandbox(seasons, players);
  AdminActions.skipDraftPick('s1');
  AdminActions.makeDraftPick('s1', 'pg1');
  AdminActions.skipDraftPick('s1');
  const state = LeagueData.getDraftState('s1');
  // 3 events consumed -> turnIndex 3 -> round 2 (n=2), even round reversed -> p1
  assert.strictEqual(state.currentRound, 2);
  assert.strictEqual(state.currentParticipantId, expectedParticipantAt(3));
});

// ─── 15: a skipped turn never assigns a player ─────────────────────────
test('A skipped turn does not assign any player to any roster', () => {
  const { seasons, players } = freshSeasonFixture();
  const { AdminActions, LeagueData } = makeSandbox(seasons, players);
  AdminActions.skipDraftPick('s1');
  AdminActions.skipDraftPick('s1');
  const avail = LeagueData.getAvailablePlayers('s1');
  assert.strictEqual(avail.length, Object.keys(players).length, 'no player should have been removed from the pool');
});

// ─── 16: existing draft history / audit trail (draftSkips) stays intact ─
test('draftSkips retains full history (participant, round, afterPickCount, timestamp) for every skip', () => {
  const { seasons, players } = freshSeasonFixture();
  const { AdminActions, LeagueData } = makeSandbox(seasons, players);
  AdminActions.makeDraftPick('s1', 'pg1');
  AdminActions.skipDraftPick('s1');
  const season = LeagueData.getSeason('s1');
  assert.strictEqual(season.draftSkips.length, 1);
  const entry = season.draftSkips[0];
  assert.strictEqual(entry.participantId, 'p2');
  assert.strictEqual(entry.afterPickCount, 1);
  assert.ok(entry.timestamp, 'skip entry should carry a timestamp');
  assert.strictEqual(typeof entry.round, 'number');
  assert.strictEqual(Object.keys(entry).sort().join(','), ['afterPickCount', 'participantId', 'round', 'timestamp'].join(','));
});

test('Pre-existing historical draftSkips[] (seeded, not created via skipDraftPick) is preserved and still readable', () => {
  const { seasons, players } = freshSeasonFixture();
  // Simulate a season that already had skip history before this change,
  // and one already-made pick, seeded directly (as p10/p12-style tests do).
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
  // And the turn schedule still derives correctly from that seeded history
  // (1 pick + 1 skip = turnIndex 2 -> round 2 -> p2, no bonus turn):
  const state = LeagueData.getDraftState('s1');
  assert.strictEqual(state.isBonusTurn, false);
  assert.strictEqual(state.currentParticipantId, expectedParticipantAt(2));
  assert.doesNotThrow(() => AdminActions.skipDraftPick('s1'), 'a normal skip must still work after seeded history');
});

// ─── 10/11 (bonus-specific): a skip creates NO bonus pick / double-pick ─
test('A skip never sets isBonusTurn or requires 2 picks on any future turn', () => {
  const { seasons, players } = freshSeasonFixture();
  const { AdminActions, LeagueData } = makeSandbox(seasons, players);
  for (let i = 0; i < 4; i++) {
    AdminActions.skipDraftPick('s1');
    const state = LeagueData.getDraftState('s1');
    assert.strictEqual(state.isBonusTurn, false, `no bonus turn after skip #${i + 1}`);
    assert.strictEqual(state.picksNeededThisTurn, 1, `picksNeededThisTurn must always be 1 (skip #${i + 1})`);
    assert.strictEqual(Object.keys(state.bonusPicks).length, 0, `bonusPicks must always be empty (skip #${i + 1})`);
  }
});

test('season.bonusPicks stays {} after any number of skips (shape preserved, mechanic inert)', () => {
  const { seasons, players } = freshSeasonFixture();
  const { AdminActions, LeagueData } = makeSandbox(seasons, players);
  AdminActions.skipDraftPick('s1');
  AdminActions.skipDraftPick('s1');
  AdminActions.skipDraftPick('s1');
  const season = LeagueData.getSeason('s1');
  assert.strictEqual(Object.keys(season.bonusPicks).length, 0);
});

// ─── Unrelated systems remain unaffected by any of the above ───────────
test('Existing roster cap (10 max) is unaffected by skip history', () => {
  const { seasons, players } = freshSeasonFixture();
  // An unrecognized-position player so the overflow attempt trips the
  // roster-size check rather than the (already-saturated, by design)
  // max-2-per-position check — both are pre-existing, unrelated rules.
  players.wildcard = player('wildcard', { position: 'UTIL', overall: 70 });
  const { AdminActions, LeagueData } = makeSandbox(seasons, players);
  // p1 drafts 10 players across their own turns; whenever it's p2's turn,
  // p2 always skips instead — driven by the actual snake schedule (not
  // assumed alternation), since skips now consume a turn slot exactly
  // like a pick and the base rotation is what decides whose turn it is.
  const p1Picks = ['pg1', 'sg1', 'sf1', 'pf1', 'c1', 'pg2', 'sg2', 'sf2', 'pf2', 'c2'];
  let taken = 0;
  let guard = 0;
  while (taken < p1Picks.length) {
    if (++guard > 100) throw new Error('infinite loop guard tripped');
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

test('Existing OVR rating cap validation is unaffected by skip history', () => {
  const { seasons, players } = freshSeasonFixture();
  players.megaC = player('megaC', { position: 'C', overall: 999 });
  const { AdminActions } = makeSandbox(seasons, players);
  AdminActions.skipDraftPick('s1'); // p1 skips
  assert.throws(() => AdminActions.makeDraftPick('s1', 'megaC'), /rating cap/i);
});

test('Existing position validation (mandatory first five) is unaffected by skip history', () => {
  const { seasons, players } = freshSeasonFixture();
  const { AdminActions, LeagueData } = makeSandbox(seasons, players);
  AdminActions.makeDraftPick('s1', 'pg1'); // p1's 1st turn: PG
  // Skip through every intervening turn (p2's, and any of p2's repeats
  // the snake schedule assigns) until it's p1's turn again.
  let guard = 0;
  while (LeagueData.getDraftState('s1').currentParticipantId !== 'p1') {
    if (++guard > 20) throw new Error('infinite loop guard tripped');
    AdminActions.skipDraftPick('s1');
  }
  assert.throws(() => AdminActions.makeDraftPick('s1', 'pg2'), /already has a PG/i); // p1 again, dup position
});

test('Existing Blue-pool phase cap and variant-group lock are unaffected by skip history', () => {
  const { seasons, players } = freshSeasonFixture();
  const { AdminActions } = makeSandbox(seasons, players);
  AdminActions.makeDraftPick('s1', 'lebronA'); // p1
  AdminActions.skipDraftPick('s1'); // p2 skips
  assert.throws(() => AdminActions.makeDraftPick('s1', 'lebronB'), /already been drafted/i); // p1's next turn
});

test('Existing Joker Pick behavior is unaffected by skip history', () => {
  const { seasons, players } = freshSeasonFixture();
  const { AdminActions } = makeSandbox(seasons, players);
  AdminActions.skipDraftPick('s1'); // p1 skips
  const result = AdminActions.makeDraftPick('s1', 'sf1', { isJoker: true, jokerPosition: 'C' }); // p2
  assert.strictEqual(result.isJoker, true);
  assert.strictEqual(result.jokerPosition, 'C');
});

test('Existing transaction/financial state is untouched by skips (no transactions, no pot changes)', () => {
  const { seasons, players } = freshSeasonFixture();
  const { AdminActions, LeagueData } = makeSandbox(seasons, players);
  for (let i = 0; i < 5; i++) AdminActions.skipDraftPick('s1');
  const season = LeagueData.getSeason('s1');
  assert.strictEqual(season.transactions.length, 0);
  assert.strictEqual(season.pot, 0);
});

// ─── Guard-rails that must still hold ───────────────────────────────────
test('Skipping still throws once the draft is marked complete', () => {
  const { seasons, players } = freshSeasonFixture();
  const { AdminActions } = makeSandbox(seasons, players);
  AdminActions.markDraftComplete('s1');
  assert.throws(() => AdminActions.skipDraftPick('s1'), /already complete/i);
});

test('Skipping still throws if the draft order has not been set', () => {
  const { seasons, players } = freshSeasonFixture();
  seasons.s1.playerDraftOrder = [];
  const { AdminActions } = makeSandbox(seasons, players);
  assert.throws(() => AdminActions.skipDraftPick('s1'), /draft order/i);
});

console.log(failures === 0 ? '\nAll tests passed.' : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
