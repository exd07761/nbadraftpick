'use strict';

// End-to-end render/event checks for free-agent and owned-player replacement.
// Run with: node tests_manual_roster_modal/manual_roster_modal_test.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const rosterSource = fs.readFileSync(path.join(root, 'js/admin/roster.js'), 'utf8');
const dataSource = fs.readFileSync(path.join(root, 'js/data.js'), 'utf8');
const publicRosterSource = fs.readFileSync(path.join(root, 'js/views/roster.js'), 'utf8');
const adminRosterSource = fs.readFileSync(path.join(root, 'js/admin/roster.js'), 'utf8');
const stylesheet = fs.readFileSync(path.join(root, 'css/admin.css'), 'utf8');
const freeAgent = { id: 'free-agent-actual-id', name: 'Free Agent', team: 'Boston Celtics', position: 'PG', pool: 'green', overall: 91 };
const ownedPlayer = { id: 'owned-player-actual-id', name: 'Owned Star', team: 'Phoenix Suns', position: 'SG', pool: 'blue', overall: 94, seasonId: 'season-scope' };
const players = [freeAgent, ownedPlayer];
const ownerSummary = { participant: { id: 'current-owner-id', name: 'Xtian' }, rosterEntries: [{ player: ownedPlayer, source: 'draft', draftSlot: 2 }] };
const destinationSummary = { participant: { id: 'destination-id', name: 'Destination Team' }, rosterEntries: [] };
const replaceCalls = [];
const appended = [];
let currentOverlay = null;
let latestMarkup = '';
let view;

const document = {
  body: { style: {}, appendChild(node) { appended.push(node); currentOverlay = node; } },
  getElementById(id) { return id === 'manualReplacePlayerOverlay' ? currentOverlay : null; },
  removeEventListener() {},
  createElement() {
    const node = { _html: '', firstElementChild: null };
    Object.defineProperty(node, 'innerHTML', {
      get() { return this._html; },
      set(value) {
        this._html = value;
        this.firstElementChild = {
          id: 'manualReplacePlayerOverlay', markup: value, listeners: {},
          addEventListener(type, listener) { this.listeners[type] = listener; },
          contains(target) { return target?.inside === true; },
          remove() { if (currentOverlay === this) currentOverlay = null; },
        };
      },
    });
    return node;
  },
};
const context = {
  document,
  AdminApp: {
    renderView() {
      view._mountReplaceModal('season-id');
      latestMarkup = view._renderReplaceModal('season-id');
    },
  },
  AuthBoundary: { requireAuth() {} },
  AdminActions: { manualReplacePlayerOnRoster(...args) { replaceCalls.push(args); } },
  showToast() {},
  LeagueData: {
    getPlayer(id, seasonId) { return seasonId === 'season-id' ? players.find(player => player.id === id) || null : null; },
    getCurrentSeason() { return { id: 'season-id', playerPoolScope: null }; },
    getSeason() { return { id: 'season-id', playerPoolScope: null }; },
    getSwapEligibleReplacements(_seasonId, pool) {
      // This is the real API's free-agent result: roster-owned players are excluded.
      return players.filter(player => player.id !== ownedPlayer.id && (!pool || player.pool === pool));
    },
    getRosterSummary() { return [ownerSummary, destinationSummary]; },
  },
  escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); },
  poolLabel(value) { return ({ green: 'Green', blue: 'Blue', white: 'White' })[value] || '—'; },
};
view = vm.runInNewContext(`${rosterSource}\nAdminRosterView;`, context);
view._manualAddTarget = destinationSummary.participant.id;
view._manualReplaceOutgoing = 'outgoing-player-id';

function markup() { return view._renderReplaceModal('season-id'); }
function click(action, playerId) {
  const item = { inside: true, dataset: { manualAction: action, playerId } };
  currentOverlay.listeners.click({
    target: { closest() { return item; } },
    preventDefault() {},
  });
}

// Free agent path: option is rendered, selectable, summarized, and passed by ID.
view._manualAddPool = 'green';
view._manualSelectedPlayer = null;
assert.match(markup(), /Free Agent[\s\S]*Boston Celtics[\s\S]*PG[\s\S]*Green[\s\S]*91/);
assert.match(markup(), /AVAILABLE · UNOWNED/);
view._mountReplaceModal('season-id');
click('selectReplace', freeAgent.id);
assert.equal(view._manualSelectedPlayer, freeAgent.id);
assert.match(latestMarkup, /aria-pressed="true"[^>]*data-player-id="free-agent-actual-id"/);
assert.match(latestMarkup, /Selected<\/span><strong>Free Agent<\/strong><b>91 OVR/);
assert.match(latestMarkup, /data-manual-action="modalConfirmReplace"(?![^>]*disabled)/);
view._manualSearch = 'free';
assert.match(markup(), /aria-pressed="true"[^>]*data-player-id="free-agent-actual-id"/,
  'search re-render keeps the selected player highlighted');
