'use strict';
/**
 * Revision — Joker Eligibility for Plain Manual Additions — regression
 * tests.
 *
 * PRODUCT DECISION (see the accompanying report): a player added through
 * Admin -> Roster -> Edit Roster Manually -> "+ Add Player" (source
 * "manual", draftSlot null -- no vacated slot inherited, as opposed to
 * "+ Fill Slot") must now be Joker-eligible too, on top of the existing
 * "occupies one of the participant's own picks #1-10" rule. Implemented
 * as a single shared predicate, isJokerEligibleRosterEntry (js/data.js),
 * called identically by getJokerEligiblePlayers (read/UI -- the 🃏 button)
 * and designateJoker (write -- the actual designation), so the two can
 * never disagree.
 *
 * This file locks in all four required cases:
 *   1. Normal drafted player, own draftSlot 1-10       -> eligible (unchanged rule)
 *   2. Manual Fill Slot player, real draftSlot 1-10    -> eligible (unchanged rule)
 *   3. Plain Manual Add player, source manual, slot null -> eligible (NEW rule)
 *   4. Non-manual player with draftSlot null (e.g. a swap) -> NOT eligible
 * For each, both getJokerEligiblePlayers (read) and designateJoker (write)
 * are checked, so a read/write disagreement would be caught here.
 *
 * Same VM-sandbox-loads-the-real-source convention as tests_f6/*.
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
function assertFalse(actual, msg) {
  if (actual) throw new Error(msg || `expected falsy, got ${JSON.stringify(actual)}`);
}
function assertThrows(fn, msg) {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error(msg || 'expected function to throw, but it did not');
}

/**
 * One participant, four roster entries -- one for each of the four cases
 * under test -- so a single scenario covers everything. rostersInitialized
 * is set directly (bypassing the real draft flow entirely, same as
 * tests_f6/joker_normal_swap_test.js does) since only designateJoker's and
 * getJokerEligiblePlayers's OWN logic is under test here, not the draft or
 * Manual Roster Edit UI/action functions themselves.
 */
function buildScenario(sandbox) {
  const { AdminActions } = sandbox;
  const season = AdminActions.createSeason('Joker Manual Add Eligibility Test Season');
  const seasonId = season.id;
  const participant = AdminActions.addParticipant(seasonId, 'Alice');

  const draftedPlayer = AdminActions.addPlayer({ name: 'Drafted PG', position: 'PG', overall: 80, pool: 'green' });
  const fillSlotPlayer = AdminActions.addPlayer({ name: 'Fill Slot SG', position: 'SG', overall: 80, pool: 'green' });
  const plainAddPlayer = AdminActions.addPlayer({ name: 'Plain Add SF', position: 'SF', overall: 80, pool: 'green' });
  const swapPlayer = AdminActions.addPlayer({ name: 'Swap PF', position: 'PF', overall: 80, pool: 'green' });

  const cache = sandbox.FirebaseSync.getCache();
  const s = cache.seasons[seasonId];
  s.rostersInitialized = true;
  s.currentRosters = {
    [participant.id]: [
      // Case 1: normal drafted player, own draftSlot 1-10.
      { playerId: draftedPlayer.id, source: 'draft', draftSlot: 1 },
      // Case 2: manual Fill Slot -- real draftSlot 1-10 inherited from the
      // vacated original slot (matches manualAddPlayerToRoster's Fill Slot
      // branch exactly).
      { playerId: fillSlotPlayer.id, source: 'manual', draftSlot: 2 },
      // Case 3 (NEW rule): plain "+ Add Player" -- source manual, no slot
      // inherited at all (matches manualAddPlayerToRoster's plain-Add
      // branch exactly: draftSlot: null).
      { playerId: plainAddPlayer.id, source: 'manual', draftSlot: null },
      // Case 4: a non-manual entry with no draftSlot at all (e.g. a
      // trade/swap acquisition) -- must remain ineligible; rule B requires
      // source === "manual", which this is not.
      { playerId: swapPlayer.id, source: 'swap' },
    ],
  };

  return { sandbox, seasonId, participant, draftedPlayer, fillSlotPlayer, plainAddPlayer, swapPlayer };
}

console.log('Joker Eligibility for Plain Manual Additions -- regression tests\n');

