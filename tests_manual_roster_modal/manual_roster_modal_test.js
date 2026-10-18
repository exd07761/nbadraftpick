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
const freeAgent = { id: 'free-agent-actual-id', name: 'Free Agent', team: 'Boston Celtics', position: 'PG', pool: 'green', overall: 91, seasonId: 'season-scope' };
const ownedPlayer = { id: 'owned-player-actual-id', name: 'Owned Star', team: 'Phoenix Suns', position: 'SG', pool: 'blue', overall: 94, seasonId: 'season-scope' };
const ownedGreenPlayer = { id: 'owned-green-actual-id', name: 'Owned Green Player', team: 'Chicago Bulls', position: 'SF', pool: 'green', overall: 86, seasonId: 'season-scope' };
const ownedScopedGreenPlayer = { id: 'owned-scoped-green-id', name: 'Owned Scoped Green', team: 'Miami Heat', position: 'PF', pool: 'green', overall: 88, seasonId: 'season-scope' };
const ownedForeignGreenPlayer = { id: 'owned-foreign-green-id', name: 'Owned Foreign Green', team: 'Dallas Mavericks', position: 'C', pool: 'green', overall: 89, seasonId: 'other-season-scope' };
const ownedWrongPoolPlayer = { id: 'owned-wrong-pool-id', name: 'Owned Blue Player', team: 'Denver Nuggets', position: 'SG', pool: 'blue', overall: 87, seasonId: 'season-scope' };
const players = [freeAgent, ownedPlayer, ownedGreenPlayer];
const ownerSummary = { participant: { id: 'current-owner-id', name: 'Xtian' }, rosterEntries: [{ player: ownedPlayer, source: 'draft', draftSlot: 2 }, { player: ownedGreenPlayer, source: 'signed', draftSlot: null }] };
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
const actualAddOwned = dataContext.AdminActions.addPlayer({ name: 'Add Transfer Actual', position: 'SF', overall: 82, pool: 'green' });
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
  [actualDestination.id]: [
    { playerId: actualOutgoing.id, source: 'draft', draftSlot: 1 },
    { source: 'empty', playerId: null, draftSlot: 6, classificationSourcePlayerId: 'vacancy-classification-anchor' },
  ],
  [actualOwner.id]: [
    { playerId: actualOwned.id, source: 'draft', draftSlot: 1 },
    { playerId: actualAddOwned.id, source: 'signed', draftSlot: null },
  ],
  [actualSlotDestination.id]: [
    { source: 'empty', playerId: null, draftSlot: 4, classificationSourcePlayerId: null },
    { source: 'empty', playerId: null, draftSlot: 5, classificationSourcePlayerId: null },
  ],
  [actualSigner.id]: [],
};
dataContext.FirebaseSync.save(persisted);
const historyBefore = JSON.stringify(seasonRecord.playerDraftPicks);
const staleTransferBefore = JSON.stringify([
  seasonRecord.currentRosters[actualOwner.id], seasonRecord.currentRosters[actualDestination.id],
]);
assert.throws(() => dataContext.AdminActions.manualSignPlayerToRoster(
  actualSeason.id, actualDestination.id, actualAddOwned.id, true, null, 'stale-owner-id'
), /current owner changed/);
assert.equal(JSON.stringify([
  dataContext.FirebaseSync.getCache().seasons[actualSeason.id].currentRosters[actualOwner.id],
  dataContext.FirebaseSync.getCache().seasons[actualSeason.id].currentRosters[actualDestination.id],
]), staleTransferBefore, 'a stale ordinary Add Player transfer leaves both rosters unchanged');
assert.ok(!dataContext.LeagueData.getSwapEligibleReplacements(actualSeason.id, 'green')
  .some(player => player.id === actualOwned.id), 'historically drafted players remain reserved from the unowned candidate pool');
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

const validationSnapshot = JSON.stringify(dataContext.FirebaseSync.getCache().seasons[actualSeason.id]);
const validationResult = dataContext.LeagueData.validateAllRosters(actualSeason.id);
assert.ok(validationResult.errors.some(finding => finding.type === 'RATING_CAP'),
  'Validate Roster reports an over-cap roster after the manual override');