view._manualSearch = 'no matching name';
assert.match(markup(), /No available players match/);
assert.match(markup(), /Selected<\/span><strong>Free Agent<\/strong><b>91 OVR/,
  'search filtering does not discard the selected player state');
view._manualSearch = '';
view._manualAddPool = 'blue';
assert.equal(view._manualSelectedPlayer, freeAgent.id, 'pool switching does not corrupt the selected player ID');
view._manualAddPool = 'green';
assert.match(markup(), /data-manual-action="modalConfirmReplace"(?![^>]*disabled)/,
  'selection remains confirmable after search and pool re-renders');
click('modalConfirmReplace');
assert.deepEqual(replaceCalls[0], ['season-id', 'destination-id', 'outgoing-player-id', freeAgent.id]);

// Owned path: player appears despite the available-player API excluding them.
view._manualAddPool = 'blue';
view._manualAddTarget = destinationSummary.participant.id;
view._manualReplaceOutgoing = 'outgoing-player-id';
view._manualSelectedPlayer = null;
view._manualTransferOwner = null;
view._mountReplaceModal('season-id');
assert.match(markup(), /Owned Star[\s\S]*Phoenix Suns[\s\S]*SG[\s\S]*Blue[\s\S]*OWNED BY Xtian[\s\S]*94/);
click('selectReplace', ownedPlayer.id);
assert.equal(view._manualSelectedPlayer, ownedPlayer.id);
assert.match(latestMarkup, /Selected<\/span><strong>Owned Star<\/strong><b>94 OVR/);
click('modalConfirmReplace');
assert.match(latestMarkup, /currently owned by <strong>Xtian<\/strong>[\s\S]*<strong>Destination Team<\/strong>/i,
  'confirmation names the actual owner and destination');
assert.match(latestMarkup, /data-manual-action="confirmReplaceTransfer">Transfer &amp; Sign/);
click('cancelReplaceTransfer');
assert.equal(replaceCalls.length, 1, 'cancelling transfer does not call a roster write');
assert.equal(view._manualTransferOwner, null);

// Confirming transfer invokes the same replacement API with an owner check.
view._manualSelectedPlayer = ownedPlayer.id;
view._mountReplaceModal('season-id');
click('modalConfirmReplace');
click('confirmReplaceTransfer');
assert.deepEqual(replaceCalls[1].slice(0, 4), [
  'season-id', 'destination-id', 'outgoing-player-id', ownedPlayer.id,
]);
assert.equal(replaceCalls[1][4].transferOwnerId, 'current-owner-id');
assert.doesNotMatch(dataSource.slice(dataSource.indexOf('manualReplacePlayerOnRoster(seasonId'), dataSource.indexOf('// ── Player Database', dataSource.indexOf('manualReplacePlayerOnRoster(seasonId'))),
  /ratingCap|validateMinimumRating|validateBlueComposition/,
  'manual replacement leaves compliance checks to the dedicated Validate Rosters action');
assert.doesNotMatch(dataSource.slice(dataSource.indexOf('manualSignPlayerToRoster(seasonId'), dataSource.indexOf('manualRemovePlayerFromRoster(seasonId')),
  /ratingCap|validateMinimumRating|validateBlueComposition/,
  'manual signing leaves compliance checks to the dedicated Validate Rosters action');
assert.match(dataSource, /options\.transferOwnerId/,
  'the transfer action validates the confirmed current owner before mutation');

