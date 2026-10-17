'use strict';

// Regression for a legacy seeded All-Time player remaining transferable in
// the current live-pool season after a swap. Uses only in-memory fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const dataSource = fs.readFileSync(path.join(root, 'js/data.js'), 'utf8');
const rosterSource = fs.readFileSync(path.join(root, 'js/admin/roster.js'), 'utf8');
const LIVE_SCOPE = '__LIVE_NBA2K27_POOL__';
const MIA_SLUG = 'alonzo-mourning-all-time-miami-heat';
const CHA_SLUG = 'alonzo-mourning-all-time-charlotte-hornets';

function buildScenario(targetDraftSlot = null) {
  const dataContext = {
    console,
    window: { USE_SUPABASE_SYNC: false },
    firebase: { firestore: () => ({ collection: () => ({ doc: () => ({ onSnapshot() {}, set() { return Promise.resolve(); } }) }) }) },
    showToast() {},
  };
  vm.createContext(dataContext);
  vm.runInContext(dataSource, dataContext, { filename: 'data.js' });
  vm.runInContext(
    'this.FirebaseSync = FirebaseSync; this.LeagueData = LeagueData; this.AdminActions = AdminActions; this.getDefaultData = getDefaultData;',
    dataContext
  );
  let cache = dataContext.getDefaultData();
  dataContext.FirebaseSync.getCache = () => cache;
  dataContext.FirebaseSync.save = (data) => { cache = data; };

  const season = dataContext.AdminActions.createSeason('Alonzo transfer fixture');
  const maca = dataContext.AdminActions.addParticipant(season.id, 'Maca');
  const destination = dataContext.AdminActions.addParticipant(season.id, 'Destination');
  const legacyAlonzo = dataContext.AdminActions.addPlayer({
    name: 'Alonzo Mourning (MIA)', position: 'C', overall: 94, pool: 'blue', nba2kRef: MIA_SLUG,
  });
  const camby = dataContext.AdminActions.addPlayer({
    name: 'Marcus Camby (DEN)', position: 'C', overall: 85, pool: 'blue', nba2kRef: 'marcus-camby-all-time-denver-nuggets',
  });
  const swapIn = dataContext.AdminActions.addPlayer({ name: 'Swap Replacement', position: 'PF', overall: 85, pool: 'blue' });
  const seasonData = cache.seasons[season.id];
  seasonData.playerPoolScope = LIVE_SCOPE;
  seasonData.rostersInitialized = true;
  seasonData.ratingCap = 875;
  seasonData.currentSeasonDay = 1;
  seasonData.playerDraftPicks = [{ participantId: maca.id, playerId: legacyAlonzo.id, round: 1, pick: 1 }];
  seasonData.currentRosters = {
    [maca.id]: [
      { playerId: legacyAlonzo.id, source: 'draft', draftSlot: 1 },
      { playerId: camby.id, source: 'draft', draftSlot: 2 },
    ],
    [destination.id]: targetDraftSlot == null ? [] : [
      { source: 'empty', playerId: null, draftSlot: targetDraftSlot },
    ],
  };
  legacyAlonzo.seasonId = 'legacy-seeded-season';
  Object.assign(cache.players[legacyAlonzo.id], legacyAlonzo, { team: 'All-Time Miami Heat' });
  Object.assign(cache.players[camby.id], camby, { seasonId: LIVE_SCOPE });
  Object.assign(cache.players[swapIn.id], swapIn, { seasonId: LIVE_SCOPE });

  // The authoritative current scoped catalog record and the separate CHA
  // variant. The old roster assignment above keeps its seeded player ID.
  const liveMia = {
    id: `p27live_${MIA_SLUG}`, nba2kRef: MIA_SLUG, name: 'Alonzo Mourning (MIA)',
    team: 'All-Time Miami Heat', position: 'C', overall: 94, pool: 'blue', seasonId: LIVE_SCOPE,
  };
  const liveCha = {
    id: `p27live_${CHA_SLUG}`, nba2kRef: CHA_SLUG, name: 'Alonzo Mourning (CHA)',
    team: 'All-Time Charlotte Hornets', position: 'C', overall: 89, pool: 'blue', seasonId: LIVE_SCOPE,
  };
  cache.players[liveMia.id] = liveMia;
  cache.players[liveCha.id] = liveCha;
  dataContext.FirebaseSync.save(cache);

  // Marcus Camby is swapped out; the All-Time Miami record remains actively
  // owned by Maca. This is the roster state the pickers must honor.
  dataContext.AdminActions.commitSwap(season.id, {
    participantId: maca.id, outgoingPlayerId: camby.id, incomingPlayerId: swapIn.id,
    isJokerSwap: false,
  });
  const postSwap = dataContext.FirebaseSync.getCache().seasons[season.id];
  assert.ok(postSwap.currentRosters[maca.id].some(e => e.playerId === legacyAlonzo.id));
  assert.ok(!postSwap.currentRosters[maca.id].some(e => e.playerId === camby.id));
  assert.equal(postSwap.transactions.at(-1).playersOut[0].playerId, camby.id);
  assert.ok(!dataContext.LeagueData.getSwapEligibleReplacements(season.id, 'blue').some(p => p.id === legacyAlonzo.id),
    'the historically drafted legacy ID remains reserved from the free-agent pool');

  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://draftp.test/admin.html' });
  const uiContext = {
    document: dom.window.document,
    window: dom.window,
    LeagueData: dataContext.LeagueData,
    AdminActions: dataContext.AdminActions,
    AuthBoundary: { requireAuth() {} },
    AdminApp: { renderView() {} },
    showToast() {},
    escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); },
    poolLabel(value) { return ({ blue: 'Blue', green: 'Green', white: 'White' })[value] || '—'; },
  };
  vm.createContext(uiContext);
  vm.runInContext(rosterSource, uiContext, { filename: 'roster.js' });
  vm.runInContext('this.AdminRosterView = AdminRosterView;', uiContext);

  const pickerRoot = dom.window.document.createElement('div');
  uiContext.AdminApp.renderView = () => {
    if (targetDraftSlot == null) {
      pickerRoot.innerHTML = uiContext.AdminRosterView._renderManualPicker(destination.id, season.id);
      uiContext.AdminRosterView._bindManualEditActions(pickerRoot, dataContext.LeagueData.getSeason(season.id));
    }
  };
  return { dataContext, uiContext, season, maca, destination, legacyAlonzo, liveCha, targetDraftSlot, pickerRoot };
}

