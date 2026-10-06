'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const root = path.join(__dirname, '..');
let livePlayers = [{ id: 'p27live_jordan', name: 'Michael Jordan', position: 'UNASSIGNED' }];
let liveReadCount = 0;
let manualEditFails = false;
const sandbox = {
  console,
  window: { USE_SUPABASE_SYNC: false },
  SupabaseReadsCore: {
    getLiveNba2k27Players: async () => { liveReadCount++; return livePlayers; },
  },
  NBA2K_OVERALL_FILTERS: [],
  LeagueData: {
    getNBATeams: () => [
      { abbr: 'CHI', name: 'Chicago Bulls' }, { abbr: 'LAL', name: 'Los Angeles Lakers' },
      { abbr: 'BOS', name: 'Boston Celtics' }, { abbr: 'OKC', name: 'Oklahoma City Thunder' },
    ],
    getNBATeam: abbr => ({ CHI: 'Chicago Bulls', LAL: 'Los Angeles Lakers', BOS: 'Boston Celtics', OKC: 'Oklahoma City Thunder' }[abbr] ? { abbr } : null),
    getAllPlayers: () => [],
  },
  escapeHtml: value => String(value || ''),
  document: { body: { contains: () => true } },
  SupabaseQuery: { callWriteRpc: async (_rpc, params) => {
    if (manualEditFails) throw new Error('write failed');
    return {
      nba2k_ref: params.p_slug, pool: params.p_position === 'UNASSIGNED' ? 'white' : 'green', position: params.p_position,
      selected_at: 'now', updated_at: 'now', overall_override: null, name_override: null, variant_group_id: null, variant_label: null,
    };
  } },
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'js/data.js'), 'utf8'), sandbox, { filename: 'data.js' });
vm.runInContext(fs.readFileSync(path.join(root, 'js/shared-utils.js'), 'utf8'), sandbox, { filename: 'shared-utils.js' });
vm.runInContext(fs.readFileSync(path.join(root, 'js/admin/nba2k-database.js'), 'utf8'), sandbox, { filename: 'nba2k-database.js' });
vm.runInContext('this.view = Nba2k27PoolView; this.db = Nba2kDatabaseView; this.formatName = nba2k27FormatDisplayName; this.livePoolCache = SupabaseLiveNba2k27PoolCache;', sandbox);
// The real pool grid is irrelevant to these assertions; retain the exact
// passed rows and pool so All mode's three pool-specific calls are visible.
sandbox.positionPoolGrid = (entries, pool) => `<section data-pool="${pool}">${entries.map(e => e.player.name).join('|')}</section>`;
sandbox._positionPoolColumn = (_pos, entries) => entries.map(e => e.player.name).join('|');

const rows = [
  { slug: 'lbj', entry: { pool: 'green', position: 'SF' }, poolValue: 'green', poolValid: true, position: 'SF', category: 'curr', effectiveName: 'LeBron James', effectiveTeam: 'Los Angeles Lakers', player: { id: 'lbj', name: 'LeBron James', team: 'Los Angeles Lakers', teamType: 'curr' }, orphan: false, effectiveOverall: 97 },
  { slug: 'bulls-current', entry: { pool: 'green', position: 'PG' }, poolValue: 'green', poolValid: true, position: 'PG', category: 'curr', effectiveName: 'Derrick Rose', effectiveTeam: 'Chicago Bulls', player: { id: 'bulls-current', name: 'Derrick Rose', team: 'Chicago Bulls', teamType: 'curr' }, orphan: false, effectiveOverall: 85 },
  { slug: 'jordan', entry: { pool: 'white', position: 'SG' }, poolValue: 'white', poolValid: true, position: 'SG', category: 'class', effectiveName: 'Michael Jordan 1992 - 1993 Chicago Bulls', effectiveTeam: '1992-93 Chicago Bulls', player: { id: 'jordan', name: 'Michael Jordan 1992 - 1993 Chicago Bulls', team: '1992-93 Chicago Bulls', teamType: 'class' }, orphan: false, effectiveOverall: 99 },
  { slug: 'norm', entry: { pool: 'blue', position: 'PG', nameOverride: 'Norm Van Lier (CHI)' }, poolValue: 'blue', poolValid: true, position: 'PG', category: 'allt', effectiveName: 'Norm Van Lier (CHI)', effectiveTeam: 'All-Time Chicago Bulls', player: { id: 'norm', name: 'Norm Van Lier', team: 'All-Time Chicago Bulls', teamType: 'allt' }, orphan: false, effectiveOverall: 90 },
  { slug: 'derek', entry: { pool: 'white', position: 'SG' }, poolValue: 'white', poolValid: true, position: 'SG', category: 'class', effectiveName: 'Derek Fisher 11-12 OKC', effectiveTeam: '2011-12 Oklahoma City Thunder', player: { id: 'derek', name: 'Derek Fisher', team: '2011-12 Oklahoma City Thunder', teamType: 'class' }, orphan: false, effectiveOverall: 80 },
  { slug: 'unknown', entry: { pool: 'blue', position: 'PF' }, poolValue: 'blue', poolValid: true, position: 'PF', category: 'allt', effectiveName: 'Mystery Player', effectiveTeam: 'Historic Seattle SuperSonics', player: { id: 'unknown', name: 'Mystery Player', team: 'Historic Seattle SuperSonics', teamType: 'allt' }, orphan: false, effectiveOverall: 70 },
];
// Use real buildRows; set each source-team fixture and pool record shape as the
// database loader does, then exercise the real filter and rendering methods.
sandbox.db._players = rows.map(r => ({ ...r.player, id: r.slug }));
sandbox.db._pool27 = Object.fromEntries(rows.map(r => [r.slug, { pool: r.poolValue, position: r.position, nameOverride: r.entry.nameOverride || null }]));
const built = sandbox.view._buildRows();