// Exercise the real data action as well as the rendered picker flow above.
// These tests prove manual writes can exceed rating/minimum rules while preserving
// ownership integrity, slot semantics, and historical draft records.
const dataContext = {
  console,
  window: { USE_SUPABASE_SYNC: false },
  firebase: { firestore: () => ({ collection: () => ({ doc: () => ({ onSnapshot() {}, set() { return Promise.resolve(); } }) }) }) },
  showToast() {},
};
vm.createContext(dataContext);
vm.runInContext(`${dataSource}\nthis.LeagueData = LeagueData; this.AdminActions = AdminActions; this.FirebaseSync = FirebaseSync; this.getDefaultData = getDefaultData;`, dataContext);
let dataCache = dataContext.getDefaultData();
dataContext.FirebaseSync.getCache = () => dataCache;
dataContext.FirebaseSync.save = data => { dataCache = data; };
const actualSeason = dataContext.AdminActions.createSeason('Replace Player regression');
const actualDestination = dataContext.AdminActions.addParticipant(actualSeason.id, 'Destination Team');
const actualOwner = dataContext.AdminActions.addParticipant(actualSeason.id, 'Xtian');
const actualSlotDestination = dataContext.AdminActions.addParticipant(actualSeason.id, 'Slot Destination');
const actualSigner = dataContext.AdminActions.addParticipant(actualSeason.id, 'Free Agent Signer');
const actualOutgoing = dataContext.AdminActions.addPlayer({ name: 'Outgoing', position: 'SF', overall: 80, pool: 'green' });
const actualOwned = dataContext.AdminActions.addPlayer({ name: 'Owned Actual', position: 'SG', overall: 99, pool: 'green' });
const actualFree = dataContext.AdminActions.addPlayer({ name: 'Free Actual', position: 'SG', overall: 99, pool: 'green' });
const invalidFree = dataContext.AdminActions.addPlayer({ name: 'Below Minimum', position: 'SG', overall: 70, pool: 'green' });
const slotFree = dataContext.AdminActions.addPlayer({ name: 'Slot Free', position: 'PG', overall: 99, pool: 'green' });
const acuff = dataContext.AdminActions.addPlayer({ name: 'Darius Acuff Jr.', team: 'SAC', position: 'PG', overall: 90, pool: 'green' });
const persisted = dataContext.FirebaseSync.getCache();
const seasonRecord = persisted.seasons[actualSeason.id];
seasonRecord.rostersInitialized = true;
seasonRecord.ratingCap = 50;
seasonRecord.playerDraftPicks = [
  { participantId: actualDestination.id, playerId: actualOutgoing.id, pickNumber: 1 },
  { participantId: actualOwner.id, playerId: actualOwned.id, pickNumber: 1 },
];
seasonRecord.currentRosters = {
  [actualDestination.id]: [{ playerId: actualOutgoing.id, source: 'draft', draftSlot: 1 }],
  [actualOwner.id]: [{ playerId: actualOwned.id, source: 'draft', draftSlot: 1 }],
  [actualSlotDestination.id]: [
    { source: 'empty', playerId: null, draftSlot: 4, classificationSourcePlayerId: null },
    { source: 'empty', playerId: null, draftSlot: 5, classificationSourcePlayerId: null },
  ],
  [actualSigner.id]: [],
};
dataContext.FirebaseSync.save(persisted);
const historyBefore = JSON.stringify(seasonRecord.playerDraftPicks);
dataContext.AdminActions.manualReplacePlayerOnRoster(actualSeason.id, actualDestination.id, actualOutgoing.id, invalidFree.id);
let savedSeason = dataContext.FirebaseSync.getCache().seasons[actualSeason.id];
assert.equal(savedSeason.currentRosters[actualDestination.id][0].playerId, invalidFree.id,
  'manual replacement is not blocked by minimum-rating or cap validation');
assert.equal(savedSeason.currentRosters[actualDestination.id][0].source, 'signed');
assert.doesNotThrow(() => dataContext.AdminActions.manualSignPlayerToRoster(
  actualSeason.id, actualSigner.id, actualFree.id
), 'manual signing is allowed above the rating cap');
savedSeason = dataContext.FirebaseSync.getCache().seasons[actualSeason.id];
assert.equal(savedSeason.currentRosters[actualSigner.id][0].source, 'signed');
assert.equal(savedSeason.currentRosters[actualSigner.id][0].playerId, actualFree.id);

assert.doesNotThrow(() => dataContext.AdminActions.manualSignPlayerToRoster(
  actualSeason.id, actualSlotDestination.id, slotFree.id, false, 4
), 'unowned players can be signed into empty draft slots above the cap');
savedSeason = dataContext.FirebaseSync.getCache().seasons[actualSeason.id];
assert.deepEqual(JSON.parse(JSON.stringify(savedSeason.currentRosters[actualSlotDestination.id][0])), {
  playerId: slotFree.id, source: 'signed', draftSlot: 4, displayPickNumber: 4,
});
assert.throws(() => dataContext.AdminActions.manualSignPlayerToRoster(
  actualSeason.id, actualSlotDestination.id, actualOwned.id, true, 5, 'stale-owner-id'
), /current owner changed/);
assert.equal(dataContext.FirebaseSync.getCache().seasons[actualSeason.id].currentRosters[actualOwner.id][0].playerId, actualOwned.id,
  'stale transfer confirmation leaves source ownership intact');
