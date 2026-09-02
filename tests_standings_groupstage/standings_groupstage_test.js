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
  return { innerHTML: '', querySelectorAll: () => [] };
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

// ─── Mobile revision: collapsible full-width group cards ──────────────
test('Each group renders as a div.group-card with a header + body (no <details>, no leftover colspan header row)', () => {
  const { html } = render({ scheduleFormat: 'groupStage', hasStage2: true });
  assert(!html.includes('<details'), 'must not use native <details> — its closed content cannot be force-shown via CSS (this was the desktop bug)');
  const cardCount = (html.match(/<div class="group-card( is-collapsed)?">/g) || []).length;
  assert.strictEqual(cardCount, 8, 'expected 4 groups × 2 stages = 8 group cards');
  const summaryCount = (html.match(/<div class="group-card-summary"/g) || []).length;
  assert.strictEqual(summaryCount, 8, 'expected one summary header per group card');
  const bodyCount = (html.match(/<div class="group-card-body">/g) || []).length;
  assert.strictEqual(bodyCount, 8, 'expected one body wrapper per group card (this is what .is-collapsed hides, mobile-only)');
  assert(!html.includes('colspan="5"'), 'the old colspan group-name header row should be gone now that the summary div is the header');
});

test('Groups A and B default expanded; Groups C and D default collapsed (per stage) — collapsed still renders the data, just tagged for mobile-only hiding', () => {
  const { html } = render({ scheduleFormat: 'groupStage', hasStage2: true });
  const cardBlocks = html.match(/<div class="group-card( is-collapsed)?">[\s\S]*?<div class="group-card-summary"[^>]*>Group (\w)<\/div>[\s\S]*?<\/div>\s*<\/div>/g) || [];
  // Simpler, robust per-card check: pair each group-card opening tag with its aria-expanded value in document order.
  const cardOpenTags = [...html.matchAll(/<div class="group-card( is-collapsed)?">\s*<div class="group-card-summary" role="button" tabindex="0" aria-expanded="(true|false)">Group (\w)<\/div>/g)];
  assert.strictEqual(cardOpenTags.length, 8, 'expected to find all 8 group card headers');
  for (const m of cardOpenTags) {
    const [, collapsedClass, ariaExpanded, groupLetter] = m;
    if (groupLetter === 'A' || groupLetter === 'B') {
      assert(!collapsedClass, `Group ${groupLetter} should not have .is-collapsed`);
      assert.strictEqual(ariaExpanded, 'true', `Group ${groupLetter} should have aria-expanded="true"`);
    } else {
      assert.strictEqual(collapsedClass, ' is-collapsed', `Group ${groupLetter} should have .is-collapsed`);
      assert.strictEqual(ariaExpanded, 'false', `Group ${groupLetter} should have aria-expanded="false"`);
    }
  }
  // Collapsed groups must still contain their standings data in the markup —
  // .is-collapsed only ever hides via CSS (mobile-only), it never omits data.
  assert(html.includes('S1-C-1') && html.includes('S1-D-1'), 'Stage 1 collapsed groups must still render their rows');
  assert(html.includes('S2-C-1') && html.includes('S2-D-1'), 'Stage 2 collapsed groups must still render their rows');
});

test('render() wires a click/keydown toggle on every .group-card-summary (mobile-only effect, see CSS tests below)', () => {
  const groupCallLog = [];
  const LeagueData = buildLeagueData({ scheduleFormat: 'groupStage', hasStage2: true, groupCallLog });
  const sandbox = { LeagueData, console };
  vm.createContext(sandbox);
  vm.runInContext(utilsSrc, sandbox, { filename: 'shared-utils.js' });
  vm.runInContext(standingsSrc, sandbox, { filename: 'standings.js' });
  const StandingsView = vm.runInContext('StandingsView', sandbox);

  // Minimal fake DOM: enough for querySelectorAll + classList.toggle +
  // closest + addEventListener to exercise the real toggle logic.
  function makeEl(className) {
    const listeners = {};
    const el = {
      className,
      attrs: { 'aria-expanded': 'true' },
      children: [],
      parent: null,
      addEventListener(type, fn) { listeners[type] = fn; },
      fire(type, evt) { listeners[type]?.(evt || {}); },
      classList: {
        toggle(cls) {
          const has = el.className.split(' ').includes(cls);
          el.className = has ? el.className.replace(` ${cls}`, '').replace(cls, '').trim() : `${el.className} ${cls}`.trim();
          return !has;
        },
      },
      setAttribute(k, v) { el.attrs[k] = v; },
      getAttribute(k) { return el.attrs[k]; },
      closest(sel) {
        const cls = sel.replace('.', '');
        let node = el;
        while (node && !(node.className || '').split(' ').includes(cls)) node = node.parent;
        return node;
      },
    };
    return el;
  }
  const card = makeEl('group-card');
  const summary = makeEl('group-card-summary');
  summary.parent = card;
  card.children.push(summary);

  const fakeContainer = {
    querySelectorAll: (sel) => (sel === '.group-card-summary' ? [summary] : []),
  };
  StandingsView.render(fakeContainer);

  assert.strictEqual(summary.getAttribute('aria-expanded'), 'true');
  summary.fire('click');
  assert(card.className.includes('is-collapsed'), 'clicking the summary should toggle .is-collapsed on the card');
  assert.strictEqual(summary.getAttribute('aria-expanded'), 'false', 'aria-expanded should flip to false when collapsed');
  summary.fire('click');
  assert(!card.className.includes('is-collapsed'), 'clicking again should remove .is-collapsed');
  assert.strictEqual(summary.getAttribute('aria-expanded'), 'true');
});

