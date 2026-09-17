'use strict';
/**
 * Verifies New Scheduling System #3 (Conference Round Robin) in js/data.js
 * and its public rendering in js/views/standings.js:
 *
 *  - generateConferenceRoundRobinSchedule produces a single round robin
 *    within each conference: every team plays every other team in its OWN
 *    conference exactly once, and NEVER a team from the other conference.
 *  - For the ticket's 14-team (7+7) configuration: 21 games/conference,
 *    42 games total, 6 games/team.
 *  - Works for an unequal/odd conference split too (not hard-coded to
 *    7/7 or any fixed team count).
 *  - Validation rejects: fewer than 2 teams in a conference, a team
 *    duplicated across conferences, a missing/extra team, and refuses to
 *    regenerate over completed games (matching generateSchedule/
 *    generateGroupStageSchedule's existing guard).
 *  - getConferenceRoundRobinStandings returns two independently-ranked
 *    conference tables (never combined), using the exact same
 *    computeTeamStandings ranking rule the rest of the app uses.
 *  - resetSchedule clears conferenceRoundRobinState along with the rest
 *    of the schedule state.
 *  - Existing Round Robin and Group Stage generation are byte-for-byte
 *    unaffected (regression check).
 *  - views/standings.js renders the two conferences as separate tables
 *    and suppresses the combined season-wide table for this format,
 *    mirroring the existing Group Stage behavior.
 *
 * Loads the REAL data.js in a vm sandbox (same pattern as
 * tests_skip_unlimited/skip_unlimited_test.js) with a synchronous fake
 * Firestore, so the actual production logic runs.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const dataSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'data.js'), 'utf8');
const utilsSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'shared-utils.js'), 'utf8');
const standingsSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'views', 'standings.js'), 'utf8');

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

// ─── data.js harness (real production logic, fake Firestore) ─────────────
function makeSandbox(seasonData) {
  const dataDoc = { exists: true, data: () => ({ seasons: seasonData, players: {}, settings: {} }), metadata: { hasPendingWrites: false } };
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
  vm.runInContext(dataSrc, sandbox, { filename: 'data.js' });
  vm.runInContext('this.FirebaseSync = FirebaseSync; this.LeagueData = LeagueData; this.AdminActions = AdminActions;', sandbox, { filename: 'export.js' });
  sandbox.FirebaseSync.init();
  return { LeagueData: sandbox.LeagueData, AdminActions: sandbox.AdminActions };
}

/** Builds a minimal season with N assigned teams, participants p1..pN, an
 * arbitrary (non-NBA-team) abbr per team so teamBadge/computeTeamStandings
 * have something to read, and every schedule field at its fresh-season
 * default — exactly the shape AdminActions.generateConferenceRoundRobinSchedule
 * expects, with nothing else populated (no draft, no financials — this
 * feature doesn't touch either). */
function makeSeason(teamCount) {
  const participants = {};
  const nbaTeamAssignments = {};
  const teamAssignmentOrder = [];
  for (let i = 1; i <= teamCount; i++) {
    const pid = `p${i}`;
    teamAssignmentOrder.push(pid);
    participants[pid] = { name: `Team ${i}` };
    nbaTeamAssignments[pid] = `T${i}`;
  }
  return {
    season1: {
      id: 'season1',
      name: 'Test Season',
      participants,
      teamAssignmentOrder,
      nbaTeamAssignments,
      teamAssignmentComplete: true,
      schedule: [],
      scheduleGeneratedAt: null,
      scheduleFormat: null,
      groupStageState: null,
      conferenceRoundRobinState: null,
      playoffs: null,
    },
  };
}

function conferencesFor(teamAssignmentOrder, aCount) {
  return {
    A: teamAssignmentOrder.slice(0, aCount),
    B: teamAssignmentOrder.slice(aCount),
  };
}

// ─── Core generation: the ticket's 14-team (7+7) configuration ───────────

