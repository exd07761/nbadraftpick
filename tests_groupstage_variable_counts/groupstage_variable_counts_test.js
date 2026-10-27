'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const context = {
  console,
  escapeHtml: (value) => String(value ?? ''),
  teamBadge: () => '',
  matchupHomeAway: (m) => ({ leftId: m.home || m.teamA, rightId: m.away || m.teamB, leftScore: null, rightScore: null, leftIsWinner: false, rightIsWinner: false, hasHomeCourt: !!m.home }),
  firebase: { firestore: () => ({
    collection: () => ({ doc: () => ({
      onSnapshot: (callback) => { callback({ exists: true, data: () => context.fixture, metadata: { hasPendingWrites: false } }); return () => {}; },
      set: () => Promise.resolve(),
    }) }),
    enablePersistence: () => Promise.resolve(),
  }) },
};
context.window = context;
vm.createContext(context);
const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
vm.runInContext(read('js/data.js'), context, { filename: 'data.js' });
vm.runInContext(read('js/admin/schedule.js'), context, { filename: 'admin/schedule.js' });
vm.runInContext(read('js/views/schedule.js'), context, { filename: 'views/schedule.js' });
vm.runInContext(`
  this.FirebaseSync = FirebaseSync;
  this.AdminActions = AdminActions;
  this.LeagueData = LeagueData;
  this.AdminScheduleView = AdminScheduleView;
  this.ScheduleView = ScheduleView;
`, context);

const groupNames = ['A', 'B', 'C', 'D'];
let syncInitialized = false;
const idsByGroup = (count) => {
  const size = count / 4;
  return Object.fromEntries(groupNames.map((group, gi) => [
    group,
    Array.from({ length: size }, (_, i) => `p${gi * size + i + 1}`),
  ]));
};
const rotatedGroups = (groups) => {
  const size = groups.A.length;
  return Object.fromEntries(groupNames.map((target, targetIndex) => [
    target,
    Array.from({ length: size }, (_, i) => groups[groupNames[(targetIndex + i) % 4]][i]),
  ]));
};

function setup(count) {
  const participants = {};
  const assignments = {};
  const ids = Array.from({ length: count }, (_, i) => `p${i + 1}`);
  ids.forEach((id, i) => {
    participants[id] = { id, name: `Player ${i + 1}` };
    assignments[id] = `T${i + 1}`;
  });
  context.fixture = {
    settings: { currentSeasonId: 'season1' }, players: {},
    seasons: { season1: {
      id: 'season1', name: `Season ${count}`, participants,
      // Deliberately reverse team-assignment order to pin Stage 1 to playerDraftOrder.
      playerDraftOrder: [...ids].reverse(), teamAssignmentOrder: ids,
      nbaTeamAssignments: assignments, teamAssignmentComplete: true,
      schedule: [], scheduleGeneratedAt: null, scheduleFormat: null,
      groupStageState: null,
    } },
  };
  if (!syncInitialized) {
    context.FirebaseSync.init();
    syncInitialized = true;
  } else {
    context.FirebaseSync.save(context.fixture);
  }
  return { ids, groups: idsByGroup(count), size: count / 4 };
}

function completeStage(stage) {
  const season = context.FirebaseSync.getCache().seasons.season1;
  season.schedule.forEach((round) => round.matchups.forEach((matchup) => {
    if (matchup.stage === stage && matchup.teamB !== null) {
      matchup.status = 'completed';
      matchup.scoreA = 100;
      matchup.scoreB = 90;
      matchup.winner = matchup.teamA;
      matchup.streamer = 'Tester';
      matchup.playedAt = new Date().toISOString();
    }
  }));
}

function assertStageShape(rounds, groups, expectedGames, gamesPerTeam, expectedRounds) {
  assert.strictEqual(rounds.length, expectedRounds);
  const allMatchups = rounds.flatMap((round) => round.matchups);
  const real = allMatchups.filter((matchup) => matchup.teamB !== null);
  assert.strictEqual(real.length, expectedGames);
  const pairs = new Set(real.map((m) => [m.teamA, m.teamB].sort().join('|')));
  assert.strictEqual(pairs.size, expectedGames, 'each fixture pair is unique');

  for (const round of rounds) {
    const appearances = round.matchups.flatMap((m) => m.teamB === null ? [m.teamA] : [m.teamA, m.teamB]);
    assert.strictEqual(new Set(appearances).size, appearances.length, 'no team plays twice in a global round');
  }
  for (const [group, teams] of Object.entries(groups)) {
    const groupGames = real.filter((m) => m.group === group);
    assert.strictEqual(groupGames.length, teams.length * (teams.length - 1) / 2);
    for (let i = 0; i < teams.length; i++) {
      assert.strictEqual(groupGames.filter((m) => m.teamA === teams[i] || m.teamB === teams[i]).length, gamesPerTeam);
      for (let j = i + 1; j < teams.length; j++) {
        assert(pairs.has([teams[i], teams[j]].sort().join('|')), 'every within-group pair plays');
      }
    }
  }
  return allMatchups;
}

