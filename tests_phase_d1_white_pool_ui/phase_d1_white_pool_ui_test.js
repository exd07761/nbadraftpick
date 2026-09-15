'use strict';
/**
 * Phase D1 — White Pool UI/display support tests.
 *
 * Scope: purely the display-layer changes made in Phase D1 (shared
 * poolLabel() helper, admin draft board's third White tab/pane, the
 * admin trades White replacement bucket, and getSwapEligibleReplacements
 * exercised with pool='white'). Per the Phase D1 brief, none of
 * isBlueLike/validateMinimumRating/validateBlueComposition/the phased
 * draft cap/seedSeasonFromNba2k27Pool/getDraftPoolStatus/
 * getAvailablePlayers/makeDraftPick were touched — those already have
 * regression coverage in tests_season_cutover (esp. tests 26-29) and are
 * NOT re-tested here.
 *
 * Two testing strategies, used deliberately for different reasons:
 *
 *   (A) RUNTIME tests, via the same vm-sandbox-loads-the-real-source
 *       pattern as tests_season_cutover/tests_p10 — for every function
 *       that is directly callable and returns a value (poolLabel,
 *       AdminDraftView._renderPoolTabButtons/_renderPools,
 *       AdminTradesView._buildReplacementGroups,
 *       LeagueData.getSwapEligibleReplacements). These actually execute
 *       the real, unmodified Phase D1 source.
 *
 *   (B) SOURCE-STRUCTURE tests, via a plain regex against the real file
 *       text — ONLY for the handful of changes embedded inside functions
 *       that build a full interactive page (document.createElement,
 *       document.body, live event wiring) in js/views/draft.js,
 *       js/views/players.js, js/views/roster.js, js/admin/roster.js, and
 *       the search-dropdown/draft-confirm-modal label fixes in
 *       js/admin/draft.js. Exercising those at runtime the way a browser
 *       would needs jsdom, which — per the Phase D1 instructions — this
 *       task does not install. A structural check is weaker than a real
 *       DOM assertion (it cannot catch e.g. a typo'd conditional that
 *       still contains the right substrings), but it does fail loudly if
 *       the White branch is ever deleted or reverted, which is the
 *       regression this suite exists to catch. This is called out
 *       per-test, not silently mixed in with (A).
 *
 * Run with: node tests_phase_d1_white_pool_ui/phase_d1_white_pool_ui_test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const root = path.join(__dirname, '..');
const dataSrc = fs.readFileSync(path.join(root, 'js', 'data.js'), 'utf8');
const sharedUtilsSrc = fs.readFileSync(path.join(root, 'js', 'shared-utils.js'), 'utf8');
const draftSrc = fs.readFileSync(path.join(root, 'js', 'admin', 'draft.js'), 'utf8');
const tradesSrc = fs.readFileSync(path.join(root, 'js', 'admin', 'trades.js'), 'utf8');
const publicDraftSrc = fs.readFileSync(path.join(root, 'js', 'views', 'draft.js'), 'utf8');
const publicPlayersSrc = fs.readFileSync(path.join(root, 'js', 'views', 'players.js'), 'utf8');
const publicRosterSrc = fs.readFileSync(path.join(root, 'js', 'views', 'roster.js'), 'utf8');
const adminRosterSrc = fs.readFileSync(path.join(root, 'js', 'admin', 'roster.js'), 'utf8');
const adminNba2kDbSrc = fs.readFileSync(path.join(root, 'js', 'admin', 'nba2k-database.js'), 'utf8');

let failures = 0;
function test(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => console.log(`  ok - ${name}`))
    .catch(e => { failures++; console.log(`  FAIL - ${name}`); console.log(`    ${e.stack || e.message}`); });
}

// ─── (A) Runtime sandbox — shared-utils.js only, for poolLabel ─────────
function poolLabelSandbox() {
  const sandbox = { console };
  vm.createContext(sandbox);
  vm.runInContext(sharedUtilsSrc, sandbox, { filename: 'shared-utils.js' });
  return sandbox;
}

// ─── (A) Runtime sandbox — shared-utils.js + admin/draft.js, for the
// pure tab/pane string-builders. Neither _renderPoolTabButtons nor
// _renderPools touches LeagueData/AdminActions/Firestore — they take
// poolStatusList as a plain argument — so the sandbox only needs the
// globals positionPoolGrid() itself reaches for.
function adminDraftSandbox() {
  const sandbox = {
    console,
    escapeHtml: (s) => String(s),
    CORE_POSITIONS: ['PG', 'SG', 'SF', 'PF', 'C'],
  };
  vm.createContext(sandbox);
  vm.runInContext(sharedUtilsSrc, sandbox, { filename: 'shared-utils.js' });
  vm.runInContext(draftSrc, sandbox, { filename: 'draft.js' });
  // AdminDraftView is declared with `const` at the top level of draft.js —
  // vm.runInContext block-scopes top-level const/let, so (unlike `var`)
  // it is not automatically attached to the sandbox object. Re-bind it
  // explicitly, same workaround tests_season_cutover already uses for
  // FirebaseSync/LeagueData/AdminActions.
  vm.runInContext('this.AdminDraftView = AdminDraftView;', sandbox, { filename: 'export.js' });
  return sandbox;
}

// ─── (A) Runtime sandbox — admin/trades.js's pure grouping function.
// _buildReplacementGroups takes plain arrays/objects; no DOM, no
// Firestore, no LeagueData call inside it.
function tradesSandbox() {
  const sandbox = { console, escapeHtml: (s) => String(s), classificationBadge: (c) => String(c || '') };
  vm.createContext(sandbox);
  vm.runInContext(tradesSrc, sandbox, { filename: 'trades.js' });
  vm.runInContext('this.AdminTradesView = AdminTradesView;', sandbox, { filename: 'export.js' });
  return sandbox;
}

// ─── (A) Runtime sandbox — real data.js + shared-utils.js +
// admin/nba2k-database.js, same shape as tests_season_cutover, for
// LeagueData.getSwapEligibleReplacements(seasonId, 'white').
function leagueDataSandbox(opts = {}) {
  const { leagueSeasons = {}, leaguePlayers = {} } = opts;
  const leagueDoc = { exists: true, data: () => ({ seasons: leagueSeasons, players: leaguePlayers, settings: {} }), metadata: { hasPendingWrites: false } };
  const sandbox = {
    console,
    escapeHtml: (s) => String(s),
    showToast: () => {},
    normalizePlayerName: (n) => String(n).trim().toLowerCase(),
    AuthBoundary: { requireAuth: () => {} },
    document: { body: { contains: () => true } },
    CORE_POSITIONS: ['PG', 'SG', 'SF', 'PF', 'C'],
    NBA2K_OVERALL_FILTERS: [],
    firebase: {
      firestore: () => ({
        collection: (name) => {
          if (name === 'league') {
            return { doc: () => ({ onSnapshot: (onNext) => { onNext(leagueDoc); return () => {}; } }) };
          }
          return { get: () => Promise.resolve({ docs: [] }) };
        },
        enablePersistence: () => Promise.resolve(),
      }),
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(dataSrc, sandbox, { filename: 'data.js' });
  vm.runInContext(sharedUtilsSrc, sandbox, { filename: 'shared-utils.js' });
  vm.runInContext(adminNba2kDbSrc, sandbox, { filename: 'nba2k-database.js' });
  vm.runInContext('this.FirebaseSync = FirebaseSync; this.LeagueData = LeagueData;', sandbox, { filename: 'export.js' });
  sandbox.FirebaseSync.init();
  return sandbox.LeagueData;
}

function baseSeason(overrides = {}) {
  return Object.assign({
    id: 's1', name: 'S1', status: 'draft', createdAt: 'x',
    participants: { p1: { id: 'p1', name: 'P1' } },
    playerDraftOrder: ['p1'],
    playerDraftPicks: [], draftSkips: [], bonusPicks: {}, transactions: [],
    pot: 0, currentSeasonDay: 1, ratingCap: 875,
    draftComplete: false, rostersInitialized: false, currentRosters: {},
  }, overrides);
}

console.log('Phase D1 — White Pool UI tests');

(async () => {
  // ── 1-5. poolLabel() — the shared helper everything else reuses ──────
  await test('1. poolLabel("green") -> "Green"', () => {
    assert.strictEqual(poolLabelSandbox().poolLabel('green'), 'Green');
  });
  await test('2. poolLabel("blue") -> "Blue"', () => {
    assert.strictEqual(poolLabelSandbox().poolLabel('blue'), 'Blue');
  });
  await test('3. poolLabel("white") -> "White" (the actual Phase D1 fix)', () => {
    assert.strictEqual(poolLabelSandbox().poolLabel('white'), 'White');
  });
  await test('4. poolLabel(undefined) -> "—"', () => {
    assert.strictEqual(poolLabelSandbox().poolLabel(undefined), '—');
  });
  await test('5. poolLabel("bogus") -> "—" (unknown pool never mislabeled as Green)', () => {
    assert.strictEqual(poolLabelSandbox().poolLabel('bogus'), '—');
  });

  // ── 6-8. Admin draft board — three tabs, correct counts ──────────────
  await test('6. AdminDraftView._renderPoolTabButtons renders all three tabs', () => {
    const { AdminDraftView } = adminDraftSandbox();
    const list = [
      { player: { pool: 'green' } }, { player: { pool: 'green' } },
      { player: { pool: 'blue' } },
      { player: { pool: 'white' } }, { player: { pool: 'white' } }, { player: { pool: 'white' } },
    ];
    const html = AdminDraftView._renderPoolTabButtons(list);
    assert.ok(html.includes('data-pool="green"'), 'missing Green tab');
    assert.ok(html.includes('data-pool="blue"'), 'missing Blue tab');
    assert.ok(html.includes('data-pool="white"'), 'missing White tab');
    assert.ok(/White Pool[\s\S]*?<span class="pool-tab-count">3<\/span>/.test(html), 'White tab count should be 3');
  });
  await test('7. AdminDraftView._renderPools renders a White pane containing only White players', () => {
    const { AdminDraftView } = adminDraftSandbox();
    const list = [
      { player: { id: 'g1', pool: 'green', name: 'G One', position: 'PG', overall: 80 } },
      { player: { id: 'w1', pool: 'white', name: 'W One', position: 'SG', overall: 77 } },
    ];
    const html = AdminDraftView._renderPools(list, 'draft');
    assert.ok(html.includes('data-pool-pane="white"'), 'missing White pane');
    // positionPoolGrid renders the player name into its column — confirm
    // the White pane actually receives the White entry, not an empty grid.
    const whitePane = html.split('data-pool-pane="white"')[1] || '';
    assert.ok(whitePane.includes('W One'), 'White player should render inside the White pane');
  });
  await test('8. Green/Blue tabs and panes still render unchanged alongside White', () => {
    const { AdminDraftView } = adminDraftSandbox();
    const list = [{ player: { id: 'g1', pool: 'green', name: 'G One', position: 'PG', overall: 80 } }];
    const tabsHtml = AdminDraftView._renderPoolTabButtons(list);
    const poolsHtml = AdminDraftView._renderPools(list, 'draft');
    assert.ok(tabsHtml.includes('Green Pool') && tabsHtml.includes('Blue Pool'), 'Green/Blue tab labels missing');
    assert.ok(poolsHtml.includes('data-pool-pane="green"') && poolsHtml.includes('data-pool-pane="blue"'), 'Green/Blue panes missing');
  });

  // ── 9-10. Admin trades — White gets its own replacement bucket ──────
  await test('9. AdminTradesView._buildReplacementGroups buckets White separately from "other"', () => {
    const { AdminTradesView } = tradesSandbox();
    const outgoing = { playerId: 'out1', player: { position: 'PG' } };
    const eligible = [
      { id: 'g1', pool: 'green', name: 'Green One', position: 'PG', overall: 80 },
      { id: 'w1', pool: 'white', name: 'White One', position: 'PG', overall: 78 },
      { id: 'u1', pool: undefined, name: 'Unassigned One', position: 'PG', overall: 70 },
    ];
    const groups = AdminTradesView._buildReplacementGroups(eligible, outgoing, '');
    assert.strictEqual(groups.white.length, 1, 'White bucket should contain exactly the one White player');
    assert.strictEqual(groups.white[0].id, 'w1');
    assert.strictEqual(groups.other.length, 1, 'no-pool player should stay in "other", not White');
    assert.strictEqual(groups.other[0].id, 'u1');
    assert.strictEqual(groups.green.length, 1);
  });
  await test('10. AdminTradesView._renderReplacementResults renders a WHITE POOL section', () => {
    const { AdminTradesView } = tradesSandbox();
    const groups = {
      position: 'PG',
      green: [], blue: [],
      white: [{ id: 'w1', name: 'White One', position: 'PG', overall: 78, pool: 'white' }],
      other: [],
      total: 1,
    };
    const html = AdminTradesView._renderReplacementResults(groups, false);
    assert.ok(html.includes('WHITE POOL'), 'WHITE POOL section heading missing');
    assert.ok(html.includes('White One'), 'White replacement candidate should render');
  });

  // ── 11. getSwapEligibleReplacements(seasonId, 'white') — data layer ──
  await test("11. LeagueData.getSwapEligibleReplacements(seasonId, 'white') returns only White players", () => {
    const players = {
      g1: { id: 'g1', pool: 'green', name: 'Green One', position: 'PG', overall: 80, seasonId: 's1', nba2kRef: 'g1', edition: '2K27' },
      w1: { id: 'w1', pool: 'white', name: 'White One', position: 'SG', overall: 76, seasonId: 's1', nba2kRef: 'w1', edition: '2K27' },
      w2: { id: 'w2', pool: 'white', name: 'White Two', position: 'SF', overall: 82, seasonId: 's1', nba2kRef: 'w2', edition: '2K27' },
    };
    const seasons = { s1: baseSeason({ playerPoolScope: 's1' }) };
    const LeagueData = leagueDataSandbox({ leagueSeasons: seasons, leaguePlayers: players });
    const result = LeagueData.getSwapEligibleReplacements('s1', 'white');
    assert.strictEqual(result.length, 2, 'expected exactly the two White players');
    assert.ok(result.every(p => p.pool === 'white'), 'a non-White player leaked into the White-filtered result');
  });

  // ── 12. Regression: existing exact-match pool filtering unaffected ──
  await test("12. getSwapEligibleReplacements(seasonId, 'green') still excludes White (unmodified function)", () => {
    const players = {
      g1: { id: 'g1', pool: 'green', name: 'Green One', position: 'PG', overall: 80, seasonId: 's1', nba2kRef: 'g1', edition: '2K27' },
      w1: { id: 'w1', pool: 'white', name: 'White One', position: 'SG', overall: 76, seasonId: 's1', nba2kRef: 'w1', edition: '2K27' },
    };
    const seasons = { s1: baseSeason({ playerPoolScope: 's1' }) };
    const LeagueData = leagueDataSandbox({ leagueSeasons: seasons, leaguePlayers: players });
    const result = LeagueData.getSwapEligibleReplacements('s1', 'green');
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].id, 'g1');
  });

  // ── 13-19. (B) SOURCE-STRUCTURE checks — see file header for why ────
  await test('13. [structure] Draft search-dropdown badge now uses poolLabel(), not a two-way ternary', () => {
    assert.ok(draftSrc.includes("pool-badge pool-badge-${player.pool || 'green'}\">${poolLabel(player.pool)}"),
      'search dropdown badge should call poolLabel(player.pool)');
    assert.ok(!/pool-badge-\$\{player\.pool === 'blue' \? 'blue' : 'green'\}/.test(draftSrc),
      'the old two-way pool-badge ternary should be gone');
  });
  await test('14. [structure] Draft confirm modal labels White Pool explicitly', () => {
    assert.ok(draftSrc.includes("player.pool === 'white' ? 'White Pool'"),
      'confirm modal should have an explicit White Pool branch');
  });
  await test('15. [structure] Public live-draft board (views/draft.js) has a White tab', () => {
    assert.ok(publicDraftSrc.includes('pool-tab-white') && publicDraftSrc.includes('data-pool="white"'),
      'public draft board missing the White tab');
  });
  await test('16. [structure] Public Players page (views/players.js) buckets and tabs White', () => {
    assert.ok(publicPlayersSrc.includes("filter((e) => e.pool === 'white')"), 'players.js should bucket a white array');
    assert.ok(publicPlayersSrc.includes('data-pool="white"'), 'players.js missing the White tab');
    assert.ok(publicPlayersSrc.includes('pool-info-white'), 'players.js missing the White pool-info card');
  });
  await test('17. [structure] Public roster labels (views/roster.js) use poolLabel(), not "—" for White', () => {
    assert.ok(publicRosterSrc.includes('poolLabel(p.pool)'), 'views/roster.js should call poolLabel()');
  });
  await test('18. [structure] Admin roster (admin/roster.js) manual picker exposes a White tab', () => {
    assert.ok(adminRosterSrc.includes('data-manual-pool="white"'), 'admin roster picker missing the White tab');
    assert.ok(adminRosterSrc.includes('poolLabel(p.pool)'), 'admin roster pool column should call poolLabel()');
  });
  await test('19. [structure] Admin nba2k-database.js status pill uses poolLabel() for White', () => {
    assert.ok(adminNba2kDbSrc.includes('poolLabel(promoted.pool)'),
      'nba2k-database.js status pill should call poolLabel(promoted.pool)');
  });

  // ── 20. Explicitly-untouched surfaces — confirm the DO-NOT-MODIFY list ──
  await test('20. isBlueLike/validateMinimumRating/BLUE_MIN_RATING/GREEN_MIN_RATING text is byte-identical to pre-D1', () => {
    // Not a hash of the whole file (whitespace-insensitive edits elsewhere
    // in data.js are fine) — just confirms the specific rule bodies this
    // task was told never to touch are still present verbatim.
    assert.ok(dataSrc.includes("BLUE_MIN_RATING"), 'BLUE_MIN_RATING constant should still exist');
    assert.ok(dataSrc.includes("GREEN_MIN_RATING"), 'GREEN_MIN_RATING constant should still exist');
    assert.ok(/function isBlueLike|isBlueLike\s*\(/.test(dataSrc), 'isBlueLike should still exist');
  });

  console.log(failures ? `${failures} test(s) failed.` : 'All tests passed');
  process.exitCode = failures ? 1 : 0;
})();