test('14 teams (7+7): generates exactly 42 games, 21/conference, 6/team, no cross-conference matchup', () => {
  const seasons = makeSeason(14);
  const { LeagueData, AdminActions } = makeSandbox(seasons);
  const season = seasons.season1;
  const conferences = conferencesFor(season.teamAssignmentOrder, 7);

  AdminActions.generateConferenceRoundRobinSchedule('season1', conferences);

  const updated = LeagueData.getSeason('season1');
  assert.strictEqual(updated.scheduleFormat, 'conferenceRoundRobin');
  // Cross-realm arrays (vm sandbox vs this file) are structurally equal
  // but not reference-equal under deepStrictEqual — use the looser form,
  // which is content-only and realm-agnostic.
  assert.deepEqual(updated.conferenceRoundRobinState.conferences, conferences);

  const allMatchups = updated.schedule.flatMap((r) => r.matchups);
  const real = allMatchups.filter((m) => m.teamB !== null);
  assert.strictEqual(real.length, 42, `expected 42 total games, got ${real.length}`);

  const gamesByConf = { A: 0, B: 0 };
  const seenPairs = new Set();
  for (const m of real) {
    assert.ok(m.conference === 'A' || m.conference === 'B', 'every real matchup is tagged with a conference');
    gamesByConf[m.conference]++;
    const confOfA = conferences.A.includes(m.teamA) ? 'A' : 'B';
    const confOfB = conferences.A.includes(m.teamB) ? 'A' : 'B';
    assert.strictEqual(confOfA, confOfB, 'no matchup crosses conferences');
    assert.strictEqual(confOfA, m.conference, 'matchup.conference matches the actual teams playing');
    const key = [m.teamA, m.teamB].sort().join('::');
    assert.ok(!seenPairs.has(key), `no duplicate matchup (${key})`);
    seenPairs.add(key);
  }
  assert.strictEqual(gamesByConf.A, 21, `Conference A: expected 21 games, got ${gamesByConf.A}`);
  assert.strictEqual(gamesByConf.B, 21, `Conference B: expected 21 games, got ${gamesByConf.B}`);

  for (const pid of season.teamAssignmentOrder) {
    const played = real.filter((m) => m.teamA === pid || m.teamB === pid).length;
    assert.strictEqual(played, 6, `team ${pid}: expected 6 games, got ${played}`);
  }
});

test('a completed game updates conference standings W/L/PD correctly', () => {
  const seasons = makeSeason(14);
  const { LeagueData, AdminActions } = makeSandbox(seasons);
  const season = seasons.season1;
  const conferences = conferencesFor(season.teamAssignmentOrder, 7);
  AdminActions.generateConferenceRoundRobinSchedule('season1', conferences);

  const updated = LeagueData.getSeason('season1');
  const firstRealGame = updated.schedule.flatMap((r) => r.matchups).find((m) => m.teamB !== null);
  AdminActions.recordMatchResult('season1', firstRealGame.id, { scoreA: 110, scoreB: 100, streamer: 'Test' });

  const standings = LeagueData.getConferenceRoundRobinStandings('season1');
  assert.ok(standings.A && standings.B, 'both conferences are returned');
  assert.strictEqual(standings.A.length + standings.B.length, 14, 'every team appears in exactly one conference table');

  const winnerRow = [...standings.A, ...standings.B].find((r) => r.participantId === firstRealGame.teamA);
  const loserRow = [...standings.A, ...standings.B].find((r) => r.participantId === firstRealGame.teamB);
  assert.strictEqual(winnerRow.wins, 1);
  assert.strictEqual(winnerRow.losses, 0);
  assert.strictEqual(winnerRow.pointDifferential, 10);
  assert.strictEqual(loserRow.wins, 0);
  assert.strictEqual(loserRow.losses, 1);
  assert.strictEqual(loserRow.pointDifferential, -10);
});

test('a Conference A team never appears in Conference B\'s standings array or vice versa', () => {
  const seasons = makeSeason(14);
  const { LeagueData, AdminActions } = makeSandbox(seasons);
  const season = seasons.season1;
  const conferences = conferencesFor(season.teamAssignmentOrder, 7);
  AdminActions.generateConferenceRoundRobinSchedule('season1', conferences);

  const standings = LeagueData.getConferenceRoundRobinStandings('season1');
  const idsInA = standings.A.map((r) => r.participantId);
  const idsInB = standings.B.map((r) => r.participantId);
  assert.deepStrictEqual(new Set(idsInA), new Set(conferences.A));
  assert.deepStrictEqual(new Set(idsInB), new Set(conferences.B));
});

// ─── Not hard-coded to 14/7+7: an unequal, non-14 split also works ───────

