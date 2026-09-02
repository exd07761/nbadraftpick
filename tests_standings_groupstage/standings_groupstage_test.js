'use strict';
/**
 * Verifies the Group Stage standings revision to js/views/standings.js:
 *  - Round Robin rendering is byte-for-byte unchanged (full table + cards).
 *  - Group Stage rendering shows Stage 1 AND Stage 2 (once it exists),
 *    each with 4 independent Group tables (#, Team, W, L, +/-).
 *  - Group Stage does NOT render the season-wide combined table/cards.
 *  - getGroupStageStandings is called once per stage and the view uses
 *    exactly what it returns (scoping itself is data.js's job, already
 *    covered by its own doc comments/tests — this suite is about the view).
 *  - A Group Stage season with no Stage 2 data yet renders Stage 1 only,
 *    nothing fabricated.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

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
    console.log(`    ${e.message}`);
  }
}

// ─── Minimal fake container (just needs to accept innerHTML) ─────────────
function makeContainer() {
  return { innerHTML: '' };
}

// ─── Fixtures ──────────────────────────────────────────────────────────
const NBA_TEAMS_BY_ABBR = {
  NYK: { abbr: 'NYK', name: 'Knicks', color: '#000', colorAlt: '#000', logo: null },
  PHI: { abbr: 'PHI', name: '76ers', color: '#000', colorAlt: '#000', logo: null },
};

function statRow(overrides) {
  return {
    participantId: 'p1', participantName: 'Someone', nbaTeam: 'NYK',
    gamesPlayed: 3, wins: 2, losses: 1, winPct: 0.667,
    pointsFor: 300, pointsAgainst: 270, pointDifferential: 30, gamesRemaining: 0,
    ...overrides,
  };
}

function buildLeagueData({ scheduleFormat, hasStage2, groupCallLog }) {
  const season = {
    id: 'season1',
    scheduleFormat,
    groupStageState: scheduleFormat === 'groupStage' ? { stage: hasStage2 ? 2 : 1 } : null,
  };

  return {
    getCurrentSeason: () => season,
    getNBATeam: (abbr) => NBA_TEAMS_BY_ABBR[abbr] || null,
    getTeamStatistics: () => [
      statRow({ participantId: 'p1', participantName: 'Ben D', nbaTeam: 'NYK', winPct: 0.667, pointDifferential: 30 }),
      statRow({ participantId: 'p2', participantName: 'Mikk', nbaTeam: 'PHI', winPct: 0.333, pointDifferential: -10 }),
    ],
    getStreamerStatistics: () => [],
    getGroupStageStandings: (seasonId, stage) => {
      groupCallLog.push(stage);
      if (stage === 2 && !hasStage2) return null; // Stage 2 not generated yet — no fabrication
      const mk = (name, w, l, pd) => statRow({ participantName: name, wins: w, losses: l, pointDifferential: pd });
      return {
        A: [mk(`S${stage}-A-1`, 2, 1, 30), mk(`S${stage}-A-2`, 1, 2, -30)],
        B: [mk(`S${stage}-B-1`, 3, 0, 52)],
        C: [mk(`S${stage}-C-1`, 1, 2, -8)],
        D: [mk(`S${stage}-D-1`, 0, 3, -33)],
      };
    },
  };
}

function render(scenario) {
  const groupCallLog = [];
  const LeagueData = buildLeagueData({ ...scenario, groupCallLog });
  const sandbox = { LeagueData, console };
  vm.createContext(sandbox);
  vm.runInContext(utilsSrc, sandbox, { filename: 'shared-utils.js' });
  vm.runInContext(standingsSrc, sandbox, { filename: 'standings.js' });
  const StandingsView = vm.runInContext('StandingsView', sandbox);
  const container = makeContainer();
  StandingsView.render(container);
  return { html: container.innerHTML, groupCallLog };
}

// ─── Round Robin: must be unaffected ──────────────────────────────────
test('Round Robin still renders the full combined table', () => {
  const { html, groupCallLog } = render({ scheduleFormat: 'roundRobin', hasStage2: false });
  assert(html.includes('id="teamStandingsTable"'), 'expected combined table to be present');
  assert(html.includes('Ben D'), 'expected combined table row for Ben D');
  assert(html.includes('Ranked by Win%, then Point Differential'), 'expected the Round Robin helper text');
  assert.strictEqual(groupCallLog.length, 0, 'Round Robin must never call getGroupStageStandings');
  assert(!html.includes('Group Stage Standings'), 'Round Robin must not show the Group Stage heading');
});

// ─── Group Stage, Stage 1 only (Stage 2 not generated yet) ────────────
test('Group Stage with only Stage 1 data renders Stage 1 groups and skips Stage 2 / combined table', () => {
  const { html, groupCallLog } = render({ scheduleFormat: 'groupStage', hasStage2: false });
  assert.deepStrictEqual(groupCallLog, [1, 2], 'expected the view to ask for both stages');
  assert(/>\s*Stage 1\s*</.test(html), 'expected a Stage 1 heading');
  assert(!/>\s*Stage 2\s*</.test(html), 'Stage 2 heading must not render when it has no data (no fabrication)');
  assert(html.includes('S1-A-1') && html.includes('S1-D-1'), 'expected all 4 Stage-1 groups');
  assert(!html.includes('S2-A-1'), 'Stage 2 group rows must not be fabricated');
  assert(!html.includes('id="teamStandingsTable"'), 'Group Stage must not render the season-wide combined table');
  assert(!html.includes('Ranked by Win%, then Point Differential'), 'combined-table helper text must not render for Group Stage');
});

// ─── Group Stage, both stages generated ───────────────────────────────
test('Group Stage with both stages renders Stage 1 AND Stage 2, each with 4 groups', () => {
  const { html, groupCallLog } = render({ scheduleFormat: 'groupStage', hasStage2: true });
  assert.deepStrictEqual(groupCallLog, [1, 2]);
  assert(html.includes('Stage 1') && html.includes('Stage 2'), 'expected both stage headings');
  for (const g of ['A', 'B', 'C', 'D']) {
    assert(html.includes(`S1-${g}-1`), `expected Stage 1 Group ${g}`);
    assert(html.includes(`S2-${g}-1`), `expected Stage 2 Group ${g}`);
  }
  // Column headers per the spec: # | Team | W | L | +/-
  assert(html.includes('<th>#</th><th>Team</th><th>W</th><th>L</th><th>+/-</th>'), 'expected the exact requested column set');
  assert(!html.includes('id="teamStandingsTable"'), 'Group Stage must not render the season-wide combined table');
  // Two-groups-per-row desktop grid, one column on mobile (css/main.css .group-stage-grid)
  const gridCount = (html.match(/class="group-stage-grid"/g) || []).length;
  assert.strictEqual(gridCount, 2, 'expected one 2-column group grid per stage (Stage 1 and Stage 2)');
});

console.log(failures === 0 ? '\nAll tests passed.' : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
