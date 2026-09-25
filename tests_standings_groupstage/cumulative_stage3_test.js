'use strict';
/**
 * Verifies Group Stage Round 3 cumulative standings:
 * Stage 3 must display Stage 1 + Stage 2 + Stage 3 W/L/+/- in the new
 * Round 3 group, while earlier stages remain scoped to their own stage.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'data.js'), 'utf8');

function makeSandbox(seasonData) {
  const doc = { exists: true, data: () => seasonData, metadata: { hasPendingWrites: false } };
  const sandbox = { console, firebase: { firestore: () => ({
    collection: () => ({ doc: () => ({
      onSnapshot: (onNext) => { onNext(doc); return () => {}; },
      set: () => Promise.resolve(),
    }) }),
    enablePersistence: () => Promise.resolve(),
  }) } };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'data.js' });
  vm.runInContext('this.FirebaseSync = FirebaseSync; this.LeagueData = LeagueData;', sandbox);
  sandbox.FirebaseSync.init();
  return sandbox.LeagueData;
}
function matchup(overrides) {
  return { id: 'm_' + Math.random().toString(36).slice(2), teamA: null, teamB: null,
    scoreA: null, scoreB: null, winner: null, status: 'completed', streamer: null,
    stage: null, group: null, ...overrides };
}
const season = {
  settings: { currentSeasonId: 's' }, players: {},
  seasons: { s: {
    id: 's', participants: Object.fromEntries(['mix','jeff','ham','mac','x','y'].map(id => [id, {id, name:id}])),
    teamAssignmentOrder: ['mix','jeff','ham','mac','x','y'],
    nbaTeamAssignments: {mix:'NYK',jeff:'PHI',ham:'OKC',mac:'IND',x:'BOS',y:'HOU'},
    scheduleFormat: 'groupStage',
    groupStageState: {
      stage: 3,
      groups: {A:['mix','jeff','ham','mac'],B:[],C:[],D:[]},
      round1Standings: {A:['mix','jeff','ham','mac'],B:[],C:[],D:[]},
      round2Groups: {A:[],B:['mix','jeff','x','y'],C:[],D:[]},
      round3Groups: {A:[],B:[],C:['mix','jeff','x','y'],D:[]},
    },
    schedule: [
      {round:1, matchups:[
        matchup({stage:1,group:'A',teamA:'mix',teamB:'jeff',scoreA:110,scoreB:100,winner:'mix'}),
        matchup({stage:1,group:'A',teamA:'mix',teamB:'ham',scoreA:105,scoreB:95,winner:'mix'}),
        matchup({stage:1,group:'A',teamA:'mix',teamB:'mac',scoreA:100,scoreB:95,winner:'mix'}),
      ]},
      {round:2, matchups:[
        matchup({stage:2,group:'B',teamA:'mix',teamB:'x',scoreA:110,scoreB:100,winner:'mix'}),
        matchup({stage:2,group:'B',teamA:'mix',teamB:'y',scoreA:108,scoreB:100,winner:'mix'}),
      ]},
      {round:3, matchups:[
        matchup({stage:3,group:'C',teamA:'mix',teamB:'x',scoreA:105,scoreB:100,winner:'mix'}),
        matchup({stage:3,group:'C',teamA:'mix',teamB:'y',scoreA:100,scoreB:102,winner:'y'}),
      ]},
    ],
  } }
};
const ld = makeSandbox(season);
const s1 = ld.getGroupStageStandings('s', 1).A.find(r => r.participantId === 'mix');
assert.strictEqual(s1.wins, 3); assert.strictEqual(s1.losses, 0); assert.strictEqual(s1.pointDifferential, 25);
const s2 = ld.getGroupStageStandings('s', 2).B.find(r => r.participantId === 'mix');
assert.strictEqual(s2.wins, 5); assert.strictEqual(s2.losses, 0); assert.strictEqual(s2.pointDifferential, 43);
const s3 = ld.getGroupStageStandings('s', 3).C.find(r => r.participantId === 'mix');
assert.strictEqual(s3.wins, 6); assert.strictEqual(s3.losses, 1); assert.strictEqual(s3.pointDifferential, 46);
console.log('All Stage 3 cumulative tests passed.');