dataContext.AdminActions.manualSignPlayerToRoster(
  actualSeason.id, actualSlotDestination.id, actualOwned.id, true, 5, actualOwner.id
);
savedSeason = dataContext.FirebaseSync.getCache().seasons[actualSeason.id];
assert.equal(savedSeason.currentRosters[actualSlotDestination.id][1].playerId, actualOwned.id);
assert.equal(savedSeason.currentRosters[actualSlotDestination.id][1].draftSlot, 5);
assert.equal(savedSeason.currentRosters[actualSlotDestination.id][1].source, 'draft',
  'transferring a drafted player preserves its draft source');
assert.equal(savedSeason.currentRosters[actualOwner.id][0].source, 'empty');
assert.equal(savedSeason.currentRosters[actualOwner.id][0].draftSlot, 1);
assert.equal(savedSeason.currentRosters[actualSlotDestination.id].filter(e => e.playerId === actualOwned.id).length, 1,
  'transferred player has exactly one active destination assignment');
assert.equal(JSON.stringify(savedSeason.playerDraftPicks), historyBefore, 'draft-pick records remain intact after replacement and slot operations');

// Signed source and public draft availability are persisted per season.
assert.ok(dataContext.LeagueData.getAvailablePlayers(actualSeason.id).some(p => p.id === acuff.id));
dataContext.AdminActions.manualSignPlayerToRoster(actualSeason.id, actualSigner.id, acuff.id);
savedSeason = dataContext.FirebaseSync.getCache().seasons[actualSeason.id];
assert.equal(savedSeason.currentRosters[actualSigner.id].find(e => e.playerId === acuff.id).source, 'signed');
assert.ok(!dataContext.LeagueData.getAvailablePlayers(actualSeason.id).some(p => p.id === acuff.id),
  'manual signing removes the player from the available draft pool');
assert.equal(dataContext.LeagueData.getDraftPoolStatus(actualSeason.id, null).find(e => e.player.id === acuff.id).status, 'signed');
// Reload the serialized cache to exercise the persisted roster source/ownership path.
dataCache = JSON.parse(JSON.stringify(dataContext.FirebaseSync.getCache()));
assert.equal(dataContext.LeagueData.getCurrentRoster(actualSeason.id, actualSigner.id).find(e => e.playerId === acuff.id).source, 'signed',
  'signed source survives cache reload');
const otherSeason = dataContext.AdminActions.createSeason('Independent season');
assert.ok(dataContext.LeagueData.getAvailablePlayers(otherSeason.id).some(p => p.id === acuff.id),
  'an assignment in one season does not remove the player from another season pool');
dataContext.AdminActions.manualSignPlayerToRoster(actualSeason.id, actualSlotDestination.id, acuff.id, true, null, actualSigner.id);
savedSeason = dataContext.FirebaseSync.getCache().seasons[actualSeason.id];
assert.equal(savedSeason.currentRosters[actualSlotDestination.id].find(e => e.playerId === acuff.id).source, 'signed',
  'transferring a signed player keeps its signed source');
assert.ok(!dataContext.LeagueData.getAvailablePlayers(actualSeason.id).some(p => p.id === acuff.id),
  'transferring a signed player does not make them available');
assert.ok(!dataContext.LeagueData.getAvailablePlayers(actualSeason.id).some(p => p.id === actualOwned.id),
  'transferring a drafted player does not make them available');
assert.equal(JSON.stringify(savedSeason.playerDraftPicks), historyBefore, 'transfers preserve existing draft history');

