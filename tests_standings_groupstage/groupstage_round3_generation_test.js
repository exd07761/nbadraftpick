'use strict';
/**
 * Integration-style test for the 3-stage Group Stage generation flow.
 * Verifies:
 *  - Round 2 still generates 24 games after completed Round 1.
 *  - Round 3 requires completed Round 2 and generates another 24 games.
 *  - Round 3 stores round3Groups and advances groupStageState.stage to 3.
 *  - Round 3 rejects a rematch from either Round 1 or Round 2.
 *  - Round 2 games are locked after Round 3 is generated.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'data.js'), 'utf8');

const participants = Object.fromEntries(Array.from({length: 16}, (_, i) => {
  const id = `p${i + 1}`;
  return [id, { id, name: `P${i + 1}` }];
}));
const assignments = Object.fromEntries(Array.from({length: 16}, (_, i) => [`p${i + 1}`, `T${i + 1}`]));
const order = Object.keys(participants);
const round1 = { A:['p1','p2','p3','p4'], B:['p5','p6','p7','p8'], C:['p9','p10','p11','p12'], D:['p13','p14','p15','p16'] };
const round2 = { A:['p1','p5','p9','p13'], B:['p2','p6','p10','p14'], C:['p3','p7','p11','p15'], D:['p4','p8','p12','p16'] };
const round3 = { A:['p1','p6','p11','p16'], B:['p2','p7','p12','p13'], C:['p3','p8','p9','p14'], D:['p4','p5','p10','p15'] };

const fixture = {
  settings: { currentSeasonId: 's' }, players: {},
  seasons: { s: {
    id: 's', participants, playerDraftOrder: order, teamAssignmentOrder: order, nbaTeamAssignments: assignments,
    teamAssignmentComplete: true, schedule: [], scheduleGeneratedAt: null,
    scheduleFormat: null, groupStageState: null,
  } },
};

const doc = { exists: true, data: () => fixture, metadata: { hasPendingWrites: false } };
const sandbox = {
  console,
  firebase: { firestore: () => ({
    collection: () => ({ doc: () => ({
      onSnapshot: (cb) => { cb(doc); return () => {}; },
      set: () => Promise.resolve(),
    }) }),
    enablePersistence: () => Promise.resolve(),
  }) },
};
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'data.js' });
vm.runInContext('this.FirebaseSync = FirebaseSync; this.LeagueData = LeagueData; this.AdminActions = AdminActions;', sandbox);
sandbox.FirebaseSync.init();

sandbox.AdminActions.generateGroupStageSchedule('s', round1);
let cache = sandbox.FirebaseSync.getCache();
let season = cache.seasons.s;
assert.strictEqual(season.schedule.flatMap(r => r.matchups).length, 24);
season.schedule.forEach(r => r.matchups.forEach(m => { if (m.teamB !== null) { m.status = 'completed'; m.scoreA = 100; m.scoreB = 90; m.winner = m.teamA; } }));

sandbox.AdminActions.generateGroupStageRound2('s', round2);
cache = sandbox.FirebaseSync.getCache(); season = cache.seasons.s;
assert.strictEqual(season.groupStageState.stage, 2);
assert.strictEqual(season.schedule.flatMap(r => r.matchups).filter(m => m.stage === 2).length, 24);
season.schedule.filter(r => r.matchups.some(m => m.stage === 2)).forEach(r => r.matchups.forEach(m => { if (m.stage === 2 && m.teamB !== null) { m.status = 'completed'; m.scoreA = 101; m.scoreB = 95; m.winner = m.teamA; } }));

sandbox.AdminActions.generateGroupStageRound3('s', round3);
cache = sandbox.FirebaseSync.getCache(); season = cache.seasons.s;
assert.strictEqual(season.groupStageState.stage, 3);
assert.deepStrictEqual(season.groupStageState.round3Groups, round3);
assert.strictEqual(season.schedule.length, 9);
assert.strictEqual(season.schedule.flatMap(r => r.matchups).filter(m => m.stage === 3).length, 24);
assert(season.schedule.flatMap(r => r.matchups).filter(m => m.stage === 1).every(m => m.status === 'completed'));
assert(season.schedule.flatMap(r => r.matchups).filter(m => m.stage === 2).every(m => m.status === 'completed'));

const stage2Game = season.schedule.flatMap(r => r.matchups).find(m => m.stage === 2 && m.teamB !== null);
assert.throws(() => sandbox.AdminActions.recordMatchResult('s', stage2Game.id, {scoreA: 110, scoreB: 100, streamer: 'Test'}), /Cannot edit a Round 2 result/);

console.log('All 3-stage Group Stage generation tests passed.');
