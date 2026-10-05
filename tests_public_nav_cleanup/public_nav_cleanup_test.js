'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const publicHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const adminHtml = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
const publicRouter = fs.readFileSync(path.join(root, 'js/public-router.js'), 'utf8');
const adminRouter = fs.readFileSync(path.join(root, 'js/admin.js'), 'utf8');

const publicNav = (publicHtml.match(/<nav class="nb-sidebar-nav">[\s\S]*?<\/nav>/) || [])[0];
assert.ok(publicNav, 'Public sidebar navigation exists');
const playersStart = publicNav.indexOf('<div class="nb-sidebar-group-label">Players</div>');
const historyStart = publicNav.indexOf('<div class="nb-sidebar-group-label">League History</div>', playersStart);
assert.ok(playersStart >= 0 && historyStart > playersStart, 'Public Players navigation group exists');
const playersGroup = publicNav.slice(playersStart, historyStart);
const publicItems = [...playersGroup.matchAll(/<a\b[^>]*data-route="([^"]+)"[^>]*>[\s\S]*?<span class="nb-link-label">([^<]+)<\/span>[\s\S]*?<\/a>/g)];
assert.deepStrictEqual(publicItems.map(([, route, label]) => [route, label]), [['players', 'Players']]);
for (const label of ['NBA 2K27 Pool', 'NBA 2K27 Position Sorting', 'NBA 2K27 Live Update']) {
  assert.ok(!playersGroup.includes(label), `Public Players group hides ${label}`);
}

// Hiding the link does not remove the directly-addressable public route.
assert.match(publicRouter, /nba2k27:\s*PublicNba2k27View/);

// Admin navigation is separate and its existing links/route table are untouched.
const adminNav = (adminHtml.match(/<nav class="nb-sidebar-nav">[\s\S]*?<\/nav>/) || [])[0];
assert.ok(adminNav, 'Admin sidebar navigation exists');
assert.ok(adminNav.includes('data-view="nba2k27PositionSort"'), 'Admin Position Sorting link remains');
assert.ok(adminNav.includes('data-view="nba2k27LiveImport"'), 'Admin Live Update link remains');
assert.ok(/nba2k27Pool:\s*Nba2k27PoolView/.test(adminRouter), 'Admin NBA2K27 Pool route remains registered');

console.log('Public navigation cleanup checks passed.');
