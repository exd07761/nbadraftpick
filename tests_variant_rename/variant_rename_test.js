'use strict';
/**
 * Verifies the Edit Player modal's new Name field (js/admin/players.js)
 * and its use of the EXISTING AdminActions.updatePlayer(playerId, fields)
 * (js/data.js) — the mechanism for a commissioner to change an
 * ALREADY-DRAFTED player's displayed variant (e.g. "LeBron James —
 * Variant A" -> "LeBron James — Variant B") without creating a second
 * pick, roster entry, or transaction.
 *
 * This tests js/data.js's real AdminActions.updatePlayer/makeDraftPick/
 * initializeRostersFromDraft directly — js/admin/players.js's modal is a
 * thin UI wrapper around that same call (see the file's own updated
 * comment), so testing the call it makes is the meaningful test; a DOM
 * click-through of the modal would only be testing string-matching HTML
 * ids, not behavior.
 *
 * Same vm-sandbox-loads-the-real-data.js pattern as tests_joker_pick.
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

function player(id, { position, overall, pool = 'green', variantGroup, nba2kRef } = {}) {
  return { id, name: id, position, overall, pool, variantGroup, nba2kRef };
}

// One season, one participant, one already-drafted player standing in
// for "LeBron James — Variant A", already on a roster, mid-season, with
// prior transaction history — exactly the "already drafted several
// picks" scenario in the ask.
function draftedPlayerFixture() {
  const players = {
    lebronA: player('lebronA', { position: 'SF', overall: 90, variantGroup: 'lebron-james', nba2kRef: 'lebron-james-variant-a' }),
    other1: player('other1', { position: 'PG', overall: 80 }),
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

console.log('Variant rename tests — Edit Player Name field + updatePlayer safety');

test('1. Name can be changed on an already-drafted player', () => {
  const { seasons, players } = draftedPlayerFixture();
  const { AdminActions, LeagueData } = makeSandbox(seasons, players);
  AdminActions.makeDraftPick('s1', 'lebronA'); // p1's pick 1
  AdminActions.makeDraftPick('s1', 'other1');  // p2's pick 1

  AdminActions.updatePlayer('lebronA', { name: 'LeBron James — Variant B', overall: 90, variantGroup: 'lebron-james' });

  const updated = LeagueData.getPlayer('lebronA');
  assert.strictEqual(updated.name, 'LeBron James — Variant B');
});

test('2. playerId remains identical after the rename', () => {
  const { seasons, players } = draftedPlayerFixture();
  const { AdminActions, LeagueData } = makeSandbox(seasons, players);
  AdminActions.makeDraftPick('s1', 'lebronA');
  AdminActions.updatePlayer('lebronA', { name: 'LeBron James — Variant B' });

  assert.strictEqual(LeagueData.getPlayer('lebronA').id, 'lebronA');
  assert.strictEqual(LeagueData.getPlayer('lebronA-should-not-exist'), null);
});

test('3. Draft history (playerDraftPicks) is unchanged by the rename', () => {
  const { seasons, players } = draftedPlayerFixture();
  const { AdminActions, LeagueData } = makeSandbox(seasons, players);
  AdminActions.makeDraftPick('s1', 'lebronA');
  AdminActions.makeDraftPick('s1', 'other1');
  const picksBefore = JSON.stringify(LeagueData.getSeason('s1').playerDraftPicks);

  AdminActions.updatePlayer('lebronA', { name: 'LeBron James — Variant B', overall: 95 });

  const picksAfter = JSON.stringify(LeagueData.getSeason('s1').playerDraftPicks);
  assert.strictEqual(picksAfter, picksBefore, 'playerDraftPicks must be byte-for-byte unchanged');
  assert.strictEqual(LeagueData.getSeason('s1').playerDraftPicks.length, 2, 'no new pick was created');
});

test('4. Roster entry (currentRosters) is unchanged by the rename', () => {
  const { seasons, players } = draftedPlayerFixture();
  const { AdminActions, LeagueData } = makeSandbox(seasons, players);
  AdminActions.makeDraftPick('s1', 'lebronA');
  AdminActions.makeDraftPick('s1', 'other1');
  AdminActions.markDraftComplete('s1');
  AdminActions.initializeRostersFromDraft('s1');
  const rostersBefore = JSON.stringify(LeagueData.getSeason('s1').currentRosters);

  AdminActions.updatePlayer('lebronA', { name: 'LeBron James — Variant B', overall: 88 });

  const rostersAfter = JSON.stringify(LeagueData.getSeason('s1').currentRosters);
  assert.strictEqual(rostersAfter, rostersBefore, 'currentRosters must be byte-for-byte unchanged — same playerId, same slot');
});

test('5. No transaction is created by the rename', () => {
  const { seasons, players } = draftedPlayerFixture();
  const { AdminActions, LeagueData } = makeSandbox(seasons, players);
  AdminActions.makeDraftPick('s1', 'lebronA');
  const txnCountBefore = LeagueData.getSeason('s1').transactions.length;

  AdminActions.updatePlayer('lebronA', { name: 'LeBron James — Variant B' });

  assert.strictEqual(LeagueData.getSeason('s1').transactions.length, txnCountBefore, 'transactions array length must not change');
});

test('6. No finance record (pot/fee) is created or changed by the rename', () => {
  const { seasons, players } = draftedPlayerFixture();
  seasons.s1.pot = 250;
  const { AdminActions, LeagueData } = makeSandbox(seasons, players);
  AdminActions.makeDraftPick('s1', 'lebronA');

  AdminActions.updatePlayer('lebronA', { name: 'LeBron James — Variant B' });

  assert.strictEqual(LeagueData.getSeason('s1').pot, 250, 'pot must be untouched');
});

test('7. variantGroup remains the grouping mechanism and survives an unrelated name/overall edit', () => {
  const { seasons, players } = draftedPlayerFixture();
  const { AdminActions, LeagueData } = makeSandbox(seasons, players);
  AdminActions.makeDraftPick('s1', 'lebronA');

  AdminActions.updatePlayer('lebronA', { name: 'LeBron James — Variant B', overall: 91, variantGroup: 'lebron-james' });

  assert.strictEqual(LeagueData.getPlayer('lebronA').variantGroup, 'lebron-james');
});

test('8. Overall can still be edited through the exact same mechanism', () => {
  const { seasons, players } = draftedPlayerFixture();
  const { AdminActions, LeagueData } = makeSandbox(seasons, players);
  AdminActions.makeDraftPick('s1', 'lebronA');

  AdminActions.updatePlayer('lebronA', { name: 'LeBron James — Variant B', overall: 97, variantGroup: 'lebron-james' });

  assert.strictEqual(LeagueData.getPlayer('lebronA').overall, 97);
});

test('9. Existing roster/rating-cap validation reads the SAME live player record either way (no new/changed validation path)', () => {
  const { seasons, players } = draftedPlayerFixture();
  const { AdminActions, LeagueData } = makeSandbox(seasons, players);
  AdminActions.makeDraftPick('s1', 'lebronA');
  AdminActions.makeDraftPick('s1', 'other1');
  AdminActions.markDraftComplete('s1');
  AdminActions.initializeRostersFromDraft('s1');

  // Before the rename: roster total is exactly the two drafted players' overalls.
  const before = LeagueData.getCurrentRoster('s1', 'p1').reduce((sum, e) => sum + (LeagueData.getPlayer(e.playerId)?.overall || 0), 0);
  assert.strictEqual(before, 90);

  AdminActions.updatePlayer('lebronA', { name: 'LeBron James — Variant B', overall: 96, variantGroup: 'lebron-james' });

  // After: the SAME live-read roster total reflects the new rating —
  // this is expected/existing behavior (validation already reads
  // players live, per the architecture inspection), not a new or
  // broken code path.
  const after = LeagueData.getCurrentRoster('s1', 'p1').reduce((sum, e) => sum + (LeagueData.getPlayer(e.playerId)?.overall || 0), 0);
  assert.strictEqual(after, 96);
});

test('10. nba2kRef (the only link toward the NBA2K27/nba2k_players universe) is left exactly as-is unless explicitly changed', () => {
  const { seasons, players } = draftedPlayerFixture();
  const { AdminActions, LeagueData } = makeSandbox(seasons, players);
  AdminActions.makeDraftPick('s1', 'lebronA');

  AdminActions.updatePlayer('lebronA', { name: 'LeBron James — Variant B', overall: 90, variantGroup: 'lebron-james' });

  assert.strictEqual(LeagueData.getPlayer('lebronA').nba2kRef, 'lebron-james-variant-a', 'unrelated field untouched, and this feature never reads/writes nba2k27_pool or nba2k_players — it is a static reference only');
});

setTimeout(() => {
  console.log(`\n${failures === 0 ? 'All tests passed' : failures + ' test(s) failed'}`);
  process.exitCode = failures > 0 ? 1 : 0;
}, 10);