// Sequential display numbers are participant-scoped, persisted, and do not
// modify existing draft records or drafted roster rows.
const numberedTeam = dataContext.AdminActions.addParticipant(actualSeason.id, 'Numbered Team');
const shorterTeam = dataContext.AdminActions.addParticipant(actualSeason.id, 'Shorter Team');
const untouchedTeam = dataContext.AdminActions.addParticipant(actualSeason.id, 'Untouched Team');
const numberedPicks = [], numberedRoster = [], shorterPicks = [], shorterRoster = [];
for (let i = 1; i <= 9; i++) {
  const drafted = dataContext.AdminActions.addPlayer({ name: `Drafted ${i}`, position: ['PG', 'SG', 'SF', 'PF', 'C'][(i - 1) % 5], overall: 75, pool: 'green' });
  numberedPicks.push({ participantId: numberedTeam.id, playerId: drafted.id, round: 1, pick: i });
  numberedRoster.push({ playerId: drafted.id, source: 'draft', draftSlot: i });
  if (i <= 5) {
    shorterPicks.push({ participantId: shorterTeam.id, playerId: drafted.id, round: 1, pick: i });
    shorterRoster.push({ playerId: drafted.id, source: 'draft', draftSlot: i, classificationSourcePlayerId: `classification-${i}` });
  }
}
const numberedCache = dataContext.FirebaseSync.getCache();
const untouchedDrafted = dataContext.AdminActions.addPlayer({ name: 'Untouched Drafted', position: 'C', overall: 75, pool: 'green' });
numberedCache.seasons[actualSeason.id].playerDraftPicks.push({ participantId: untouchedTeam.id, playerId: untouchedDrafted.id, round: 1, pick: 1 });
numberedCache.seasons[actualSeason.id].draftComplete = true;
numberedCache.seasons[actualSeason.id].playerDraftPicks.push(...numberedPicks, ...shorterPicks);
numberedCache.seasons[actualSeason.id].currentRosters[numberedTeam.id] = numberedRoster;
numberedCache.seasons[actualSeason.id].currentRosters[shorterTeam.id] = shorterRoster;
numberedCache.seasons[actualSeason.id].currentRosters[untouchedTeam.id] = [{ playerId: untouchedDrafted.id, source: 'draft' }];
dataContext.FirebaseSync.save(numberedCache);
const manualOne = dataContext.AdminActions.addPlayer({ name: 'Manual One', position: 'PG', overall: 75, pool: 'green' });
const manualTwo = dataContext.AdminActions.addPlayer({ name: 'Manual Two', position: 'SG', overall: 75, pool: 'green' });
dataContext.AdminActions.manualSignPlayerToRoster(actualSeason.id, numberedTeam.id, manualOne.id);
dataContext.AdminActions.manualSignPlayerToRoster(actualSeason.id, numberedTeam.id, manualTwo.id);
savedSeason = dataContext.FirebaseSync.getCache().seasons[actualSeason.id];
const numberedRows = dataContext.LeagueData.getCurrentRoster(actualSeason.id, numberedTeam.id);
assert.equal(numberedRows.find(e => e.playerId === manualOne.id).displayPickNumber, 10);
assert.equal(numberedRows.find(e => e.playerId === manualTwo.id).displayPickNumber, 11);
assert.equal(numberedRows.find(e => e.playerId === manualOne.id).draftSlot, null);
assert.equal(savedSeason.currentRosters[numberedTeam.id].find(e => e.playerId === manualOne.id).source, 'signed');
assert.deepEqual(Array.from(numberedRows.filter(e => e.source === 'draft'), e => e.displayPickNumber), [1,2,3,4,5,6,7,8,9]);
assert.equal(savedSeason.playerDraftPicks.filter(p => p.participantId === numberedTeam.id).length, 9);
assert.deepEqual(JSON.parse(JSON.stringify(savedSeason.currentRosters[numberedTeam.id].slice(0, 9))), numberedRoster);
assert.ok(savedSeason.currentRosters[shorterTeam.id].every(entry => !Object.hasOwn(entry, 'displayPickNumber')));
assert.ok(!Object.hasOwn(savedSeason.currentRosters[untouchedTeam.id][0], 'draftSlot'),
  'editing one team does not backfill original-slot fields on another participant');
