'use strict';
/**
 * Swap Pool Restriction Revision — regression tests.
 *
 * Covers two layers, matching the two concepts the revision is careful to
 * keep separate:
 *
 *   A. Swap Pool eligibility (which players an admin can even pick as a
 *      replacement) — LeagueData.getSwapEligibleReplacements() plus
 *      AdminTradesView._buildReplacementGroups(), the UI-layer grouping
 *      that used to also filter by same-position ("position duplication").
 *
 *   B. Actual swap execution — AdminActions.evaluateSwap()/commitSwap(),
 *      which must still enforce Overrating (Rating Cap), Minimum Rating,
 *      and Season Day exactly as before, and must be completely unaffected
 *      by the Swap Pool UI change.
 *
 * Same VM-sandbox convention as tests_f6/f6_test.js: load data.js in a
 * fresh Node vm context per test file, with FirebaseSync's cache swapped
 * for a plain in-memory object.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const dataJsPath = path.join(__dirname, '..', 'js', 'data.js');
const tradesJsPath = path.join(__dirname, '..', 'js', 'admin', 'trades.js');
const dataSrc = fs.readFileSync(dataJsPath, 'utf8');
const tradesSrc = fs.readFileSync(tradesJsPath, 'utf8');

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

  // AdminTradesView (admin/trades.js) references browser globals
  // (LeagueData/AdminActions/AuthBoundary/escapeHtml/showToast/AdminApp) but
  // only inside methods we never call here — _buildReplacementGroups is a
  // pure function of its two arguments, so loading the object literal is
  // enough; none of those globals need to exist for it to run.
  vm.runInContext(tradesSrc, sandbox, { filename: 'trades.js' });
  vm.runInContext('this.AdminTradesView = AdminTradesView;', sandbox, { filename: 'export2.js' });

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
function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'assertion failed'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function assertTrue(actual, msg) {
  if (!actual) throw new Error(msg || `expected truthy, got ${JSON.stringify(actual)}`);
}
function assertIncludes(arr, id, msg) {
  if (!arr.some((p) => p.id === id)) throw new Error(msg || `expected ${id} to be present`);
}
function assertExcludes(arr, id, msg) {
  if (arr.some((p) => p.id === id)) throw new Error(msg || `expected ${id} to be absent`);
}

/**
 * Builds a minimal two-team season with rosters already initialized,
 * bypassing the full draft flow (same "inject the shape commitTrade/
 * initializeRostersFromDraft would have written" approach f6_test.js uses
 * for tradeFeeSplit records) since none of this exercises draft logic.
 */
