'use strict';
// Focused integration regressions for PIN-gated Manual Roster Edit Joker actions.
// Run with: node tests_joker_pick/manual_joker_improvements_test.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const dataSource = fs.readFileSync(path.join(root, 'js', 'data.js'), 'utf8');
const rosterSource = fs.readFileSync(path.join(root, 'js', 'admin', 'roster.js'), 'utf8');

const dataContext = {
  console, window: { USE_SUPABASE_SYNC: false },
  firebase: { firestore: () => ({ collection: () => ({ doc: () => ({ onSnapshot() {}, set() { return Promise.resolve(); } }) }) }) },
  showToast() {},
};
vm.createContext(dataContext);
vm.runInContext(dataSource + '\nthis.LeagueData=LeagueData; this.AdminActions=AdminActions; this.FirebaseSync=FirebaseSync; this.getDefaultData=getDefaultData;', dataContext);
let cache = dataContext.getDefaultData();
dataContext.FirebaseSync.getCache = () => cache;
dataContext.FirebaseSync.save = value => { cache = value; };

const season = dataContext.AdminActions.createSeason('Manual Joker Improvements Regression');
const participant = dataContext.AdminActions.addParticipant(season.id, 'Joker Test');
const firstFour = ['PG', 'SG', 'SF', 'PF'].map((position, i) => dataContext.AdminActions.addPlayer({
  name: 'Opening ' + (i + 1), position, overall: 80, pool: i < 2 ? 'green' : 'blue',
}));
const second = dataContext.AdminActions.addPlayer({ name: 'Second Candidate', position: 'C', overall: 81, pool: 'green' });
const third = dataContext.AdminActions.addPlayer({ name: 'Third Candidate', position: 'C', overall: 82, pool: 'green' });
const savedSeason = cache.seasons[season.id];
savedSeason.rostersInitialized = true;
savedSeason.ratingCap = 875;
savedSeason.playerDraftPicks = firstFour.map((player, i) => ({
  round: 1, pick: i + 1, participantId: participant.id, playerId: player.id,
  ...(i === 0 ? { isJoker: true, jokerPosition: 'PG' } : {}),
}));
savedSeason.currentRosters = {
  [participant.id]: [
    ...firstFour.map((player, i) => ({
      playerId: player.id, source: 'draft', draftSlot: i + 1,
      ...(i === 0 ? { isJoker: true, jokerPosition: 'PG' } : {}),
    })),
    { playerId: second.id, source: 'manual', draftSlot: null },
    { playerId: third.id, source: 'manual', draftSlot: null },
  ],
};
dataContext.FirebaseSync.save(cache);

const rosterNow = () => cache.seasons[season.id].currentRosters[participant.id];
const rosterBefore = () => JSON.stringify(rosterNow());
const historyBefore = JSON.stringify(cache.seasons[season.id].playerDraftPicks);
const ovrBefore = dataContext.LeagueData.getCurrentRoster(season.id, participant.id)
  .reduce((sum, entry) => sum + entry.player.overall, 0);
assert.throws(() => dataContext.AdminActions.designateJoker(
  season.id, participant.id, second.id, 'C', { bypassRosterRules: true },
), /first four picks are all Green Pool players/);

let confirmResult = false;
let confirmCount = 0;
const confirmButton = { dataset: { participantId: participant.id, playerId: second.id } };
const removeButton = { dataset: { participantId: participant.id, playerId: second.id } };
const positionSelect = { value: 'PG' };
const uiContext = {
  document: { getElementById(id) { return id === 'manualJokerPositionSelect' ? positionSelect : null; } },
  window: { confirm(message) {
    confirmCount++;
    assert.equal(message, 'Warning: This participant will have two Jokers. Do you want to continue?');
    return confirmResult;
  } },
  AuthBoundary: { requireAuth() {} },
  FirebaseSync: dataContext.FirebaseSync,
  AdminActions: dataContext.AdminActions,
  AdminApp: { renderView() {} },
  LeagueData: dataContext.LeagueData,
  escapeHtml(value) { return String(value ?? ''); },
  showToast() {},
};
vm.createContext(uiContext);
const view = vm.runInNewContext(rosterSource + '\nAdminRosterView;', uiContext);
const container = {
  querySelector() { return null; },
  querySelectorAll(selector) {
    if (selector.includes('confirmJokerSwap')) return [confirmButton];
    if (selector.includes('removeJoker')) return [removeButton];
    return [];
  },
};
view._bindManualEditActions(container, season);
const beforeCancel = rosterBefore();
confirmButton.onclick();
assert.equal(confirmCount, 1, 'a second Joker prompts for confirmation');
assert.equal(rosterBefore(), beforeCancel, 'cancellation makes no roster change');

confirmResult = true;
confirmButton.onclick();
assert.equal(rosterNow().filter(entry => entry.isJoker).length, 2, 'confirmation preserves the first Joker and assigns the second');
assert.equal(rosterNow().find(entry => entry.playerId === second.id).jokerOriginalPosition, 'C');
assert.equal(JSON.stringify(cache.seasons[season.id].playerDraftPicks), historyBefore);
assert.equal(confirmCount, 2);
const picker = view._renderJokerSwapPicker(participant.id, second.id, season.id);
assert.match(picker, /Remove Joker/);

// Repositioning an existing Joker does not warn and retains its saved original position.
positionSelect.value = 'PF';
confirmButton.onclick();
assert.equal(confirmCount, 2, 'repositioning does not ask for second-Joker confirmation');
assert.equal(rosterNow().find(entry => entry.playerId === second.id).jokerPosition, 'PF');
assert.equal(rosterNow().find(entry => entry.playerId === second.id).jokerOriginalPosition, 'C');

removeButton.onclick();
let roster = rosterNow();
const restored = roster.find(entry => entry.playerId === second.id);
assert.equal(restored.isJoker, undefined);
assert.equal(restored.jokerPosition, undefined);
assert.equal(restored.jokerOriginalPosition, undefined);
assert.equal(restored.source, 'manual');
assert.equal(restored.draftSlot, null);
assert.equal(roster.filter(entry => entry.isJoker).length, 1, 'removing one Joker leaves the other untouched');
assert.equal(JSON.stringify(cache.seasons[season.id].playerDraftPicks), historyBefore);
assert.equal(dataContext.LeagueData.getCurrentRoster(season.id, participant.id).reduce((sum, entry) => sum + entry.player.overall, 0), ovrBefore);
assert.ok(ovrBefore <= 875);

// Historical Joker entries lack position metadata; never guess a restoration position.
const legacyBefore = rosterBefore();
assert.throws(
  () => dataContext.AdminActions.manualRemoveJoker(season.id, participant.id, firstFour[0].id),
  /original roster position was not saved/,
);
assert.equal(rosterBefore(), legacyBefore, 'legacy removal failure leaves the roster unchanged');

// A third Joker remains prohibited even with the manual-only option.
dataContext.AdminActions.designateJoker(season.id, participant.id, second.id, 'C', {
  bypassRosterRules: true, allowSecondJokerManual: true, captureJokerOriginalPosition: true,
});
assert.throws(
  () => dataContext.AdminActions.designateJoker(season.id, participant.id, third.id, 'C', {
    bypassRosterRules: true, allowSecondJokerManual: true, captureJokerOriginalPosition: true,
  }),
  /at most two Jokers/,
);
console.log('Manual Joker improvements: confirmation, cancellation, two-Joker preservation, removal, legacy safety, draft isolation, OVR, and cap checks passed.');