test('Team cell stacks logo/abbr and participant name in a dedicated wrapper (mobile-safe)', () => {
  const { html } = render({ scheduleFormat: 'groupStage', hasStage2: false });
  assert(html.includes('class="group-team-cell"'), 'expected the stacked team-cell wrapper');
  assert(html.includes('class="group-team-name"'), 'expected the participant-name span inside it');
  assert(html.includes('S1-A-1'), 'expected the participant name to still render inside the cell');
});

test('Helper text accurately reflects cumulative Stage 2 only when Stage 2 exists', () => {
  const stage1Only = render({ scheduleFormat: 'groupStage', hasStage2: false }).html;
  assert(!/Stage 1 results never affect Stage 2/.test(stage1Only), 'the old, now-inaccurate wording must be gone');
  assert(!/cumulative/i.test(stage1Only), 'no Stage 2 yet — nothing cumulative to describe');

  const bothStages = render({ scheduleFormat: 'groupStage', hasStage2: true }).html;
  assert(/cumulative/i.test(bothStages), 'once Stage 2 exists, the helper text should say standings are cumulative');
  assert(!/Stage 1 results never affect Stage 2/.test(bothStages), 'must not claim Stage 1 has no effect on Stage 2 — it does, by design');
});

// ─── CSS: the actual responsive rules exist in css/main.css ───────────
test('css/main.css: mobile breakpoint collapses the group grid to 1 column, compacts group cards, and hides .is-collapsed bodies', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'css', 'main.css'), 'utf8');
  const mobileBlockMatch = css.match(/@media \(max-width: 700px\) \{([\s\S]*?)\n\}/);
  assert(mobileBlockMatch, 'expected the existing 700px mobile breakpoint to still exist');
  const mobileBlock = mobileBlockMatch[1];
  assert(/\.group-stage-grid\s*\{\s*grid-template-columns:\s*1fr;\s*\}/.test(mobileBlock), 'expected groups to go to 1 column on mobile');
  assert(/\.group-team-cell\s*\{[^}]*flex-direction:\s*column/.test(mobileBlock), 'expected the team cell to stack vertically on mobile');
  assert(/\.group-card\.is-collapsed \.group-card-body\s*\{\s*display:\s*none;\s*\}/.test(mobileBlock), 'expected the collapse-hide rule to live inside the mobile block only');
});

test('css/main.css: the >700px block never hides .group-card-body — desktop always-expanded is structural, not attribute-dependent', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'css', 'main.css'), 'utf8');
  const desktopBlockMatch = css.match(/@media \(min-width: 701px\) \{([\s\S]*?)\n\}/);
  assert(desktopBlockMatch, 'expected a >700px breakpoint that keeps desktop static');
  const desktopBlock = desktopBlockMatch[1];
  const desktopBlockCode = desktopBlock.replace(/\/\*[\s\S]*?\*\//g, ''); // strip comments before checking actual rules
  assert(!/\.group-card(-body)?\s*\{[^}]*display:\s*none/.test(desktopBlockCode), 'the desktop block must never hide .group-card or .group-card-body');
  assert(!desktopBlockCode.includes('.is-collapsed'), 'desktop block should not have a live rule referencing .is-collapsed — it has no effect there by construction');
  assert(!css.includes('[open]'), 'no leftover native <details>[open] selectors should remain');
});

console.log(failures === 0 ? '\nAll tests passed.' : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
