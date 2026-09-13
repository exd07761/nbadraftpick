'use strict';
/**
 * Phase B — sidebar navigation-only cleanup.
 *
 * Verifies that:
 *   A. The "NBA 2K Player Database" sidebar nav link is no longer present
 *      in admin.html's markup.
 *   B. "Players" nav link is still present.
 *   C. "NBA2K Import" nav link is still present.
 *   D. "NBA 2K27 Position Sorting" nav link is still present.
 *   E. The other Management-group nav links (Participants, Trade / Swap,
 *      Finances, Backup) are still present.
 *   F. The existing route registration for the `nba2kDatabase` view key
 *      in js/admin.js was NOT deleted (direct navigation must keep working).
 *   G. Nba2kDatabaseView remains defined in js/admin/nba2k-database.js
 *      (internal functionality preserved).
 *
 * This is a static/string-based test — it parses admin.html and the JS
 * source files as text/regex rather than mounting a DOM, so it has no
 * dependency on jsdom (which is not installed in this environment; see
 * the implementation report). It is intentionally narrow in scope,
 * matching the navigation-only nature of Phase B.
 *
 * Run with: node tests_sidebar_players_only/sidebar_players_only_test.js
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const adminHtmlPath = path.join(__dirname, '..', 'admin.html');
const adminJsPath = path.join(__dirname, '..', 'js', 'admin.js');
const dbViewPath = path.join(__dirname, '..', 'js', 'admin', 'nba2k-database.js');

const adminHtml = fs.readFileSync(adminHtmlPath, 'utf8');
const adminJs = fs.readFileSync(adminJsPath, 'utf8');
const dbViewSrc = fs.readFileSync(dbViewPath, 'utf8');

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok - ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL - ${name}`);
    console.log(`    ${e.stack || e.message}`);
  }
}

// Pull out just the sidebar <nav> block so we don't accidentally match
// unrelated text elsewhere in the file.
const navMatch = adminHtml.match(/<nav class="nb-sidebar-nav">[\s\S]*?<\/nav>/);
assert.ok(navMatch, 'Could not locate <nav class="nb-sidebar-nav"> block in admin.html');
const navHtml = navMatch[0];

test('NBA 2K Player Database nav item is absent from sidebar', () => {
  assert.ok(
    !navHtml.includes('NBA 2K Player Database'),
    'Sidebar markup still contains the "NBA 2K Player Database" label'
  );
  assert.ok(
    !navHtml.includes('data-view="nba2kDatabase"'),
    'Sidebar markup still contains a data-view="nba2kDatabase" link'
  );
});

test('Players nav item remains present', () => {
  assert.ok(navHtml.includes('data-view="players"'), 'Players nav link missing');
  assert.ok(navHtml.includes('>Players<'), 'Players label missing');
});

test('NBA2K Import nav item remains present', () => {
  assert.ok(navHtml.includes('data-view="nba2kImport"'), 'NBA2K Import nav link missing');
  assert.ok(navHtml.includes('NBA2K Import'), 'NBA2K Import label missing');
});

test('NBA 2K27 Position Sorting nav item remains present', () => {
  assert.ok(
    navHtml.includes('data-view="nba2k27PositionSort"'),
    'NBA 2K27 Position Sorting nav link missing'
  );
  assert.ok(
    navHtml.includes('NBA 2K27 Position Sorting'),
    'NBA 2K27 Position Sorting label missing'
  );
});

test('Other Management nav items remain present (Participants, Trade / Swap, Finances, Backup)', () => {
  assert.ok(navHtml.includes('data-view="participants"'), 'Participants nav link missing');
  assert.ok(navHtml.includes('data-view="trades"'), 'Trade / Swap nav link missing');
  assert.ok(navHtml.includes('data-view="financial"'), 'Finances nav link missing');
  assert.ok(navHtml.includes('data-view="backup"'), 'Backup nav link missing');
});

test('nba2kDatabase route registration in js/admin.js was NOT deleted', () => {
  assert.ok(
    /nba2kDatabase\s*:\s*Nba2kDatabaseView/.test(adminJs),
    'Route registration "nba2kDatabase: Nba2kDatabaseView" is missing from js/admin.js — ' +
      'direct navigation to the existing route must keep working'
  );
});

test('Nba2kDatabaseView remains defined internally', () => {
  assert.ok(
    /class\s+Nba2kDatabaseView/.test(dbViewSrc) || /Nba2kDatabaseView\s*=/.test(dbViewSrc),
    'Nba2kDatabaseView definition appears to be missing from js/admin/nba2k-database.js'
  );
});

console.log('');
if (failures > 0) {
  console.log(`${failures} test(s) failed.`);
  process.exit(1);
} else {
  console.log('All sidebar_players_only tests passed.');
}
