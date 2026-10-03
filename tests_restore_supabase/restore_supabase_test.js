'use strict';
/**
 * Tests for scripts/restore-supabase.js.
 *
 * Everything runs against an in-memory fake of Supabase's PostgREST surface
 * injected through the script's `deps.fetch` — no network, no credentials,
 * never connects to production. The fake enforces the verified production
 * facts that matter to restore ordering: nba2k27_pool.nba2k_ref has a real
 * foreign key to nba2k_players.slug, and the upsert `columns` parameter must
 * stay inside the whitelist.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const R = require('../scripts/restore-supabase.js');

let failures = 0;
const pending = [];
function test(name, fn) {
  pending.push(
    Promise.resolve().then(fn)
      .then(() => console.log(`  ok - ${name}`))
      .catch((e) => { failures++; console.log(`  FAIL - ${name}`); console.log(`    ${e.stack || e.message}`); })
  );
}

// ─── Fixtures ───────────────────────────────────────────────────────────

const TS_A = '2026-09-01T07:41:41.123456+00:00';
const TS_B = '2026-09-02T10:00:00.5+00:00';

function player(slug, over = {}) {
  return {
    slug, name: `Name ${slug}`, overall: 80, team: 'Team', team_type: 'curr', positions: ['PG'],
    build: 'Playmaker', height: "6'3\"", weight: '190 lbs', wingspan: "6'8\"",
    attributes: { b: 1, a: 2 }, badges: { x: 'gold' }, player_url: `https://x/${slug}`,
    team_img: null, player_image: null, last_updated: TS_A, imported_at: TS_B, ...over,
  };
}
function poolRow(ref, over = {}) {
  return {
    nba2k_ref: ref, pool: 'green', selected_at: TS_A, updated_at: TS_B, position: 'PG',
    overall_override: null, name_override: null, variant_group_id: null, variant_label: null, ...over,
  };
}
function makeBackup(over = {}) {
  return {
    metadata: { format: 'supabase-json-v1', createdAt: '2026-10-04T12:00:00.000Z', tables: ['league_state', 'nba2k_players', 'nba2k27_pool'] },
    league_state: { id: 'main', data: { settings: { currentSeasonId: 's1' }, players: { p: 1 } }, updated_at: '2026-10-04T11:59:59.000000+00:00' },
    nba2k_players: [player('alpha'), player('bravo'), player('charlie')],
    nba2k27_pool: [poolRow('alpha'), poolRow('bravo', { overall_override: 90, name_override: 'Bravo!' })],
    ...over,
  };
}

// ─── Fake Supabase (PostgREST) ──────────────────────────────────────────

function makeFake(opts = {}) {
  const state = {
    players: new Map((opts.players || []).map(r => [r.slug, { ...r }])),
    pool: new Map((opts.pool || []).map(r => [r.nba2k_ref, { ...r }])),
    league: opts.league === undefined
      ? { id: 'main', data: { live: true }, updated_at: '2026-10-03T00:00:00.000000+00:00' }
      : opts.league,
    calls: [],
    corruptReadBack: opts.corruptReadBack || null, // (table, rows) => rows, applied to GETs after the first write
    wrote: false,
  };
  const res = (status, body) => ({
    ok: status >= 200 && status < 300, status, statusText: String(status),
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => body,
  });
  const tableMap = { nba2k_players: ['players', 'slug'], nba2k27_pool: ['pool', 'nba2k_ref'] };

  async function fetchStub(url, init = {}) {
    const u = new URL(url);
    const method = init.method || 'GET';
    const m = /\/rest\/v1\/(.+)$/.exec(u.pathname);
    const target = m[1];
    state.calls.push({ method, target, query: u.search });

    if (method === 'GET') {
      if (target === 'league_state') return res(200, state.league ? [state.league] : []);
      const [bucket, key] = tableMap[target];
      let rows = [...state[bucket].values()].sort((a, b) => (a[key] < b[key] ? -1 : 1));
      const offset = Number(u.searchParams.get('offset') || 0);
      const limit = Number(u.searchParams.get('limit') || 1000);
      rows = rows.slice(offset, offset + limit).map(r => ({ ...r }));
      if (state.wrote && state.corruptReadBack) rows = state.corruptReadBack(target, rows);
      return res(200, rows);
    }

    if (method === 'POST' && target === 'rpc/save_league_state') {
      if (opts.failRpc) return res(500, { message: 'rpc boom' });
      const body = JSON.parse(init.body);
      state.wrote = true;
      state.rpcArgs = body;
      state.league = { ...state.league, data: body.p_data, updated_at: '2026-10-04T13:00:00.000000+00:00' };
      return res(200, null);
    }

    if (method === 'POST' && tableMap[target.split('?')[0]]) {
      const table = target.split('?')[0];
      const [bucket, key] = tableMap[table];
      if (opts.failTable === table) return res(500, { message: 'upsert boom' });
      const cols = (u.searchParams.get('columns') || '').split(',');
      const whitelist = table === 'nba2k_players' ? R.PLAYER_COLUMNS : R.POOL_COLUMNS;
      assert.deepStrictEqual([...cols].sort(), [...whitelist].sort(), 'columns param must equal the whitelist');
      assert.strictEqual(u.searchParams.get('on_conflict'), key);
      const rows = JSON.parse(init.body);
      for (const r of rows) {
        assert.deepStrictEqual(Object.keys(r).sort(), [...whitelist].sort(), 'row must contain exactly the whitelisted columns');
        if (table === 'nba2k27_pool' && !state.players.has(r.nba2k_ref)) return res(409, { code: '23503', message: 'FK violation' });
      }
      state.wrote = true;
      state.batchSizes = state.batchSizes || {};
      (state.batchSizes[table] = state.batchSizes[table] || []).push(rows.length);
      for (const r of rows) state[bucket].set(r[key], { ...r });
      return res(201, '');
    }
    return res(400, { message: `unexpected ${method} ${url}` });
  }
  state.fetch = fetchStub;
  return state;
}

// ─── Harness ────────────────────────────────────────────────────────────

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-supabase-test-'));
let n = 0;
function writeBackupFile(obj) {
  const f = path.join(tmpRoot, `backup-${++n}.json`);
  fs.writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj));
  return f;
}
const CREDS = { url: 'https://example.invalid', serviceRoleKey: 'sb_secret_test' };

async function run(backupObj, flags, fakeOpts, extraDeps = {}) {
  const fake = makeFake(fakeOpts);
  const out = []; const err = [];
  const file = writeBackupFile(backupObj);
  const snapDir = path.join(tmpRoot, `snap-${++n}`);
  const argv = [file, ...flags];
  if (flags.includes('--apply') && !flags.includes('--snapshot-dir')) argv.push('--snapshot-dir', snapDir);
  const code = await R.main(argv, {
    fetch: fake.fetch, creds: CREDS, log: (...a) => out.push(a.join(' ')), error: (...a) => err.push(a.join(' ')),
    confirm: async () => true, now: () => new Date('2026-10-04T12:30:00'), ...extraDeps,
  });
  return { code, fake, out: out.join('\n'), err: err.join('\n'), snapDir };
}
const writesOf = (fake) => fake.calls.filter(c => c.method !== 'GET');
const liveWithAll = () => ({ players: [player('alpha')], pool: [poolRow('alpha')] });

// ─── Validation ─────────────────────────────────────────────────────────

test('valid backup passes validation', () => {
  const { errors, orphans } = R.validateBackup(makeBackup());
  assert.deepStrictEqual(errors, []);
  assert.deepStrictEqual(orphans, []);
});

test('wrong metadata format rejected', () => {
  const b = makeBackup(); b.metadata.format = 'firestore-json-v1';
  assert.ok(R.validateBackup(b).errors.some(e => e.includes('metadata.format')));
});

test('metadata.tables must be exactly the three datasets', () => {
  const b = makeBackup(); b.metadata.tables = ['league_state', 'nba2k_players'];
  assert.ok(R.validateBackup(b).errors.some(e => e.includes('metadata.tables')));
});

test('missing dataset rejected (each of the three)', () => {
  for (const k of ['league_state', 'nba2k_players', 'nba2k27_pool']) {
    const b = makeBackup(); delete b[k];
    assert.ok(R.validateBackup(b).errors.some(e => e.includes(`${k} dataset is missing`)), k);
  }
});

test('league_state id other than main rejected', () => {
  const b = makeBackup(); b.league_state.id = 'other';
  assert.ok(R.validateBackup(b).errors.some(e => e.includes('league_state.id')));
});

test('invalid league_state.data rejected (array, null, string)', () => {
  for (const bad of [[], null, 'x', 5]) {
    const b = makeBackup(); b.league_state.data = bad;
    assert.ok(R.validateBackup(b).errors.some(e => e.includes('league_state.data must be a JSON object')), JSON.stringify(bad));
  }
});

test('duplicate player slug rejected', () => {
  const b = makeBackup(); b.nba2k_players.push(player('alpha'));
  assert.ok(R.validateBackup(b).errors.some(e => e.includes('Duplicate nba2k_players.slug')));
});

test('duplicate pool nba2k_ref rejected', () => {
  const b = makeBackup(); b.nba2k27_pool.push(poolRow('alpha'));
  assert.ok(R.validateBackup(b).errors.some(e => e.includes('Duplicate nba2k27_pool.nba2k_ref')));
});

test('orphan pool reference rejected and listed', () => {
  const b = makeBackup(); b.nba2k27_pool.push(poolRow('ghost'));
  const { errors, orphans } = R.validateBackup(b);
  assert.deepStrictEqual(orphans, ['ghost']);
  assert.ok(errors.some(e => e.includes('orphans') && e.includes('ghost')));
});

test('unexpected column rejected (players and pool)', () => {
  const b1 = makeBackup(); b1.nba2k_players[0].mystery = 1;
  assert.ok(R.validateBackup(b1).errors.some(e => e.includes('unexpected column') && e.includes('mystery')));
  const b2 = makeBackup(); b2.nba2k27_pool[0].team_override = 'x';
  assert.ok(R.validateBackup(b2).errors.some(e => e.includes('unexpected column') && e.includes('team_override')));
});

test('missing column rejected (no defaults may replace backed-up values)', () => {
  const b = makeBackup(); delete b.nba2k_players[0].badges;
  assert.ok(R.validateBackup(b).errors.some(e => e.includes('missing column') && e.includes('badges')));
});

test('per-column type / schema checks (NOT NULL, CHECK values, timestamps)', () => {
  const cases = [
    [b => { b.nba2k_players[0].name = null; }, "'name'"],
    [b => { b.nba2k_players[0].overall = null; }, "'overall'"],
    [b => { b.nba2k_players[0].overall = 99999; }, "'overall'"],
    [b => { b.nba2k_players[0].positions = null; }, "'positions'"],
    [b => { b.nba2k_players[0].attributes = []; }, "'attributes'"],
    [b => { b.nba2k_players[0].last_updated = 'yesterday'; }, "'last_updated'"],
    [b => { b.nba2k27_pool[0].pool = 'red'; }, "'pool'"],
    [b => { b.nba2k27_pool[0].position = 'XX'; }, "'position'"],
    [b => { b.nba2k27_pool[0].selected_at = null; }, "'selected_at'"],
    [b => { b.nba2k27_pool[0].updated_at = null; }, "'updated_at'"],
    [b => { b.nba2k27_pool[0].overall_override = 1.5; }, "'overall_override'"],
  ];
  for (const [mutate, needle] of cases) {
    const b = makeBackup(); mutate(b);
    assert.ok(R.validateBackup(b).errors.some(e => e.includes(needle)), needle);
  }
});

test('NUL characters rejected (jsonb cannot store them)', () => {
  const b = makeBackup(); b.league_state.data.note = 'a\u0000b';
  assert.ok(R.validateBackup(b).errors.some(e => e.includes('NUL')));
});

test('unexpected top-level key rejected', () => {
  const b = makeBackup(); b.extra = [];
  assert.ok(R.validateBackup(b).errors.some(e => e.includes('Unexpected top-level key')));
});

test('invalid backup sends NOTHING to the network (not even reads)', async () => {
  const b = makeBackup(); b.nba2k27_pool.push(poolRow('ghost'));
  const r = await run(b, ['--apply'], liveWithAll());
  assert.strictEqual(r.code, 1);
  assert.strictEqual(r.fake.calls.length, 0);
  assert.ok(r.err.includes('BACKUP VALIDATION FAILED'));
});

test('unparseable JSON file fails cleanly', async () => {
  const r = await run('{not json', [], {});
  assert.strictEqual(r.code, 1);
  assert.strictEqual(r.fake.calls.length, 0);
});

// ─── CLI ────────────────────────────────────────────────────────────────

test('CLI argument errors', () => {
  assert.ok(R.parseArgs([]).error);
  assert.ok(R.parseArgs(['f.json', '--bogus']).error);
  assert.ok(R.parseArgs(['a.json', 'b.json']).error);
  assert.ok(R.parseArgs(['f.json', '--yes']).error, '--yes without --apply');
  assert.ok(R.parseArgs(['f.json', '--apply', '--snapshot-dir']).error);
  const ok = R.parseArgs(['f.json', '--apply', '--yes', '--snapshot-dir', '/x']);
  assert.deepStrictEqual([ok.error, ok.apply, ok.yes, ok.snapshotDir], [null, true, true, '/x']);
  assert.strictEqual(R.parseArgs(['f.json']).apply, false, 'dry run is the default');
});

// ─── Dry run ────────────────────────────────────────────────────────────

test('dry run performs no writes (reads only) and reports the plan', async () => {
  const live = { players: [player('alpha', { name: 'Changed' }), player('zzz-extra')], pool: [poolRow('alpha'), poolRow('zzz-extra')] };
  const r = await run(makeBackup(), [], live);
  assert.strictEqual(r.code, 0);
  assert.deepStrictEqual(writesOf(r.fake), []);
  assert.ok(r.out.includes('ROLL-FORWARD OVERWRITE — extra live rows will NOT be deleted.'));
  assert.ok(r.out.includes('DRY RUN'));
  assert.ok(/already exist \(would be overwritten\): 1 {2}\(of which 1 differ/.test(r.out));
  assert.ok(/new rows \(would be created\):\s+2/.test(r.out));
  assert.ok(r.out.includes('NOT in the backup and will be LEFT AS-IS'));
  assert.ok(r.out.includes('league_state: WOULD BE REPLACED'));
  assert.ok(r.out.includes('Live league_state.updated_at: 2026-10-03'));
});

test('dry run with no credentials validates offline and makes no network calls', async () => {
  const fake = makeFake(); const out = [];
  const prev = process.env.SUPABASE_SERVICE_ROLE_KEY; delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    const code = await R.main([writeBackupFile(makeBackup())], { fetch: fake.fetch, log: (...a) => out.push(a.join(' ')), error: () => {} });
    assert.strictEqual(code, 0);
  } finally { if (prev !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = prev; }
  assert.strictEqual(fake.calls.length, 0);
  assert.ok(out.join('\n').includes('Live comparison skipped'));
});

test('--apply without credentials fails before any network call', async () => {
  const fake = makeFake(); const err = [];
  const prev = process.env.SUPABASE_SERVICE_ROLE_KEY; delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  let code;
  try {
    code = await R.main([writeBackupFile(makeBackup()), '--apply', '--yes'], { fetch: fake.fetch, log: () => {}, error: (...a) => err.push(a.join(' ')) });
  } finally { if (prev !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = prev; }
  assert.strictEqual(code, 1);
  assert.strictEqual(fake.calls.length, 0);
  assert.ok(err.join('\n').includes('SUPABASE_SERVICE_ROLE_KEY'));
});

// ─── Apply: order, RPC, preservation, no deletes ────────────────────────

test('players are written before pool; league_state is written last', async () => {
  const r = await run(makeBackup(), ['--apply'], { players: [], pool: [] });
  assert.strictEqual(r.code, 0, r.err);
  const order = writesOf(r.fake).map(c => c.target.split('?')[0]);
  assert.deepStrictEqual(order, ['nba2k_players', 'nba2k27_pool', 'rpc/save_league_state']);
});

test('league_state uses the save_league_state RPC with ONLY data (no id / updated_at)', async () => {
  const b = makeBackup();
  const r = await run(b, ['--apply'], {});
  assert.strictEqual(r.code, 0, r.err);
  assert.deepStrictEqual(Object.keys(r.fake.rpcArgs), ['p_data']);
  assert.deepStrictEqual(r.fake.rpcArgs.p_data, b.league_state.data);
  assert.ok(!writesOf(r.fake).some(c => c.target.startsWith('league_state')), 'no direct table write to league_state');
});

test('backup timestamps and nullable overrides are preserved exactly for NBA tables', async () => {
  const b = makeBackup();
  const r = await run(b, ['--apply'], {});
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(r.fake.players.get('alpha').last_updated, TS_A);
  assert.strictEqual(r.fake.players.get('alpha').imported_at, TS_B);
  assert.strictEqual(r.fake.pool.get('alpha').selected_at, TS_A);
  assert.strictEqual(r.fake.pool.get('alpha').updated_at, TS_B);
  assert.strictEqual(r.fake.pool.get('alpha').overall_override, null);
  assert.strictEqual(r.fake.pool.get('bravo').overall_override, 90);
  assert.strictEqual(r.fake.pool.get('bravo').name_override, 'Bravo!');
});

test('extra live rows are NOT deleted; no DELETE/PATCH/PUT is ever issued', async () => {
  const live = { players: [player('zzz-extra')], pool: [poolRow('zzz-extra')] };
  const r = await run(makeBackup(), ['--apply'], live);
  assert.strictEqual(r.code, 0, r.err);
  assert.ok(r.fake.players.has('zzz-extra'));
  assert.ok(r.fake.pool.has('zzz-extra'));
  assert.ok(r.out.includes('left untouched') || r.out.includes('LEFT AS-IS'));
  assert.deepStrictEqual(r.fake.calls.map(c => c.method).filter(m => !['GET', 'POST'].includes(m)), []);
});

test('upserts are batched at 500 rows', async () => {
  const b = makeBackup();
  b.nba2k_players = Array.from({ length: 1201 }, (_, i) => player(`p${String(i).padStart(5, '0')}`));
  b.nba2k27_pool = [poolRow('p00000')];
  const r = await run(b, ['--apply'], {});
  assert.strictEqual(r.code, 0, r.err);
  assert.deepStrictEqual(r.fake.batchSizes.nba2k_players, [500, 500, 201]);
});

test('live reads page past the 1000-row PostgREST cap', async () => {
  const many = Array.from({ length: 2500 }, (_, i) => player(`p${String(i).padStart(5, '0')}`));
  const r = await run(makeBackup(), [], { players: many });
  assert.strictEqual(r.code, 0);
  const reads = r.fake.calls.filter(c => c.target.startsWith('nba2k_players'));
  assert.strictEqual(reads.length, 3);
  assert.ok(r.out.includes('live rows: 2500'));
});

// ─── Failure safety ─────────────────────────────────────────────────────

test('failure in players stops: pool and league_state are never written', async () => {
  const r = await run(makeBackup(), ['--apply'], { failTable: 'nba2k_players' });
  assert.strictEqual(r.code, 1);
  assert.deepStrictEqual(writesOf(r.fake).map(c => c.target.split('?')[0]), ['nba2k_players']);
  assert.ok(r.err.includes('nba2k27_pool and league_state were NOT written'));
  assert.ok(r.err.includes('Safety snapshot:'));
  assert.ok(!r.out.includes('RESTORE COMPLETE'));
});

test('failure in pool stops: league_state is never written', async () => {
  const r = await run(makeBackup(), ['--apply'], { failTable: 'nba2k27_pool' });
  assert.strictEqual(r.code, 1);
  assert.ok(!writesOf(r.fake).some(c => c.target.startsWith('rpc/')));
  assert.ok(r.err.includes('league_state was NOT written'));
  assert.ok(r.err.includes('Safety snapshot:'));
});

test('failure in league_state reports tables were restored + snapshot location, no rollback', async () => {
  const r = await run(makeBackup(), ['--apply'], { failRpc: true });
  assert.strictEqual(r.code, 1);
  assert.ok(r.err.includes('ALREADY RESTORED'));
  assert.ok(r.err.includes('No automatic rollback'));
  assert.ok(r.err.includes(r.snapDir));
  assert.deepStrictEqual(r.fake.calls.filter(c => c.method === 'DELETE'), []);
  assert.ok(r.fake.players.has('alpha'), 'earlier writes are left in place (not atomic)');
});

test('read-back mismatch is reported as FAILURE even though writes succeeded', async () => {
  const corrupt = (table, rows) => (table === 'nba2k_players' ? rows.map(r => (r.slug === 'bravo' ? { ...r, name: 'TAMPERED' } : r)) : rows);
  const r = await run(makeBackup(), ['--apply'], { corruptReadBack: corrupt });
  assert.strictEqual(r.code, 1);
  assert.ok(r.err.includes('RESTORE FAILED') && r.err.includes('read-back'));
  assert.ok(r.err.includes('bravo') && r.err.includes('name'));
  assert.ok(!r.out.includes('RESTORE COMPLETE'));
});

test('read-back league_state mismatch is a FAILURE', async () => {
  const corrupt = (table, rows) => rows; // players/pool fine
  const fake = makeFake({ corruptReadBack: corrupt });
  const orig = fake.fetch;
  fake.fetch = async (url, init) => {
    const res = await orig(url, init);
    if (fake.wrote && /league_state\?/.test(url) && (init.method || 'GET') === 'GET') {
      return { ...res, json: async () => [{ id: 'main', data: { different: true }, updated_at: 'x' }] };
    }
    return res;
  };
  const out = []; const err = [];
  const code = await R.main([writeBackupFile(makeBackup()), '--apply', '--yes', '--snapshot-dir', path.join(tmpRoot, `snap-${++n}`)],
    { fetch: fake.fetch, creds: CREDS, log: (...a) => out.push(a.join(' ')), error: (...a) => err.push(a.join(' ')) });
  assert.strictEqual(code, 1);
  assert.ok(err.join('\n').includes('league_state.data on read-back does not match'));
});

test('successful apply prints RESTORE COMPLETE with counts and snapshot location', async () => {
  const r = await run(makeBackup(), ['--apply'], liveWithAll());
  assert.strictEqual(r.code, 0, r.err);
  assert.ok(r.out.includes('RESTORE COMPLETE'));
  assert.ok(/players restored:\s+3/.test(r.out));
  assert.ok(/pool rows restored:\s+2/.test(r.out));
  assert.ok(r.out.includes('league state restored:  yes'));
  assert.ok(r.out.includes(r.snapDir));
});

// ─── Snapshot + confirmation ────────────────────────────────────────────

test('snapshot is written BEFORE any write, outside the repo, and holds all three live datasets', async () => {
  const live = { players: [player('alpha'), player('zzz-extra')], pool: [poolRow('alpha')], league: { id: 'main', data: { live: 'orig' }, updated_at: '2026-10-03T00:00:00.000000+00:00' } };
  let snapshotSeenBeforeWrite = false;
  const fake = makeFake(live);
  const orig = fake.fetch;
  fake.fetch = async (url, init) => {
    if ((init.method || 'GET') === 'POST' && !snapshotSeenBeforeWrite) {
      const snapDirNow = fs.readdirSync(path.join(tmpRoot, 'snap-order'));
      snapshotSeenBeforeWrite = snapDirNow.some(f => f.startsWith('supabase-snapshot-'));
    }
    return orig(url, init);
  };
  const code = await R.main([writeBackupFile(makeBackup()), '--apply', '--yes', '--snapshot-dir', path.join(tmpRoot, 'snap-order')],
    { fetch: fake.fetch, creds: CREDS, log: () => {}, error: () => {}, now: () => new Date('2026-10-04T12:30:00') });
  assert.strictEqual(code, 0);
  assert.ok(snapshotSeenBeforeWrite, 'snapshot file must exist before the first write');
  const file = fs.readdirSync(path.join(tmpRoot, 'snap-order')).find(f => f.startsWith('supabase-snapshot-'));
  const snap = JSON.parse(fs.readFileSync(path.join(tmpRoot, 'snap-order', file), 'utf8'));
  assert.strictEqual(snap.metadata.format, 'supabase-json-v1');
  assert.deepStrictEqual(snap.league_state.data, { live: 'orig' });
  assert.deepStrictEqual(snap.nba2k_players.map(p => p.slug), ['alpha', 'zzz-extra']);
  assert.strictEqual(snap.nba2k27_pool.length, 1);
  assert.ok(!path.resolve(path.join(tmpRoot, 'snap-order')).startsWith(R.REPO_ROOT));
});

test('snapshot inside the git repository is refused and nothing is written', async () => {
  const fake = makeFake(); const err = [];
  const code = await R.main([writeBackupFile(makeBackup()), '--apply', '--yes', '--snapshot-dir', path.join(R.REPO_ROOT, 'backups', 'oops')],
    { fetch: fake.fetch, creds: CREDS, log: () => {}, error: (...a) => err.push(a.join(' ')) });
  assert.strictEqual(code, 1);
  assert.deepStrictEqual(fake.calls.filter(c => c.method !== 'GET'), []);
  assert.ok(err.join('\n').includes('inside the git repository'));
  assert.ok(!fs.existsSync(path.join(R.REPO_ROOT, 'backups', 'oops')));
});

test('snapshot failure aborts the restore with zero writes', async () => {
  const blocker = path.join(tmpRoot, 'a-file-not-a-dir'); fs.writeFileSync(blocker, 'x');
  const fake = makeFake(); const err = [];
  const code = await R.main([writeBackupFile(makeBackup()), '--apply', '--yes', '--snapshot-dir', path.join(blocker, 'sub')],
    { fetch: fake.fetch, creds: CREDS, log: () => {}, error: (...a) => err.push(a.join(' ')) });
  assert.strictEqual(code, 1);
  assert.deepStrictEqual(fake.calls.filter(c => c.method !== 'GET'), []);
  assert.ok(err.join('\n').includes('safety snapshot'));
});

test('declined confirmation writes nothing (snapshot is kept)', async () => {
  const r = await run(makeBackup(), ['--apply'], {}, { confirm: async () => false });
  assert.strictEqual(r.code, 1);
  assert.deepStrictEqual(writesOf(r.fake), []);
  assert.ok(r.out.includes('ABORTED by user'));
  assert.ok(fs.readdirSync(r.snapDir).some(f => f.startsWith('supabase-snapshot-')));
});

test('--yes skips only the confirmation prompt (snapshot still taken)', async () => {
  let asked = 0;
  const r = await run(makeBackup(), ['--apply', '--yes'], {}, { confirm: async () => { asked++; return false; } });
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(asked, 0);
  assert.ok(fs.readdirSync(r.snapDir).some(f => f.startsWith('supabase-snapshot-')));
});

test('the league_state replacement warning is printed before any write', async () => {
  const r = await run(makeBackup(), ['--apply'], {});
  const warnAt = r.out.indexOf('REPLACES THE ENTIRE CURRENT LEAGUE STATE');
  assert.ok(warnAt > -1);
  assert.ok(warnAt < r.out.indexOf('Upserting'));
  assert.ok(r.out.includes('NOT atomic'));
});

test('--apply refuses when the live league_state/main row is missing (zero writes)', async () => {
  const r = await run(makeBackup(), ['--apply', '--yes'], { league: null });
  assert.strictEqual(r.code, 1);
  assert.deepStrictEqual(writesOf(r.fake), []);
  assert.ok(r.err.includes('league_state/main row does not exist'));
});

// ─── Comparison helpers ─────────────────────────────────────────────────

test('timestamp / jsonb comparison is format- and key-order-insensitive', () => {
  assert.strictEqual(R.canonicalTimestamp('2026-09-01T07:41:41.5Z'), R.canonicalTimestamp('2026-09-01T07:41:41.500000+00:00'));
  assert.strictEqual(R.canonicalTimestamp('2026-09-01T09:41:41+02:00'), R.canonicalTimestamp('2026-09-01T07:41:41Z'));
  assert.notStrictEqual(R.canonicalTimestamp('2026-09-01T07:41:41.123456Z'), R.canonicalTimestamp('2026-09-01T07:41:41.123457Z'));
  assert.strictEqual(R.canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] }), R.canonicalJson({ a: [2, { c: 2, d: 1 }], b: 1 }));
  assert.ok(R.isValidTimestamp(TS_A) && !R.isValidTimestamp('2026-13-45T00:00:00Z') && !R.isValidTimestamp(5));
});

// ─── Legacy restore untouched ───────────────────────────────────────────

test('legacy scripts/restore.js still exists and was not rewritten to use this tool', () => {
  const legacy = fs.readFileSync(path.join(R.REPO_ROOT, 'scripts', 'restore.js'), 'utf8');
  assert.ok(legacy.includes('firebase') || legacy.includes('initAdmin'));
  assert.ok(!legacy.includes('restore-supabase'));
});

Promise.all(pending).then(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  const total = pending.length;
  console.log(`\n${total - failures} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
});
