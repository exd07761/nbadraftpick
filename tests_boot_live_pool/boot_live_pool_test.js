'use strict';
/**
 * Boot regression test: Supabase live-pool preload in the shared boot.
 *
 * Runs the REAL js/public-router.js and js/admin.js source in a vm sandbox
 * (fake DOM, fake caches, fake timers) and drives their DOMContentLoaded
 * boot handler. Covers, for BOTH files:
 *
 *   - successful Supabase pool load (and that boot is held until it settles)
 *   - Supabase failure (rejected promise)
 *   - Supabase timeout / hang (the 8s bound, driven by a fake timer)
 *   - a SYNCHRONOUS throw from SupabaseLiveNba2k27PoolCache.ensureLoaded()
 *   - boot still completes in every case
 *   - no infinite retry (one request, one timer, however many events follow)
 *   - the legacy Firestore LiveNba2k27PoolCache preload is still there,
 *     still called once, and still non-fatal
 *   - boot performs no writes: the fake caches / FirebaseSync are Proxies that
 *     record any call other than the ones boot is meant to make
 *
 * Background: bafcde3 moved loadData() to SupabaseLiveNba2k27PoolCache but
 * the boots kept preloading only the legacy Firestore cache, so a cold open
 * of any live-pool page saw no live players. See the boot comments.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const SRC = {
  public: fs.readFileSync(path.join(root, 'js', 'public-router.js'), 'utf8'),
  admin: fs.readFileSync(path.join(root, 'js', 'admin.js'), 'utf8'),
};
const PUBLIC_VIEWS = ['HomeView', 'ScheduleView', 'StandingsView', 'PlayoffsView', 'PublicRosterView',
  'PublicPlayersView', 'PublicDraftView', 'PublicNba2k27View', 'PublicRosterSimulatorView'];
const ADMIN_VIEWS = ['AdminSeasonsView', 'AdminParticipantsView', 'AdminPlayersView', 'AdminDraftOrderView',
  'AdminDraftView', 'AdminTeamAssignmentView', 'AdminRosterView', 'AdminScheduleView', 'AdminPlayoffsView',
  'AdminTradesView', 'AdminFinancialView', 'AdminBackupView', 'Nba2kImport', 'Nba2kDatabaseView',
  'Nba2k27PoolView', 'Nba2k27PositionSortView'];

// Any call boot is NOT expected to make is recorded here (writes, saves, retries...).
function strictProxy(name, target, allowed, unexpected) {
  return new Proxy(target, {
    get(t, prop) {
      if (typeof prop === 'symbol' || prop === 'then') return t[prop];
      if (!allowed.includes(prop)) { unexpected.push(`${name}.${String(prop)}`); }
      return t[prop];
    },
  });
}

function makeEnv(kind, { supabase = 'resolve', firestore = 'resolve' } = {}) {
  const c = { supabaseCalls: 0, firestoreCalls: 0, renders: [], errors: [], timers: [], remote: [], unexpected: [], bootError: null, finished: false };
  const els = {};
  const mkEl = (id) => ({
    id, dataset: {}, style: {}, value: '', textContent: '', innerHTML: '', disabled: false, checked: false,
    classList: { _s: new Set(), add(x) { this._s.add(x); }, remove(x) { this._s.delete(x); }, contains(x) { return this._s.has(x); },
      toggle(x, f) { (f === undefined ? !this._s.has(x) : f) ? this._s.add(x) : this._s.delete(x); } },
    addEventListener() {}, focus() {},
  });
  let handler = null;
  const document = {
    addEventListener(type, fn) { if (type === 'DOMContentLoaded') handler = fn; },
    getElementById(id) { return els[id] || (els[id] = mkEl(id)); },
    querySelectorAll() { return []; },
    querySelector() { return null; },
  };
  // Controlled Supabase pool: tests decide when/how it settles.
  const gate = new Promise((res, rej) => { c.resolveSupabase = res; c.rejectSupabase = rej; });
  gate.catch(() => {});
  const supa = {
    ensureLoaded() {
      c.supabaseCalls++;
      if (supabase === 'resolve') return Promise.resolve({});
      if (supabase === 'reject') return Promise.reject(new Error('supabase boom'));
      if (supabase === 'hang') return new Promise(() => {});
      if (supabase === 'syncThrow') throw new ReferenceError('SupabaseReadsCore is not defined');
      return gate; // 'controlled'
    },
  };
  const fsCache = {
    ensureLoaded() { c.firestoreCalls++; return firestore === 'reject' ? Promise.reject(new Error('firestore boom')) : Promise.resolve({}); },
  };
  const firebaseSync = {
    init() { return Promise.resolve(); },
    onRemoteChange(fn) { c.remote.push(fn); },
  };
  const sandbox = {
    document,
    FirebaseSync: strictProxy('FirebaseSync', firebaseSync, ['init', 'onRemoteChange'], c.unexpected),
    LiveNba2k27PoolCache: strictProxy('LiveNba2k27PoolCache', fsCache, ['ensureLoaded'], c.unexpected),
    SupabaseLiveNba2k27PoolCache: strictProxy('SupabaseLiveNba2k27PoolCache', supa, ['ensureLoaded'], c.unexpected),
    AuthBoundary: { ready: () => Promise.resolve(false), onAuthStateChanged() {}, login: async () => ({ ok: false }), logout: async () => {}, getCurrentUser: () => null },
    console: { error: (...a) => c.errors.push(a), log() {}, warn() {} },
    // fake timers: nothing runs until the test fires it, so the 8s bound is instant and deterministic
    setTimeout: (fn, ms) => { c.timers.push({ fn, ms, fired: false }); return c.timers.length; },
    clearTimeout() {},
    location: { hash: '' },
    history: { replaceState() {} },
  };
  (kind === 'public' ? PUBLIC_VIEWS : ADMIN_VIEWS).forEach((n) => { sandbox[n] = { render() { c.renders.push(n); } }; });
  vm.createContext(sandbox);
  vm.runInContext(SRC[kind], sandbox, { filename: kind === 'public' ? 'public-router.js' : 'admin.js' });
  if (!handler) throw new Error('DOMContentLoaded handler was not registered');
  c.bootEl = document.getElementById('bootLoading');
  c.start = () => { c.bootPromise = handler(); c.bootPromise.then(() => { c.finished = true; }, (e) => { c.bootError = e; }); return c.bootPromise; };
  c.fireTimers = () => { let n = 0; c.timers.forEach((t) => { if (!t.fired) { t.fired = true; t.fn(); n++; } }); return n; };
  c.bootComplete = () => c.finished && c.bootEl.classList.contains('hidden') && (kind !== 'public' || c.renders.includes('HomeView'));
  return c;
}

const flush = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); };
const unhandled = [];
process.on('unhandledRejection', (r) => unhandled.push(r));

let pass = 0, fail = 0;
async function check(name, fn) {
  unhandled.length = 0;
  try { await fn(); pass++; console.log(`  ok - ${name}`); }
  catch (e) { fail++; console.log(`  FAIL - ${name}`); console.log(`         ${e.message}`); }
}
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg || 'assertion failed'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function truthy(v, msg) { if (!v) throw new Error(msg || 'expected truthy'); }
const supaErrors = (c) => c.errors.filter((a) => String(a[0]).includes('Failed to load the Supabase live NBA2K27 pool'));

async function main() {
  console.log('Boot live-pool regression tests:');
  for (const kind of ['public', 'admin']) {
    const tag = kind === 'public' ? 'public-router.js' : 'admin.js';
    console.log(`\n[${tag}]`);

    await check(`${kind}: success — boot is HELD until the Supabase pool settles, then completes (1 request, no errors)`, async () => {
      const c = makeEnv(kind, { supabase: 'controlled' }); c.start(); await flush();
      eq(c.supabaseCalls, 1, 'Supabase preload requested at boot');
      eq(c.bootComplete(), false, 'boot must not complete (or first-render) before the pool settles');
      eq(c.bootEl.classList.contains('hidden'), false, 'boot spinner must still be showing');
      if (kind === 'public') eq(c.renders.length, 0, 'no view may render before the pool settles');
      c.resolveSupabase({}); await flush();
      truthy(c.bootComplete(), 'boot completes once the pool settles');
      eq(c.supabaseCalls, 1, 'still exactly one request');
      eq(c.errors.length, 0, 'no errors logged');
      eq(c.fireTimers() >= 0, true);
      eq(unhandled.length, 0, 'no unhandled rejections');
    });

    await check(`${kind}: success (already-settled pool) — boot completes without waiting for the 8s timer`, async () => {
      const c = makeEnv(kind, { supabase: 'resolve' }); c.start(); await flush();
      truthy(c.bootComplete(), 'boot completed with the timer never fired');
      eq(c.timers.filter((t) => t.fired).length, 0, 'timeout was not needed');
    });

    await check(`${kind}: Supabase failure — logged, boot still completes, no unhandled rejection, no retry`, async () => {
      const c = makeEnv(kind, { supabase: 'reject' }); c.start(); await flush();
      truthy(c.bootComplete(), 'boot completes despite the failure');
      eq(supaErrors(c).length, 1, 'one Supabase error logged');
      truthy(String(supaErrors(c)[0][0]).startsWith(`[${kind === 'public' ? 'public-router' : 'AdminApp'}]`), 'uses the file\'s own logger prefix');
      eq(c.supabaseCalls, 1, 'not retried');
      eq(c.bootError, null, 'boot did not abort');
      eq(unhandled.length, 0, 'no unhandled rejections');
    });

    await check(`${kind}: Supabase hang — boot is bounded at exactly 8000ms, then completes`, async () => {
      const c = makeEnv(kind, { supabase: 'hang' }); c.start(); await flush();
      eq(c.bootComplete(), false, 'boot waits while the request is pending');
      eq(c.timers.length, 1, 'exactly one timeout scheduled');
      eq(c.timers[0].ms, 8000, 'timeout is 8 seconds');
      c.fireTimers(); await flush();
      truthy(c.bootComplete(), 'boot completes once the bound elapses');
      eq(c.bootError, null); eq(c.supabaseCalls, 1); eq(unhandled.length, 0, 'no unhandled rejections');
    });

    await check(`${kind}: SYNCHRONOUS throw from ensureLoaded() — handled, logged, boot completes (does not abort)`, async () => {
      const c = makeEnv(kind, { supabase: 'syncThrow' }); c.start(); await flush();
      truthy(c.bootComplete(), 'boot completes');
      eq(c.bootError, null, 'boot handler did not reject');
      eq(supaErrors(c).length, 1, 'error logged');
      truthy(String(supaErrors(c)[0][1]).includes('SupabaseReadsCore is not defined'), 'the original error is passed to the logger');
      eq(unhandled.length, 0, 'no unhandled rejections');
    });

    await check(`${kind}: no infinite retry — after failure/hang/sync-throw, repeated timers, ticks and remote-change events add no requests or timers`, async () => {
      for (const mode of ['reject', 'hang', 'syncThrow']) {
        const c = makeEnv(kind, { supabase: mode }); c.start(); await flush();
        if (mode === 'hang') { c.fireTimers(); await flush(); }
        for (let i = 0; i < 5; i++) { c.fireTimers(); await flush(); c.remote.forEach((fn) => fn()); await flush(); }
        eq(c.supabaseCalls, 1, `${mode}: exactly one Supabase request ever`);
        eq(c.timers.length, 1, `${mode}: no retry/backoff timers were created`);
        eq(c.firestoreCalls, 1, `${mode}: legacy preload not re-run`);
      }
    });

    await check(`${kind}: legacy Firebase LiveNba2k27PoolCache preload is untouched — still called once, and its failure is still non-fatal with its original message`, async () => {
      const ok = makeEnv(kind, { supabase: 'resolve' }); ok.start(); await flush();
      eq(ok.firestoreCalls, 1, 'legacy preload still runs once');
      const bad = makeEnv(kind, { supabase: 'resolve', firestore: 'reject' }); bad.start(); await flush();
      truthy(bad.bootComplete(), 'boot completes even if the legacy preload fails');
      const legacyMsg = bad.errors.filter((a) => String(a[0]).includes('Failed to load the live NBA2K27 pool'));
      eq(legacyMsg.length, 1, 'original legacy error message still logged');
      eq(bad.errors.filter((a) => String(a[0]).includes('Supabase')).length, 0, 'and it is not confused with the Supabase message');
    });

    await check(`${kind}: boot performs no writes — only ensureLoaded/init/onRemoteChange are ever called`, async () => {
      for (const mode of ['controlled', 'resolve', 'reject', 'hang', 'syncThrow']) {
        const c = makeEnv(kind, { supabase: mode }); c.start(); await flush();
        if (mode === 'controlled') { c.resolveSupabase({}); await flush(); }
        if (mode === 'hang') { c.fireTimers(); await flush(); }
        c.remote.forEach((fn) => fn()); await flush();
        eq(JSON.stringify(c.unexpected), '[]', `${mode}: unexpected calls on FirebaseSync / caches (save, set, update, delete, ...)`);
      }
    });

    await check(`${kind}: source shape — both preloads sit in the ONE existing Promise.all; hardened pattern present`, async () => {
      const src = SRC[kind];
      eq((src.match(/Promise\.all\(/g) || []).length, 1, 'exactly one boot Promise.all');
      const start = src.indexOf('await Promise.all([');
      const block = src.slice(start, src.indexOf('  ]);', start));
      eq((block.match(/(?<![A-Za-z])LiveNba2k27PoolCache\.ensureLoaded\(\)\.catch/g) || []).length, 1, 'legacy Firestore preload still present, once');
      truthy(/Promise\.race\(\[\s*Promise\.resolve\(\)\.then\(\(\) => SupabaseLiveNba2k27PoolCache\.ensureLoaded\(\)\),\s*new Promise\(\(resolve\) => setTimeout\(resolve, 8000\)\),\s*\]\)\.catch\(/.test(block),
        'Promise.race([Promise.resolve().then(() => SupabaseLiveNba2k27PoolCache.ensureLoaded()), 8000ms timeout]).catch(...) is inside the same Promise.all');
    });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main();
