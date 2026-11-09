const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'js', 'supabase-sync.js'), 'utf8');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => setImmediate(resolve));

function makeHarness({ host = 'app.example.com', flag = false, diag = false } = {}) {
  let row = { id: 'main', data: { n: 0 }, updated_at: 'v0' };
  let realtime;
  const rpcCalls = [];
  let selectCalls = 0;
  const responses = [];
  let selectFailure = null;
  const client = {
    from() { return { select() { return { eq() { return { maybeSingle: async () => {
      selectCalls++;
      if (selectFailure) throw selectFailure;
      return { data: structuredClone(row), error: null };
    } }; } }; } }; },
    rpc(_name, args) {
      const gate = responses.shift();
      rpcCalls.push({ args, gate });
      if (gate) return gate.promise;
      row = { id: 'main', data: structuredClone(args.p_data), updated_at: `v${Number(row.updated_at.slice(1)) + 1}` };
      return Promise.resolve({ data: { updated_at: row.updated_at }, error: null });
    },
    channel() { return { on(_type, _filter, callback) { realtime = callback; return this; }, subscribe() { return this; } }; },
  };
  const window = { DRAFTP_DEV_ADMIN: flag, DRAFTP_DEV_DIAGNOSTICS: { enabled: diag, pageInstanceId: 'test' }, location: { hostname: host } };
  const context = { window, SupabaseClient: client, stripLiveNba2k27PoolPlayers: x => structuredClone(x), console, crypto, setTimeout, clearTimeout };
  vm.runInNewContext(`${source}\nglobalThis.__syncForTest = SupabaseSync;`, context, { filename: 'supabase-sync.js' });
  const sync = context.__syncForTest;
  return {
    sync, window, rpcCalls, responses,
    get selectCalls() { return selectCalls; },
    get row() { return structuredClone(row); },
    set row(value) { row = structuredClone(value); },
    failSelect(error) { selectFailure = error; },
    event() { realtime({ eventType: 'UPDATE', new: { id: 'main' } }); },
    gate() { const d = deferred(); responses.push(d); return d; },
  };
}