const shorterManual = dataContext.AdminActions.addPlayer({ name: 'Short Team Manual', position: 'PF', overall: 75, pool: 'green' });
dataContext.AdminActions.manualSignPlayerToRoster(actualSeason.id, shorterTeam.id, shorterManual.id);
savedSeason = dataContext.FirebaseSync.getCache().seasons[actualSeason.id];
assert.equal(savedSeason.currentRosters[shorterTeam.id].find(e => e.playerId === shorterManual.id).displayPickNumber, 6);
assert.equal(savedSeason.currentRosters[numberedTeam.id].filter(e => e.source === 'signed').length, 2);
dataCache = JSON.parse(JSON.stringify(dataContext.FirebaseSync.getCache()));
assert.equal(dataContext.LeagueData.getCurrentRoster(actualSeason.id, numberedTeam.id).find(e => e.playerId === manualTwo.id).displayPickNumber, 11);
const manualThree = dataContext.AdminActions.addPlayer({ name: 'Manual Three', position: 'SF', overall: 75, pool: 'green' });
dataContext.AdminActions.manualAddPlayerToRoster(actualSeason.id, numberedTeam.id, manualThree.id);
savedSeason = dataContext.FirebaseSync.getCache().seasons[actualSeason.id];
assert.equal(savedSeason.currentRosters[numberedTeam.id].find(e => e.playerId === manualThree.id).displayPickNumber, 12);
assert.match(publicRosterSource, /e\.displayPickNumber \?\? e\.draftSlot/);
assert.match(adminRosterSource, /e\.displayPickNumber \?\? e\.draftSlot/);
dataContext.AdminActions.manualRemovePlayerFromRoster(actualSeason.id, actualSlotDestination.id, acuff.id);
assert.ok(dataContext.LeagueData.getAvailablePlayers(actualSeason.id).some(p => p.id === acuff.id),
  'a removed undrafted signing returns to the pool when no active assignment remains');
assert.ok(!dataContext.LeagueData.getAvailablePlayers(actualSeason.id).some(p => p.id === actualOwned.id),
  'removing a signed player does not make a historically drafted player available');

const publicRosterView = vm.runInNewContext(`${publicRosterSource}\nPublicRosterView;`, {
  escapeHtml(value) { return String(value ?? ''); }, poolLabel(value) { return value || '—'; },
  classificationBadge(value) { return value || '—'; }, teamBadge() { return ''; },
});
const publicRosterMarkup = publicRosterView._renderRosterCard({
  participant: { name: 'Signed Test' }, rosterEntries: [{ source: 'signed', draftSlot: null, player: { name: 'Darius Acuff Jr.', overall: 90, pool: 'green', position: 'PG' } }],
  totalRating: 90, remaining: 785, isOverCap: false,
}, 875, null);
assert.match(publicRosterMarkup, /<td class="roster-card-source">Signed<\/td>/, 'public roster shows a plain Signed source label');
assert.doesNotMatch(publicRosterMarkup, /signed-badge/, 'public roster does not render badge styling for signed players');
const adminRosterView = vm.runInNewContext(`${adminRosterSource}\nAdminRosterView;`, {
  LeagueData: { getJokerEligiblePlayers() { return []; } },
  escapeHtml(value) { return String(value ?? ''); }, poolLabel(value) { return value || '—'; },
  classificationBadge(value) { return value || '—'; }, teamBadge() { return ''; },
});
const adminRosterMarkup = adminRosterView._renderRosterCard({
  participant: { id: 'signed-test', name: 'Signed Test' }, rosterEntries: [{ source: 'signed', draftSlot: null, player: { id: acuff.id, name: 'Darius Acuff Jr.', overall: 90, pool: 'green', position: 'PG' } }],
  totalRating: 90, remaining: 785, isOverCap: false,
}, 875, null, actualSeason.id);
assert.match(adminRosterMarkup, /<td class="muted"[^>]*>Signed<\/td>/, 'admin roster shows a plain Signed source label');
assert.doesNotMatch(adminRosterMarkup, /signed-badge/, 'admin roster does not render badge styling for signed players');