const expected = new Map([
  [8, [4, 1, 1]], [12, [12, 2, 3]], [16, [24, 3, 3]],
  [20, [40, 4, 5]], [24, [60, 5, 5]], [32, [112, 7, 7]],
]);

for (const count of [8, 12, 16, 20, 24, 32]) {
  const { groups, size } = setup(count);
  context.AdminActions.generateGroupStageSchedule('season1', groups);
  const schedule = context.FirebaseSync.getCache().seasons.season1.schedule;
  const [games, perTeam, rounds] = expected.get(count);
  const stage1 = schedule.filter((round) => round.matchups.some((m) => m.stage === 1));
  const matchups = assertStageShape(stage1, groups, games, perTeam, rounds);
  const expectedByes = size % 2 === 1 ? 4 * rounds : 0;
  assert.strictEqual(matchups.filter((m) => m.teamB === null).length, expectedByes, 'Stage 1 BYE count');
  for (const m of matchups.filter((item) => item.teamB !== null)) {
    const firstIndex = context.fixture.seasons.season1.playerDraftOrder.indexOf(m.teamA);
    const secondIndex = context.fixture.seasons.season1.playerDraftOrder.indexOf(m.teamB);
    assert.strictEqual(m.home, firstIndex < secondIndex ? m.teamA : m.teamB, 'Stage 1 home uses existing playerDraftOrder behavior');
  }

  completeStage(1);
  if (size <= 4) {
    const nextGroups = rotatedGroups(groups);
    const stage2 = context.AdminActions.generateGroupStageRound2('season1', nextGroups);
    const stage2Matchups = assertStageShape(stage2, nextGroups, games, perTeam, rounds);
    assert.strictEqual(stage2Matchups.filter((m) => m.teamB === null).length, expectedByes, 'Stage 2 BYE count');
    assert.strictEqual(stage2[0].round, rounds + 1, 'Stage 2 offset follows the actual Stage 1 round count');
    const stage2Matchup = stage2.flatMap((r) => r.matchups).find((m) => m.teamB !== null);
    assert(stage2Matchup.home && stage2Matchup.away, 'later-stage home court remains assigned');
    const stage1Standings = context.LeagueData.getGroupStageStandings('season1', 1);
    const stage1Stats = Object.fromEntries(groupNames.flatMap((g) => stage1Standings[g]).map((row) => [row.participantId, row]));
    assert(Object.values(stage1Stats).every((row) => row.gamesPlayed === perTeam), 'Stage 1 BYEs do not count as played games');
    const homeA = stage1Stats[stage2Matchup.teamA];
    const homeB = stage1Stats[stage2Matchup.teamB];
    const order = context.FirebaseSync.getCache().seasons.season1.playerDraftOrder;
    const expectedHome = homeA.pointDifferential !== homeB.pointDifferential
      ? (homeA.pointDifferential > homeB.pointDifferential ? stage2Matchup.teamA : stage2Matchup.teamB)
      : homeA.pointsFor !== homeB.pointsFor
        ? (homeA.pointsFor > homeB.pointsFor ? stage2Matchup.teamA : stage2Matchup.teamB)
        : (order.indexOf(stage2Matchup.teamA) < order.indexOf(stage2Matchup.teamB) ? stage2Matchup.teamA : stage2Matchup.teamB);
    assert.strictEqual(stage2Matchup.home, expectedHome, 'later-stage home court follows standings and existing tie-breaks');
    completeStage(2);
    const cumulative2 = context.LeagueData.getGroupStageStandings('season1', 2);
    for (const g of groupNames) {
      assert.strictEqual(cumulative2[g].length, size);
      assert(cumulative2[g].every((row) => row.gamesPlayed === 2 * perTeam), `Stage 2 standings carry Stage 1 games forward: ${count} teams`);
    }
    const stage3 = context.AdminActions.generateGroupStageRound3('season1', groups);
    const stage3Matchups = assertStageShape(stage3, groups, games, perTeam, rounds);
    assert.strictEqual(stage3Matchups.filter((m) => m.teamB === null).length, expectedByes, 'Stage 3 BYE count');
    assert.strictEqual(stage3[0].round, 2 * rounds + 1, 'Stage 3 offset follows both preceding stage lengths');
    const stage1Pairs = new Set(stage1.flatMap((r) => r.matchups).filter((m) => m.teamB !== null).map((m) => [m.teamA, m.teamB].sort().join('|')));
    assert(stage3.flatMap((r) => r.matchups).some((m) => m.teamB !== null && stage1Pairs.has([m.teamA, m.teamB].sort().join('|'))), 'Stage 3 permits prior opponents');
    completeStage(3);
    const cumulative3 = context.LeagueData.getGroupStageStandings('season1', 3);
    assert(groupNames.every((g) => cumulative3[g].every((row) => row.gamesPlayed === 3 * perTeam)), 'Stage 3 standings carry both earlier stages forward');
  } else {
    assert.throws(
      () => context.AdminActions.generateGroupStageRound2('season1', groups),
      /cannot be generated with strict rematch protection/
    );
  }
}