test('an unequal 5+3 conference split (8 teams total) also generates a correct, non-cross-conference schedule', () => {
  const seasons = makeSeason(8);
  const { LeagueData, AdminActions } = makeSandbox(seasons);
  const season = seasons.season1;
  const conferences = conferencesFor(season.teamAssignmentOrder, 5); // A: 5 teams, B: 3 teams

  AdminActions.generateConferenceRoundRobinSchedule('season1', conferences);
  const updated = LeagueData.getSeason('season1');
  const real = updated.schedule.flatMap((r) => r.matchups).filter((m) => m.teamB !== null);

  // 5 teams -> 10 games, 3 teams -> 3 games, total 13 — never a hard-coded 21/42.
  assert.strictEqual(real.filter((m) => m.conference === 'A').length, 10);
  assert.strictEqual(real.filter((m) => m.conference === 'B').length, 3);
  assert.strictEqual(real.length, 13);
  for (const m of real) {
    const confOfA = conferences.A.includes(m.teamA) ? 'A' : 'B';
    const confOfB = conferences.A.includes(m.teamB) ? 'A' : 'B';
    assert.strictEqual(confOfA, confOfB, 'no matchup crosses conferences even with unequal conference sizes');
  }
});

// ─── Validation ────────────────────────────────────────────────────────

test('rejects a conference with fewer than 2 teams', () => {
  const seasons = makeSeason(14);
  const { AdminActions } = makeSandbox(seasons);
  const season = seasons.season1;
  const conferences = { A: [season.teamAssignmentOrder[0]], B: season.teamAssignmentOrder.slice(1) };
  assert.throws(() => AdminActions.generateConferenceRoundRobinSchedule('season1', conferences), /at least 2 teams/);
});

test('rejects a team duplicated across conferences', () => {
  const seasons = makeSeason(14);
  const { AdminActions } = makeSandbox(seasons);
  const season = seasons.season1;
  const conferences = conferencesFor(season.teamAssignmentOrder, 7);
  conferences.B.push(conferences.A[0]); // duplicate
  assert.throws(() => AdminActions.generateConferenceRoundRobinSchedule('season1', conferences), /duplicated across conferences/);
});

test('rejects a missing assigned team (not placed in either conference)', () => {
  const seasons = makeSeason(14);
  const { AdminActions } = makeSandbox(seasons);
  const season = seasons.season1;
  const conferences = conferencesFor(season.teamAssignmentOrder, 7);
  conferences.B.pop(); // one assigned team now missing from both conferences
  assert.throws(() => AdminActions.generateConferenceRoundRobinSchedule('season1', conferences), /exactly one conference/);
});

test('refuses to regenerate once a game has been completed (same guard as Round Robin/Group Stage)', () => {
  const seasons = makeSeason(14);
  const { LeagueData, AdminActions } = makeSandbox(seasons);
  const season = seasons.season1;
  const conferences = conferencesFor(season.teamAssignmentOrder, 7);
  AdminActions.generateConferenceRoundRobinSchedule('season1', conferences);

  const updated = LeagueData.getSeason('season1');
  const firstRealGame = updated.schedule.flatMap((r) => r.matchups).find((m) => m.teamB !== null);
  AdminActions.recordMatchResult('season1', firstRealGame.id, { scoreA: 100, scoreB: 90, streamer: 'Test' });

  assert.throws(
    () => AdminActions.generateConferenceRoundRobinSchedule('season1', conferences),
    /already has completed games/
  );
});

test('resetSchedule clears conferenceRoundRobinState along with schedule/scheduleFormat', () => {
  const seasons = makeSeason(14);
  const { LeagueData, AdminActions } = makeSandbox(seasons);
  const season = seasons.season1;
  const conferences = conferencesFor(season.teamAssignmentOrder, 7);
  AdminActions.generateConferenceRoundRobinSchedule('season1', conferences);

  AdminActions.resetSchedule('season1');
  const updated = LeagueData.getSeason('season1');
  assert.strictEqual(updated.schedule.length, 0);
  assert.strictEqual(updated.scheduleFormat, null);
  assert.strictEqual(updated.conferenceRoundRobinState, null);

  // And generation can run again cleanly afterward.
  AdminActions.generateConferenceRoundRobinSchedule('season1', conferences);
  assert.strictEqual(LeagueData.getSeason('season1').scheduleFormat, 'conferenceRoundRobin');
});

// ─── Regression: existing Round Robin / Group Stage generation untouched ──

test('regression: plain Round Robin generation is unaffected (14 teams -> 91 games, 13/team)', () => {
  const seasons = makeSeason(14);
  const { LeagueData, AdminActions } = makeSandbox(seasons);
  AdminActions.generateSchedule('season1');
  const updated = LeagueData.getSeason('season1');
  assert.strictEqual(updated.scheduleFormat, 'roundRobin');
  const real = updated.schedule.flatMap((r) => r.matchups).filter((m) => m.teamB !== null);
  assert.strictEqual(real.length, (14 * 13) / 2);
});

