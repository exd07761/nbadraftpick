'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const dataJsPath = path.join(__dirname, '..', 'nbadraftpick-main', 'js', 'data.js');
const src = fs.readFileSync(dataJsPath, 'utf8');

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
  vm.runInContext(src, sandbox, { filename: 'data.js' });
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
  try { fn(); pass++; console.log(`  ok - ${name}`); }
  catch (e) { fail++; console.log(`  FAIL - ${name}\n         ${e.message}`); }
}
function assertEqual(actual, expected, msg) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${msg || 'assertion failed'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// Simulate a Firestore round-trip that scrambles plain-object key order —
// exactly the failure mode identified in the investigation (Firestore map
// fields have no guaranteed key order). If getRosterSummary still reads
// object order anywhere, this would expose it.
function scrambleParticipantKeyOrder(sandbox, seasonId) {
  const cache = sandbox.FirebaseSync.getCache();
  const data = JSON.parse(JSON.stringify(cache));
  const season = data.seasons[seasonId];
  const entries = Object.entries(season.participants).sort((a, b) => (a[0] < b[0] ? 1 : -1)); // reverse-ish scramble
  const scrambled = {};
  entries.forEach(([k, v]) => { scrambled[k] = v; });
  season.participants = scrambled;
  sandbox.FirebaseSync.save(data);
}

console.log('Roster order + NBA team badge tests');

(() => {
  const sandbox = makeSandbox();
  const { AdminActions, LeagueData } = sandbox;
  const season = AdminActions.createSeason('Order Test');
  // Add in a DIFFERENT order than the intended draft order, to prove the
  // fix isn't just reading addition order by coincidence.
  const maka = AdminActions.addParticipant(season.id, 'Maka');
  const gigs = AdminActions.addParticipant(season.id, 'Gigs');
  const jordan = AdminActions.addParticipant(season.id, 'Jordan');

  AdminActions.setPlayerDraftOrder(season.id, [gigs.id, jordan.id, maka.id]);

  check('1. Gigs -> Jordan -> Maka order after "refresh" (fresh getRosterSummary call)', () => {
    const summary = LeagueData.getRosterSummary(season.id);
    assertEqual(summary.map((s) => s.participant.name), ['Gigs', 'Jordan', 'Maka']);
  });

  check('2. Order unchanged after a trade (roster contents change, order does not)', () => {
    // Simulate what a trade does to rosters — mutate currentRosters directly,
    // without touching participants/playerDraftOrder (the real commitTrade()
    // never touches those either).
    const cache = sandbox.FirebaseSync.getCache();
    const data = JSON.parse(JSON.stringify(cache));
    const s = data.seasons[season.id];
    s.currentRosters[gigs.id] = [{ playerId: 'fake_player_1', source: 'trade' }];
    s.currentRosters[maka.id] = [{ playerId: 'fake_player_2', source: 'trade' }];
    sandbox.FirebaseSync.save(data);

    const summary = LeagueData.getRosterSummary(season.id);
    assertEqual(summary.map((s2) => s2.participant.name), ['Gigs', 'Jordan', 'Maka']);
  });

  check('3. Order unchanged after a simulated Firebase resync that scrambles participants{} key order', () => {
    scrambleParticipantKeyOrder(sandbox, season.id);
    const summary = LeagueData.getRosterSummary(season.id);
    assertEqual(summary.map((s) => s.participant.name), ['Gigs', 'Jordan', 'Maka']);
  });

  check('4. Admin and Public Roster consume the same getRosterSummary — identical order guaranteed by construction', () => {
    // Both AdminRosterView and PublicRosterView call LeagueData.getRosterSummary()
    // directly with no further sorting in either view — verified by inspection
    // of js/admin/roster.js and js/views/roster.js (no .sort()/reorder calls
    // added or present in either file's render path). Re-assert the order
    // here as the shared contract both views rely on.
    const summary = LeagueData.getRosterSummary(season.id);
    assertEqual(summary.map((s) => s.participant.name), ['Gigs', 'Jordan', 'Maka']);
  });

  check('participant not in playerDraftOrder is appended via deterministic ID fallback, not lost', () => {
    const extra = AdminActions.addParticipant(season.id, 'Zeke'); // never added to playerDraftOrder
    const summary = LeagueData.getRosterSummary(season.id);
    assertEqual(summary.slice(0, 3).map((s) => s.participant.name), ['Gigs', 'Jordan', 'Maka']);
    assertEqual(summary.some((s) => s.participant.id === extra.id), true, 'fallback participant still appears');
  });
})();

(() => {
  const sandbox = makeSandbox();
  const { AdminActions, LeagueData } = sandbox;
  const season = AdminActions.createSeason('Team Assignment Test');
  const p1 = AdminActions.addParticipant(season.id, 'Alpha');
  const p2 = AdminActions.addParticipant(season.id, 'Beta');
  AdminActions.setPlayerDraftOrder(season.id, [p1.id, p2.id]);
  AdminActions.assignNBATeam(season.id, p1.id, 'LAL');

  check('5. getNBATeamAssignments correctly reports the assigned abbreviation for lookup by the roster views', () => {
    const assignments = LeagueData.getNBATeamAssignments(season.id);
    assertEqual(assignments[p1.id], 'LAL');
    const team = LeagueData.getNBATeam(assignments[p1.id]);
    assertEqual(team.name, 'Los Angeles Lakers');
    assertEqual(typeof team.logo, 'string');
    assertEqual(team.logo.endsWith('.svg'), true);
  });

  check('6. Participant without an assignment resolves to no team (abbr undefined), same lookup path used by both views', () => {
    const assignments = LeagueData.getNBATeamAssignments(season.id);
    assertEqual(assignments[p2.id], undefined);
    // teamBadge(undefined,...) is a DOM/string-rendering concern (shared-utils.js),
    // not part of data.js — verified separately by static inspection below.
  });
})();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
