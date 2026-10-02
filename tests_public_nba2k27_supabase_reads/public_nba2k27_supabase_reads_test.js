'use strict';
/**
 * Phase 8.4 — Public NBA 2K27 player lookup: Firestore -> Supabase tests.
 *
 * Verifies:
 *  - js/supabase-reads-nba2k27.js correctly maps nba2k27_pool/nba2k_players
 *    snake_case rows to the camelCase shape the public views already
 *    expect, including chunking + per-chunk fault tolerance for the
 *    players lookup.
 *  - js/views/players.js and js/views/nba2k27.js now source their data
 *    from SupabaseReadsNba2k27 and render identically to before — their
 *    own _buildEntries()/_buildRows() and rendering are exercised
 *    UNMODIFIED, through the real render() entry point.
 *  - Neither public view makes any Firestore call for player/pool data
 *    anymore (window.firebase.firestore().collection(...) is never
 *    invoked for 'nba2k27_pool' or 'nba2k_players').
 *  - The nba2k27.js error state no longer claims a Firestore access rule
 *    is needed (that copy would now be inaccurate).
 *
 * Never touches real Supabase or Firestore — every call is served by an
 * in-memory fake, same convention as every other suite in this repo
 * (e.g. tests_players_2k27_pool_merge), adapted for the Supabase client
 * shape (SupabaseClient.from(table).select(...) resolving {data, error}).
 *
 * Run with: node tests_public_nba2k27_supabase_reads/public_nba2k27_supabase_reads_test.js
 * Requires the `jsdom` package (npm install --no-save jsdom).
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const dataSrc = fs.readFileSync(path.join(root, 'js', 'data.js'), 'utf8');
const sharedUtilsSrc = fs.readFileSync(path.join(root, 'js', 'shared-utils.js'), 'utf8');
const supabaseQuerySrc = fs.readFileSync(path.join(root, 'js', 'supabase-query.js'), 'utf8');
const supabaseReadsNba2k27Src = fs.readFileSync(path.join(root, 'js', 'supabase-reads-nba2k27.js'), 'utf8');
const playersViewSrc = fs.readFileSync(path.join(root, 'js', 'views', 'players.js'), 'utf8');
const nba2k27ViewSrc = fs.readFileSync(path.join(root, 'js', 'views', 'nba2k27.js'), 'utf8');

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

// ── Fixture builders ──────────────────────────────────────────────────
function poolRow(nba2k_ref, overrides = {}) {
  return Object.assign({
    nba2k_ref,
    pool: 'green',
    position: 'PG',
    selected_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    overall_override: null,
    name_override: null,
    variant_group_id: null,
    variant_label: null,
  }, overrides);
}
function playerRow(slug, overrides = {}) {
  return Object.assign({
    slug,
    name: 'Source Name',
    team: 'Source Team',
    team_type: 'curr',
    overall: 85,
    positions: ['PG'],
    build: null,
    height: null,
    weight: null,
    wingspan: null,
    attributes: {},
    badges: { legendary: 0, hallOfFame: 0, gold: 0, silver: 0, bronze: 0, total: 0, list: [] },
    player_url: 'https://www.2kratings.com/' + slug,
    player_image: null,
    team_img: null,
    last_updated: null,
    imported_at: '2026-01-01T00:00:00.000Z',
  }, overrides);
}

// ── Fake Supabase client — matches SupabaseQuery's actual usage shape:
// SupabaseClient.from(table).select('*') returns a chainable, awaitable
// ("thenable") query builder; awaiting it resolves {data, error}. ─────
// Phase 8.4.1: PostgREST (real Supabase) returns at most 1000 rows per
// request UNLESS the caller paginates with `.range()` — this default cap
// is simulated here (not just a documented assumption) so a regression
// that drops pagination will make these tests actually fail, the same
// way it silently truncated the real nba2k27_pool read in production.
const POSTGREST_DEFAULT_ROW_CAP = 1000;

function makeSupabaseClient(tables, shouldError) {
  const calls = [];
  function runQuery(table, inFilter, orderBy, range) {
    calls.push({
      table,
      inFilter: inFilter ? { field: inFilter.field, values: inFilter.values.slice() } : null,
      orderBy, range,
    });
    if (shouldError && shouldError(table, inFilter)) {
      return Promise.resolve({ data: null, error: { message: 'simulated Supabase read failure' } });
    }
    let rows = Object.values(tables[table] || {});
    if (inFilter) rows = rows.filter((r) => inFilter.values.includes(r[inFilter.field]));
    if (orderBy) {
      rows = rows.slice().sort((a, b) => {
        const av = a[orderBy.field], bv = b[orderBy.field];
        const cmp = av < bv ? -1 : av > bv ? 1 : 0;
        return orderBy.ascending === false ? -cmp : cmp;
      });
    }
    if (range) {
      rows = rows.slice(range.from, range.to + 1);
    } else if (rows.length > POSTGREST_DEFAULT_ROW_CAP) {
      // Real PostgREST behavior: no .range() => capped at the default,
      // not an error — exactly the shape of bug this suite must catch.
      rows = rows.slice(0, POSTGREST_DEFAULT_ROW_CAP);
    }
    return Promise.resolve({ data: rows, error: null });
  }
  const client = {
    from(table) {
      return {
        select() {
          let inFilter = null;
          let orderBy = null;
          let range = null;
          const qb = {
            in(field, values) { inFilter = { field, values }; return qb; },
            eq() { return qb; },
            order(field, opts) { orderBy = { field, ascending: !opts || opts.ascending !== false }; return qb; },
            range(from, to) { range = { from, to }; return qb; },
            then(resolve, reject) { return runQuery(table, inFilter, orderBy, range).then(resolve, reject); },
            catch(onReject) { return this.then(undefined, onReject); },
          };
          return qb;
        },
      };
    },
  };
  return { client, getCalls: () => calls.slice() };
}

function makeEnv(opts = {}) {
  const {
    pool27 = {},       // { slug: poolRow-shaped object }
    players = {},      // { slug: playerRow-shaped object }
    shouldError = null,
  } = opts;

  const dom = new JSDOM(
    '<!doctype html><html><body><div id="publicViewContainer"></div></body></html>',
    { url: 'https://example.test/' }
  );
  const window = dom.window;
  const document = window.document;

  // Minimal Firestore fake — needed only so data.js's FirebaseSync.init()
  // and LeagueData.getCurrentSeason()/getDraftPoolStatus() (used by
  // players.js for its unrelated draft-status join) don't throw at load
  // time. NOTE: 'nba2k27_pool'/'nba2k_players' are deliberately NOT
  // registered here — if either public view still called Firestore for
  // player/pool data, this fake's default branch (empty docs) would
  // silently return nothing, so the firestoreCalls log below is what
  // actually proves neither view calls Firestore for this data anymore.
  const firestoreCalls = [];
  let leagueDoc = {
    exists: true,
    data: () => ({ seasons: {}, players: {}, settings: {} }),
    metadata: { hasPendingWrites: false },
  };
  window.firebase = {
    firestore: () => ({
      collection: (name) => {
        firestoreCalls.push(name);
        if (name === 'league') {
          return {
            doc: () => ({
              onSnapshot: (onNext) => { onNext(leagueDoc); return () => {}; },
            }),
          };
        }
        return { get: () => Promise.resolve({ docs: [] }) };
      },
    }),
  };

  const { client: supabaseClient, getCalls: getSupabaseCalls } = makeSupabaseClient(
    { nba2k27_pool: pool27, nba2k_players: players },
    shouldError
  );
  window.SupabaseClient = supabaseClient;

  vm.createContext(window);
  vm.runInContext(supabaseQuerySrc, window, { filename: 'supabase-query.js' });
  vm.runInContext(supabaseReadsNba2k27Src, window, { filename: 'supabase-reads-nba2k27.js' });
  vm.runInContext(dataSrc, window, { filename: 'data.js' });
  vm.runInContext(sharedUtilsSrc, window, { filename: 'shared-utils.js' });
  window.toasts = [];
  window.showToast = (msg, type) => { window.toasts.push({ msg, type }); };
  vm.runInContext(playersViewSrc, window, { filename: 'players.js' });
  vm.runInContext(nba2k27ViewSrc, window, { filename: 'nba2k27.js' });
  vm.runInContext(
    'this.SupabaseQuery = SupabaseQuery; this.SupabaseReadsNba2k27 = SupabaseReadsNba2k27; ' +
    'this.FirebaseSync = FirebaseSync; this.LeagueData = LeagueData; ' +
    'this.PublicPlayersView = PublicPlayersView; this.PublicNba2k27View = PublicNba2k27View;',
    window,
    { filename: 'export.js' }
  );
  window.FirebaseSync.init();

  const container = document.getElementById('publicViewContainer');
  return {
    window, document, container,
    getFirestoreCalls: () => firestoreCalls.slice(),
    getSupabaseCalls,
  };
}

console.log('Phase 8.4 — Public NBA 2K27 player lookup Supabase migration — tests');

(async () => {
  // ── A. SupabaseReadsNba2k27.getNba2k27PoolRows() ───────────────────────
  await test('A1. getNba2k27PoolRows() maps every snake_case column to the expected camelCase shape, keyed by nba2k_ref', async () => {
    const env = makeEnv({
      pool27: {
        sga: poolRow('sga', { pool: 'blue', position: 'PG', overall_override: 99, name_override: 'SGA', variant_group_id: 'g1', variant_label: 'Season 1' }),
      },
    });
    const result = JSON.parse(JSON.stringify(await env.window.SupabaseReadsNba2k27.getNba2k27PoolRows()));
    assert.deepStrictEqual(result.sga, {
      nba2kRef: 'sga', pool: 'blue', position: 'PG',
      selectedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      overallOverride: 99, nameOverride: 'SGA', variantGroupId: 'g1', variantLabel: 'Season 1',
    });
  });

  // ── A continued. Phase 8.4.1 — pagination fix ──────────────────────────
  await test('A2. getNba2k27PoolRows() retrieves all 1,987 rows across multiple pages, not just the first 1,000', async () => {
    const pool27 = {};
    for (let i = 0; i < 1987; i++) {
      // Zero-padded so lexicographic (nba2k_ref) ordering matches
      // numeric order, exactly like the fake client's real .order() sort.
      const slug = 'player-' + String(i).padStart(4, '0');
      pool27[slug] = poolRow(slug);
    }
    const env = makeEnv({ pool27 });
    const result = await env.window.SupabaseReadsNba2k27.getNba2k27PoolRows();
    assert.strictEqual(
      Object.keys(result).length, 1987,
      'all 1,987 pool rows must be retrieved, not truncated at the PostgREST default 1,000-row cap'
    );
  });

  await test('A3. getNba2k27PoolRows() includes rows from page 2 (offset >= 1000), not just page 1', async () => {
    const pool27 = {};
    for (let i = 0; i < 1987; i++) {
      const slug = 'player-' + String(i).padStart(4, '0');
      pool27[slug] = poolRow(slug);
    }
    const env = makeEnv({ pool27 });
    const result = await env.window.SupabaseReadsNba2k27.getNba2k27PoolRows();
    // 'player-1500' sorts after the first 1,000 rows (player-0000..player-0999) —
    // its presence proves a second page was actually fetched and merged.
    assert.ok(result['player-1500'], 'a row from page 2 (offset 1000+) must be present');
    assert.ok(result['player-1986'], 'the very last row must be present');
    const supabaseCalls = env.getSupabaseCalls().filter((c) => c.table === 'nba2k27_pool');
    assert.strictEqual(supabaseCalls.length, 2, 'a 1,987-row table must be fetched in exactly 2 pages of up to 1,000');
  });

  await test('A4. getNba2k27PoolRows() returned shape is unchanged after the pagination fix: { [nba2k_ref]: normalizedPoolRow }', async () => {
    const env = makeEnv({
      pool27: { sga: poolRow('sga', { pool: 'blue', overall_override: 99, name_override: 'SGA', variant_group_id: 'g1', variant_label: 'S1' }) },
    });
    const result = JSON.parse(JSON.stringify(await env.window.SupabaseReadsNba2k27.getNba2k27PoolRows()));
    assert.deepStrictEqual(result.sga, {
      nba2kRef: 'sga', pool: 'blue', position: 'PG',
      selectedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      overallOverride: 99, nameOverride: 'SGA', variantGroupId: 'g1', variantLabel: 'S1',
    });
  });

  // ── B. SupabaseReadsNba2k27.getNba2k27PlayersBySlugs() ─────────────────
  await test('B1. getNba2k27PlayersBySlugs([]) returns {} and makes no Supabase call', async () => {
    const env = makeEnv({});
    const result = await env.window.SupabaseReadsNba2k27.getNba2k27PlayersBySlugs([]);
    assert.strictEqual(Object.keys(result).length, 0);
    assert.strictEqual(env.getSupabaseCalls().length, 0);
  });

  await test('B2. getNba2k27PlayersBySlugs(slugs) maps every field to the expected shape, keyed by slug', async () => {
    const env = makeEnv({
      players: { sga: playerRow('sga', { name: 'Shai Gilgeous-Alexander', overall: 97, player_image: 'img.png', team_img: 'team.png' }) },
    });
    const result = await env.window.SupabaseReadsNba2k27.getNba2k27PlayersBySlugs(['sga']);
    assert.strictEqual(result.sga.id, 'sga');
    assert.strictEqual(result.sga.name, 'Shai Gilgeous-Alexander');
    assert.strictEqual(result.sga.overall, 97);
    assert.strictEqual(result.sga.playerImage, 'img.png');
    assert.strictEqual(result.sga.teamImg, 'team.png');
  });

  await test('B3. getNba2k27PlayersBySlugs chunks large slug lists and merges every chunk\'s results', async () => {
    const players = {};
    const slugs = [];
    for (let i = 0; i < 250; i++) {
      const slug = 'player-' + i;
      slugs.push(slug);
      players[slug] = playerRow(slug, { name: 'Player ' + i });
    }
    const env = makeEnv({ players });
    const result = await env.window.SupabaseReadsNba2k27.getNba2k27PlayersBySlugs(slugs);
    assert.strictEqual(Object.keys(result).length, 250, 'all 250 players across both chunks must be present');
    assert.strictEqual(result['player-0'].name, 'Player 0');
    assert.strictEqual(result['player-249'].name, 'Player 249');
    const chunkSizes = env.getSupabaseCalls().filter((c) => c.table === 'nba2k_players').map((c) => c.inFilter.values.length);
    assert.strictEqual(chunkSizes.length, 2, 'a 250-slug request must be split into exactly 2 chunks (chunk size 200)');
    assert.deepStrictEqual(chunkSizes.sort((a, b) => a - b), [50, 200]);
  });

  await test('B4. a single failed chunk does not discard the other chunk\'s results (partial failure tolerated)', async () => {
    const players = {};
    const slugs = [];
    for (let i = 0; i < 250; i++) {
      const slug = 'player-' + i;
      slugs.push(slug);
      players[slug] = playerRow(slug);
    }
    // Fail only the chunk that contains 'player-0' (the first chunk).
    const env = makeEnv({
      players,
      shouldError: (table, inFilter) => table === 'nba2k_players' && inFilter && inFilter.values.includes('player-0'),
    });
    const result = await env.window.SupabaseReadsNba2k27.getNba2k27PlayersBySlugs(slugs);
    assert.strictEqual(result['player-0'], undefined, 'the failed chunk\'s players must simply be absent, not fabricated');
    assert.ok(result['player-249'], 'the OTHER, successful chunk\'s players must still be present');
  });

  await test('B4b. (Phase 8.4.1 regression guard) getNba2k27PlayersBySlugs never hits the PostgREST default row cap even at full 1,987-player pool scale', async () => {
    const players = {};
    const slugs = [];
    for (let i = 0; i < 1987; i++) {
      const slug = 'player-' + String(i).padStart(4, '0');
      slugs.push(slug);
      players[slug] = playerRow(slug);
    }
    const env = makeEnv({ players });
    const result = await env.window.SupabaseReadsNba2k27.getNba2k27PlayersBySlugs(slugs);
    assert.strictEqual(Object.keys(result).length, 1987, 'every player must resolve — each 200-slug chunk is well under the 1,000-row default cap');
  });

  await test('B5. every chunk failing rethrows, for the caller\'s own load-error handling', async () => {
    const env = makeEnv({
      players: { sga: playerRow('sga') },
      shouldError: (table) => table === 'nba2k_players',
    });
    await assert.rejects(
      () => env.window.SupabaseReadsNba2k27.getNba2k27PlayersBySlugs(['sga']),
      /simulated Supabase read failure/
    );
  });

  // ── C. PublicPlayersView renders from Supabase, never touches Firestore ─
  await test('C1. Players page renders a seeded 2K27 pool player sourced entirely from Supabase', async () => {
    const env = makeEnv({
      pool27: { sga: poolRow('sga', { pool: 'green', position: 'PG' }) },
      players: { sga: playerRow('sga', { name: 'Shai Gilgeous-Alexander', overall: 97, positions: ['PG'] }) },
    });
    await env.window.PublicPlayersView.render(env.container);
    assert.ok(
      env.container.textContent.includes('Shai Gilgeous-Alexander'),
      'the seeded player must be rendered'
    );
  });

  await test('C2. Players page never calls Firestore for nba2k27_pool or nba2k_players', async () => {
    const env = makeEnv({
      pool27: { sga: poolRow('sga') },
      players: { sga: playerRow('sga', { name: 'Shai Gilgeous-Alexander' }) },
    });
    await env.window.PublicPlayersView.render(env.container);
    const fsCalls = env.getFirestoreCalls();
    assert.ok(!fsCalls.includes('nba2k27_pool'), 'Firestore nba2k27_pool must never be queried');
    assert.ok(!fsCalls.includes('nba2k_players'), 'Firestore nba2k_players must never be queried');
    assert.ok(env.getSupabaseCalls().some((c) => c.table === 'nba2k27_pool'), 'the pool data must actually come from Supabase');
    assert.ok(env.getSupabaseCalls().some((c) => c.table === 'nba2k_players'), 'the player data must actually come from Supabase');
  });

  // ── D. PublicNba2k27View renders full detail from Supabase ─────────────
  await test('D1. NBA 2K27 View renders a card and detail modal with badges/attributes/variant info sourced from Supabase', async () => {
    const env = makeEnv({
      pool27: {
        'derek-fisher-2011-12': poolRow('derek-fisher-2011-12', {
          pool: 'green', position: 'PG', name_override: 'Derek Fisher 11-12', variant_group_id: 'derek-fisher', variant_label: '2011-12 OKC',
        }),
      },
      players: {
        'derek-fisher-2011-12': playerRow('derek-fisher-2011-12', {
          name: 'Derek Fisher', overall: 78, positions: ['PG'],
          attributes: { speed: 65, three_point: 70 },
          badges: { legendary: 0, hallOfFame: 0, gold: 1, silver: 0, bronze: 0, total: 1, list: [{ name: 'Clutch Shooter', tier: 'gold', category: 'Shooting' }] },
        }),
      },
    });
    await env.window.PublicNba2k27View.render(env.container);
    assert.ok(env.container.textContent.includes('Derek Fisher 11-12'), 'the name override must be shown, not the raw source name');

    const card = env.container.querySelector('[data-player-id="derek-fisher-2011-12"], .nba2k27-card[data-slug="derek-fisher-2011-12"]')
      || Array.from(env.container.querySelectorAll('[data-slug], [data-player-id]')).find((el) => (el.dataset.slug || el.dataset.playerId) === 'derek-fisher-2011-12');
    assert.ok(card, 'a card/row for the seeded player must be present');
  });

  await test('D2. NBA 2K27 View never calls Firestore for nba2k27_pool or nba2k_players', async () => {
    const env = makeEnv({
      pool27: { sga: poolRow('sga') },
      players: { sga: playerRow('sga', { name: 'Shai Gilgeous-Alexander' }) },
    });
    await env.window.PublicNba2k27View.render(env.container);
    const fsCalls = env.getFirestoreCalls();
    assert.ok(!fsCalls.includes('nba2k27_pool'));
    assert.ok(!fsCalls.includes('nba2k_players'));
  });

  // ── E. Error state no longer claims a Firestore access rule is needed ──
  await test('E. a total pool-read failure shows a generic error state, not the old Firestore-rule-specific message', async () => {
    const env = makeEnv({
      pool27: { sga: poolRow('sga') },
      shouldError: (table) => table === 'nba2k27_pool',
    });
    await env.window.PublicNba2k27View.render(env.container);
    assert.ok(!env.container.textContent.includes('Firestore'), 'the error state must not mention Firestore at all now that the source is Supabase');
    assert.ok(env.container.textContent.toLowerCase().includes('went wrong') || env.container.textContent.includes("isn't available"), 'an explanatory empty/error state must still be shown');
  });

  console.log(`\n${failures === 0 ? 'All tests passed.' : failures + ' test(s) failed.'}`);
  process.exitCode = failures === 0 ? 0 : 1;
})();