assert.ok(validationResult.errors.some(finding => finding.type === 'MISSING_POSITION'),
  'Validate Roster reports missing position requirements');
assert.equal(JSON.stringify(dataContext.FirebaseSync.getCache().seasons[actualSeason.id]), validationSnapshot,
  'Validate Roster is read-only and does not repair or mutate roster data');

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
assert.throws(() => dataContext.AdminActions.manualSignPlayerToRoster(actualSeason.id, numberedTeam.id, manualTwo.id), /roster is full/i);
savedSeason = dataContext.FirebaseSync.getCache().seasons[actualSeason.id];
const numberedRows = dataContext.LeagueData.getCurrentRoster(actualSeason.id, numberedTeam.id);
assert.equal(numberedRows.find(e => e.playerId === manualOne.id).displayPickNumber, 10);
assert.equal(numberedRows.find(e => e.playerId === manualTwo.id), undefined,
  'an eleventh player is blocked once the ten-player roster is full');
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
assert.equal(savedSeason.currentRosters[numberedTeam.id].filter(e => e.source === 'signed').length, 1);
dataCache = JSON.parse(JSON.stringify(dataContext.FirebaseSync.getCache()));
assert.equal(dataContext.LeagueData.getCurrentRoster(actualSeason.id, numberedTeam.id).find(e => e.playerId === manualTwo.id), undefined);
const vacancyTeam = dataContext.AdminActions.addParticipant(actualSeason.id, 'Vacancy Team');
const vacancyRoster = [];
const vacancyPicks = [];
for (let slot = 1; slot <= 10; slot++) {
  if (slot === 6) {
    vacancyRoster.push({ source: 'empty', playerId: null, draftSlot: 6, classificationSourcePlayerId: 'pick-6-classification' });
    continue;
  }
  const drafted = dataContext.AdminActions.addPlayer({ name: `Vacancy Drafted ${slot}`, position: 'SG', overall: 75, pool: 'blue' });
  vacancyRoster.push({ playerId: drafted.id, source: 'draft', draftSlot: slot });
  vacancyPicks.push({ participantId: vacancyTeam.id, playerId: drafted.id, round: 1, pick: slot });
}
const vacancyCache = dataContext.FirebaseSync.getCache();
vacancyCache.seasons[actualSeason.id].currentRosters[vacancyTeam.id] = vacancyRoster;
vacancyCache.seasons[actualSeason.id].playerDraftPicks.push(...vacancyPicks);
dataContext.FirebaseSync.save(vacancyCache);
const slotSixSigner = dataContext.AdminActions.addPlayer({ name: 'Slot Six Signer', position: 'PG', overall: 80, pool: 'green' });
dataContext.AdminActions.manualSignPlayerToRoster(actualSeason.id, vacancyTeam.id, slotSixSigner.id);
const filledVacancyRoster = dataContext.FirebaseSync.getCache().seasons[actualSeason.id].currentRosters[vacancyTeam.id];
assert.equal(filledVacancyRoster.length, 10, 'Add Player fills the vacancy without creating pick #11');
assert.equal(filledVacancyRoster.filter(entry => entry.source !== 'empty' && entry.playerId).length, 10,
  'the filled roster has ten active players; empty slots are excluded from the count');
assert.equal(filledVacancyRoster.find(entry => entry.playerId === slotSixSigner.id).draftSlot, 6);
assert.equal(filledVacancyRoster.find(entry => entry.playerId === slotSixSigner.id).classificationSourcePlayerId,
  'pick-6-classification', 'slot #6 classification metadata survives automatic filling');
assert.equal(dataContext.FirebaseSync.getCache().seasons[actualSeason.id].playerDraftPicks.filter(pick => pick.participantId === vacancyTeam.id).length, 9,
  'automatic filling leaves historical draft records unchanged');
