/**
 * Phase 8.6 regression: raw Supabase `nba2k_players` rows (snake_case) must be
 * normalized to the camelCase shape the frontend expects before they land in
 * Nba2kDatabaseView._players. Also confirms the existing `nba2k27_pool`
 * normalization (_pool27) is correct, and that the pool-derivation rules and
 * the Phase 8.6 validator see the right values.
 *
 * Run:  node tests_p8_6/player_row_normalization_test.js
 * (from the repo root; no dependencies, no network, no Supabase)
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const SRC = path.join(__dirname, '..', 'js', 'admin', 'nba2k-database.js');

// ---- load the real source into a sandbox with a stubbed SupabaseQuery -----
let tables = {};
const selectCalls = [];
const sandbox = {
  console,
  document: { body: { contains: () => true } },
  escapeHtml: s => String(s),
  SupabaseQuery: {
    // Same call shape as the real one: select(table, build) where build
    // receives a chainable query builder. The stub applies order/range.
    async select(table, build) {
      selectCalls.push(table);
      let from = 0, to = Infinity;
      const qb = {
        order() { return qb; },
        range(a, b) { from = a; to = b; return qb; },
      };
      if (typeof build === 'function') build(qb);
      return (tables[table] || []).slice(from, to + 1);
    },
  },
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox, { filename: SRC });
const api = vm.runInContext(
  '({ Nba2kDatabaseView, Nba2k27PoolValidator, nba2k27PoolForTeamType })',
  sandbox
);
const { Nba2kDatabaseView: View, Nba2k27PoolValidator: Validator } = api;

function playerRow(slug, teamType, extra) {
  return Object.assign({
    slug,
    name: 'Player ' + slug,
    team: 'Team',
    overall: 90,
    positions: ['PG'],
    team_type: teamType,
    variant_group_id: null,
  }, extra || {});
}

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  PASS  ' + name); }
  catch (e) { console.error('  FAIL  ' + name + '\n        ' + e.message); process.exitCode = 1; }
}

(async () => {
  tables = {
    nba2k_players: [
      playerRow('lebron-curr', 'curr'),
      playerRow('lebron-class', 'class', { variant_group_id: 'lebron-james' }),
      playerRow('lebron-allt', 'allt', { variant_group_id: 'lebron-james' }),
      playerRow('mystery', null),
      playerRow('weird', 'bogus'),
    ],
    nba2k27_pool: [
      {
        nba2k_ref: 'lebron-curr', pool: 'green', position: 'PG',
        selected_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-02T00:00:00Z',
        overall_override: 95, name_override: 'King', variant_group_id: 'lebron-james',
        variant_label: 'Current',
      },
    ],
  };
  await View._ensureLoaded();
  const byId = Object.fromEntries(View._players.map(p => [p.id, p]));

  console.log('nba2k_players normalization');
  await test('team_type "curr" -> teamType "curr" -> green', () => {
    assert.strictEqual(byId['lebron-curr'].teamType, 'curr');
    assert.strictEqual(api.nba2k27PoolForTeamType(byId['lebron-curr'].teamType), 'green');
  });
  await test('team_type "class" -> teamType "class" -> white', () => {
    assert.strictEqual(byId['lebron-class'].teamType, 'class');
    assert.strictEqual(api.nba2k27PoolForTeamType(byId['lebron-class'].teamType), 'white');
  });
  await test('team_type "allt" -> teamType "allt" -> blue', () => {
    assert.strictEqual(byId['lebron-allt'].teamType, 'allt');
    assert.strictEqual(api.nba2k27PoolForTeamType(byId['lebron-allt'].teamType), 'blue');
  });
  await test('null / unrecognized team_type -> null pool (unknown stays unknown)', () => {
    assert.strictEqual(api.nba2k27PoolForTeamType(byId['mystery'].teamType), null);
    assert.strictEqual(api.nba2k27PoolForTeamType(byId['weird'].teamType), null);
  });
  await test('variant_group_id -> variantGroupId', () => {
    assert.strictEqual(byId['lebron-class'].variantGroupId, 'lebron-james');
    assert.strictEqual(byId['lebron-allt'].variantGroupId, 'lebron-james');
    assert.strictEqual(byId['lebron-curr'].variantGroupId, null);
  });
  await test('id is still the slug; raw snake_case columns are still present', () => {
    assert.strictEqual(byId['lebron-curr'].id, 'lebron-curr');
    assert.strictEqual(byId['lebron-curr'].slug, 'lebron-curr');
    assert.strictEqual(byId['lebron-curr'].team_type, 'curr');
    assert.strictEqual(byId['lebron-class'].variant_group_id, 'lebron-james');
  });
  await test('already-camelCase fields (name/team/overall/positions) pass through untouched', () => {
    const p = byId['lebron-curr'];
    assert.strictEqual(p.name, 'Player lebron-curr');
    assert.strictEqual(p.team, 'Team');
    assert.strictEqual(p.overall, 90);
    assert.deepStrictEqual(Array.from(p.positions), ['PG']);
  });
  await test('row missing team_type column entirely does not invent a teamType', async () => {
    // Reload through the real _ensureLoaded() with a row that has no
    // team_type / variant_group_id columns at all.
    const savedPlayers = View._players, savedPool27 = View._pool27, savedTables = tables;
    try {
      View._players = null;
      View._pool27 = null;
      tables = { nba2k_players: [{ slug: 'x', name: 'X' }], nba2k27_pool: [] };
      await View._ensureLoaded();
      const x = View._players.find(p => p.id === 'x');
      assert.ok(x, 'player x should have loaded');
      assert.strictEqual(x.teamType, undefined);
      assert.strictEqual(x.variantGroupId, undefined);
      assert.strictEqual(api.nba2k27PoolForTeamType(x.teamType), null);
    } finally {
      View._players = savedPlayers; View._pool27 = savedPool27; tables = savedTables;
    }
  });

  console.log('nba2k27_pool (_pool27) normalization — pre-existing, unchanged');
  await test('_pool27 snake_case -> camelCase, keyed by nba2k_ref', () => {
    const e = View._pool27['lebron-curr'];
    assert.deepStrictEqual(JSON.parse(JSON.stringify(e)), {
      nba2kRef: 'lebron-curr',
      pool: 'green',
      position: 'PG',
      selectedAt: '2026-10-01T00:00:00Z',
      updatedAt: '2026-10-02T00:00:00Z',
      overallOverride: 95,
      nameOverride: 'King',
      variantGroupId: 'lebron-james',
      variantLabel: 'Current',
    });
  });

  console.log('validator end-to-end (the production symptom)');
  await test('selected players with valid data no longer report Unknown Pool Eligibility', () => {
    const rows = ['lebron-curr', 'lebron-class', 'lebron-allt'].map(slug => {
      const expected = api.nba2k27PoolForTeamType(byId[slug].teamType);
      return { slug, player: byId[slug], orphan: false, poolValid: true, poolValue: expected };
    });
    const summary = Validator.summarize(Validator.classifyAll(rows));
    assert.strictEqual(summary.unknownPoolEligibility, 0);
    assert.strictEqual(summary.poolMismatches, 0);
    assert.strictEqual(summary.ready, 3);
  });
  await test('un-normalized raw rows reproduce the bug (guards the test itself)', () => {
    const raw = { id: 'r', ...playerRow('r', 'curr') }; // old spread behaviour
    assert.strictEqual(raw.teamType, undefined);
    const c = Validator.classify({ slug: 'r', player: raw, orphan: false, poolValid: true, poolValue: 'green' });
    assert.strictEqual(c.issues.unknownPoolEligibility, true);
  });

  console.log('\n' + passed + ' passed' + (process.exitCode ? ', FAILURES above' : ''));
})();
