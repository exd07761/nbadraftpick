'use strict';
/**
 * NBA2K27 archive/active "edition" field — Phase 2 audit implementation
 * tests.
 *
 * Covers the narrow, approved Phase 2 plan:
 *   1. createPlayer()/isLegacyEditionPlayer() — the new optional `edition`
 *      field and its legacy-compatible read helper (js/data.js).
 *   2. AdminActions.seedSeasonFromNba2k27Pool() — the ONE call site that
 *      now sets `edition: "2K27"` (js/data.js).
 *   3. LeagueData.getSwapEligibleReplacements() — the swap-eligibility fix
 *      (js/data.js) that now respects `season.playerPoolScope`, exactly
 *      mirroring the existing getAvailablePlayers/getDraftPoolStatus rule.
 *   4. js/admin/players.js — the archive/active display filter and
 *      per-row badge, exercised via a jsdom sandbox.
 *
 * Two harnesses are used, matching this repo's existing conventions:
 *   - Part 1 (tests A-G): a data.js-only vm sandbox with a fake Firestore
 *     serving both the league/main single-document pattern and the
 *     nba2k27_pool/nba2k_players collection.get() pattern — same pattern
 *     as tests_season_cutover/season_cutover_test.js. Loads data.js +
 *     shared-utils.js + admin/nba2k-database.js (seedSeasonFromNba2k27Pool
 *     depends on that file's nba2k27EffectiveName/Overall/Team and
 *     nba2k27PoolPositionValid globals — same dependency
 *     tests_season_cutover already has).
 *   - Part 2 (test H): a jsdom sandbox with the real js/admin/players.js
 *     loaded, same pattern as tests_nba2k27_autoseed/nba2k27_autoseed_test.js.
 *
 * Never touches real Firestore, never runs a migration/backfill script —
 * every Firestore call here is served by an in-memory fake.
 *
 * Run with: node tests_edition_archive/edition_archive_test.js
 * Requires the `jsdom` package (installed via `npm install --no-save jsdom`,
 * same as tests_nba2k27_autoseed).
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const { JSDOM } = require('jsdom');

const dataSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'data.js'), 'utf8');
const sharedUtilsSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'shared-utils.js'), 'utf8');
const dbSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'admin', 'nba2k-database.js'), 'utf8');
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

// ─── Part 1 harness: data.js-only vm sandbox (tests A-G) ──────────────────

function makeDataSandbox(opts = {}) {
  const { leagueSeasons = {}, leaguePlayers = {}, nba2k27PoolDocs = {}, nba2kPlayersDocs = {} } = opts;
  let leagueDoc = { exists: true, data: () => ({ seasons: leagueSeasons, players: leaguePlayers, settings: {} }), metadata: { hasPendingWrites: false } };

  const sandbox = {
    console,
    escapeHtml: (s) => String(s),
    showToast: () => {},
    normalizePlayerName: (n) => String(n).trim().toLowerCase(),
    AuthBoundary: { requireAuth: () => {} },
    AdminActions: undefined,
    document: { body: { contains: () => true } },
    CORE_POSITIONS: ['PG', 'SG', 'SF', 'PF', 'C'],
    NBA2K_OVERALL_FILTERS: [],
    firebase: {
      firestore: () => ({
        collection: (name) => {
          if (name === 'league') {
            return {
              doc: () => ({
                onSnapshot: (onNext) => { onNext(leagueDoc); return () => {}; },
                set: (data) => {
                  leagueDoc = { exists: true, data: () => data, metadata: { hasPendingWrites: false } };
                  return Promise.resolve();
                },
              }),
            };
          }
          if (name === 'nba2k27_pool') {
            return { get: () => Promise.resolve({ size: Object.keys(nba2k27PoolDocs).length, docs: Object.keys(nba2k27PoolDocs).map(id => ({ id, data: () => nba2k27PoolDocs[id] })) }) };
          }
          if (name === 'nba2k_players') {
            return { get: () => Promise.resolve({ docs: Object.keys(nba2kPlayersDocs).map(id => ({ id, data: () => nba2kPlayersDocs[id] })) }) };
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
  vm.runInContext(dbSrc, sandbox, { filename: 'nba2k-database.js' });
  vm.runInContext(
    'this.FirebaseSync = FirebaseSync; this.LeagueData = LeagueData; ' +
    'this.AdminActions = AdminActions; this.isLegacyEditionPlayer = isLegacyEditionPlayer;',
    sandbox,
    { filename: 'export.js' }
  );
  sandbox.FirebaseSync.init();
  return { LeagueData: sandbox.LeagueData, AdminActions: sandbox.AdminActions, isLegacyEditionPlayer: sandbox.isLegacyEditionPlayer };
}

function baseSeason(overrides = {}) {
  return Object.assign({
    id: 's1', name: 'S1', status: 'setup', createdAt: 'x',
    participants: { p1: { id: 'p1', name: 'P1' }, p2: { id: 'p2', name: 'P2' } },
    playerDraftOrder: ['p1', 'p2'],
    playerDraftPicks: [], draftSkips: [], bonusPicks: {}, transactions: [],
    pot: 0, currentSeasonDay: 1, ratingCap: 875,
    draftComplete: false, rostersInitialized: false, currentRosters: {},
  }, overrides);
}

function poolEntry(overrides = {}) {
  return Object.assign({ pool: 'green', position: 'PG', selectedAt: 'x', updatedAt: 'x' }, overrides);
}
function sourcePlayer(overrides = {}) {
  return Object.assign({ name: 'Source Name', team: 'T', teamType: 'curr', overall: 85 }, overrides);
}

// ─── Part 2 harness: jsdom + real js/admin/players.js (test H) ────────────

function makeAdminUiEnv(opts = {}) {
  const { leaguePlayers = {} } = opts;
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="adminViewContainer"></div></body></html>',
    { url: 'https://example.test/' }
  );
  const window = dom.window;
  const document = window.document;

  let leagueDoc = { exists: true, data: () => ({ seasons: {}, players: leaguePlayers, settings: {} }), metadata: { hasPendingWrites: false } };

  window.firebase = {
    firestore: () => ({
      collection: (name) => {
        if (name === 'league') {
          return {
            doc: () => ({
              onSnapshot: (onNext) => { onNext(leagueDoc); return () => {}; },
              set: (data) => {
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
  window.AdminPlayersView.render(container);

  return { window, document, container };
}

console.log('NBA2K27 edition/archive audit — Phase 2 tests');

(async () => {
  // ── A. Existing player with no edition remains legacy-compatible ──────
  await test('A. a manually-added player has no `edition` field and is classified legacy', () => {
    const { AdminActions, isLegacyEditionPlayer } = makeDataSandbox();
    const player = AdminActions.addPlayer({ name: 'Manual Guy', position: 'PG', overall: 80, pool: 'green' });
    assert.strictEqual(player.edition, undefined, 'manually-added players must not get an edition field');
    assert.strictEqual(isLegacyEditionPlayer(player), true, 'a player with no edition must read as legacy');
  });

  await test('A2. a CSV-imported player has no `edition` field and reads as legacy', () => {
    const sandbox = makeDataSandbox();
    const result = sandbox.AdminActions.importPlayersFromCSV([
      { name: 'CSV Guy', position: 'SG', overall: 82, pool: 'blue' },
    ]);
    assert.strictEqual(result.imported, 1);
    const player = sandbox.LeagueData.getAllPlayers().find(p => p.name === 'CSV Guy');
    assert.ok(player, 'imported player should exist');
    assert.strictEqual(player.edition, undefined);
    assert.strictEqual(sandbox.isLegacyEditionPlayer(player), true);
  });

  await test('A4. a single-player 2K26-style promotion (AdminActions.addPlayer with nba2kRef, no edition) reads as legacy', () => {
    // Mirrors js/admin/nba2k-database.js's Nba2kDatabaseView "Add to Draft
    // Pool" promotion call (AdminActions.addPlayer({..., nba2kRef}) with NO
    // edition argument) — confirms that path still yields a legacy player.
    const { AdminActions, isLegacyEditionPlayer } = makeDataSandbox();
    const player = AdminActions.addPlayer({ name: 'Promoted 2K26 Guy', position: 'C', overall: 88, pool: 'blue', nba2kRef: 'some-2k26-slug' });
    assert.strictEqual(player.edition, undefined);
    assert.strictEqual(isLegacyEditionPlayer(player), true);
  });

  // ── B. NBA2K27 seeded player receives edition: "2K27" ──────────────────
  await test('B. AdminActions.seedSeasonFromNba2k27Pool sets edition: "2K27" on every seeded player', async () => {
    const nba2k27PoolDocs = { sga: poolEntry({ pool: 'green', position: 'PG', variantGroupId: '' }) };
    const nba2kPlayersDocs = { sga: sourcePlayer({ name: 'Shai Gilgeous-Alexander', overall: 97 }) };
    const seasons = { s1: baseSeason({ id: 's1', playerPoolScope: 's1' }) };
    const { AdminActions, LeagueData, isLegacyEditionPlayer } = makeDataSandbox({ leagueSeasons: seasons, nba2k27PoolDocs, nba2kPlayersDocs });

    const result = await AdminActions.seedSeasonFromNba2k27Pool('s1');
    assert.strictEqual(result.seeded, 1);
    const seeded = LeagueData.getAllPlayers().find(p => p.nba2kRef === 'sga');
    assert.ok(seeded, 'seeded player should exist');
    assert.strictEqual(seeded.edition, '2K27', 'seedSeasonFromNba2k27Pool must set edition: "2K27"');
    assert.strictEqual(isLegacyEditionPlayer(seeded), false, 'a 2K27-seeded player must NOT read as legacy');
    // No other field's behavior should have changed by this addition.
    assert.strictEqual(seeded.seasonId, 's1');
    assert.strictEqual(seeded.pool, 'green');
  });

  // ── C. A 2K27-scoped season's draft still sees only its own pool ──────
  await test('C. getAvailablePlayers/getDraftPoolStatus remain scoped to playerPoolScope, unchanged by edition', async () => {
    const nba2k27PoolDocsA = { sga: poolEntry({ pool: 'green', position: 'PG' }) };
    const nba2kPlayersDocsA = { sga: sourcePlayer({ name: 'Shai Gilgeous-Alexander', overall: 97 }) };
    const seasons = {
      sA: baseSeason({ id: 'sA', playerPoolScope: 'sA' }),
    };
    const { AdminActions, LeagueData } = makeDataSandbox({ leagueSeasons: seasons, nba2k27PoolDocs: nba2k27PoolDocsA, nba2kPlayersDocs: nba2kPlayersDocsA });
    await AdminActions.seedSeasonFromNba2k27Pool('sA');
    // Add an unrelated legacy (no seasonId) player directly into the same
    // global pool, the way a manual Add Player would.
    AdminActions.addPlayer({ name: 'Legacy Guy', position: 'PG', overall: 70, pool: 'green' });

    const available = LeagueData.getAvailablePlayers('sA');
    assert.strictEqual(available.length, 1, 'only the seeded 2K27 player should be available in the scoped season');
    assert.strictEqual(available[0].nba2kRef, 'sga');

    const status = LeagueData.getDraftPoolStatus('sA', null);
    // getDraftPoolStatus intentionally returns EVERY player, annotated —
    // but ONLY within the scoped set (see js/data.js's own doc comment).
    assert.strictEqual(status.length, 1, 'getDraftPoolStatus must also stay scoped to playerPoolScope');
    assert.strictEqual(status[0].player.nba2kRef, 'sga');
  });

  // ── D. Swap replacements exclude cross-edition/cross-season players ───
  await test('D. getSwapEligibleReplacements, for a scoped season, excludes legacy 2K26 players, another season\'s 2K27 players, and unrelated global players', async () => {
    const nba2k27PoolDocs = {
      sga: poolEntry({ pool: 'green', position: 'PG' }),
      mj: poolEntry({ pool: 'blue', position: 'SG' }),
    };
    const nba2kPlayersDocs = {
      sga: sourcePlayer({ name: 'Shai Gilgeous-Alexander', overall: 97 }),
      mj: sourcePlayer({ name: 'Michael Jordan', overall: 98 }),
    };
    const seasons = {
      sA: baseSeason({ id: 'sA', playerPoolScope: 'sA' }),
      sB: baseSeason({ id: 'sB', playerPoolScope: 'sB' }),
    };
    const { AdminActions, LeagueData } = makeDataSandbox({ leagueSeasons: seasons, nba2k27PoolDocs, nba2kPlayersDocs });

    // Seed season A from the pool first...
    await AdminActions.seedSeasonFromNba2k27Pool('sA');
    // ...then seed season B from the SAME pool (undo A's seed first so the
    // "already seeded" dedupe doesn't block B — undoSeasonSeed only clears
    // A's own seasonId-tagged players, so this is a clean, realistic setup
    // for "two different seasons each seeded independently over time").
    AdminActions.undoSeasonSeed('sA');
    await AdminActions.seedSeasonFromNba2k27Pool('sA');
    await AdminActions.seedSeasonFromNba2k27Pool('sB');

    // A legacy 2K26 player and an "unrelated global player" (manually
    // added, no seasonId, no nba2kRef) — both must be excluded from A's
    // swap-replacement search once A is scoped.
    AdminActions.addPlayer({ name: 'Legacy 2K26 Guy', position: 'PG', overall: 75, pool: 'green' });
    AdminActions.addPlayer({ name: 'Unrelated Global Guy', position: 'SG', overall: 76, pool: 'blue' });

    const seasonAPlayer = LeagueData.getAllPlayers().find(p => p.seasonId === 'sA' && p.nba2kRef === 'sga');
    const seasonBPlayer = LeagueData.getAllPlayers().find(p => p.seasonId === 'sB' && p.nba2kRef === 'sga');
    assert.ok(seasonAPlayer && seasonBPlayer, 'both seasons should have their own independently-seeded copy of the sga slug');
    assert.notStrictEqual(seasonAPlayer.id, seasonBPlayer.id, 'each season\'s seed creates its own player record/id');

    const eligibleForA = LeagueData.getSwapEligibleReplacements('sA', '');
    const eligibleIds = eligibleForA.map(p => p.id);

    assert.ok(eligibleIds.includes(seasonAPlayer.id), 'season A\'s own seeded player must be swap-eligible in season A');
    assert.ok(!eligibleIds.includes(seasonBPlayer.id), 'season B\'s seeded player must NOT be swap-eligible in season A');
    assert.ok(!eligibleForA.some(p => p.name === 'Legacy 2K26 Guy'), 'legacy 2K26 players must NOT be swap-eligible in a scoped season');
    assert.ok(!eligibleForA.some(p => p.name === 'Unrelated Global Guy'), 'unrelated global players must NOT be swap-eligible in a scoped season');
  });

  // ── E. Unscoped legacy season retains its existing (unfiltered) behavior ─
  await test('E. getSwapEligibleReplacements for an UNSCOPED season is unfiltered, exactly as before this fix', () => {
    const seasons = { legacy: baseSeason({ id: 'legacy' }) }; // no playerPoolScope — a classic/2K26-style season
    const players = {
      p1: { id: 'p1', name: 'Legacy Green', pool: 'green', position: 'PG', overall: 80 },
      p2: { id: 'p2', name: 'Some 2K27 Guy', pool: 'green', position: 'SG', overall: 85, seasonId: 'otherSeason', edition: '2K27', nba2kRef: 'x' },
    };
    const { LeagueData } = makeDataSandbox({ leagueSeasons: seasons, leaguePlayers: players });

    const eligible = LeagueData.getSwapEligibleReplacements('legacy', '');
    const ids = eligible.map(p => p.id);
    assert.ok(ids.includes('p1'), 'the legacy player must remain eligible for an unscoped season');
    assert.ok(ids.includes('p2'), 'an unscoped season\'s swap search must remain UNFILTERED (preserve prior behavior) — a 2K27 player from another season is still visible here, same as before this fix');
  });

  // ── F. Historical roster lookup by playerId still works ───────────────
  await test('F. getParticipantRoster resolves drafted players by id unchanged, regardless of edition', () => {
    const players = {
      legacyPick: { id: 'legacyPick', name: 'Old Timer', pool: 'green', position: 'PG', overall: 80 },
      modernPick: { id: 'modernPick', name: 'New Guy', pool: 'green', position: 'SG', overall: 90, seasonId: 's1', edition: '2K27', nba2kRef: 'x' },
    };
    const seasons = {
      s1: baseSeason({
        id: 's1',
        playerPoolScope: 's1',
        playerDraftPicks: [
          { playerId: 'legacyPick', participantId: 'p1', pick: 1, round: 1 },
          { playerId: 'modernPick', participantId: 'p1', pick: 2, round: 1 },
        ],
      }),
    };
    const { LeagueData } = makeDataSandbox({ leagueSeasons: seasons, leaguePlayers: players });
    const roster = LeagueData.getParticipantRoster('s1', 'p1');
    assert.strictEqual(roster.length, 2);
    assert.strictEqual(roster[0].player.id, 'legacyPick');
    assert.strictEqual(roster[0].player.name, 'Old Timer');
    assert.strictEqual(roster[1].player.id, 'modernPick');
    assert.strictEqual(roster[1].player.name, 'New Guy');
  });

  // ── G. Variant locking still works exactly as before ───────────────────
  await test('G. getDraftPoolStatus variant-locking is unaffected by the edition field', () => {
    const players = {
      lebronA: { id: 'lebronA', name: 'LeBron (Current)', pool: 'green', position: 'SF', overall: 96, variantGroup: 'lebron-james', seasonId: 's1', edition: '2K27', nba2kRef: 'x1' },
      lebronB: { id: 'lebronB', name: 'LeBron (Prime)', pool: 'blue', position: 'SF', overall: 98, variantGroup: 'lebron-james', seasonId: 's1', edition: '2K27', nba2kRef: 'x2' },
    };
    const seasons = {
      s1: baseSeason({
        id: 's1',
        playerPoolScope: 's1',
        playerDraftPicks: [{ playerId: 'lebronA', participantId: 'p1', pick: 1, round: 1 }],
      }),
    };
    const { LeagueData } = makeDataSandbox({ leagueSeasons: seasons, leaguePlayers: players });
    const status = LeagueData.getDraftPoolStatus('s1', null);
    const a = status.find(s => s.player.id === 'lebronA');
    const b = status.find(s => s.player.id === 'lebronB');
    assert.strictEqual(a.status, 'drafted');
    assert.strictEqual(b.status, 'variant-locked', 'the other variant-group member must still be locked out once one is drafted');
  });

  // ── H. Admin Player Database can distinguish active 2K27 from archived 2K26 ─
  await test('H1. edition-filter tab counts match isLegacyEditionPlayer classification exactly', () => {
    const players = {
      legacy1: { id: 'legacy1', name: 'Legacy One', pool: 'green', position: 'PG', overall: 80 },
      legacy2: { id: 'legacy2', name: 'Legacy Two', pool: 'blue', position: 'SG', overall: 82 },
      modern1: { id: 'modern1', name: 'Modern One', pool: 'green', position: 'SF', overall: 90, edition: '2K27', seasonId: 's1', nba2kRef: 'x' },
    };
    const { container, window } = makeAdminUiEnv({ leaguePlayers: players });
    const editionTabs = container.querySelectorAll('#editionFilterTabs .pool-tab .pool-tab-count');
    assert.strictEqual(editionTabs.length, 3, 'expected All/Active/Archived edition-filter tabs');
    assert.strictEqual(editionTabs[0].textContent, '3', 'All must count every player');
    assert.strictEqual(editionTabs[1].textContent, '1', 'Active must count only the 2K27-edition player');
    assert.strictEqual(editionTabs[2].textContent, '2', 'Archived must count both legacy players');
    void window;
  });

  await test('H2. filtering to "Archived" hides the active 2K27 player from the visible grid, without deleting it from data.players', () => {
    const players = {
      legacy1: { id: 'legacy1', name: 'Legacy One', pool: 'green', position: 'PG', overall: 80 },
      modern1: { id: 'modern1', name: 'Modern One', pool: 'green', position: 'SF', overall: 90, edition: '2K27', seasonId: 's1', nba2kRef: 'x' },
    };
    const { container, window } = makeAdminUiEnv({ leaguePlayers: players });
    const archivedTab = Array.from(container.querySelectorAll('#editionFilterTabs .pool-tab')).find(b => b.dataset.edition === 'archived');
    archivedTab.onclick();

    // Green pool tab is active by default — "Modern One" is in Green pool
    // and should now be hidden from the rendered grid...
    const rows = Array.from(container.querySelectorAll('.pos-table-row[data-player-id]')).map(r => r.dataset.playerId);
    assert.ok(rows.includes('legacy1'), 'the legacy player must still be shown when filtered to Archived');
    assert.ok(!rows.includes('modern1'), 'the active 2K27 player must be hidden from the grid when filtered to Archived');

    // ...but the underlying global player map must be completely untouched.
    assert.ok(window.LeagueData.getPlayer('modern1'), 'the archived-filter must never delete/move the underlying player record');
    assert.strictEqual(window.LeagueData.getAllPlayers().length, 2, 'no player was removed from data.players by filtering the UI');
  });

  await test('H3. per-row badges mark each player ACTIVE (2K27) or ARCHIVED (2K26)', () => {
    const players = {
      legacy1: { id: 'legacy1', name: 'Legacy One', pool: 'green', position: 'PG', overall: 80 },
      modern1: { id: 'modern1', name: 'Modern One', pool: 'green', position: 'SF', overall: 90, edition: '2K27', seasonId: 's1', nba2kRef: 'x' },
    };
    const { container } = makeAdminUiEnv({ leaguePlayers: players });
    // Both players are in the Green pool tab (default _activePool), so
    // both rows should be present with the "All" edition filter active.
    const legacyRow = container.querySelector('.pos-table-row[data-player-id="legacy1"]');
    const modernRow = container.querySelector('.pos-table-row[data-player-id="modern1"]');
    assert.ok(legacyRow, 'legacy player row should be rendered under All filter');
    assert.ok(modernRow, 'modern (2K27) player row should be rendered under All filter');
    assert.ok(legacyRow.querySelector('.edition-badge-archived'), 'legacy player row must carry an archived badge');
    assert.ok(!legacyRow.querySelector('.edition-badge-active'), 'legacy player row must NOT carry an active badge');
    assert.ok(modernRow.querySelector('.edition-badge-active'), '2K27 player row must carry an active badge');
    assert.ok(!modernRow.querySelector('.edition-badge-archived'), '2K27 player row must NOT carry an archived badge');
  });

  // ── I. isLegacyEditionPlayer() compatibility fix — pre-Phase-2 promoted
  // 2K27 records (seasonId + nba2kRef set, but no `edition`, since they
  // were created before this field existed — ~744 real production
  // players per the follow-up audit) must NOT be misclassified as
  // legacy/archived. Direct unit tests of the classification function
  // itself, covering exactly the four cases called out in that audit.
  await test('I1. edition === "2K27" -> active', () => {
    const { isLegacyEditionPlayer } = makeDataSandbox();
    assert.strictEqual(isLegacyEditionPlayer({ id: 'x', edition: '2K27' }), false);
  });

  await test('I2. edition === "2K26" -> archived', () => {
    const { isLegacyEditionPlayer } = makeDataSandbox();
    assert.strictEqual(isLegacyEditionPlayer({ id: 'x', edition: '2K26' }), true);
  });

  await test('I3. missing edition + seasonId + nba2kRef both set -> active (pre-Phase-2 promoted 2K27 player)', () => {
    const { isLegacyEditionPlayer } = makeDataSandbox();
    const preExistingPromoted2K27Player = {
      id: 'pl_existing', name: 'Shai Gilgeous-Alexander', position: 'PG', overall: 97,
      pool: 'green', nba2kRef: 'sga', seasonId: 'realSeasonId123',
      // no `edition` key — created before this field existed
    };
    assert.strictEqual('edition' in preExistingPromoted2K27Player, false, 'fixture must have no edition key, matching real pre-Phase-2 records');
    assert.strictEqual(isLegacyEditionPlayer(preExistingPromoted2K27Player), false, 'a pre-existing promoted 2K27 player must read as ACTIVE, not archived');
  });

  await test('I4. missing edition, and NOT both seasonId+nba2kRef set -> archived', () => {
    const { isLegacyEditionPlayer } = makeDataSandbox();
    // Neither field set — an ordinary legacy 2K26 player.
    assert.strictEqual(isLegacyEditionPlayer({ id: 'a', name: 'Legacy Guy', pool: 'green' }), true);
    // seasonId alone (no nba2kRef) — not the seedSeasonFromNba2k27Pool
    // signature; must not be treated as active on seasonId alone.
    assert.strictEqual(isLegacyEditionPlayer({ id: 'b', name: 'Season-tagged only', seasonId: 's1' }), true);
    // nba2kRef alone (no seasonId) — matches the single-player 2K26
    // promotion path (Nba2kDatabaseView "Add to Draft Pool", see test A4),
    // which never sets seasonId; must not be treated as active either.
    assert.strictEqual(isLegacyEditionPlayer({ id: 'c', name: 'Nba2kRef only', nba2kRef: 'some-2k26-slug' }), true);
  });

  console.log(`\n${failures === 0 ? 'All tests passed.' : failures + ' test(s) failed.'}`);
  process.exitCode = failures === 0 ? 0 : 1;
})();