{
  const sandbox = makeSandbox();
  const { LeagueData } = sandbox;
  const { seasonId, participant, draftedPlayer, fillSlotPlayer, plainAddPlayer, swapPlayer } = buildScenario(sandbox);

  const eligibleIds = new Set(
    LeagueData.getJokerEligiblePlayers(seasonId, participant.id).map((e) => e.playerId)
  );

  console.log('READ side -- getJokerEligiblePlayers:');
  check('Case 1 (drafted, own slot 1-10) is eligible', () => assertTrue(eligibleIds.has(draftedPlayer.id)));
  check('Case 2 (manual Fill Slot, real slot 1-10) is eligible', () => assertTrue(eligibleIds.has(fillSlotPlayer.id)));
  check('Case 3 (plain manual add, slot null) is eligible -- NEW rule', () => assertTrue(eligibleIds.has(plainAddPlayer.id)));
  check('Case 4 (non-manual, no slot) is NOT eligible', () => assertFalse(eligibleIds.has(swapPlayer.id)));
}

{
  const sandbox = makeSandbox();
  const { AdminActions } = sandbox;
  const { seasonId, participant, draftedPlayer } = buildScenario(sandbox);

  console.log('\nWRITE side -- designateJoker (Case 1, unchanged rule):');
  check('drafted player CAN be designated Joker', () => {
    AdminActions.designateJoker(seasonId, participant.id, draftedPlayer.id, 'PG');
  });
  check('designation actually recorded isJoker on the roster entry', () => {
    const cache = sandbox.FirebaseSync.getCache();
    const entry = cache.seasons[seasonId].currentRosters[participant.id].find((e) => e.playerId === draftedPlayer.id);
    assertTrue(entry.isJoker === true, 'expected isJoker to be true after designateJoker');
  });
}

{
  const sandbox = makeSandbox();
  const { AdminActions } = sandbox;
  const { seasonId, participant, fillSlotPlayer } = buildScenario(sandbox);

  console.log('\nWRITE side -- designateJoker (Case 2, unchanged rule):');
  check('manual Fill Slot player CAN be designated Joker', () => {
    AdminActions.designateJoker(seasonId, participant.id, fillSlotPlayer.id, 'SG');
  });
  check('designation actually recorded isJoker on the roster entry', () => {
    const cache = sandbox.FirebaseSync.getCache();
    const entry = cache.seasons[seasonId].currentRosters[participant.id].find((e) => e.playerId === fillSlotPlayer.id);
    assertTrue(entry.isJoker === true, 'expected isJoker to be true after designateJoker');
  });
}

{
  const sandbox = makeSandbox();
  const { AdminActions } = sandbox;
  const { seasonId, participant, plainAddPlayer } = buildScenario(sandbox);

  console.log('\nWRITE side -- designateJoker (Case 3, NEW rule):');
  check('plain manual-add player CAN be designated Joker', () => {
    AdminActions.designateJoker(seasonId, participant.id, plainAddPlayer.id, 'SF');
  });
  check('designation actually recorded isJoker on the roster entry', () => {
    const cache = sandbox.FirebaseSync.getCache();
    const entry = cache.seasons[seasonId].currentRosters[participant.id].find((e) => e.playerId === plainAddPlayer.id);
    assertTrue(entry.isJoker === true, 'expected isJoker to be true after designateJoker');
  });
  check('draftSlot remains null after designation (no fake slot invented)', () => {
    const cache = sandbox.FirebaseSync.getCache();
    const entry = cache.seasons[seasonId].currentRosters[participant.id].find((e) => e.playerId === plainAddPlayer.id);
    assertTrue(entry.draftSlot === null, `expected draftSlot to remain null, got ${JSON.stringify(entry.draftSlot)}`);
  });
}

{
  const sandbox = makeSandbox();
  const { AdminActions } = sandbox;
  const { seasonId, participant, swapPlayer } = buildScenario(sandbox);

  console.log('\nWRITE side -- designateJoker (Case 4, must stay rejected):');
  check('non-manual player with no draftSlot CANNOT be designated Joker', () => {
    const err = assertThrows(() => AdminActions.designateJoker(seasonId, participant.id, swapPlayer.id, 'PF'));
    assertTrue(/own picks #1-10|manually added/.test(err.message), `unexpected error message: ${err.message}`);
  });
}

console.log(`\n${pass} passed, ${fail} failed.`);
if (fail > 0) process.exitCode = 1;
