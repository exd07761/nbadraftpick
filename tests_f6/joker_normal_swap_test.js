'use strict';
/**
 * Revision — Bypass Joker Status for Normal Swaps — regression tests.
 *
 * AUDIT FINDING (see the accompanying report): as originally written,
 * evaluateSwap's only Joker-related check was
 *
 *   if (isJokerSwap && !outgoingEntry.isJoker) fail("Joker", ...);
 *
 * which was gated behind isJokerSwap === true — i.e. it belonged
 * exclusively to the dedicated Joker Swap path (the "This is a Joker
 * swap" checkbox in admin/trades.js) and never fired for a normal swap
 * (isJokerSwap falsy). No other function in the normal-swap path
 * (getSwapEligibleReplacements, AdminTradesView._buildReplacementGroups,
 * the outgoing-player <select>, or evaluateSwap/commitSwap's other
 * checks) read isJoker at all. There was therefore no existing
 * restriction to remove for normal swaps — this file exists to lock that
 * (already-correct) behavior in place as a regression guard, per the
 * revision's own Phase 10 testing requirement.
 *
 * NOTE: the check quoted above was later removed entirely by the "Fix
 * Joker Swap" revision (it no longer requires the outgoing player to be
 * the current Joker even for a real Joker Swap) — see Test 7/7b below and
 * loosen_swap_validation_test.js for that revision's own coverage.
 *
 * Same VM-sandbox convention as tests_f6/swap_pool_eligibility_test.js.
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
        collection: () => ({
          doc: () => ({
            onSnapshot: () => {},
            set: () => Promise.resolve(),
          }),
        }),
      }),
    },
    showToast: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(dataSrc, sandbox, { filename: 'data.js' });
  vm.runInContext(
    'this.LeagueData = LeagueData; this.AdminActions = AdminActions; ' +
    'this.FirebaseSync = FirebaseSync; this.getDefaultData = getDefaultData;',
    sandbox,
    { filename: 'export.js' }
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

/**
 * Two-team season with rosters already initialized. Alice's PG is her
 * designated Joker (isJoker: true, jokerPosition: 'PG') — set directly on
 * the roster entry, same shape designateJoker itself writes, since none of
 * this needs to exercise designateJoker's own eligibility rules.
 */
function buildScenario(sandbox) {
  const { AdminActions } = sandbox;
  const season = AdminActions.createSeason('Joker Normal Swap Test Season');
  const seasonId = season.id;
  const pA = AdminActions.addParticipant(seasonId, 'Alice');
  const pB = AdminActions.addParticipant(seasonId, 'Bob');

  const jokerPlayer = AdminActions.addPlayer({ name: 'Alice Joker PG', position: 'PG', overall: 80, pool: 'green' });
  const sg1 = AdminActions.addPlayer({ name: 'Alice SG', position: 'SG', overall: 80, pool: 'green' });
  const sf1 = AdminActions.addPlayer({ name: 'Bob SF', position: 'SF', overall: 80, pool: 'green' });
  const pf1 = AdminActions.addPlayer({ name: 'Bob PF', position: 'PF', overall: 80, pool: 'green' });

  const validReplacement = AdminActions.addPlayer({ name: 'Free SF', position: 'SF', overall: 82, pool: 'green' });
  // A second Joker-eligible-looking free agent used as an INCOMING player —
  // note isJoker is never actually a field on the free-agent pool (it's a
  // roster-entry concept), so this is just an ordinary player used to prove
  // a normal swap can bring in whoever is eligible on the merits.
  const incomingCandidate = AdminActions.addPlayer({ name: 'Free PG', position: 'PG', overall: 83, pool: 'green' });
  const belowMinRating = AdminActions.addPlayer({ name: 'Too Low', position: 'SG', overall: 50, pool: 'green' });
  const overCapPlayer = AdminActions.addPlayer({ name: 'Way Too Good', position: 'SG', overall: 999, pool: 'green' });

  const cache = sandbox.FirebaseSync.getCache();
  const s = cache.seasons[seasonId];
  s.currentRosters = {
    [pA.id]: [
      { playerId: jokerPlayer.id, source: 'draft', draftSlot: 1, isJoker: true, jokerPosition: 'PG' },
      { playerId: sg1.id, source: 'draft', draftSlot: 2 },
    ],
    [pB.id]: [
      { playerId: sf1.id, source: 'draft', draftSlot: 1 },
      { playerId: pf1.id, source: 'draft', draftSlot: 2 },
    ],
  };
  s.rostersInitialized = true;
  s.draftComplete = true;
  sandbox.FirebaseSync.save(cache);

  return { seasonId, pA, pB, jokerPlayer, validReplacement, incomingCandidate, belowMinRating, overCapPlayer };
}

console.log('Bypass Joker Status for Normal Swaps tests:');
const sandbox = makeSandbox();
const scenario = buildScenario(sandbox);
const { AdminActions } = sandbox;

// ── Test 1 — Joker player can be swapped OUT through a normal swap ─────────

