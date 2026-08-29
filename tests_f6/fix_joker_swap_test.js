'use strict';
/**
 * Revision — Fix Joker Swap: outgoing player / new Joker logic.
 *
 * BUG (fixed here): evaluateSwap used to require outgoingPlayerId to
 * already be the participant's current Joker for isJokerSwap===true. The
 * Swap UI never communicated or enforced that — the outgoing-player
 * picker lists every roster player regardless of Joker status, and the
 * "Assigned position for new Joker" field makes the real intent explicit:
 * whichever player comes IN becomes the Joker, unconditionally. This file
 * proves the fix: any outgoing player can be used in a Joker Swap, the
 * incoming player always becomes the new Joker, and — since only one
 * Joker is allowed per participant at a time — any different Joker
 * already on that roster is cleared by the same transaction.
 *
 * Same VM-sandbox convention as the other tests_f6 swap test files.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const dataJsPath = path.join(__dirname, '..', 'js', 'data.js');
const dataSrc = fs.readFileSync(dataJsPath, 'utf8');

function makeSandbox() {
  const sandbox = {
    console,
    firebase: {
      firestore: () => ({
        collection: () => ({ doc: () => ({ onSnapshot: () => {}, set: () => Promise.resolve() }) }),
      }),
    },
    showToast: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(dataSrc, sandbox, { filename: 'data.js' });
  vm.runInContext(
    'this.LeagueData = LeagueData; this.AdminActions = AdminActions; ' +
    'this.FirebaseSync = FirebaseSync; this.getDefaultData = getDefaultData;',
    sandbox, { filename: 'export.js' }
  );
  let cache = sandbox.getDefaultData();
  sandbox.FirebaseSync.getCache = () => cache;
  sandbox.FirebaseSync.save = (data) => { cache = data; };
  return sandbox;
}

let pass = 0, fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ok - ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL - ${name}`);
    console.log(`         ${e.message}`);
  }
}
function assertTrue(actual, msg) {
  if (!actual) throw new Error(msg || `expected truthy, got ${JSON.stringify(actual)}`);
}
function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'assertion failed'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

console.log('Fix Joker Swap (outgoing / new Joker logic) tests:');
const sandbox = makeSandbox();
const { AdminActions, LeagueData } = sandbox;

// ── Scenario matching the ticket's own example almost exactly: ─────────────
//    Outgoing: Elvin Hayes (NOT the current Joker)
//    Incoming: M. Gasol (becomes the NEW Joker at PF)
//    Team also already has a DIFFERENT designated Joker beforehand, to
//    prove it gets cleared rather than leaving two Jokers on one roster.

function buildScenario() {
  const season = AdminActions.createSeason('Fix Joker Swap Test Season');
  const seasonId = season.id;
  const team = AdminActions.addParticipant(seasonId, 'Commissioner Test Team');

  const currentJoker = AdminActions.addPlayer({ name: 'Old Designated Joker', position: 'SG', overall: 88, pool: 'green' });
  const elvinHayes = AdminActions.addPlayer({ name: 'Elvin Hayes', position: 'PF', overall: 85, pool: 'green' });
  const otherPlayer = AdminActions.addPlayer({ name: 'Filler Player', position: 'C', overall: 80, pool: 'green' });
  const gasol = AdminActions.addPlayer({ name: 'M. Gasol', position: 'C', overall: 87, pool: 'green' });

  const cache = sandbox.FirebaseSync.getCache();
  const s = cache.seasons[seasonId];
  s.currentRosters = {
    [team.id]: [
      { playerId: currentJoker.id, source: 'draft', draftSlot: 1, isJoker: true, jokerPosition: 'SG' },
      { playerId: elvinHayes.id, source: 'draft', draftSlot: 2 },
      { playerId: otherPlayer.id, source: 'draft', draftSlot: 3 },
    ],
  };
  s.rostersInitialized = true;
  s.draftComplete = true;
  sandbox.FirebaseSync.save(cache);

  return { seasonId, team, currentJoker, elvinHayes, otherPlayer, gasol };
}

const scenario = buildScenario();

// ── Test 1 — the exact ticket scenario evaluates as valid ──────────────────

check('Test 1: Joker Swap with a non-Joker outgoing player (Elvin Hayes) evaluates as valid', () => {
  const result = AdminActions.evaluateSwap(scenario.seasonId, {
    participantId: scenario.team.id,
    outgoingPlayerId: scenario.elvinHayes.id, // was NOT the current Joker
    incomingPlayerId: scenario.gasol.id,
    isJokerSwap: true,
    jokerPosition: 'PF',
  });
  assertTrue(result.valid, `expected valid Joker Swap, checks: ${JSON.stringify(result.checks)}`);
});

// ── Test 2 — committing it makes the incoming player the new Joker ────────

check('Test 2: committing makes M. Gasol the new Joker at the assigned position', () => {
  AdminActions.commitSwap(scenario.seasonId, {
    participantId: scenario.team.id,
    outgoingPlayerId: scenario.elvinHayes.id,
    incomingPlayerId: scenario.gasol.id,
    isJokerSwap: true,
    jokerPosition: 'PF',
  });
  const roster = sandbox.FirebaseSync.getCache().seasons[scenario.seasonId].currentRosters[scenario.team.id];
  const gasolEntry = roster.find((e) => e.playerId === scenario.gasol.id);
  assertTrue(gasolEntry && gasolEntry.isJoker === true, 'Gasol should be the new Joker');
  assertEqual(gasolEntry.jokerPosition, 'PF', 'Gasol should be assigned PF');
});

// ── Test 3 — Elvin Hayes actually left the roster ───────────────────────────

check('Test 3: Elvin Hayes (the outgoing player) left the roster', () => {
  const roster = sandbox.FirebaseSync.getCache().seasons[scenario.seasonId].currentRosters[scenario.team.id];
  assertTrue(!roster.some((e) => e.playerId === scenario.elvinHayes.id), 'Elvin Hayes should no longer be on the roster');
});

// ── Test 4 — the PREVIOUS Joker's flag was cleared (only one Joker at a ────
//    time — this is the data-integrity guarantee the fix has to preserve).

check('Test 4: the previous Joker (who was not involved in this swap) is no longer flagged as Joker', () => {
  const roster = sandbox.FirebaseSync.getCache().seasons[scenario.seasonId].currentRosters[scenario.team.id];
  const oldJokerEntry = roster.find((e) => e.playerId === scenario.currentJoker.id);
  assertTrue(oldJokerEntry, 'the old Joker player should still be on the roster (never touched by this swap)');
  assertTrue(!oldJokerEntry.isJoker, 'the old Joker flag should have been cleared');
});

check('Test 5: exactly one Joker exists on the roster after the swap', () => {
  const roster = sandbox.FirebaseSync.getCache().seasons[scenario.seasonId].currentRosters[scenario.team.id];
  const jokerCount = roster.filter((e) => e.isJoker).length;
  assertEqual(jokerCount, 1, 'expected exactly one Joker-flagged entry');
});

// ── Test 6 — a Joker Swap where outgoing IS the current Joker still works ──
//    (the pre-existing case must keep working after this fix).

check('Test 6: a Joker Swap where the outgoing player already IS the current Joker still works', () => {
  const season2 = AdminActions.createSeason('Fix Joker Swap Test Season 2');
  const seasonId2 = season2.id;
  const team2 = AdminActions.addParticipant(seasonId2, 'Team Two');
  const joker2 = AdminActions.addPlayer({ name: 'Joker Two', position: 'SF', overall: 84, pool: 'green' });
  const incoming2 = AdminActions.addPlayer({ name: 'Incoming Two', position: 'SF', overall: 86, pool: 'green' });

  const cache = sandbox.FirebaseSync.getCache();
  cache.seasons[seasonId2].currentRosters = {
    [team2.id]: [{ playerId: joker2.id, source: 'draft', draftSlot: 1, isJoker: true, jokerPosition: 'SF' }],
  };
  cache.seasons[seasonId2].rostersInitialized = true;
  cache.seasons[seasonId2].draftComplete = true;
  sandbox.FirebaseSync.save(cache);

  const result = AdminActions.commitSwap(seasonId2, {
    participantId: team2.id,
    outgoingPlayerId: joker2.id,
    incomingPlayerId: incoming2.id,
    isJokerSwap: true,
    jokerPosition: 'SF',
  });
  assertTrue(result.valid, 'expected valid commit');
  const roster2 = sandbox.FirebaseSync.getCache().seasons[seasonId2].currentRosters[team2.id];
  assertEqual(roster2.length, 1, 'expected exactly one roster entry');
  assertTrue(roster2[0].playerId === incoming2.id && roster2[0].isJoker, 'incoming player should be the sole, new Joker');
});

// ── Test 7 — the swap transaction log records isJoker accurately per side ──
//    (outgoing reflects whether THEY actually were the Joker; incoming is
//    always true for a Joker Swap).

check('Test 7: transaction log records outgoing isJoker accurately (false here) and incoming isJoker true', () => {
  const txns = sandbox.FirebaseSync.getCache().seasons[scenario.seasonId].transactions;
  const jokerTxn = txns.find((t) => t.type === 'jokerSwap');
  assertTrue(jokerTxn, 'expected a jokerSwap transaction to be recorded');
  assertEqual(jokerTxn.playersOut[0].isJoker, false, 'Elvin Hayes was not actually the Joker when he left');
  assertEqual(jokerTxn.playersIn[0].isJoker, true, 'Gasol became the Joker');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail > 0 ? 1 : 0;