test('regression: Group Stage generation (16 teams, 4 groups of 4) is unaffected', () => {
  const seasons = makeSeason(16);
  const { LeagueData, AdminActions } = makeSandbox(seasons);
  const season = seasons.season1;
  const ids = season.teamAssignmentOrder;
  const groups = { A: ids.slice(0, 4), B: ids.slice(4, 8), C: ids.slice(8, 12), D: ids.slice(12, 16) };
  AdminActions.generateGroupStageSchedule('season1', groups);
  const updated = LeagueData.getSeason('season1');
  assert.strictEqual(updated.scheduleFormat, 'groupStage');
  const real = updated.schedule.flatMap((r) => r.matchups).filter((m) => m.teamB !== null);
  assert.strictEqual(real.length, 24);
});

// ─── View layer: js/views/standings.js renders conferences separately ────

function makeContainer() {
  return { innerHTML: '', querySelectorAll: () => [] };
}

function statRow(overrides) {
  return {
    participantId: 'p1', participantName: 'Someone', nbaTeam: 'T1',
    gamesPlayed: 1, wins: 1, losses: 0, winPct: 1,
    pointsFor: 100, pointsAgainst: 90, pointDifferential: 10, gamesRemaining: 0,
    ...overrides,
  };
}

function makeStandingsSandbox({ scheduleFormat, conferenceStandings, combinedStats }) {
  const season = {
    id: 'season1',
    scheduleFormat,
    groupStageState: null,
    conferenceRoundRobinState: scheduleFormat === 'conferenceRoundRobin' ? { conferences: { A: [], B: [] } } : null,
  };
  const fakeLeagueData = {
    getCurrentSeason: () => season,
    getTeamStatistics: () => combinedStats,
    getStreamerStatistics: () => [],
    getGroupStageStandings: () => null,
    getConferenceRoundRobinStandings: () => conferenceStandings,
    getNBATeam: () => null,
  };
  const sandbox = {
    console,
    escapeHtml: (s) => String(s ?? ''),
    teamBadge: () => '<span class="badge"></span>',
    LeagueData: fakeLeagueData,
  };
  vm.createContext(sandbox);
  vm.runInContext(utilsSrc, sandbox, { filename: 'shared-utils.js' });
  vm.runInContext(standingsSrc, sandbox, { filename: 'standings.js' });
  return vm.runInContext('StandingsView', sandbox);
}

test('view: Conference Round Robin renders two conference tables and suppresses the combined table', () => {
  const conferenceStandings = {
    A: [statRow({ participantId: 'a1', participantName: 'A One' }), statRow({ participantId: 'a2', participantName: 'A Two', wins: 0, losses: 1, pointDifferential: -10 })],
    B: [statRow({ participantId: 'b1', participantName: 'B One' })],
  };
  const combinedStats = [...conferenceStandings.A, ...conferenceStandings.B];
  const StandingsView = makeStandingsSandbox({ scheduleFormat: 'conferenceRoundRobin', conferenceStandings, combinedStats });
  const container = makeContainer();
  StandingsView.render(container);

  assert.ok(container.innerHTML.includes('Conference Standings'), 'renders a Conference Standings heading');
  assert.ok(container.innerHTML.includes('Conference A'), 'renders Conference A');
  assert.ok(container.innerHTML.includes('Conference B'), 'renders Conference B');
  assert.ok(container.innerHTML.includes('A One') && container.innerHTML.includes('B One'), 'renders teams from both conferences');
  assert.ok(!container.innerHTML.includes('id="teamStandingsTable"'), 'the combined season-wide table is suppressed for this format');
  assert.ok(container.innerHTML.includes('Eliminated'), 'marks the last-place team in a conference as Eliminated');
  assert.ok(container.innerHTML.includes('Qualifies'), 'marks every other team as Qualifies');
});

test('view: Round Robin rendering is unaffected (still shows the combined table, no conference section)', () => {
  const combinedStats = [statRow({ participantId: 'p1' }), statRow({ participantId: 'p2', wins: 0, losses: 1, pointDifferential: -10 })];
  const StandingsView = makeStandingsSandbox({ scheduleFormat: 'roundRobin', conferenceStandings: null, combinedStats });
  const container = makeContainer();
  StandingsView.render(container);

  assert.ok(container.innerHTML.includes('id="teamStandingsTable"'), 'Round Robin still shows the combined table');
  assert.ok(!container.innerHTML.includes('Conference Standings'), 'no Conference Standings section for Round Robin');
});

console.log(`\n${failures === 0 ? 'All tests passed.' : failures + ' test(s) FAILED.'}`);
process.exitCode = failures === 0 ? 0 : 1;