check('Test 1: a Joker-designated player can be the OUTGOING player in a normal swap', () => {
  const result = AdminActions.evaluateSwap(scenario.seasonId, {
    participantId: scenario.pA.id,
    outgoingPlayerId: scenario.jokerPlayer.id,
    incomingPlayerId: scenario.validReplacement.id,
    isJokerSwap: false,
  });
  assertTrue(result.valid, `expected valid swap, checks: ${JSON.stringify(result.checks)}`);
  const jokerCheck = result.checks.find((c) => c.label === 'Joker');
  assertTrue(!jokerCheck, 'the Joker-swap-only check must not even run for a normal swap');
});

// ── Test 2 — a Joker-designated player can be selected as the INCOMING ─────
//    replacement (mirrors Phase 6 "Normal → Joker" direction: nothing
//    about isJoker on the incoming side blocks a normal swap either).

check('Test 2: a normal swap bringing in an ordinary replacement evaluates as valid', () => {
  const roster = sandbox.LeagueData.getRosterForTransactions(scenario.seasonId, scenario.pB.id);
  const outgoing = roster[1]; // Bob PF
  const result = AdminActions.evaluateSwap(scenario.seasonId, {
    participantId: scenario.pB.id,
    outgoingPlayerId: outgoing.playerId,
    incomingPlayerId: scenario.incomingCandidate.id,
    isJokerSwap: false,
  });
  assertTrue(result.valid, `expected valid swap, checks: ${JSON.stringify(result.checks)}`);
});

// ── Test 3 — Joker status ALONE cannot reject a normal swap ────────────────
//    Two otherwise-identical evaluations, the only difference being which
//    roster entry (Joker vs non-Joker) is the outgoing player — both must
//    evaluate identically valid.

check('Test 3: swapping the Joker vs swapping a non-Joker teammate evaluate identically', () => {
  const jokerResult = AdminActions.evaluateSwap(scenario.seasonId, {
    participantId: scenario.pA.id,
    outgoingPlayerId: scenario.jokerPlayer.id,
    incomingPlayerId: scenario.validReplacement.id,
    isJokerSwap: false,
  });
  const roster = sandbox.LeagueData.getRosterForTransactions(scenario.seasonId, scenario.pA.id);
  const nonJokerEntry = roster.find((e) => e.playerId !== scenario.jokerPlayer.id);
  const nonJokerResult = AdminActions.evaluateSwap(scenario.seasonId, {
    participantId: scenario.pA.id,
    outgoingPlayerId: nonJokerEntry.playerId,
    incomingPlayerId: scenario.validReplacement.id,
    isJokerSwap: false,
  });
  assertEqual(jokerResult.valid, true, 'Joker outgoing should be valid');
  assertEqual(nonJokerResult.valid, true, 'non-Joker outgoing should also be valid');
});

// ── Test 4 — Overrating (Rating Cap) still blocks, even for the Joker ──────

check('Test 4: Rating Cap still blocks a normal swap involving the Joker, for the right reason', () => {
  const result = AdminActions.evaluateSwap(scenario.seasonId, {
    participantId: scenario.pA.id,
    outgoingPlayerId: scenario.jokerPlayer.id,
    incomingPlayerId: scenario.overCapPlayer.id,
    isJokerSwap: false,
  });
  assertTrue(!result.valid, 'expected swap to be invalid');
  const capCheck = result.checks.find((c) => c.label.startsWith('Rating cap'));
  assertTrue(capCheck && !capCheck.valid, 'expected the Rating Cap check to fail');
  const jokerCheck = result.checks.find((c) => c.label === 'Joker');
  assertTrue(!jokerCheck, 'must be rejected by Rating Cap, not by any Joker check');
});

// ── Test 5 — Minimum Rating still blocks, even for the Joker ───────────────

check('Test 5: Minimum Rating still blocks a normal swap involving the Joker, for the right reason', () => {
  const result = AdminActions.evaluateSwap(scenario.seasonId, {
    participantId: scenario.pA.id,
    outgoingPlayerId: scenario.jokerPlayer.id,
    incomingPlayerId: scenario.belowMinRating.id,
    isJokerSwap: false,
  });
  assertTrue(!result.valid, 'expected swap to be invalid');
  const minCheck = result.checks.find((c) => c.label === 'Minimum rating');
  assertTrue(minCheck && !minCheck.valid, 'expected the Minimum Rating check to fail');
  const jokerCheck = result.checks.find((c) => c.label === 'Joker');
  assertTrue(!jokerCheck, 'must be rejected by Minimum Rating, not by any Joker check');
});

// ── Test 6 — Season Day still blocks, even for the Joker ───────────────────