function exerciseTransfer(targetDraftSlot) {
  const fixture = buildScenario(targetDraftSlot);
  const { dataContext, uiContext, season, maca, destination, legacyAlonzo, liveCha, pickerRoot } = fixture;
  const view = uiContext.AdminRosterView;
  view._manualAddTarget = destination.id;
  view._manualReplaceOutgoing = null;
  view._manualFillSlot = targetDraftSlot;
  view._manualAddPool = 'blue';
  view._manualSelectedPlayer = null;

  const candidates = view._getManualReplaceCandidates(season.id, 'blue');
  const selected = candidates.find(p => p.nba2kRef === MIA_SLUG);
  assert.ok(selected, 'All-Time Miami Heat Alonzo must be listed');
  assert.equal(selected.id, legacyAlonzo.id, 'selection keeps the actual owned roster ID for validation');
  assert.equal(selected.overall, 94);
  assert.equal(selected.team, 'All-Time Miami Heat');
  assert.equal(selected.ownerId, maca.id, 'candidate is correctly marked owned by Maca');
  assert.equal(candidates.filter(p => p.nba2kRef === MIA_SLUG).length, 1, 'no duplicate live/legacy row is shown');
  const charlotte = candidates.find(p => p.nba2kRef === CHA_SLUG);
  assert.equal(charlotte.id, liveCha.id);
  assert.equal(charlotte.overall, 89);
  assert.notEqual(charlotte.id, selected.id, 'the 89 OVR CHA variant remains distinct');

  if (targetDraftSlot == null) {
    const markup = view._renderManualPicker(destination.id, season.id);
    assert.match(markup, /Alonzo Mourning \(MIA\)[\s\S]*94/);
    assert.match(markup, /Maca/);
    uiContext.AdminApp.renderView();
    const transferButton = pickerRoot.querySelector(`[data-manual-action="requestTransfer"][data-player-id="${legacyAlonzo.id}"]`);
    assert.ok(transferButton, 'Add Player offers a transfer action for the exact Miami player ID');
    transferButton.click();
    assert.equal(view._manualTransferOwner?.id, maca.id, 'Add Player enters its transfer confirmation path');
    assert.ok(pickerRoot.querySelector('[data-manual-action="confirmTransfer"]'));
    pickerRoot.querySelector('[data-manual-action="confirmTransfer"]').click();
  } else {
    const markup = view._renderReplaceModal(season.id);
    assert.match(markup, /Alonzo Mourning \(MIA\)[\s\S]*94/);
    assert.match(markup, /OWNED BY Maca/);
    assert.match(markup, new RegExp(`Fill Draft Slot #${targetDraftSlot}`));
    view._manualSelectedPlayer = selected.id;
    view._requestManualSign(season.id);
    assert.equal(view._manualTransferOwner?.ownerId, maca.id, 'Fill Draft Slot enters its transfer confirmation path');
    assert.equal(view._manualTransferOwner?.playerId, legacyAlonzo.id);
    view._confirmManualTransferReplace(season.id);
  }

  const after = dataContext.FirebaseSync.getCache().seasons[season.id];
  const sourceRoster = after.currentRosters[maca.id];
  const destinationRoster = after.currentRosters[destination.id];
  assert.equal(sourceRoster.filter(e => e.playerId === legacyAlonzo.id).length, 0);
  assert.equal(destinationRoster.filter(e => e.playerId === legacyAlonzo.id).length, 1);
  if (targetDraftSlot != null) assert.equal(destinationRoster.find(e => e.playerId === legacyAlonzo.id).draftSlot, targetDraftSlot);
  assert.equal(after.transactions.at(-1).type, 'manualRosterTransfer');
  assert.deepEqual(JSON.parse(JSON.stringify(after.playerDraftPicks)), [
    { participantId: maca.id, playerId: legacyAlonzo.id, round: 1, pick: 1 },
  ], 'the original historical draft record is preserved');
  assert.ok(dataContext.LeagueData.getSwapEligibleReplacements(season.id, 'blue').every(p => p.id !== legacyAlonzo.id),
    'transfer does not make the historical player available as a free agent');
}

exerciseTransfer(null); // Add Player
exerciseTransfer(8);    // Fill Draft Slot
console.log('Alonzo Mourning owned-player candidate and transfer regressions passed.');