const manualThree = dataContext.AdminActions.addPlayer({ name: 'Manual Three', position: 'SF', overall: 75, pool: 'green' });
assert.throws(() => dataContext.AdminActions.manualSignPlayerToRoster(actualSeason.id, numberedTeam.id, manualThree.id), /roster is full/i);
assert.throws(() => dataContext.AdminActions.manualAddPlayerToRoster(actualSeason.id, numberedTeam.id, manualThree.id), /roster is full/i);
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
let renderViewCalls = 0;
let activePoolScope = 'season-scope';
let activeEscapeListeners = 0;
const nativeDocumentAddEventListener = dom.window.document.addEventListener.bind(dom.window.document);
const nativeDocumentRemoveEventListener = dom.window.document.removeEventListener.bind(dom.window.document);
dom.window.document.addEventListener = (type, listener, options) => {
  if (type === 'keydown' && listener === domView?._replaceEscape) activeEscapeListeners++;
  return nativeDocumentAddEventListener(type, listener, options);
};
dom.window.document.removeEventListener = (type, listener, options) => {
  if (type === 'keydown' && listener === domView?._replaceEscape) activeEscapeListeners--;
  return nativeDocumentRemoveEventListener(type, listener, options);
};
const domReplaceCalls = [];
const domSignCalls = [];
const addTransferCandidate = { id: actualAddOwned.id, name: actualAddOwned.name, team: 'Phoenix Suns', position: 'SF', pool: 'green', overall: 82, seasonId: 'season-scope' };
players.push(addTransferCandidate, ownedScopedGreenPlayer, ownedForeignGreenPlayer, ownedWrongPoolPlayer);
ownerSummary.rosterEntries.push(
  { player: addTransferCandidate, source: 'signed', draftSlot: null },
  { player: ownedScopedGreenPlayer, source: 'draft', draftSlot: 4 },
  { player: ownedForeignGreenPlayer, source: 'draft', draftSlot: 5 },
  { player: ownedWrongPoolPlayer, source: 'draft', draftSlot: 6 },
);
const domContext = {
  document: dom.window.document,
  window: dom.window,
  AdminApp: { renderView() {
    renderViewCalls++;
    domView._mountReplaceModal('season-id');
    if (domView._manualEditUnlocked) domView._bindManualEditActions(dom.window.document.querySelector('#roster'), { id: 'season-id' });
  } },
  AuthBoundary: { requireAuth() {} },
  AdminActions: {
    manualReplacePlayerOnRoster(...args) { domReplaceCalls.push(args); },
    manualSignPlayerToRoster(...args) {
      domSignCalls.push(args);
      if (args[2] === actualAddOwned.id) {
        dataContext.AdminActions.manualSignPlayerToRoster(
          actualSeason.id, args[1] === 'destination-id' ? actualDestination.id : args[1],
          args[2], args[3], args[4], args[5] === 'current-owner-id' ? actualOwner.id : args[5]
        );
      }
    },
  },
  showToast() {},
  escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); },
  poolLabel(value) { return ({ green: 'Green', blue: 'Blue', white: 'White' })[value] || '—'; },
  classificationBadge(value) { return value || '—'; },
  teamBadge() { return '<span>Team</span>'; },
  LeagueData: {
    getPlayer(id, seasonId) { return seasonId === 'season-id' ? players.find(p => p.id === id) || null : null; },
    getParticipant(_seasonId, participantId) { return [ownerSummary, destinationSummary].find(s => s.participant.id === participantId)?.participant || null; },
    getCurrentSeason() { return { id: 'season-id', playerPoolScope: activePoolScope }; },
    getSeason() { return { id: 'season-id', playerPoolScope: activePoolScope }; },
    getSwapEligibleReplacements(_seasonId, pool) {
      const rosterOwnedIds = new Set(ownerSummary.rosterEntries.map(entry => entry.player?.id));
      return players.filter(p => p.pool === pool
        && (p.id === actualAddOwned.id || (p.seasonId === activePoolScope && !rosterOwnedIds.has(p.id))));
    },
    getRosterSummary() { return [ownerSummary, destinationSummary]; },
    getJokerEligiblePlayers() { return []; },
  },
};