assert.match(stylesheet, /#manualReplacePlayerOverlay\.modal-overlay\s*\{\s*z-index:\s*10000/);

// Exercise the actual generated option element and native bubbling click path
// in a DOM, with a scoped-only player that global getPlayer(id) cannot find.
const dom = new JSDOM('<!doctype html><body><main id="roster"></main></body>', { url: 'http://draftp.test/admin.html' });
let domView;
const domReplaceCalls = [];
const domSignCalls = [];
const domContext = {
  document: dom.window.document,
  window: dom.window,
  AdminApp: { renderView() { domView._mountReplaceModal('season-id'); } },
  AuthBoundary: { requireAuth() {} },
  AdminActions: {
    manualReplacePlayerOnRoster(...args) { domReplaceCalls.push(args); },
    manualSignPlayerToRoster(...args) { domSignCalls.push(args); },
  },
  showToast() {},
  escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); },
  poolLabel(value) { return ({ green: 'Green', blue: 'Blue', white: 'White' })[value] || '—'; },
  classificationBadge(value) { return value || '—'; },
  teamBadge() { return '<span>Team</span>'; },
  LeagueData: {
    getPlayer(id, seasonId) { return seasonId === 'season-id' ? players.find(p => p.id === id) || null : null; },
    getParticipant(_seasonId, participantId) { return [ownerSummary, destinationSummary].find(s => s.participant.id === participantId)?.participant || null; },
    getCurrentSeason() { return { id: 'season-id', playerPoolScope: 'season-scope' }; },
    getSeason() { return { id: 'season-id', playerPoolScope: 'season-scope' }; },
    getSwapEligibleReplacements(_seasonId, pool) { return players.filter(p => p.id !== ownedPlayer.id && p.pool === pool); },
    getRosterSummary() { return [ownerSummary, destinationSummary]; },
    getJokerEligiblePlayers() { return []; },
  },
};
domView = vm.runInNewContext(`${rosterSource}\nAdminRosterView;`, domContext);
domView._manualEditUnlocked = true;
domView._manualAddTarget = destinationSummary.participant.id;
domView._manualReplaceOutgoing = 'outgoing-player-id';
domView._manualAddPool = 'blue';
domView._mountReplaceModal('season-id');
const domOption = dom.window.document.querySelector('#manualReplacePlayerOverlay button[data-player-id="owned-player-actual-id"]');
assert.ok(domOption, 'the rendered owned-player option is a real button carrying the selected player ID');
assert.equal(domOption.disabled, false);
domOption.querySelector('strong').click(); // Click nested visible text and bubble to the overlay.
let liveOverlay = dom.window.document.getElementById('manualReplacePlayerOverlay');
assert.equal(domView._manualSelectedPlayer, ownedPlayer.id);
assert.ok(liveOverlay.querySelector('[data-player-id="owned-player-actual-id"].is-selected'));
assert.equal(liveOverlay.querySelector('[data-player-id="owned-player-actual-id"]').getAttribute('aria-pressed'), 'true');
assert.match(liveOverlay.querySelector('.manual-roster-selected').textContent, /Owned Star\s*94 OVR/);
assert.equal(liveOverlay.querySelector('[data-manual-action="modalConfirmReplace"]').disabled, false);
liveOverlay.querySelector('[data-manual-action="modalConfirmReplace"]').click();
liveOverlay = dom.window.document.getElementById('manualReplacePlayerOverlay');
assert.match(liveOverlay.querySelector('[role="alert"]').textContent, /Xtian[\s\S]*Destination Team/);
liveOverlay.querySelector('[data-manual-action="confirmReplaceTransfer"]').click();
assert.equal(domReplaceCalls[0][3], ownedPlayer.id, 'confirmation passes the actual selected ID to replacement validation');
assert.equal(domReplaceCalls[0][4].transferOwnerId, 'current-owner-id');

// Filling an empty pick opens the same body-mounted modal, not the inline
// Fill Draft Slot picker; its sign and transfer actions carry the exact slot.
domView._closeManualPicker();
const slotSummary = {
  participant: destinationSummary.participant,
  rosterEntries: [
    { source: 'empty', playerId: null, draftSlot: 8, player: null },
    { source: 'empty', playerId: null, draftSlot: 9, player: null },
  ],
  totalRating: 0, ratingCap: 50, remaining: 50, isOverCap: false,
};
domView._manualEditUnlocked = true;
domView._manualAddTarget = 'destination-id';
domView._manualReplaceOutgoing = null;
domView._manualFillSlot = 8;
domView._manualSelectedPlayer = null;
domView._manualTransferOwner = null;
domView._manualAddPool = 'green';
const slotMarkup = domView._renderRosterCard(slotSummary, 50, 'DST', 'season-id');
assert.doesNotMatch(slotMarkup, /roster-manual-picker|Fill Draft Slot with/,
  'empty-slot flow no longer renders the obsolete inline picker');
