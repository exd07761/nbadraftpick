'use strict';
/**
 * Revision — Loosen Swap Validation — regression tests.
 *
 * A normal swap (isJokerSwap falsy) must enforce ONLY: Rating Cap,
 * Minimum Rating, Season Day (plus basic data integrity — Ownership,
 * Replacement eligibility). Position limit and Blue restrictions must be
 * bypassed entirely for a normal swap. The dedicated Joker Swap path
 * (isJokerSwap === true) must be completely unaffected — it still runs
 * every check, including Position limit, Blue restrictions, and the
 * Joker-must-be-outgoing check.
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
function findCheck(result, label) {
  return result.checks.find((c) => c.label === label);
}

console.log('Loosen Swap Validation tests:');
const sandbox = makeSandbox();
const { AdminActions, LeagueData } = sandbox;

// ── Scenario: a Joker (native SF, assigned to play PG) is on the roster ────
// alongside one natural PG. This is the exact repro from the diagnosis —
// swapping in ANOTHER PG for an unrelated player used to fail Position
// limit (3 effective PGs > max 2) purely because of the Joker's position
// reassignment.

function buildScenario(sandbox) {
  const season = AdminActions.createSeason('Loosen Swap Validation Test Season');
  const seasonId = season.id;
  const pA = AdminActions.addParticipant(seasonId, 'Alice');

  const jokerCard = AdminActions.addPlayer({ name: 'Joker Card (native SF)', position: 'SF', overall: 82, pool: 'green' });
  const naturalPG = AdminActions.addPlayer({ name: 'Natural PG', position: 'PG', overall: 78, pool: 'green' });
  const unrelatedSG = AdminActions.addPlayer({ name: 'Unrelated SG', position: 'SG', overall: 75, pool: 'green' });
  const incomingPG = AdminActions.addPlayer({ name: 'New PG Target', position: 'PG', overall: 83, pool: 'green' });

  // Four Blue-pool players already at the roster-wide Blue cap (5 max), so
  // bringing in one more Blue would previously fail Blue restrictions.
  const blue1 = AdminActions.addPlayer({ name: 'Blue 1', position: 'C', overall: 90, pool: 'blue' });
  const blue2 = AdminActions.addPlayer({ name: 'Blue 2', position: 'C', overall: 90, pool: 'blue' });
  const blue3 = AdminActions.addPlayer({ name: 'Blue 3', position: 'C', overall: 90, pool: 'blue' });
  const blue4 = AdminActions.addPlayer({ name: 'Blue 4', position: 'C', overall: 90, pool: 'blue' });
  const blue5 = AdminActions.addPlayer({ name: 'Blue 5', position: 'C', overall: 90, pool: 'blue' });

  const belowMinRating = AdminActions.addPlayer({ name: 'Too Low', position: 'SG', overall: 50, pool: 'green' });
  const overCapPlayer = AdminActions.addPlayer({ name: 'Way Too Good', position: 'SG', overall: 999, pool: 'green' });

  const cache = sandbox.FirebaseSync.getCache();
  const s = cache.seasons[seasonId];
  s.currentRosters = {
    [pA.id]: [
      { playerId: jokerCard.id, source: 'draft', draftSlot: 1, isJoker: true, jokerPosition: 'PG' },
      { playerId: naturalPG.id, source: 'draft', draftSlot: 2 },
      { playerId: unrelatedSG.id, source: 'draft', draftSlot: 3 },
      { playerId: blue1.id, source: 'draft', draftSlot: 4 },
      { playerId: blue2.id, source: 'draft', draftSlot: 5 },
      { playerId: blue3.id, source: 'draft', draftSlot: 6 },
      { playerId: blue4.id, source: 'draft', draftSlot: 7 },
      { playerId: blue5.id, source: 'draft', draftSlot: 8 },
    ],
  };
  s.rostersInitialized = true;
  s.draftComplete = true;
  sandbox.FirebaseSync.save(cache);

  return {
    seasonId, pA, jokerCard, naturalPG, unrelatedSG, incomingPG,
    blue1, belowMinRating, overCapPlayer,
  };
}

const scenario = buildScenario(sandbox);

// ── Test 1 — Position limit no longer blocks a normal swap ─────────────────

check('Test 1: Position limit no longer blocks a normal swap (the diagnosed repro case)', () => {
  const result = AdminActions.evaluateSwap(scenario.seasonId, {
    participantId: scenario.pA.id,
    outgoingPlayerId: scenario.unrelatedSG.id,
    incomingPlayerId: scenario.incomingPG.id,
    isJokerSwap: false,
  });
  assertTrue(result.valid, `expected valid swap, checks: ${JSON.stringify(result.checks)}`);
  assertTrue(!findCheck(result, 'Position limit'), 'Position limit should not even be evaluated for a normal swap');
});

// ── Test 2 — Blue restrictions no longer block a normal swap ───────────────

check('Test 2: Blue restrictions no longer block a normal swap (bringing in a 6th Blue)', () => {
  const sixthBlue = AdminActions.addPlayer({ name: 'Blue 6', position: 'PF', overall: 88, pool: 'blue' });
  const result = AdminActions.evaluateSwap(scenario.seasonId, {
    participantId: scenario.pA.id,
    outgoingPlayerId: scenario.unrelatedSG.id,
    incomingPlayerId: sixthBlue.id,
    isJokerSwap: false,
  });
  assertTrue(result.valid, `expected valid swap, checks: ${JSON.stringify(result.checks)}`);
  assertTrue(!findCheck(result, 'Blue restrictions'), 'Blue restrictions should not even be evaluated for a normal swap');
});

// ── Test 3 — Rating Cap still enforced for a normal swap ───────────────────

check('Test 3: Rating Cap still blocks a normal swap', () => {
  const result = AdminActions.evaluateSwap(scenario.seasonId, {
    participantId: scenario.pA.id,
    outgoingPlayerId: scenario.unrelatedSG.id,
    incomingPlayerId: scenario.overCapPlayer.id,
    isJokerSwap: false,
  });
  assertTrue(!result.valid, 'expected swap to be invalid');
  const capCheck = findCheck(result, 'Rating cap (875)');
  assertTrue(capCheck && !capCheck.valid, 'expected Rating Cap to fail');
});

// ── Test 4 — Minimum Rating still enforced for a normal swap ───────────────

check('Test 4: Minimum Rating still blocks a normal swap', () => {
  const result = AdminActions.evaluateSwap(scenario.seasonId, {
    participantId: scenario.pA.id,
    outgoingPlayerId: scenario.unrelatedSG.id,
    incomingPlayerId: scenario.belowMinRating.id,
    isJokerSwap: false,
  });
  assertTrue(!result.valid, 'expected swap to be invalid');
  const minCheck = findCheck(result, 'Minimum rating');
  assertTrue(minCheck && !minCheck.valid, 'expected Minimum Rating to fail');
});

// ── Test 5 — Season Day still enforced for a normal swap ───────────────────

check('Test 5: Season Day still blocks a normal swap', () => {
  AdminActions.setSeasonDay(scenario.seasonId, 12); // locked day
  const result = AdminActions.evaluateSwap(scenario.seasonId, {
    participantId: scenario.pA.id,
    outgoingPlayerId: scenario.unrelatedSG.id,
    incomingPlayerId: scenario.incomingPG.id,
    isJokerSwap: false,
  });
  assertTrue(!result.valid, 'expected swap to be invalid on a locked day');
  const dayCheck = findCheck(result, 'Season Day');
  assertTrue(dayCheck && !dayCheck.valid, 'expected Season Day to fail');
  AdminActions.setSeasonDay(scenario.seasonId, 1); // reset
});

// ── Test 6 — basic data integrity (Ownership / Replacement eligibility) ────
//    still enforced for a normal swap.

check('Test 6: Ownership is still enforced (outgoing player must actually be on the roster)', () => {
  const someoneElse = AdminActions.addPlayer({ name: 'Not On Roster', position: 'SG', overall: 80, pool: 'green' });
  const result = AdminActions.evaluateSwap(scenario.seasonId, {
    participantId: scenario.pA.id,
    outgoingPlayerId: someoneElse.id,
    incomingPlayerId: scenario.incomingPG.id,
    isJokerSwap: false,
  });
  assertTrue(!result.valid, 'expected swap to be invalid');
  const ownCheck = findCheck(result, 'Ownership');
  assertTrue(ownCheck && !ownCheck.valid, 'expected Ownership to fail');
});

check('Test 6b: Replacement eligibility is still enforced (incoming player must not already be owned)', () => {
  const result = AdminActions.evaluateSwap(scenario.seasonId, {
    participantId: scenario.pA.id,
    outgoingPlayerId: scenario.unrelatedSG.id,
    incomingPlayerId: scenario.naturalPG.id, // already on Alice's own roster
    isJokerSwap: false,
  });
  assertTrue(!result.valid, 'expected swap to be invalid');
  const elig = findCheck(result, 'Replacement eligibility');
  assertTrue(elig && !elig.valid, 'expected Replacement eligibility to fail');
});

// ── Test 7 — the dedicated Joker Swap path is completely unaffected: ───────
//    Position limit and Blue restrictions still run and can still block it.

check('Test 7: Position limit and Blue restrictions are still evaluated for a Joker Swap', () => {
  const result = AdminActions.evaluateSwap(scenario.seasonId, {
    participantId: scenario.pA.id,
    outgoingPlayerId: scenario.jokerCard.id, // the current Joker
    incomingPlayerId: scenario.incomingPG.id,
    isJokerSwap: true,
    jokerPosition: 'SG',
  });
  assertTrue(!!findCheck(result, 'Position limit'), 'Position limit must still be evaluated for a Joker Swap');
  assertTrue(!!findCheck(result, 'Blue restrictions'), 'Blue restrictions must still be evaluated for a Joker Swap');
});

check('Test 7b: a Joker Swap is still blocked when it genuinely violates Position limit', () => {
  // Dedicated mini-scenario: two natural PGs already on the roster, and
  // the current Joker plays their own natural SF (no hidden PG slot). A
  // Joker Swap that reassigns the INCOMING Joker to PG would make 3
  // effective PGs — over the cap of 2 — and must still be rejected exactly
  // as before this revision (Joker Swap is unaffected by it).
  const season2 = AdminActions.createSeason('Joker Swap Position Cap Test');
  const seasonId2 = season2.id;
  const pC = AdminActions.addParticipant(seasonId2, 'Carol');
  const jokerNatural = AdminActions.addPlayer({ name: 'Joker (native SF)', position: 'SF', overall: 80, pool: 'green' });
  const pg1 = AdminActions.addPlayer({ name: 'PG One', position: 'PG', overall: 78, pool: 'green' });
  const pg2 = AdminActions.addPlayer({ name: 'PG Two', position: 'PG', overall: 78, pool: 'green' });
  const newJokerCandidate = AdminActions.addPlayer({ name: 'New Joker Candidate', position: 'C', overall: 80, pool: 'green' });

  const cache = sandbox.FirebaseSync.getCache();
  const s2 = cache.seasons[seasonId2];
  s2.currentRosters = {
    [pC.id]: [
      { playerId: jokerNatural.id, source: 'draft', draftSlot: 1, isJoker: true, jokerPosition: 'SF' },
      { playerId: pg1.id, source: 'draft', draftSlot: 2 },
      { playerId: pg2.id, source: 'draft', draftSlot: 3 },
    ],
  };
  s2.rostersInitialized = true;
  s2.draftComplete = true;
  sandbox.FirebaseSync.save(cache);

  const result = AdminActions.evaluateSwap(seasonId2, {
    participantId: pC.id,
    outgoingPlayerId: jokerNatural.id, // current Joker, valid for a Joker Swap
    incomingPlayerId: newJokerCandidate.id,
    isJokerSwap: true,
    jokerPosition: 'PG', // would make PG1 + PG2 + new Joker = 3, over cap of 2
  });
  assertTrue(!result.valid, 'expected the Joker Swap to be rejected');
  const posCheck = findCheck(result, 'Position limit');
  assertTrue(posCheck && !posCheck.valid, 'expected Position limit to fail for this Joker Swap, unchanged by this revision');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail > 0 ? 1 : 0;