for (const count of [14, 18]) {
  setup(count);
  assert.throws(
    () => context.AdminActions.generateGroupStageSchedule('season1', {}),
    /at least 8 assigned teams and a team count divisible by 4/
  );
}

// Verify Stage 2 is blocked until all real Stage 1 fixtures finish, while BYEs do not block it.
{
  const { groups } = setup(12);
  context.AdminActions.generateGroupStageSchedule('season1', groups);
  const firstReal = context.FirebaseSync.getCache().seasons.season1.schedule.flatMap((r) => r.matchups).find((m) => m.teamB !== null);
  assert.throws(() => context.AdminActions.generateGroupStageRound2('season1', rotatedGroups(groups)), /Round 1 is not yet complete/);
  firstReal.status = 'completed';
  completeStage(1);
  const stage1Byes = context.FirebaseSync.getCache().seasons.season1.schedule.flatMap((r) => r.matchups).filter((m) => m.stage === 1 && m.teamB === null);
  assert(stage1Byes.length > 0 && stage1Byes.every((m) => m.status !== 'completed'), 'BYEs remain unplayed when Stage 1 is complete');
  context.AdminActions.generateGroupStageRound2('season1', rotatedGroups(groups));
  completeStage(2);
  const stage2Byes = context.FirebaseSync.getCache().seasons.season1.schedule.flatMap((r) => r.matchups).filter((m) => m.stage === 2 && m.teamB === null);
  assert(stage2Byes.length > 0 && stage2Byes.every((m) => m.status !== 'completed'), 'BYEs remain unplayed when Stage 2 is complete');
  context.AdminActions.generateGroupStageRound3('season1', groups);
}

// Completed results still prevent regeneration; unsupported counts also render clear admin guidance.
{
  const { groups } = setup(8);
  context.AdminActions.generateGroupStageSchedule('season1', groups);
  completeStage(1);
  assert.throws(() => context.AdminActions.generateGroupStageSchedule('season1', groups), /Cannot regenerate/);
}
{
  const { ids } = setup(14);
  context.AdminScheduleView._pendingGroups = context.AdminScheduleView._autoAssignGroups(context.fixture.seasons.season1);
  const html = context.AdminScheduleView._renderGroupStageSetup(context.fixture.seasons.season1, ids.length);
  assert(html.includes('total divisible by 4'));
}

// Admin/public count calculations follow each supported group size and stage round count.
for (const count of [8, 12, 16, 20, 24, 32]) {
  const { groups, size } = setup(count);
  const config = context.AdminScheduleView._groupStageConfig(count);
  const [games, perTeam, rounds] = expected.get(count);
  assert.strictEqual(config.gamesPerStage, games);
  assert.strictEqual(config.gamesPerTeam, perTeam);
  assert.strictEqual(config.roundsPerStage, rounds);
  const autoGroups = context.AdminScheduleView._autoAssignGroups(context.fixture.seasons.season1);
  assert(groupNames.every((g) => autoGroups[g].length === size));
  context.AdminScheduleView._pendingGroups = autoGroups;
  const adminSetup = context.AdminScheduleView._renderGroupStageSetup(context.fixture.seasons.season1, count);
  assert(adminSetup.includes(`${count} teams → 4 groups of ${size}`));
  assert(adminSetup.includes(`${games} games per stage (${perTeam} games/team/stage)`));
  assert(adminSetup.includes(`across ${size > 4 ? 1 : 3} available stage`));
  assert.strictEqual(adminSetup.includes('Stage 2 and Stage 3 will be unavailable'), size > 4);
  if (size > 4) {
    const laterStage = context.AdminScheduleView._renderLaterRoundAssignment(context.fixture.seasons.season1, 2);
    assert(laterStage.includes(`With ${size} teams per group but only 4 Stage 1 groups`));
    assert(laterStage.includes('every Stage 2 group must repeat at least one Stage 1 opponent'));
    assert(laterStage.includes('disabled'));
  }

  context.AdminActions.generateGroupStageSchedule('season1', groups);
  const season = context.FirebaseSync.getCache().seasons.season1;
  const publicContainer = { innerHTML: '', querySelector: () => ({ addEventListener: () => {} }) };
  context.ScheduleView._selectedRound = 1;
  context.ScheduleView.render(publicContainer);
  assert(publicContainer.innerHTML.includes(`Stage 1 of ${size > 4 ? 1 : 3} — 4 equal groups of ${size}`));
  assert(publicContainer.innerHTML.includes(`${rounds} rounds, ${games} games total, ${perTeam} games/team`));
}

// Later-round admin setup exposes the strict-rematch limitation and expected dynamic slot count.
{
  setup(20);
  const season = context.fixture.seasons.season1;
  context.AdminScheduleView._pendingRound2Groups = null;
  const html = context.AdminScheduleView._renderLaterRoundAssignment(season, 2);
  assert(html.includes('every Stage 2 group must repeat at least one Stage 1 opponent'));
  assert(html.includes('disabled'));
  assert.strictEqual((html.match(/data-later-index=/g) || []).length, 20);
}

console.log('Variable Group Stage scheduler and UI tests passed.');