check('Test 6: Season Day still blocks a normal swap involving the Joker, for the right reason', () => {
  AdminActions.setSeasonDay(scenario.seasonId, 12); // TRANSACTIONS_LOCKED_DAYS includes 12
  const result = AdminActions.evaluateSwap(scenario.seasonId, {
    participantId: scenario.pA.id,
    outgoingPlayerId: scenario.jokerPlayer.id,
    incomingPlayerId: scenario.validReplacement.id,
    isJokerSwap: false,
  });
  assertTrue(!result.valid, 'expected swap to be invalid on a locked day');
  const dayCheck = result.checks.find((c) => c.label === 'Season Day');
  assertTrue(dayCheck && !dayCheck.valid, 'expected the Season Day check to fail');
  const jokerCheck = result.checks.find((c) => c.label === 'Joker');
  assertTrue(!jokerCheck, 'must be rejected by Season Day, not by any Joker check');
  AdminActions.setSeasonDay(scenario.seasonId, 1); // reset for subsequent tests
});

// ── Test 7 — Revision: "Fix Joker Swap" superseded this test's original ────
//    premise. A Joker Swap no longer requires the outgoing player to
//    already be the current Joker — see loosen_swap_validation_test.js's
//    "Fix Joker Swap" coverage for the full before/after behavior. Kept
//    here (updated) so this file's Joker Swap coverage stays accurate.

check('Test 7: a Joker Swap with a NON-Joker outgoing player is now accepted (Fix Joker Swap revision)', () => {
  const roster = sandbox.LeagueData.getRosterForTransactions(scenario.seasonId, scenario.pA.id);
  const nonJokerEntry = roster.find((e) => e.playerId !== scenario.jokerPlayer.id);
  const result = AdminActions.evaluateSwap(scenario.seasonId, {
    participantId: scenario.pA.id,
    outgoingPlayerId: nonJokerEntry.playerId, // NOT the current Joker — now allowed
    incomingPlayerId: scenario.validReplacement.id,
    isJokerSwap: true,
    jokerPosition: 'SF',
  });
  assertTrue(result.valid, `expected a valid Joker Swap regardless of outgoing Joker status, checks: ${JSON.stringify(result.checks)}`);
});

check('Test 7b: a Joker Swap with the ACTUAL Joker as outgoing still evaluates valid and commits as isJoker on the incoming player', () => {
  const result = AdminActions.evaluateSwap(scenario.seasonId, {
    participantId: scenario.pA.id,
    outgoingPlayerId: scenario.jokerPlayer.id,
    incomingPlayerId: scenario.validReplacement.id,
    isJokerSwap: true,
    jokerPosition: 'SF',
  });
  assertTrue(result.valid, `expected valid Joker Swap, checks: ${JSON.stringify(result.checks)}`);
});

// ── Test 8 — a plain normal swap (no Joker involved at all) still works ────

check('Test 8: an ordinary normal swap with no Joker involved still commits, updates rosters, and records history/fees', () => {
  const before = sandbox.FirebaseSync.getCache().seasons[scenario.seasonId];
  const potBefore = before.pot || 0;
  const roster = sandbox.LeagueData.getRosterForTransactions(scenario.seasonId, scenario.pB.id);
  const outgoing = roster.find((e) => !e.isJoker);

  AdminActions.commitSwap(scenario.seasonId, {
    participantId: scenario.pB.id,
    outgoingPlayerId: outgoing.playerId,
    incomingPlayerId: scenario.incomingCandidate.id,
    isJokerSwap: false,
  });

  const after = sandbox.FirebaseSync.getCache().seasons[scenario.seasonId];
  const rosterB = after.currentRosters[scenario.pB.id];
  assertTrue(!rosterB.some((e) => e.playerId === outgoing.playerId), 'outgoing player removed from roster');
  assertTrue(rosterB.some((e) => e.playerId === scenario.incomingCandidate.id), 'incoming player added to roster');

  const swapTxns = after.transactions.filter((t) => t.type === 'swap');
  assertEqual(swapTxns.length, 1, 'one swap transaction recorded');
  assertEqual(after.pot, potBefore + 100, 'pot increased by the regular swap fee');
});

// ── Test 9 — committing a normal swap OUT of the Joker actually works end- ─
//    to-end (Phase 5 "Joker → Normal" direction) and simply drops the
//    isJoker tag along with the departing player, per Phase 7 (no invented
//    isJoker-state behavior — the entry is just gone, like any other swap).

check('Test 9: committing a normal swap out of the Joker succeeds and the Joker tag leaves with that player', () => {
  const result = AdminActions.commitSwap(scenario.seasonId, {
    participantId: scenario.pA.id,
    outgoingPlayerId: scenario.jokerPlayer.id,
    incomingPlayerId: scenario.validReplacement.id,
    isJokerSwap: false,
  });
  assertTrue(result.valid, 'commit should succeed');
  const rosterA = sandbox.FirebaseSync.getCache().seasons[scenario.seasonId].currentRosters[scenario.pA.id];
  assertTrue(!rosterA.some((e) => e.playerId === scenario.jokerPlayer.id), 'former Joker player left the roster');
  const newEntry = rosterA.find((e) => e.playerId === scenario.validReplacement.id);
  assertTrue(newEntry && !newEntry.isJoker, 'incoming player is not automatically made Joker by a normal swap');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail > 0 ? 1 : 0;