const tests = [];
function test(name, fn) { tests.push([name, fn]); }
test('Current names format with the canonical team abbreviation', () => assert.strictEqual(sandbox.formatName('LeBron James', 'Los Angeles Lakers', 'green'), 'LeBron James (LAL)'));
test('All-Time formatted overrides remain idempotent', () => assert.strictEqual(sandbox.formatName('Norm Van Lier (CHI)', 'All-Time Chicago Bulls', 'blue'), 'Norm Van Lier (CHI)'));
test('Classic source season/team converts to compact season and abbreviation', () => assert.strictEqual(sandbox.formatName('Michael Jordan 1992 - 1993 Chicago Bulls', '1992-93 Chicago Bulls', 'white'), 'Michael Jordan 92-93 CHI'));
test('Classic formatted name is preserved and unknown historic teams are not guessed', () => {
  assert.strictEqual(sandbox.formatName('Derek Fisher 11-12 OKC', '2011-12 Oklahoma City Thunder', 'white'), 'Derek Fisher 11-12 OKC');
  assert.strictEqual(sandbox.formatName('Mystery Player', 'Historic Seattle SuperSonics', 'blue'), 'Mystery Player');
});
test('roster options retain distinct current, season, and All-Time roster labels', () => {
  const opts = sandbox.view._getRosterOptions(built);
  assert.deepStrictEqual(Array.from(opts), ['1992-93 Chicago Bulls', '2011-12 Oklahoma City Thunder', 'All-Time Chicago Bulls', 'Chicago Bulls', 'Historic Seattle SuperSonics', 'Los Angeles Lakers']);
});
test('pool, exact roster, position, and search combine with AND semantics', () => {
  sandbox.view._filterPool = 'white'; sandbox.view._filterRoster = '1992-93 Chicago Bulls'; sandbox.view._filterPosition = 'SG'; sandbox.view._search = 'jordan';
  assert.deepStrictEqual(Array.from(sandbox.view._getVisibleRows(built), r => r.slug), ['jordan']);
  sandbox.view._search = 'derek';
  assert.strictEqual(sandbox.view._getVisibleRows(built).length, 0);
});
test('All mode renders each pool separately with its pool styling key', () => {
  sandbox.view._filterPool = ''; sandbox.view._filterRoster = ''; sandbox.view._filterPosition = ''; sandbox.view._search = '';
  const html = sandbox.view._renderPoolPane();
  for (const pool of ['green', 'blue', 'white']) assert.ok(html.includes(`data-pool="${pool}"`));
  assert.ok(html.includes('LeBron James (LAL)'));
  assert.ok(html.includes('Michael Jordan 92-93 CHI'));
  assert.ok(html.includes('Norm Van Lier (CHI)'));
});
test('Manual position save still uses the existing update RPC and selected position', async () => {
  const saved = await sandbox.view._saveManualEdit({ p_slug: 'jordan', p_position: 'SG' });
  assert.strictEqual(saved.position, 'SG');
});
test('successful Draft Pool Position edit makes the next live-pool read fetch fresh players', async () => {
  await sandbox.livePoolCache.ensureLoaded();
  assert.strictEqual(sandbox.livePoolCache.getEntries().p27live_jordan.position, 'UNASSIGNED');
  assert.strictEqual(liveReadCount, 1);

  livePlayers = [{ id: 'p27live_jordan', name: 'Michael Jordan', position: 'SG' }];
  const saved = await sandbox.view._saveManualEdit({ p_slug: 'jordan', p_position: 'SG' });
  assert.strictEqual(saved.position, 'SG');
  assert.strictEqual(sandbox.livePoolCache.isLoaded(), false, 'successful manual edit invalidates the prior snapshot');

  await sandbox.livePoolCache.ensureLoaded();
  assert.strictEqual(liveReadCount, 2, 'next read reloads the effective-player view');
  assert.strictEqual(sandbox.livePoolCache.getEntries().p27live_jordan.position, 'SG');
});
test('failed Draft Pool Position edit preserves the currently loaded live-pool cache', async () => {
  await sandbox.livePoolCache.ensureLoaded();
  const cached = sandbox.livePoolCache.getEntries();
  const readsBefore = liveReadCount;
  manualEditFails = true;
  await assert.rejects(sandbox.view._saveManualEdit({ p_slug: 'jordan', p_position: 'PF' }), /Could not save/);
  manualEditFails = false;
  assert.strictEqual(sandbox.livePoolCache.getEntries(), cached, 'failed save leaves existing cache intact');
  await sandbox.livePoolCache.ensureLoaded();
  assert.strictEqual(liveReadCount, readsBefore, 'failed save does not trigger a reload');
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`  ok - ${name}`); }
    catch (err) { failed++; console.error(`  FAIL - ${name}\n    ${err.stack || err.message}`); }
  }
  console.log(failed ? `${failed} test(s) failed.` : 'All tests passed');
  process.exitCode = failed ? 1 : 0;
})();