// Ordinary Add Player opens the shared body-mounted modal, includes both
// unowned and roster-owned candidates, and filters the list in place while
// typing instead of re-rendering the complete roster view.
domView = vm.runInNewContext(`${rosterSource}\nAdminRosterView;`, domContext);
domView._manualEditUnlocked = true;
domView._manualAddTarget = destinationSummary.participant.id;
domView._manualReplaceOutgoing = null;
domView._manualFillSlot = null;
domView._manualAddPool = 'green';
domView._manualSelectedPlayer = null;
const addMarkup = domView._renderRosterCard({ ...destinationSummary, totalRating: 0, remaining: 875, isOverCap: false }, 875, null, 'season-id');
assert.doesNotMatch(addMarkup, /roster-manual-picker/, 'Add Player no longer renders the old inline picker');
domView._mountReplaceModal('season-id');
let addOverlay = dom.window.document.getElementById('manualReplacePlayerOverlay');
assert.match(addOverlay.querySelector('[role="dialog"] h2').textContent, /Sign Player/);
assert.ok(addOverlay.querySelector('[data-player-id="free-agent-actual-id"]'), 'unowned available players are shown');
assert.ok(addOverlay.querySelector('[data-player-id="owned-green-actual-id"]'), 'players owned by another roster are offered for transfer');
const greenCandidateIds = domView._getManualReplaceCandidates('season-id', 'green').map(player => player.id);
assert.ok(greenCandidateIds.includes(ownedScopedGreenPlayer.id), 'owned players matching the active scope remain visible');
assert.ok(!greenCandidateIds.includes(ownedForeignGreenPlayer.id), 'owned players with an explicit conflicting scope are excluded');
assert.ok(!greenCandidateIds.includes(ownedWrongPoolPlayer.id), 'owned players outside the selected pool are excluded');
assert.equal(greenCandidateIds.filter(id => id === actualAddOwned.id).length, 1,
  'a stale duplicate from the unowned source is shown once and remains marked as owned');
assert.equal(domView._getManualReplaceCandidates('season-id', 'green').find(p => p.id === actualAddOwned.id).ownerId,
  ownerSummary.participant.id, 'roster ownership wins over a duplicate availability snapshot');
activePoolScope = null;
assert.ok(domView._getManualReplaceCandidates('season-id', 'green').some(p => p.id === ownedForeignGreenPlayer.id),
  'unscoped legacy seasons retain their prior roster-owned candidate behavior');
activePoolScope = 'season-scope';
renderViewCalls = 0;
domView._bindManualEditActions(dom.window.document.querySelector('#roster'), { id: 'season-id' });
assert.equal(activeEscapeListeners, 1, 'opening the popup installs exactly one Escape listener');
let addSearch = addOverlay.querySelector('#manualPickerSearch');
assert.equal(dom.window.document.activeElement, addSearch, 'opening the popup focuses its search input');
const outsideFocusControl = dom.window.document.createElement('button');
outsideFocusControl.textContent = 'Unrelated roster control';
dom.window.document.querySelector('#roster').appendChild(outsideFocusControl);
outsideFocusControl.focus();
domContext.AdminApp.renderView('roster');
addOverlay = dom.window.document.getElementById('manualReplacePlayerOverlay');
assert.equal(dom.window.document.activeElement, outsideFocusControl,
  'an unrelated roster rerender does not steal focus into the popup');
assert.equal(activeEscapeListeners, 1, 'an unrelated rerender does not duplicate the Escape listener');
outsideFocusControl.remove();
addSearch = addOverlay.querySelector('#manualPickerSearch');
renderViewCalls = 0;
addSearch.focus();
addSearch.value = 'Free Agent';
addSearch.setSelectionRange(4, 4);
addSearch.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
addOverlay = dom.window.document.getElementById('manualReplacePlayerOverlay');
assert.equal(renderViewCalls, 0, 'typing does not re-render the complete roster view');
assert.equal(dom.window.document.activeElement, addSearch, 'in-place search keeps focus on the search input');
assert.equal(addSearch.selectionStart, 4, 'in-place search preserves the caret position');
assert.deepEqual(Array.from(addOverlay.querySelectorAll('.manual-roster-candidate'), option => option.dataset.playerId), ['free-agent-actual-id']);
addSearch.value = '';
addSearch.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
assert.equal(addOverlay.querySelectorAll('.manual-roster-candidate').length, 4, 'clearing search restores every eligible available and transferable candidate');
const greenPoolTab = addOverlay.querySelector('[data-manual-pool="green"]');
greenPoolTab.focus();
greenPoolTab.click();
addOverlay = dom.window.document.getElementById('manualReplacePlayerOverlay');
assert.equal(dom.window.document.activeElement, addOverlay.querySelector('[data-manual-pool="green"]'),
  'switching pools keeps focus on the corresponding tab inside the remounted dialog');