async function test(name, fn) { await fn(); console.log(`ok - ${name}`); }
(async () => {
  await test('queued payload is rejected after Realtime advances the remote generation', async () => {
    const h = makeHarness(); await h.sync.init();
    h.sync.save({ n: 1 });
    h.row = { id: 'main', data: { n: 9 }, updated_at: 'v9' };
    h.event();
    await assert.rejects(h.sync.waitForPendingSave(), /remote update arrived/);
    assert.deepEqual(h.sync.getCache(), { n: 9 });
    assert.equal(h.rpcCalls.length, 0);
  });

  await test('Realtime event during an in-flight write is fetched before the next queued payload', async () => {
    const h = makeHarness(); await h.sync.init();
    const gate = h.gate(); h.sync.save({ n: 1 }); await tick();
    h.sync.save({ n: 2 });
    h.row = { id: 'main', data: { n: 8 }, updated_at: 'v8' };
    h.event();
    gate.resolve({ data: { updated_at: 'v1' }, error: null });
    await assert.rejects(h.sync.waitForPendingSave(), /remote update arrived/);
    assert.deepEqual(h.sync.getCache(), { n: 8 });
    assert.equal(h.rpcCalls.length, 1);
  });

  await test('multiple same-tab writes keep call order and use successive versions', async () => {
    const h = makeHarness(); await h.sync.init();
    h.sync.save({ n: 1 }); h.sync.save({ n: 2 });
    await h.sync.waitForPendingSave();
    assert.deepEqual(h.rpcCalls.map(x => x.args.p_data.n), [1, 2]);
    assert.deepEqual(h.rpcCalls.map(x => x.args.p_expected_updated_at), ['v0', 'v1']);
  });

  await test('failed save reconciles cache from a successful refresh and remains blocked', async () => {
    const h = makeHarness(); await h.sync.init();
    h.gate().resolve({ data: null, error: { code: 'XX000', message: 'failed' } });
    h.sync.save({ n: 5 });
    await assert.rejects(h.sync.waitForPendingSave()); await tick();
    assert.deepEqual(h.sync.getCache(), { n: 0 });
    const originalError = h.sync.getSyncError();
    assert.match(originalError.message, /Cloud save failed: failed/);
    h.sync.save({ n: 6 });
    await assert.rejects(h.sync.waitForPendingSave(), /Writes are paused/);
    assert.equal(h.sync.getSyncError(), originalError, 'a blocked save must retain the original failure');
    assert.match(h.sync.getSyncError().message, /Cloud save failed: failed/);
    assert.equal(h.selectCalls, 2, 'a pre-persist rejection must not start another recovery refresh');
    assert.equal(h.sync.getDiagnostics, undefined);
  });

  await test('failed save and failed refresh preserve explicit error state and block writes', async () => {
    const h = makeHarness(); await h.sync.init();
    h.failSelect(new Error('offline'));
    h.gate().resolve({ data: null, error: { code: 'XX000', message: 'failed' } });
    h.sync.save({ n: 5 });
    await assert.rejects(h.sync.waitForPendingSave()); await tick();
    assert.equal(h.sync.getSyncError().message.includes('refresh failed'), true);
    assert.deepEqual(h.sync.getCache(), { n: 0 });
    h.sync.save({ n: 6 });
    await assert.rejects(h.sync.waitForPendingSave(), /Writes are paused/);
    assert.equal(h.selectCalls, 2, 'a blocked save must not repeat recovery after a failed refresh');
  });

  await test('missing version sets a meaningful sync error without persisting or refreshing', async () => {
    const h = makeHarness();
    h.row = { id: 'main', data: { n: 0 }, updated_at: null };
    await assert.rejects(h.sync.init(), /no version metadata/);
    h.sync.save({ n: 1 });
    await assert.rejects(h.sync.waitForPendingSave(), /No league version is available/);
    assert.match(h.sync.getSyncError().message, /No league version is available/);
    assert.equal(h.rpcCalls.length, 0);
    assert.equal(h.selectCalls, 1, 'version precondition failure must not trigger recovery refresh');
  });

  await test('saveAndConfirm completion cannot replace a later optimistic save snapshot', async () => {
    const h = makeHarness(); await h.sync.init();
    const gate = h.gate();
    const confirmed = h.sync.saveAndConfirm({ n: 1 }); await tick();
    h.sync.save({ n: 2 });
    gate.resolve({ data: { updated_at: 'v1' }, error: null });
    await confirmed;
    assert.deepEqual(h.sync.getCache(), { n: 2 });
    await h.sync.waitForPendingSave();
  });

  for (const code of ['PT409', '40001']) {
    await test(`conflict ${code} refreshes authoritative state and blocks stale writes`, async () => {
      const h = makeHarness(); await h.sync.init();
      h.row = { id: 'main', data: { n: 7 }, updated_at: 'v7' };
      h.gate().resolve({ data: null, error: { code, message: 'conflict' } });
      h.sync.save({ n: 3 });
      await assert.rejects(h.sync.waitForPendingSave()); await tick();
      assert.deepEqual(h.sync.getCache(), { n: 7 });
      assert.equal(h.rpcCalls.length, 1);
    });
  }

  await test('production page flag alone cannot expose injected-client factory or diagnostics', async () => {
    const h = makeHarness({ host: 'app.example.com', flag: true, diag: true });
    assert.equal(h.window.createDraftPSupabaseSync, undefined);
    assert.equal(h.sync.getDiagnostics, undefined);
    const dev = makeHarness({ host: 'localhost', flag: true, diag: true });
    assert.equal(typeof dev.window.createDraftPSupabaseSync, 'function');
  });
})().catch(error => { console.error(error); process.exitCode = 1; });
