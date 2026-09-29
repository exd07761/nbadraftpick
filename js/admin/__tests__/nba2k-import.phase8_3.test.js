/**
 * Phase 8.3 — focused, framework-free tests for the new pure logic added
 * to js/admin/nba2k-import.js: `_toRpcPlayer()` (camelCase preview item
 * -> snake_case RPC payload) and `_mapImportRpcError()` (RPC error ->
 * friendly message). No test framework is introduced — plain Node
 * `assert`, run with `node js/admin/__tests__/nba2k-import.phase8_3.test.js`.
 *
 * The rest of nba2k-import.js (file parsing, validation, slug/badge
 * normalization, the preview UI, DOM wiring) depends on browser globals
 * (firebase — for other unrelated historical reasons kept out of this
 * file's execution path, AuthBoundary, SupabaseQuery, escapeHtml,
 * showToast, the DOM) and is NOT covered here — this script only
 * isolates the two new pure functions this phase actually added.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE_PATH = path.join(__dirname, '..', 'nba2k-import.js');
const source = fs.readFileSync(SOURCE_PATH, 'utf8');

// The file only *defines* `const Nba2kImport = {...}` at the top level —
// none of its methods run until called, so none of the browser globals
// they reference (firebase, AuthBoundary, SupabaseQuery, escapeHtml,
// showToast) need to exist just to load the object and test the two
// pure methods below.
const sandbox = {};
vm.createContext(sandbox);
// `const Nba2kImport = {...}` doesn't attach to the context object as a
// property (unlike `var`), so the object is retrieved via the script's
// completion value instead — appending a trailing expression statement
// referencing the binding.
const Nba2kImport = vm.runInContext(source + '\n;Nba2kImport;', sandbox, { filename: SOURCE_PATH });

assert.ok(Nba2kImport, 'Nba2kImport should be defined after evaluating the file');
assert.strictEqual(typeof Nba2kImport._toRpcPlayer, 'function', '_toRpcPlayer must exist');
assert.strictEqual(typeof Nba2kImport._mapImportRpcError, 'function', '_mapImportRpcError must exist');

let passed = 0;
function check(label, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok - ${label}`);
  } catch (e) {
    console.error(`  FAIL - ${label}`);
    console.error(`    ${e.message}`);
    process.exitCode = 1;
  }
}

console.log('_toRpcPlayer()');

check('maps every field from camelCase doc to the snake_case RPC shape', () => {
  const item = {
    slug: 'aaron-gordon',
    doc: {
      name: 'Aaron Gordon',
      team: 'Denver Nuggets',
      teamType: 'curr',
      overall: 83,
      positions: ['PF', 'C'],
      height: `6'8"`,
      weight: '235 lbs',
      wingspan: `7'0"`,
      build: 'Athletic',
      playerUrl: 'https://www.2kratings.com/aaron-gordon',
      playerImage: 'https://example.com/aaron-gordon.png',
      teamImg: 'https://example.com/den.png',
      attributes: { speed: 71, strength: 79 },
      badges: { gold: 3, silver: 5, bronze: 4, legendary: 0, hallOfFame: 0, total: 12, list: [] },
      lastUpdated: '2026-08-30T01:53:18.756Z',
    },
  };

  const rpc = Nba2kImport._toRpcPlayer(item);

  assert.strictEqual(rpc.slug, 'aaron-gordon');
  assert.strictEqual(rpc.name, 'Aaron Gordon');
  assert.strictEqual(rpc.team, 'Denver Nuggets');
  assert.strictEqual(rpc.team_type, 'curr'); // camelCase -> snake_case
  assert.strictEqual(rpc.overall, 83);
  assert.deepStrictEqual(rpc.positions, ['PF', 'C']);
  assert.strictEqual(rpc.height, `6'8"`);
  assert.strictEqual(rpc.weight, '235 lbs');
  assert.strictEqual(rpc.wingspan, `7'0"`);
  assert.strictEqual(rpc.build, 'Athletic');
  assert.strictEqual(rpc.player_url, 'https://www.2kratings.com/aaron-gordon');
  assert.strictEqual(rpc.player_image, 'https://example.com/aaron-gordon.png');
  assert.strictEqual(rpc.team_img, 'https://example.com/den.png');
  assert.deepStrictEqual(rpc.attributes, { speed: 71, strength: 79 });
  assert.deepStrictEqual(rpc.badges, { gold: 3, silver: 5, bronze: 4, legendary: 0, hallOfFame: 0, total: 12, list: [] });
  assert.strictEqual(rpc.last_updated, '2026-08-30T01:53:18.756Z');
});

check('never includes imported_at — the RPC always sets it server-side', () => {
  const item = { slug: 'x', doc: { name: 'X', team: 'T', teamType: 'curr', overall: 70, positions: [], height: null, weight: null, wingspan: null, build: null, playerUrl: 'u', playerImage: null, teamImg: null, attributes: {}, badges: {}, lastUpdated: null } };
  const rpc = Nba2kImport._toRpcPlayer(item);
  assert.strictEqual('imported_at' in rpc, false, 'imported_at must not be present in the client payload');
  assert.strictEqual('importedAt' in rpc, false, 'importedAt (camelCase) must not leak through either');
});

check('passes through null values for optional fields unchanged', () => {
  const item = { slug: 'aaron-holiday', doc: { name: 'Aaron Holiday', team: 'T', teamType: 'curr', overall: 72, positions: ['SG', 'PG'], height: null, weight: null, wingspan: null, build: null, playerUrl: 'u', playerImage: null, teamImg: null, attributes: {}, badges: {}, lastUpdated: null } };
  const rpc = Nba2kImport._toRpcPlayer(item);
  assert.strictEqual(rpc.height, null);
  assert.strictEqual(rpc.weight, null);
  assert.strictEqual(rpc.wingspan, null);
  assert.strictEqual(rpc.last_updated, null);
});

console.log('_mapImportRpcError()');

check('maps UNAUTHENTICATED to a friendly permission message', () => {
  const msg = Nba2kImport._mapImportRpcError(new Error('UNAUTHENTICATED: sign-in required'));
  assert.ok(/permission/i.test(msg), `expected a permission-related message, got: ${msg}`);
});

check('maps UNAUTHORIZED to a friendly permission message', () => {
  const msg = Nba2kImport._mapImportRpcError(new Error('UNAUTHORIZED: commissioner access required'));
  assert.ok(/permission/i.test(msg), `expected a permission-related message, got: ${msg}`);
});

check('maps INVALID_PAYLOAD to a friendly malformed-data message', () => {
  const msg = Nba2kImport._mapImportRpcError(new Error('INVALID_PAYLOAD: p_players must be a JSON array of player objects.'));
  assert.ok(/malformed/i.test(msg), `expected a malformed-data message, got: ${msg}`);
});

check('falls back to the raw message for an unrecognized error', () => {
  const msg = Nba2kImport._mapImportRpcError(new Error('some other database error'));
  assert.strictEqual(msg, 'some other database error');
});

check('falls back to "Unknown error." when given no message at all', () => {
  const msg = Nba2kImport._mapImportRpcError({});
  assert.strictEqual(msg, 'Unknown error.');
});

console.log(`\n${passed} check(s) passed.`);
if (process.exitCode) {
  console.error('SOME CHECKS FAILED');
  process.exit(1);
} else {
  console.log('ALL CHECKS PASSED');
}