assert.equal(dom.window.document.activeElement.closest('[role="dialog"]'), addOverlay.querySelector('[role="dialog"]'),
  'pool switching does not move focus outside the dialog');

// Ordinary Add Player transfer: selecting an owned player requires explicit
// confirmation; Cancel performs no write; confirmation invokes the real
// data-layer transfer action with the expected current owner.
const addTransferBeforeCancel = JSON.stringify([
  dataContext.FirebaseSync.getCache().seasons[actualSeason.id].currentRosters[actualOwner.id],
  dataContext.FirebaseSync.getCache().seasons[actualSeason.id].currentRosters[actualDestination.id],
]);
const addTransferHistoryBefore = JSON.stringify(dataContext.FirebaseSync.getCache().seasons[actualSeason.id].playerDraftPicks);
const addOwnedButton = addOverlay.querySelector(`[data-player-id="${actualAddOwned.id}"]`);
addOwnedButton.focus();
addOwnedButton.click();
addOverlay = dom.window.document.getElementById('manualReplacePlayerOverlay');
const selectedOwnedButton = addOverlay.querySelector(`[data-player-id="${actualAddOwned.id}"]`);
assert.equal(dom.window.document.activeElement, selectedOwnedButton,
  'selecting a player restores focus to its candidate button after the popup rerender');
assert.equal(selectedOwnedButton.getAttribute('aria-pressed'), 'true', 'the focused selected candidate remains keyboard-accessible');
assert.equal(dom.window.document.activeElement.closest('[role="dialog"]'), addOverlay.querySelector('[role="dialog"]'),
  'selecting a candidate never leaves focus on the body or outside the dialog');
const addSignButton = addOverlay.querySelector('[data-manual-action="modalConfirmSign"]');
addSignButton.focus();
addSignButton.click();
addOverlay = dom.window.document.getElementById('manualReplacePlayerOverlay');
assert.equal(dom.window.document.activeElement, addOverlay.querySelector('[data-manual-action="cancelReplaceTransfer"]'),
  'transfer confirmation rerender focuses its in-dialog Cancel action');
assert.match(addOverlay.querySelector('[role="alert"]').textContent, /Add Transfer Actual[\s\S]*Xtian[\s\S]*Destination Team/);
assert.equal(domSignCalls.length, 0, 'selecting an owned player does not sign it without transfer confirmation');
addOverlay.querySelector('[data-manual-action="cancelReplaceTransfer"]').click();
assert.equal(JSON.stringify([
  dataContext.FirebaseSync.getCache().seasons[actualSeason.id].currentRosters[actualOwner.id],
  dataContext.FirebaseSync.getCache().seasons[actualSeason.id].currentRosters[actualDestination.id],
]), addTransferBeforeCancel, 'canceling transfer confirmation leaves both rosters unchanged');
addOverlay = dom.window.document.getElementById('manualReplacePlayerOverlay');
addOverlay.querySelector('[data-manual-action="modalConfirmSign"]').click();
addOverlay = dom.window.document.getElementById('manualReplacePlayerOverlay');
addOverlay.querySelector('[aria-label="Close replace player dialog"]').click();
assert.equal(dom.window.document.getElementById('manualReplacePlayerOverlay'), null,
  'closing the transfer confirmation dismisses the Add Player modal');
assert.equal(activeEscapeListeners, 0, 'closing the popup removes its Escape listener');
assert.equal(JSON.stringify([
  dataContext.FirebaseSync.getCache().seasons[actualSeason.id].currentRosters[actualOwner.id],
  dataContext.FirebaseSync.getCache().seasons[actualSeason.id].currentRosters[actualDestination.id],
]), addTransferBeforeCancel, 'closing transfer confirmation leaves both rosters unchanged');

domView._manualAddTarget = destinationSummary.participant.id;
domView._manualReplaceOutgoing = null;
domView._manualFillSlot = null;
domView._manualSelectedPlayer = null;
domView._manualTransferOwner = null;
domView._manualAddPool = 'green';
domContext.AdminApp.renderView('roster');
assert.equal(activeEscapeListeners, 1, 'reopening the popup installs one fresh Escape listener');
dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
assert.equal(dom.window.document.getElementById('manualReplacePlayerOverlay'), null, 'Escape closes the popup');
assert.equal(activeEscapeListeners, 0, 'Escape-to-close removes the listener without a stale registration');

