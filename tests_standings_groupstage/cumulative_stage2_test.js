'use strict';
/**
 * Verifies the Stage 2 "carry forward" revision to
 * LeagueData.getGroupStageStandings(seasonId, stage) in js/data.js.
 *
 * Loads the REAL data.js source in a vm sandbox (same pattern as this
 * repo's other data.js-backed suites) with a minimal synchronous fake
 * Firestore, so the actual computeTeamStandings/getGroupStageStandings
 * logic runs unmodified — not a reimplementation of it.
 *
 * Scenario mirrors the spec's own worked example:
 *   Stage 1, Group A: Mix goes 3-0, +25 (beats Jeff, Ham, Mac).
 *   Stage 2, Group B: Mix is regrouped with Jeff, X, Y and goes 2-0, +18.
 *   Expected DISPLAYED Stage 2 Group B record for Mix: 5-0, +43.
 * Also checks Stage 1 Group A standings are completely unaffected
 * (Stage-1-only), and that a team with no Stage 1 record (X) still shows
 * correctly (0-0 carried forward, cumulative == Stage 2 only for them).
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'data.js'), 'utf8');

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

function makeSandbox(seasonData) {
  const doc = { exists: true, data: () => seasonData, metadata: { hasPendingWrites: false } };
  const sandbox = {
    console,
    firebase: {
      firestore: () => ({
        collection: () => ({
          doc: () => ({
            onSnapshot: (onNext) => { onNext(doc); return () => {}; },
            set: () => Promise.resolve(),
          }),
        }),
        enablePersistence: () => Promise.resolve(),
      }),
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'data.js' });
  vm.runInContext('this.FirebaseSync = FirebaseSync; this.LeagueData = LeagueData;', sandbox, { filename: 'export.js' });
  sandbox.FirebaseSync.init();
  return sandbox.LeagueData;
}

function matchup(overrides) {
  return {
    id: 'm_' + Math.random().toString(36).slice(2),
    teamA: null, teamB: null, scoreA: null, scoreB: null,
    winner: null, status: 'completed', streamer: null,
    stage: null, group: null,
    ...overrides,
  };
}

// ─── Fixture: mirrors the spec's own worked example ──────────────────────
const seasonFixture = {
  settings: { currentSeasonId: 'season1' },
  players: {},
  seasons: {
    season1: {
      id: 'season1',
      createdAt: '2026-01-01',
      participants: {
        mix: { id: 'mix', name: 'Mix' },
        jeff: { id: 'jeff', name: 'Jeff' },
        ham: { id: 'ham', name: 'Ham' },
        mac: { id: 'mac', name: 'Mac' },
        x: { id: 'x', name: 'X' },
        y: { id: 'y', name: 'Y' },
      },
      teamAssignmentOrder: ['mix', 'jeff', 'ham', 'mac', 'x', 'y'],
      nbaTeamAssignments: { mix: 'NYK', jeff: 'PHI', ham: 'OKC', mac: 'IND', x: 'BOS', y: 'HOU' },
      scheduleFormat: 'groupStage',
      groupStageState: {
        stage: 2,
        groups: { A: ['mix', 'jeff', 'ham', 'mac'], B: [], C: [], D: [] },
        round1Standings: null,
        round2Groups: { A: [], B: ['mix', 'jeff', 'x', 'y'], C: [], D: [] },
      },
      schedule: [
        {
          round: 1,
          matchups: [
            // Stage 1, Group A — Mix goes 3-0, +25
            matchup({ stage: 1, group: 'A', teamA: 'mix', teamB: 'jeff', scoreA: 110, scoreB: 100, winner: 'mix' }),
            matchup({ stage: 1, group: 'A', teamA: 'mix', teamB: 'ham', scoreA: 105, scoreB: 95, winner: 'mix' }),
            matchup({ stage: 1, group: 'A', teamA: 'mix', teamB: 'mac', scoreA: 100, scoreB: 95, winner: 'mix' }),
            // filler so Jeff/Ham/Mac aren't undefeated-looking by omission
            matchup({ stage: 1, group: 'A', teamA: 'jeff', teamB: 'ham', scoreA: 90, scoreB: 88, winner: 'jeff' }),
          ],
        },
        {
          round: 2,
          matchups: [
            // Stage 2, Group B (reshuffled) — Mix goes 2-0, +18 in Stage 2
            matchup({ stage: 2, group: 'B', teamA: 'mix', teamB: 'x', scoreA: 110, scoreB: 100, winner: 'mix' }),
            matchup({ stage: 2, group: 'B', teamA: 'mix', teamB: 'y', scoreA: 108, scoreB: 100, winner: 'mix' }),
            matchup({ stage: 2, group: 'B', teamA: 'jeff', teamB: 'x', scoreA: 95, scoreB: 90, winner: 'jeff' }),
          ],
        },
      ],
    },
  },
};

const LeagueData = makeSandbox(seasonFixture);

// ─── Stage 1 must remain Stage-1-only ─────────────────────────────────
test('Stage 1 Group A standings are unaffected (Stage-1-only)', () => {
  const stage1 = LeagueData.getGroupStageStandings('season1', 1);
  const mix = stage1.A.find((r) => r.participantId === 'mix');
  assert.strictEqual(mix.wins, 3, 'Mix should have 3 Stage 1 wins');
  assert.strictEqual(mix.losses, 0, 'Mix should have 0 Stage 1 losses');
  assert.strictEqual(mix.pointDifferential, 25, 'Mix should have +25 Stage 1 PD');
});

// ─── Stage 2 must carry forward Stage 1's record into the new group ───
test('Stage 2 Group B standings carry forward Stage 1 record (cumulative)', () => {
  const stage2 = LeagueData.getGroupStageStandings('season1', 2);
  const mix = stage2.B.find((r) => r.participantId === 'mix');
  assert(mix, 'Mix should appear in Stage 2 Group B (his new group)');
  assert.strictEqual(mix.wins, 5, `expected cumulative 5 wins, got ${mix.wins}`);
  assert.strictEqual(mix.losses, 0, `expected cumulative 0 losses, got ${mix.losses}`);
  assert.strictEqual(mix.pointDifferential, 43, `expected cumulative +43 PD, got ${mix.pointDifferential}`);
});

test('Stage 2 Group B: a teammate with no prior Stage 1 record shows Stage-2-only numbers', () => {
  const stage2 = LeagueData.getGroupStageStandings('season1', 2);
  const x = stage2.B.find((r) => r.participantId === 'x');
  assert(x, 'X should appear in Stage 2 Group B');
  assert.strictEqual(x.wins, 0);
  assert.strictEqual(x.losses, 2); // lost to Mix and to Jeff
  assert.strictEqual(x.pointDifferential, -10 + -5); // -10 vs Mix, -5 vs Jeff
});

test('Stage 2 Group B never pulls in Group A-only Stage 1 opponents (Ham/Mac absent)', () => {
  const stage2 = LeagueData.getGroupStageStandings('season1', 2);
  const ids = stage2.B.map((r) => r.participantId);
  assert(!ids.includes('ham') && !ids.includes('mac'), 'Ham/Mac stayed in Stage 1 Group A, not Stage 2 Group B');
});

test('Stage 2 request returns null when round2Groups does not exist yet (no fabrication)', () => {
  const noStage2Fixture = JSON.parse(JSON.stringify(seasonFixture));
  noStage2Fixture.seasons.season1.groupStageState.stage = 1;
  noStage2Fixture.seasons.season1.groupStageState.round2Groups = null;
  const ld = makeSandbox(noStage2Fixture);
  assert.strictEqual(ld.getGroupStageStandings('season1', 2), null);
});

console.log(failures === 0 ? '\nAll tests passed.' : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
