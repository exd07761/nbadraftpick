'use strict';
/**
 * Swap Pool search bar — regression tests.
 *
 * Covers _buildReplacementGroups' new optional searchQuery argument: a
 * pure display filter (name or position, case-insensitive substring) that
 * never changes swap eligibility itself — getSwapEligibleReplacements and
 * evaluateSwap/commitSwap are completely untouched by this revision.
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
  // AdminTradesView only needs to be an object literal here — same
  // convention as tests_f6/swap_pool_eligibility_test.js.
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
function assertTrue(actual, msg) {
  if (!actual) throw new Error(msg || `expected truthy, got ${JSON.stringify(actual)}`);
}
function assertIncludes(arr, id, msg) {
  if (!arr.some((p) => p.id === id)) throw new Error(msg || `expected ${id} to be present`);
}
function assertExcludes(arr, id, msg) {
  if (arr.some((p) => p.id === id)) throw new Error(msg || `expected ${id} to be absent`);
}

console.log('Swap Pool search bar tests:');
const sandbox = makeSandbox();
const { AdminActions, LeagueData, AdminTradesView } = sandbox;

const season = AdminActions.createSeason('Swap Search Test Season');
const seasonId = season.id;
const pA = AdminActions.addParticipant(seasonId, 'Alice');

const outgoing = AdminActions.addPlayer({ name: 'Outgoing Guy', position: 'SF', overall: 80, pool: 'green' });
const lebron = AdminActions.addPlayer({ name: 'LeBron James', position: 'SF', overall: 97, pool: 'green' });
const curry = AdminActions.addPlayer({ name: 'Stephen Curry', position: 'PG', overall: 96, pool: 'blue' });
const durant = AdminActions.addPlayer({ name: 'Kevin Durant', position: 'SF', overall: 95, pool: 'blue' });

const cache = sandbox.FirebaseSync.getCache();
const s = cache.seasons[seasonId];
s.currentRosters = {
  [pA.id]: [{ playerId: outgoing.id, source: 'draft', draftSlot: 1 }],
};
s.rostersInitialized = true;
s.draftComplete = true;
sandbox.FirebaseSync.save(cache);

const roster = LeagueData.getRosterForTransactions(seasonId, pA.id);
const outgoingEntry = roster.find((e) => e.playerId === outgoing.id);
const allEligible = LeagueData.getSwapEligibleReplacements(seasonId, '');

check('No search query: every eligible player is shown (unchanged behavior)', () => {
  const groups = AdminTradesView._buildReplacementGroups(allEligible, outgoingEntry, '');
  const all = [...groups.green, ...groups.blue, ...groups.other];
  assertIncludes(all, lebron.id);
  assertIncludes(all, curry.id);
  assertIncludes(all, durant.id);
});

check('Search by partial name (case-insensitive) narrows the list', () => {
  const groups = AdminTradesView._buildReplacementGroups(allEligible, outgoingEntry, 'lebron');
  const all = [...groups.green, ...groups.blue, ...groups.other];
  assertIncludes(all, lebron.id, 'LeBron should match');
  assertExcludes(all, curry.id, 'Curry should not match "lebron"');
  assertExcludes(all, durant.id, 'Durant should not match "lebron"');
});

check('Search by position matches every player at that position', () => {
  const groups = AdminTradesView._buildReplacementGroups(allEligible, outgoingEntry, 'SF');
  const all = [...groups.green, ...groups.blue, ...groups.other];
  assertIncludes(all, lebron.id, 'LeBron plays SF');
  assertIncludes(all, durant.id, 'Durant plays SF');
  assertExcludes(all, curry.id, 'Curry plays PG, not SF');
});

check('Search with no matches returns an empty (but valid) group set', () => {
  const groups = AdminTradesView._buildReplacementGroups(allEligible, outgoingEntry, 'zzz-nobody-named-this');
  assertEqual(groups.total, 0, 'expected zero matches');
});

check('Search never changes actual swap eligibility (evaluateSwap/commitSwap untouched)', () => {
  // The search bar is a pure UI filter — a player excluded from the
  // filtered display is still fully eligible if selected directly.
  const result = AdminActions.evaluateSwap(seasonId, {
    participantId: pA.id,
    outgoingPlayerId: outgoing.id,
    incomingPlayerId: curry.id, // would NOT show under a search for "lebron"
    isJokerSwap: false,
  });
  assertTrue(result.valid, `expected valid swap regardless of search text, checks: ${JSON.stringify(result.checks)}`);
});

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'assertion failed'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail > 0 ? 1 : 0;