domView._manualAddTarget = destinationSummary.participant.id;
domView._manualReplaceOutgoing = null;
domView._manualFillSlot = null;
domView._manualSelectedPlayer = actualAddOwned.id;
domView._manualTransferOwner = null;
domView._manualAddPool = 'green';
domContext.AdminApp.renderView('roster');
addOverlay = dom.window.document.getElementById('manualReplacePlayerOverlay');
addOverlay.querySelector('[data-manual-action="modalConfirmSign"]').focus();
addOverlay.querySelector('[data-manual-action="modalConfirmSign"]').click();
addOverlay = dom.window.document.getElementById('manualReplacePlayerOverlay');
assert.equal(domSignCalls.length, 0, 'closing the confirmation performs no roster write');
assert.match(addOverlay.querySelector('[role="alert"]').textContent, /Add Transfer Actual[\s\S]*Xtian[\s\S]*Destination Team/);
addOverlay.querySelector('[data-manual-action="confirmReplaceTransfer"]').click();
assert.deepEqual(domSignCalls[0], [
  'season-id', 'destination-id', actualAddOwned.id, true, null, 'current-owner-id',
], 'ordinary Add Player transfer invokes manualSignPlayerToRoster with the expected owner and no draft slot');
const addTransferSeason = dataContext.FirebaseSync.getCache().seasons[actualSeason.id];
assert.ok(!addTransferSeason.currentRosters[actualOwner.id].some(entry => entry.playerId === actualAddOwned.id),
  'the former owner no longer owns the transferred player');
assert.equal(addTransferSeason.currentRosters[actualDestination.id].filter(entry => entry.playerId === actualAddOwned.id).length, 1,
  'the destination owns exactly one transferred player');
assert.equal(addTransferSeason.currentRosters[actualDestination.id].find(entry => entry.playerId === actualAddOwned.id).draftSlot, 6,
  'ordinary Add Player transfer fills the lowest destination vacancy');
assert.equal(addTransferSeason.currentRosters[actualDestination.id].find(entry => entry.playerId === actualAddOwned.id).classificationSourcePlayerId,
  'vacancy-classification-anchor', 'the filled vacancy preserves its classification metadata');
assert.equal(addTransferSeason.currentRosters[actualDestination.id].length, 2,
  'filling a vacancy replaces the roster entry instead of appending');
assert.equal(addTransferSeason.currentRosters[actualDestination.id].filter(entry => entry.source !== 'empty' && entry.playerId).length, 2,
  'empty draft slots are not counted as active players');
assert.equal(JSON.stringify(addTransferSeason.playerDraftPicks), addTransferHistoryBefore,
  'ordinary transfer preserves historical draft-pick records');
assert.equal(Object.values(addTransferSeason.currentRosters).flat()
  .filter(entry => entry.source !== 'empty' && entry.playerId === actualAddOwned.id).length, 1,
  'the transferred player has exactly one active roster assignment');
domView._closeManualPicker();
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
assert.deepEqual(domSignCalls[1].slice(0, 5), ['season-id', 'destination-id', freeAgent.id, false, 8],
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
const signCallsBeforeCancelledSlotTransfer = domSignCalls.length;
assert.match(slotOverlay.querySelector('[role="alert"]').textContent, /Xtian[\s\S]*Destination Team[\s\S]*slot #9/);
slotOverlay.querySelector('[data-manual-action="cancelReplaceTransfer"]').click();
assert.equal(domSignCalls.length, signCallsBeforeCancelledSlotTransfer, 'cancelling slot transfer causes no assignment');
slotOverlay = dom.window.document.getElementById('manualReplacePlayerOverlay');
slotOverlay.querySelector('[data-manual-action="modalConfirmSign"]').click();
slotOverlay = dom.window.document.getElementById('manualReplacePlayerOverlay');
slotOverlay.querySelector('[data-manual-action="confirmReplaceTransfer"]').click();
assert.deepEqual(domSignCalls[2].slice(0, 6), [
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