const slotHost = dom.window.document.createElement('div');
slotHost.innerHTML = slotMarkup;
domView._mountReplaceModal('season-id');
let slotOverlay = dom.window.document.getElementById('manualReplacePlayerOverlay');
assert.match(slotOverlay.querySelector('[role="dialog"]').textContent, /Fill Draft Slot #8/);
slotOverlay.querySelector('[data-player-id="free-agent-actual-id"] strong').click();
slotOverlay = dom.window.document.getElementById('manualReplacePlayerOverlay');
slotOverlay.querySelector('[data-manual-action="modalConfirmSign"]').click();
assert.deepEqual(domSignCalls[0].slice(0, 5), ['season-id', 'destination-id', freeAgent.id, false, 8],
  'unowned slot signing carries the player ID and exact draft slot');

domView._manualAddTarget = 'destination-id';
domView._manualReplaceOutgoing = null;
domView._manualFillSlot = 9;
domView._manualAddPool = 'blue';
domView._manualSelectedPlayer = null;
domView._manualTransferOwner = null;
domView._mountReplaceModal('season-id');
slotOverlay = dom.window.document.getElementById('manualReplacePlayerOverlay');
slotOverlay.querySelector('[data-player-id="owned-player-actual-id"] strong').click();
slotOverlay = dom.window.document.getElementById('manualReplacePlayerOverlay');
slotOverlay.querySelector('[data-manual-action="modalConfirmSign"]').click();
slotOverlay = dom.window.document.getElementById('manualReplacePlayerOverlay');
assert.match(slotOverlay.querySelector('[role="alert"]').textContent, /Xtian[\s\S]*Destination Team[\s\S]*slot #9/);
slotOverlay.querySelector('[data-manual-action="cancelReplaceTransfer"]').click();
assert.equal(domSignCalls.length, 1, 'cancelling slot transfer causes no assignment');
slotOverlay = dom.window.document.getElementById('manualReplacePlayerOverlay');
slotOverlay.querySelector('[data-manual-action="modalConfirmSign"]').click();
slotOverlay = dom.window.document.getElementById('manualReplacePlayerOverlay');
slotOverlay.querySelector('[data-manual-action="confirmReplaceTransfer"]').click();
assert.deepEqual(domSignCalls[1].slice(0, 6), [
  'season-id', 'destination-id', ownedPlayer.id, true, 9, 'current-owner-id',
], 'owned slot transfer carries confirmed owner and exact target slot');

// The row action is available only while edit mode is active, and actions are
// bound to the exact roster player/participant represented by that row.
domView._closeManualPicker();
const rowSummary = {
  participant: ownerSummary.participant,
  rosterEntries: ownerSummary.rosterEntries,
  totalRating: 94, ratingCap: 875, remaining: 781, isOverCap: false,
};
const rowHost = dom.window.document.querySelector('#roster');
domView._manualAddTarget = null;
const editingRowMarkup = domView._renderRosterCard(rowSummary, 875, 'BOS', 'season-id');
rowHost.innerHTML = editingRowMarkup;
const editingRow = rowHost.querySelector('tr[data-manual-action="openRosterEntry"]');
assert.ok(editingRow, 'manual edit mode renders an interactive player row');
domView._bindManualRosterEntryRows(rowHost, { id: 'season-id' });
editingRow.querySelector('td:nth-child(2)').click();
const entryOverlay = dom.window.document.getElementById('manualRosterEntryOverlay');
assert.match(entryOverlay.textContent, /Owned Star[\s\S]*94[\s\S]*SG[\s\S]*Blue[\s\S]*Xtian/);
assert.equal(dom.window.document.body.style.overflow, 'hidden', 'opening the entry modal prevents background scrolling');
entryOverlay.querySelector('[data-entry-action="close"]').click();
assert.equal(dom.window.document.body.style.overflow, '', 'Cancel restores background scrolling');
editingRow.querySelector('td:nth-child(2)').click();
dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
assert.equal(dom.window.document.getElementById('manualRosterEntryOverlay'), null, 'Escape closes the entry modal');
assert.equal(dom.window.document.body.style.overflow, '', 'Escape restores background scrolling');
editingRow.querySelector('td:nth-child(2)').click();
dom.window.document.querySelector('#manualRosterEntryOverlay [data-entry-action="replace"]').click();
assert.equal(domView._manualAddTarget, 'current-owner-id');
assert.equal(domView._manualReplaceOutgoing, ownedPlayer.id, 'row editor keeps the clicked roster player ID');
domView._manualEditUnlocked = false;
assert.doesNotMatch(domView._renderRosterCard(rowSummary, 875, 'BOS', 'season-id'), /data-manual-action="openRosterEntry"/,
  'player rows are not interactive when manual edit mode is inactive');

dom.window.close();
console.log('Manual roster picker, cap override, slot fill/transfer, and draft-history regression checks passed.');