function buildScenario(sandbox) {
  const { AdminActions } = sandbox;
  const season = AdminActions.createSeason('Swap Pool Test Season');
  const seasonId = season.id;
  const pA = AdminActions.addParticipant(seasonId, 'Alice');
  const pB = AdminActions.addParticipant(seasonId, 'Bob');

  const pg1 = AdminActions.addPlayer({ name: 'Alice PG', position: 'PG', overall: 80, pool: 'green' });
  const sg1 = AdminActions.addPlayer({ name: 'Alice SG', position: 'SG', overall: 80, pool: 'green' });
  const sf1 = AdminActions.addPlayer({ name: 'Bob SF', position: 'SF', overall: 80, pool: 'green' });
  const pf1 = AdminActions.addPlayer({ name: 'Bob PF', position: 'PF', overall: 80, pool: 'green' });

  // Free-agent pool: one at the outgoing player's own position, one at a
  // different position, one that violates each retained rule.
  const samePosReplacement = AdminActions.addPlayer({ name: 'Free PG', position: 'PG', overall: 82, pool: 'green' });
  const otherPosReplacement = AdminActions.addPlayer({ name: 'Free SF', position: 'SF', overall: 82, pool: 'green' });
  const belowMinRating = AdminActions.addPlayer({ name: 'Too Low', position: 'SG', overall: 50, pool: 'green' });
  const overCapPlayer = AdminActions.addPlayer({ name: 'Way Too Good', position: 'SG', overall: 999, pool: 'green' });

  const cache = sandbox.FirebaseSync.getCache();
  const s = cache.seasons[seasonId];
  s.currentRosters = {
    [pA.id]: [
      { playerId: pg1.id, source: 'draft', draftSlot: 1 },
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

  return {
    seasonId, pA, pB,
    outgoing: pg1, samePosReplacement, otherPosReplacement, belowMinRating, overCapPlayer,
  };
}

console.log('Swap Pool Restriction Revision tests:');
const sandbox = makeSandbox();
const scenario = buildScenario(sandbox);
const { LeagueData, AdminActions, AdminTradesView } = sandbox;

// ── Test 5 / Test 6 — Swap Pool eligibility (position no longer restricts) ──

check('Test 5/6: pool listing itself is unfiltered by position (unchanged, pre-existing behavior)', () => {
  const eligible = LeagueData.getSwapEligibleReplacements(scenario.seasonId, '');
  assertIncludes(eligible, scenario.samePosReplacement.id, 'same-position free agent should be listed');
  assertIncludes(eligible, scenario.otherPosReplacement.id, 'different-position free agent should be listed');
});

check('Test 5: UI replacement groups no longer exclude a different-position player', () => {
  const roster = LeagueData.getRosterForTransactions(scenario.seasonId, scenario.pA.id);
  const outgoingEntry = roster.find((e) => e.playerId === scenario.outgoing.id);
  const allEligible = LeagueData.getSwapEligibleReplacements(scenario.seasonId, '');
  const groups = AdminTradesView._buildReplacementGroups(allEligible, outgoingEntry);
  const allShown = [...groups.green, ...groups.blue, ...groups.other];
  assertIncludes(allShown, scenario.samePosReplacement.id, 'same-position player still shown');
  assertIncludes(allShown, scenario.otherPosReplacement.id, 'different-position player is now shown too');
});

check('Test 6: five-position/roster-composition rules do not hide otherwise-eligible players from the pool', () => {
  // Both teams already have their positions filled (2 each); a free agent
  // at a position neither team is "missing" must still appear.
  const allEligible = LeagueData.getSwapEligibleReplacements(scenario.seasonId, '');
  assertIncludes(allEligible, scenario.otherPosReplacement.id);
});

check('UI grouping still excludes the outgoing player himself and still splits/sorts by pool', () => {
  const roster = LeagueData.getRosterForTransactions(scenario.seasonId, scenario.pA.id);
  const outgoingEntry = roster.find((e) => e.playerId === scenario.outgoing.id);
  // Outgoing player is on his own roster, so he wouldn't appear in
  // getSwapEligibleReplacements anyway — this just documents that the
  // explicit belt-and-suspenders exclusion still runs.
  const allEligible = [...LeagueData.getSwapEligibleReplacements(scenario.seasonId, ''), scenario.outgoing];
  const groups = AdminTradesView._buildReplacementGroups(allEligible, outgoingEntry);
  const allShown = [...groups.green, ...groups.blue, ...groups.other];
  assertExcludes(allShown, scenario.outgoing.id, 'outgoing player must not appear as his own replacement');
});

// ── Test 1 — a fully valid swap remains available/valid ─────────────────────

check('Test 1: a valid replacement (passes all 3 retained rules) evaluates as valid', () => {
  const result = AdminActions.evaluateSwap(scenario.seasonId, {
    participantId: scenario.pA.id,
    outgoingPlayerId: scenario.outgoing.id,
    incomingPlayerId: scenario.otherPosReplacement.id,
    isJokerSwap: false,
  });
  assertTrue(result.valid, `expected valid swap, checks: ${JSON.stringify(result.checks)}`);
});

// ── Test 2 — Overrating (Rating Cap) still enforced ─────────────────────────

check('Test 2: Overrating (Rating Cap) restriction still blocks an over-cap replacement', () => {
  const result = AdminActions.evaluateSwap(scenario.seasonId, {
    participantId: scenario.pA.id,
    outgoingPlayerId: scenario.outgoing.id,
    incomingPlayerId: scenario.overCapPlayer.id,
    isJokerSwap: false,
  });
  assertTrue(!result.valid, 'expected swap to be invalid');
  const capCheck = result.checks.find((c) => c.label.startsWith('Rating cap'));
  assertTrue(capCheck && !capCheck.valid, 'expected the Rating Cap check to fail');
});

// ── Test 3 — Minimum Rating still enforced ──────────────────────────────────

check('Test 3: Minimum Rating restriction still blocks a below-minimum replacement', () => {
  const result = AdminActions.evaluateSwap(scenario.seasonId, {
    participantId: scenario.pA.id,
    outgoingPlayerId: scenario.outgoing.id,
    incomingPlayerId: scenario.belowMinRating.id,
    isJokerSwap: false,
  });
  assertTrue(!result.valid, 'expected swap to be invalid');
  const minCheck = result.checks.find((c) => c.label === 'Minimum rating');
  assertTrue(minCheck && !minCheck.valid, 'expected the Minimum Rating check to fail');
});

// ── Test 4 / Test 8 — Season Day still enforced ─────────────────────────────

check('Test 4/8: Season Day restriction still blocks a swap on a locked day', () => {
  AdminActions.setSeasonDay(scenario.seasonId, 12); // TRANSACTIONS_LOCKED_DAYS includes 12
  const result = AdminActions.evaluateSwap(scenario.seasonId, {
    participantId: scenario.pA.id,
    outgoingPlayerId: scenario.outgoing.id,
    incomingPlayerId: scenario.otherPosReplacement.id,
    isJokerSwap: false,
  });
  assertTrue(!result.valid, 'expected swap to be invalid on a locked day');
  const dayCheck = result.checks.find((c) => c.label === 'Season Day');
  assertTrue(dayCheck && !dayCheck.valid, 'expected the Season Day check to fail');
  AdminActions.setSeasonDay(scenario.seasonId, 1); // reset for subsequent tests
});

// ── Test 7 — normal swap execution still commits correctly ─────────────────

check('Test 7: a normal cross-position swap still commits, updates rosters, and records history/fees', () => {
  const before = sandbox.FirebaseSync.getCache().seasons[scenario.seasonId];
  const potBefore = before.pot || 0;

  AdminActions.commitSwap(scenario.seasonId, {
    participantId: scenario.pA.id,
    outgoingPlayerId: scenario.outgoing.id,
    incomingPlayerId: scenario.otherPosReplacement.id,
    isJokerSwap: false,
  });

  const after = sandbox.FirebaseSync.getCache().seasons[scenario.seasonId];
  const rosterA = after.currentRosters[scenario.pA.id];
  assertExcludes(rosterA.map((e) => ({ id: e.playerId })), scenario.outgoing.id, 'outgoing player removed from roster');
  assertTrue(rosterA.some((e) => e.playerId === scenario.otherPosReplacement.id), 'incoming player added to roster');

  const swapTxns = after.transactions.filter((t) => t.type === 'swap');
  assertEqual(swapTxns.length, 1, 'one swap transaction recorded');
  assertEqual(after.pot, potBefore + 100, 'pot increased by the regular swap fee');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail > 0 ? 1 : 0;
