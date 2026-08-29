'use strict';
/**
 * Revision — Display Original Pick Color.
 *
 * getCurrentRoster (the read both admin/roster.js and views/roster.js
 * consume via getRosterSummary) now includes `classification` on every
 * enriched entry — the same RED/YELLOW/PINK value the Trade/Swap picker
 * already showed via getRosterForTransactions, just never previously
 * exposed on the roster tables themselves. This does NOT touch the
 * underlying classification/draftSlot preservation logic (already correct
 * — see the "Fix Joker Swap"/"Bypass Joker Status" test files and the
 * accompanying audit) — only what's returned for display.
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
function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'assertion failed'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

console.log('Display Original Pick Color tests:');
const sandbox = makeSandbox();
const { AdminActions, LeagueData } = sandbox;

const season = AdminActions.createSeason('Pick Color Display Test');
const seasonId = season.id;
const team = AdminActions.addParticipant(seasonId, 'Test Team');

// Picks 1-2 -> RED, 3-5 -> YELLOW, 6+ -> null (per classifyPickNumber).
const names = ['Pick 1', 'Pick 2', 'Pick 3', 'Pick 4', 'Pick 5', 'Pick 6'];
const players = names.map((name) => AdminActions.addPlayer({ name, position: 'SF', overall: 80, pool: 'green' }));

const cache = sandbox.FirebaseSync.getCache();
const s = cache.seasons[seasonId];
s.playerDraftPicks = players.map((p, i) => ({ participantId: team.id, playerId: p.id, pickNumber: i + 1 }));
s.draftComplete = true;
sandbox.FirebaseSync.save(cache);

AdminActions.initializeRostersFromDraft(seasonId);

check('Test 1: original picks #1-2 are classified RED', () => {
  const roster = LeagueData.getCurrentRoster(seasonId, team.id);
  assertEqual(roster[0].classification, 'RED', 'pick #1 should be RED');
  assertEqual(roster[1].classification, 'RED', 'pick #2 should be RED');
});

check('Test 2: original picks #3-5 are classified YELLOW', () => {
  const roster = LeagueData.getCurrentRoster(seasonId, team.id);
  assertEqual(roster[2].classification, 'YELLOW', 'pick #3 should be YELLOW');
  assertEqual(roster[4].classification, 'YELLOW', 'pick #5 should be YELLOW');
});

check('Test 3: pick #6 and later have no classification', () => {
  const roster = LeagueData.getCurrentRoster(seasonId, team.id);
  assertEqual(roster[5].classification, null, 'pick #6 should have no classification');
});

check('Test 4: getRosterSummary (what both roster UIs read) carries classification through', () => {
  const summary = LeagueData.getRosterSummary(seasonId);
  const teamSummary = summary.find((r) => r.participant.id === team.id);
  assertEqual(teamSummary.rosterEntries[0].classification, 'RED', 'summary entry should carry classification');
});

check('Test 5: classification survives a manual replace at a RED slot (pick #1)', () => {
  const replacement = AdminActions.addPlayer({ name: 'Replacement for Pick 1', position: 'SF', overall: 85, pool: 'green' });
  AdminActions.manualReplacePlayerOnRoster(seasonId, team.id, players[0].id, replacement.id);
  const roster = LeagueData.getCurrentRoster(seasonId, team.id);
  const entry = roster.find((e) => e.playerId === replacement.id);
  assertEqual(entry.classification, 'RED', 'the replacement should inherit the RED classification of the slot');
  assertEqual(entry.draftSlot, 1, 'and should still show Pick #1');
});

check('Test 6: an isJoker entry always classifies as PINK regardless of its original pick color', () => {
  const cache2 = sandbox.FirebaseSync.getCache();
  const roster = cache2.seasons[seasonId].currentRosters[team.id];
  const entry = roster.find((e) => e.draftSlot === 3); // a YELLOW slot
  entry.isJoker = true;
  entry.jokerPosition = 'SF';
  sandbox.FirebaseSync.save(cache2);
  const enriched = LeagueData.getCurrentRoster(seasonId, team.id).find((e) => e.draftSlot === 3);
  assertEqual(enriched.classification, 'PINK', 'a Joker always shows PINK, overriding RED/YELLOW');
});

check('Test 7: an "empty" vacancy entry has no classification', () => {
  AdminActions.manualRemovePlayerFromRoster(seasonId, team.id, players[3].id); // pick #4 (YELLOW)
  const roster = LeagueData.getCurrentRoster(seasonId, team.id);
  const emptyEntry = roster.find((e) => e.source === 'empty');
  assertEqual(emptyEntry.classification, null, 'an empty vacancy has no classification');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail > 0 ? 1 : 0;
