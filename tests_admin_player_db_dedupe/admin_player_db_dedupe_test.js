'use strict';
/**
 * Admin Player Database — duplicate NBA2K27 seasonal-copy display fix.
 *
 * The problem: NBA2K27 season seeding intentionally creates a NEW,
 * season-scoped `league/main.players` record every time a season is
 * seeded from the same nba2k27_pool source (AdminActions.
 * seedSeasonFromNba2k27Pool, unchanged). Across multiple seeded seasons,
 * the exact same source card legitimately exists as many separate player
 * records, all `edition: "2K27"`. The "Active — NBA 2K27" tab in
 * js/admin/players.js was showing every one of those historical copies,
 * making the current pool look like it has thousands of duplicates.
 *
 * This suite exercises the fix entirely as a DISPLAY-LAYER concern:
 *   - AdminPlayersView._dedupeActiveEditionPlayers()  (new)
 *   - AdminPlayersView._editionCounts()               (new)
 *   - AdminPlayersView._editionFiltered()             (updated to dedupe
 *     only its 'active' branch)
 *
 * LeagueData.getAllPlayers()/getAvailablePlayers()/getDraftPoolStatus(),
 * seedSeasonFromNba2k27Pool(), swap/roster/draft logic, and
 * shared-utils.js are never touched by this fix and are not exercised
 * here beyond being loaded as dependencies.
 *
 * Never touches real Firestore — every Firestore call is served by an
 * in-memory fake, same convention as tests_edition_archive/. Test H
 * explicitly asserts the fake's `set()` (the only write path) is never
 * called by anything this suite does.
 *
 * Run with: node tests_admin_player_db_dedupe/admin_player_db_dedupe_test.js
 * Requires the `jsdom` package (npm install --no-save jsdom).
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const { JSDOM } = require('jsdom');

const dataSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'data.js'), 'utf8');
const sharedUtilsSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'shared-utils.js'), 'utf8');
const playersViewSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'admin', 'players.js'), 'utf8');

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ok - ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL - ${name}`);
    console.log(`    ${e.stack || e.message}`);
  }
}

function makeAdminUiEnv(opts = {}) {
  const { leaguePlayers = {}, currentSeasonId = null } = opts;
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="adminViewContainer"></div></body></html>',
    { url: 'https://example.test/' }
  );
  const window = dom.window;
  const document = window.document;

  let setCallCount = 0;
  let leagueDoc = {
    exists: true,
    data: () => ({ seasons: {}, players: leaguePlayers, settings: { currentSeasonId } }),
    metadata: { hasPendingWrites: false },
  };

  window.firebase = {
    firestore: () => ({
      collection: (name) => {
        if (name === 'league') {
          return {
            doc: () => ({
              onSnapshot: (onNext) => { onNext(leagueDoc); return () => {}; },
              set: (data) => {
                setCallCount++; // test H asserts this stays 0
                leagueDoc = { exists: true, data: () => data, metadata: { hasPendingWrites: false } };
                return Promise.resolve();
              },
            }),
          };
        }
        return { get: () => Promise.resolve({ docs: [] }) };
      },
      enablePersistence: () => Promise.resolve(),
    }),
  };
  window.AuthBoundary = { requireAuth: () => {} };
  window.confirm = () => true;
  window.normalizePlayerName = (n) => String(n || '').trim().toLowerCase();

  vm.createContext(window);
  vm.runInContext(dataSrc, window, { filename: 'data.js' });
  vm.runInContext(sharedUtilsSrc, window, { filename: 'shared-utils.js' });
  window.toasts = [];
  window.showToast = (msg, type) => { window.toasts.push({ msg, type }); };
  vm.runInContext(playersViewSrc, window, { filename: 'players.js' });
  vm.runInContext(
    'this.FirebaseSync = FirebaseSync; this.LeagueData = LeagueData; ' +
    'this.AdminActions = AdminActions; this.AdminPlayersView = AdminPlayersView; ' +
    'this.isLegacyEditionPlayer = isLegacyEditionPlayer;',
    window,
    { filename: 'export.js' }
  );
  window.FirebaseSync.init();

  const container = document.getElementById('adminViewContainer');
  window.AdminApp = { renderView: (name) => { if (name === 'players') window.AdminPlayersView.render(container); } };
  window.AdminPlayersView._editionFilter = 'all'; // reset shared module state between tests
  window.AdminPlayersView._activePool = 'green';
  window.AdminPlayersView.render(container);

  return { window, document, container, getSetCallCount: () => setCallCount };
}

function twoK27(overrides = {}) {
  return Object.assign({ pool: 'green', position: 'PG', overall: 90, edition: '2K27' }, overrides);
}

console.log('Admin Player Database — duplicate NBA2K27 copies display fix — tests');

(async () => {
  // ── A. Same nba2kRef, different seasonIds -> ONE active displayed record ──
  await test('A. two seasonal copies of the same nba2kRef collapse to one in the Active view', () => {
    const players = {
      copyA: twoK27({ id: 'copyA', name: 'Shai Gilgeous-Alexander', nba2kRef: 'sga', seasonId: 'seasonOld' }),
      copyB: twoK27({ id: 'copyB', name: 'Shai Gilgeous-Alexander', nba2kRef: 'sga', seasonId: 'seasonNewer' }),
    };
    const { window } = makeAdminUiEnv({ leaguePlayers: players });
    const activePlayers = Object.values(players);
    const deduped = window.AdminPlayersView._dedupeActiveEditionPlayers(activePlayers);
    assert.strictEqual(deduped.length, 1, 'two copies of the same nba2kRef must collapse to a single displayed record');
  });

  // ── B. Current-season copy is preferred when one exists ──────────────
  await test('B. when one copy belongs to the current season, that copy is selected', () => {
    const players = {
      copyOld: twoK27({ id: 'copyOld', name: 'Shai Gilgeous-Alexander', nba2kRef: 'sga', seasonId: 'seasonOld' }),
      copyCurrent: twoK27({ id: 'copyCurrent', name: 'Shai Gilgeous-Alexander', nba2kRef: 'sga', seasonId: 'seasonCurrent' }),
    };
    const { window } = makeAdminUiEnv({ leaguePlayers: players, currentSeasonId: 'seasonCurrent' });
    assert.strictEqual(window.LeagueData.getCurrentSeasonId(), 'seasonCurrent', 'sanity check on the fixture itself');
    const deduped = window.AdminPlayersView._dedupeActiveEditionPlayers(Object.values(players));
    assert.strictEqual(deduped.length, 1);
    assert.strictEqual(deduped[0].id, 'copyCurrent', 'the current season\'s copy must win over an older season\'s copy');
  });

  await test('B2. order of iteration does not matter — current-season copy still wins when listed first', () => {
    // Guards against an implementation that only checks "current beats
    // whatever came before" one-directionally.
    const players = {
      copyCurrent: twoK27({ id: 'copyCurrent', name: 'X', nba2kRef: 'x', seasonId: 'seasonCurrent' }),
      copyOld: twoK27({ id: 'copyOld', name: 'X', nba2kRef: 'x', seasonId: 'seasonOld' }),
    };
    const { window } = makeAdminUiEnv({ leaguePlayers: players, currentSeasonId: 'seasonCurrent' });
    const deduped = window.AdminPlayersView._dedupeActiveEditionPlayers(Object.values(players));
    assert.strictEqual(deduped.length, 1);
    assert.strictEqual(deduped[0].id, 'copyCurrent');
  });

  await test('B3. no current season set (or current season has no copy of this card) -> deterministic fallback, not random', () => {
    const players = {
      copyB: twoK27({ id: 'zzz-later-id', name: 'X', nba2kRef: 'x', seasonId: 'seasonB' }),
      copyA: twoK27({ id: 'aaa-earlier-id', name: 'X', nba2kRef: 'x', seasonId: 'seasonA' }),
    };
    const { window: win1 } = makeAdminUiEnv({ leaguePlayers: players, currentSeasonId: null });
    const { window: win2 } = makeAdminUiEnv({ leaguePlayers: players, currentSeasonId: 'someOtherSeasonEntirely' });
    const d1 = win1.AdminPlayersView._dedupeActiveEditionPlayers(Object.values(players));
    const d2 = win2.AdminPlayersView._dedupeActiveEditionPlayers(Object.values(players));
    assert.strictEqual(d1.length, 1);
    assert.strictEqual(d2.length, 1);
    assert.strictEqual(d1[0].id, 'aaa-earlier-id', 'fallback must be deterministic (lexicographically smallest id), not iteration-order dependent');
    assert.strictEqual(d2[0].id, 'aaa-earlier-id', 'fallback must give the identical result regardless of what the (non-matching) current season is');
  });

  // ── C. Different nba2kRef, same name -> remain separate ───────────────
  await test('C. two records with different nba2kRef but the same player name remain separate', () => {
    const players = {
      variant1: twoK27({ id: 'variant1', name: 'LeBron James', nba2kRef: 'lebron-cle-2003', seasonId: 's1' }),
      variant2: twoK27({ id: 'variant2', name: 'LeBron James', nba2kRef: 'lebron-mia-2010', seasonId: 's1' }),
    };
    const { window } = makeAdminUiEnv({ leaguePlayers: players });
    const deduped = window.AdminPlayersView._dedupeActiveEditionPlayers(Object.values(players));
    assert.strictEqual(deduped.length, 2, 'distinct nba2kRef values must never be collapsed together, even with an identical name');
  });

  // ── D. Legacy 2K26 record with same name as a 2K27 player -> not deduped ─
  await test('D. a 2K26 legacy record sharing a name with a 2K27 player is not deduplicated with it', () => {
    const players = {
      legacySameName: { id: 'legacySameName', name: 'Shai Gilgeous-Alexander', pool: 'green', position: 'PG', overall: 80 }, // no edition, no seasonId, no nba2kRef -> legacy
      modern: twoK27({ id: 'modern', name: 'Shai Gilgeous-Alexander', nba2kRef: 'sga', seasonId: 's1' }),
    };
    const { window, container } = makeAdminUiEnv({ leaguePlayers: players });
    window.AdminPlayersView._editionFilter = 'active';
    window.AdminPlayersView.render(container);
    const activeIds = Array.from(container.querySelectorAll('.pos-table-row[data-player-id]')).map(r => r.dataset.playerId);
    assert.ok(activeIds.includes('modern'), 'the 2K27 record must be shown under Active');
    assert.ok(!activeIds.includes('legacySameName'), 'the legacy record must never appear under Active, regardless of matching name');

    window.AdminPlayersView._editionFilter = 'archived';
    window.AdminPlayersView.render(container);
    const archivedIds = Array.from(container.querySelectorAll('.pos-table-row[data-player-id]')).map(r => r.dataset.playerId);
    assert.ok(archivedIds.includes('legacySameName'), 'the legacy record must be shown under Archived');
    assert.ok(!archivedIds.includes('modern'), 'the 2K27 record must never appear under Archived');
  });

  // ── E. Existing archived filtering still works ─────────────────────────
  await test('E. Archived filtering is completely unaffected by the dedup fix (raw count, no collapsing)', () => {
    const players = {
      legacy1: { id: 'legacy1', name: 'Legacy One', pool: 'green', position: 'PG', overall: 80 },
      legacy2: { id: 'legacy2', name: 'Legacy One', pool: 'green', position: 'PG', overall: 80 }, // same name as legacy1 on purpose
      modern1: twoK27({ id: 'modern1', name: 'Modern One', nba2kRef: 'x', seasonId: 's1' }),
    };
    const { window, container } = makeAdminUiEnv({ leaguePlayers: players });
    const editionTabs = container.querySelectorAll('#editionFilterTabs .pool-tab .pool-tab-count');
    assert.strictEqual(editionTabs[2].textContent, '2', 'Archived count must remain a plain count — two legacy records stay two, never collapsed by name');
  });

  // ── F. Existing Green/Blue pool filtering still works, post-dedup ──────
  await test('F. Green/Blue pool split still works correctly on the deduplicated Active list', () => {
    const players = {
      greenCurrent: twoK27({ id: 'greenCurrent', name: 'Green Guy', nba2kRef: 'green-guy', seasonId: 'seasonCurrent', pool: 'green' }),
      greenOld: twoK27({ id: 'greenOld', name: 'Green Guy', nba2kRef: 'green-guy', seasonId: 'seasonOld', pool: 'green' }),
      blueOnly: twoK27({ id: 'blueOnly', name: 'Blue Guy', nba2kRef: 'blue-guy', seasonId: 'seasonCurrent', pool: 'blue' }),
    };
    const { window, container } = makeAdminUiEnv({ leaguePlayers: players, currentSeasonId: 'seasonCurrent' });
    window.AdminPlayersView._editionFilter = 'active';
    window.AdminPlayersView._activePool = 'green';
    window.AdminPlayersView.render(container);

    const greenTabCount = container.querySelector('.pool-tab-green .pool-tab-count').textContent;
    const blueTabCount = container.querySelector('.pool-tab-blue .pool-tab-count').textContent;
    assert.strictEqual(greenTabCount, '1', 'Green pool count must reflect the deduped list (one greenGuy card, not two)');
    assert.strictEqual(blueTabCount, '1', 'Blue pool count is unaffected (only one blue card exists)');

    const greenRows = Array.from(container.querySelectorAll('.pos-table-row[data-player-id]')).map(r => r.dataset.playerId);
    assert.ok(greenRows.includes('greenCurrent'), 'the current season\'s green copy should be the one displayed');
    assert.ok(!greenRows.includes('greenOld'), 'the older season\'s duplicate green copy must not also be displayed');

    // Switch to Blue and confirm it still renders correctly off the same list.
    const blueTabBtn = container.querySelector('.pool-tab-blue');
    blueTabBtn.onclick();
    const blueRows = Array.from(container.querySelectorAll('.pos-table-row[data-player-id]')).map(r => r.dataset.playerId);
    assert.ok(blueRows.includes('blueOnly'));
    assert.ok(!blueRows.includes('greenCurrent') && !blueRows.includes('greenOld'), 'switching pool tabs must not leak green-pool rows into the blue pane');
  });

  // ── G. No player objects are mutated by the display dedup ─────────────
  await test('G. dedup never mutates any player object (fields, references, or the underlying data.players map)', () => {
    const players = {
      copyA: twoK27({ id: 'copyA', name: 'X', nba2kRef: 'x', seasonId: 'seasonA' }),
      copyB: twoK27({ id: 'copyB', name: 'X', nba2kRef: 'x', seasonId: 'seasonB' }),
    };
    const { window } = makeAdminUiEnv({ leaguePlayers: players, currentSeasonId: 'seasonB' });
    const before = JSON.parse(JSON.stringify(window.LeagueData.getAllPlayers()));
    window.AdminPlayersView._dedupeActiveEditionPlayers(window.LeagueData.getAllPlayers());
    const after = window.LeagueData.getAllPlayers();
    assert.deepStrictEqual(
      after.sort((a, b) => a.id.localeCompare(b.id)),
      before.sort((a, b) => a.id.localeCompare(b.id)),
      'no field on any player object may change as a result of computing the deduplicated display list'
    );
    assert.strictEqual(after.length, 2, 'the underlying global player map must still contain BOTH historical copies — dedup is display-only');
  });

  // ── H. No Firestore write occurs ───────────────────────────────────────
  await test('H. rendering/filtering/switching tabs never triggers a Firestore write', () => {
    const players = {
      copyA: twoK27({ id: 'copyA', name: 'X', nba2kRef: 'x', seasonId: 'seasonA' }),
      copyB: twoK27({ id: 'copyB', name: 'X', nba2kRef: 'x', seasonId: 'seasonB' }),
      legacy1: { id: 'legacy1', name: 'Legacy One', pool: 'blue', position: 'PG', overall: 80 },
    };
    const { window, container, getSetCallCount } = makeAdminUiEnv({ leaguePlayers: players, currentSeasonId: 'seasonB' });
    assert.strictEqual(getSetCallCount(), 0, 'initial render must not write to Firestore');

    const activeTab = Array.from(container.querySelectorAll('#editionFilterTabs .pool-tab')).find(b => b.dataset.edition === 'active');
    activeTab.onclick();
    assert.strictEqual(getSetCallCount(), 0, 'switching to the Active tab (which triggers dedup) must not write to Firestore');

    const archivedTab = Array.from(container.querySelectorAll('#editionFilterTabs .pool-tab')).find(b => b.dataset.edition === 'archived');
    archivedTab.onclick();
    assert.strictEqual(getSetCallCount(), 0, 'switching to Archived must not write to Firestore either');

    void window;
  });

  console.log(`\n${failures === 0 ? 'All tests passed.' : failures + ' test(s) failed.'}`);
  process.exitCode = failures === 0 ? 0 : 1;
})();
