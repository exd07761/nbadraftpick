'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

class FakeControl {
  constructor(document, id, value = '') {
    this.document = document;
    this.id = id;
    this.value = value;
    this.textContent = '';
    this.disabled = false;
    this.onclick = null;
    this.isConnected = true;
    this.hidden = false;
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.options = [];
  }
  focus() { this.document.activeElement = this; }
  addEventListener(type, callback) {
    (this.listeners[type] ||= []).push(callback);
  }
  dispatch(type, event = {}) {
    for (const callback of this.listeners[type] || []) callback(event);
  }
  click() {
    this.onclick?.();
    this.dispatch('click', { target: this });
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'data-active') this.dataset.active = String(value);
  }
  removeAttribute(name) {
    delete this.attributes[name];
    if (name === 'aria-activedescendant') delete this.attributes[name];
    if (name === 'data-active') delete this.dataset.active;
  }
  toggleAttribute(name, force) {
    if (force) this.setAttribute(name, 'true');
    else this.removeAttribute(name);
  }
  querySelectorAll() { return this.options; }
  scrollIntoView() {}
}

class FakeDialog {
  constructor(document, overlay) {
    this.document = document;
    this.overlay = overlay;
    this.isConnected = true;
    this.controls = {};
  }
  focus() { this.document.activeElement = this; }
  contains(element) { return element === this || Object.values(this.controls).includes(element); }
  querySelector(selector) { return this.controls[selector.slice(1)] || null; }
  querySelectorAll() {
    return ['scoreAInput', 'scoreBInput', 'streamerInput', 'btnCancelScore', 'btnSaveScore']
      .map((id) => this.controls[id]);
  }
}

class FakeOverlay {
  constructor(document) {
    this.document = document;
    this.isConnected = false;
    this.markup = '';
    this.controls = {};
    this.dialog = new FakeDialog(document, this);
  }
  set innerHTML(markup) {
    this.markup = markup;
    const valueFor = (id) => {
      const input = markup.match(new RegExp(`<input[^>]*id="${id}"[^>]*value="([^"]*)"`));
      if (input) return input[1];
      return '';
    };
    for (const id of ['scoreAInput', 'scoreBInput', 'streamerInput', 'scoreStreamerValue', 'scoreStreamerOptions', 'scoreError', 'btnCancelScore', 'btnSaveScore']) {
      this.controls[id] = new FakeControl(this.document, id, valueFor(id));
    }
    const streamerValue = markup.match(/id="streamerInput"[^>]*data-streamer-value="([^"]*)"/);
    this.controls.streamerInput.dataset.streamerValue = streamerValue ? streamerValue[1] : '';
    const selectedLabel = markup.match(/id="scoreStreamerValue">([^<]*)/);
    this.controls.scoreStreamerValue.textContent = selectedLabel ? selectedLabel[1] : '';
    this.controls.scoreStreamerOptions.hidden = /id="scoreStreamerOptions"[^>]*\shidden>/.test(markup);
    this.controls.scoreStreamerOptions.options = [...markup.matchAll(/<div class="score-streamer-option" id="([^"]+)" role="option" tabindex="-1"\s+aria-selected="([^"]+)" data-streamer-value="([^"]*)">\s*([\s\S]*?)\s*<\/div>/g)]
      .map((match) => {
        const option = new FakeControl(this.document, match[1]);
        option.dataset.streamerValue = match[3];
        option.textContent = match[4].trim();
        option.setAttribute('aria-selected', match[2]);
        return option;
      });
    this.dialog.controls = this.controls;
  }
  get innerHTML() { return this.markup; }
  querySelector(selector) {
    if (selector === '[role="dialog"]') return this.dialog;
    return this.controls[selector.slice(1)] || null;
  }
  querySelectorAll(selector) {
    if (selector === '[role="option"]') return this.controls.scoreStreamerOptions.options;
    return [];
  }
  remove() {
    this.document.body.children = this.document.body.children.filter((child) => child !== this);
    this.isConnected = false;
    this.dialog.isConnected = false;
    Object.values(this.controls).forEach((control) => { control.isConnected = false; });
  }
}

const document = {
  activeElement: null,
  listeners: {},
  body: {
    style: { overflow: 'auto' },
    children: [],
    appendChild(child) { child.isConnected = true; this.children.push(child); return child; },
  },
  createElement() { return new FakeOverlay(this); },
  addEventListener(type, callback) { this.listeners[type] = callback; },
  removeEventListener(type, callback) {
    if (this.listeners[type] === callback) delete this.listeners[type];
  },
};

const teamA = 'p1';
const teamB = 'p2';
const byeTeam = 'p3';
const matchup = {
  id: 'game-1', teamA, teamB, home: teamA, away: teamB,
  status: 'scheduled', scoreA: null, scoreB: null, winner: null, streamer: null,
  stage: 2, group: 'C',
};
const fixture = {
  settings: { currentSeasonId: 'season1' }, players: {},
  seasons: { season1: {
    id: 'season1', name: 'Modal Test Season',
    participants: {
      [teamA]: { id: teamA, name: 'Player Alpha' },
      [teamB]: { id: teamB, name: 'Player Beta' },
      [byeTeam]: { id: byeTeam, name: 'Player Gamma' },
    },
    teamAssignmentOrder: [teamA, teamB, byeTeam],
    playerDraftOrder: [teamA, teamB, byeTeam],
    nbaTeamAssignments: { [teamA]: 'BOS', [teamB]: 'LAL', [byeTeam]: 'NYK' },
    scheduleFormat: 'groupStage',
    groupStageState: {
      stage: 2,
      groups: { A: [teamA, teamB], B: [byeTeam], C: [], D: [] },
      round2Groups: { A: [teamA, teamB], B: [byeTeam], C: [], D: [] },
    },
    schedule: [{ round: 5, matchups: [matchup, {
      id: 'bye-1', teamA: byeTeam, teamB: null, status: 'scheduled', stage: 2, group: 'B',
    }] }],
    scheduleGeneratedAt: '2026-01-01T00:00:00.000Z',
  } },
};

let failNextWrite = false;
const fakeConsole = { log() {}, warn() {}, error() {} };
const context = {
  console: fakeConsole,
  document,
  window: {},
  fixture,
  escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]); },
  teamBadge: () => '',
  matchupHomeAway: (m) => ({ leftId: m.home || m.teamA, rightId: m.away || m.teamB, leftScore: null, rightScore: null, leftIsWinner: false, rightIsWinner: false, hasHomeCourt: !!m.home }),
  AuthBoundary: { requireAuth() {} },
  showToast() {},
  firebase: { firestore: () => ({
    collection: () => ({ doc: () => ({
      onSnapshot(callback) { callback({ exists: true, data: () => fixture, metadata: { hasPendingWrites: false } }); return () => {}; },
      set() { return failNextWrite ? Promise.reject(new Error('network write failed')) : Promise.resolve(); },
    }) }),
    enablePersistence: () => Promise.resolve(),
  }) },
};
vm.createContext(context);
const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
vm.runInContext(read('js/data.js'), context, { filename: 'data.js' });
vm.runInContext(read('js/admin/schedule.js'), context, { filename: 'admin/schedule.js' });
vm.runInContext(`
  this.FirebaseSync = FirebaseSync;
  this.AdminActions = AdminActions;
  this.LeagueData = LeagueData;
  this.AdminScheduleView = AdminScheduleView;
`, context);
async function run() {
context.FirebaseSync.init();

const season = fixture.seasons.season1;
const updatedScoreButton = new FakeControl(document, 'editScoreButton');
updatedScoreButton.dataset = { matchupId: matchup.id };
const container = { querySelectorAll: () => [updatedScoreButton] };
let renderCount = 0;
context.AdminScheduleView.render = () => { renderCount++; };
const opener = new FakeControl(document, 'enterScoreButton');
opener.focus();

function openGame(id = matchup.id) {
  context.AdminScheduleView._openScoreModal(container, season, id, opener);
  return document.body.children.at(-1) || null;
}
function chooseStreamer(overlay, value) {
  const trigger = overlay.controls.streamerInput;
  if (overlay.controls.scoreStreamerOptions.hidden) trigger.click();
  const option = overlay.controls.scoreStreamerOptions.options.find((item) => item.dataset.streamerValue === value);
  assert(option, `streamer option ${value} exists`);
  option.click();
}

// Opening displays accessible context, score fields, exact streamer order, and focuses the first score.
assert(context.AdminScheduleView._renderMatchupRow(season, matchup).includes('data-action="enter-score"'));
let overlay = openGame();
assert(overlay, 'actual matchup opens a modal');
assert(overlay.markup.includes('role="dialog"') && overlay.markup.includes('aria-modal="true"'));
assert(overlay.markup.includes('Player Alpha') && overlay.markup.includes('BOS'));
assert(overlay.markup.includes('Player Beta') && overlay.markup.includes('LAL'));
assert(overlay.markup.includes('Round 5 · Stage 2 · Group C'));
const scoreFooter = overlay.markup.slice(overlay.markup.indexOf('<footer class="score-modal-actions">'));
assert(scoreFooter.indexOf('class="score-modal-fields"') < scoreFooter.indexOf('id="streamerInput"'));
assert(scoreFooter.indexOf('id="streamerInput"') < scoreFooter.indexOf('class="score-modal-action-buttons"'), 'full-width actions follow the streamer field in a separate footer row');
assert.strictEqual(document.activeElement.id, 'scoreAInput');
assert.strictEqual(document.body.style.overflow, 'hidden');
assert(overlay.markup.includes('role="combobox"') && overlay.markup.includes('aria-haspopup="listbox"'));
assert.deepStrictEqual(overlay.controls.scoreStreamerOptions.options.map((option) => option.dataset.streamerValue), ['Gigs', 'Xtian', 'Jordan', 'Ham', 'Lau', 'Err']);
const scoreCss = read('css/admin.css');
assert(/\.score-modal-actions\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;/s.test(scoreCss), 'footer actions use a full-width vertical layout');
assert(/\.score-modal-streamer \.score-streamer-trigger\s*\{[^}]*display:\s*flex;[^}]*width:\s*100%;[^}]*min-width:\s*0;[^}]*height:\s*44px;/s.test(scoreCss), 'combobox has explicit full-width sizing and readable height');
assert(/\.score-streamer-options\s*\{[^}]*position:\s*absolute;[^}]*bottom:\s*calc\(100%/s.test(scoreCss), 'custom option list opens above the field, away from footer actions');
assert(/\.score-streamer-options\s*\{[^}]*z-index:\s*3;[^}]*background:\s*#1a1d24;/s.test(scoreCss), 'streamer listbox stacks above modal content on a fully opaque dark background');
assert(/\.score-streamer-option\s*\{[^}]*color:\s*var\(--text\);/s.test(scoreCss), 'streamer options use high-contrast text');
assert(/\.score-streamer-option\[aria-selected="true"\][^{]*\{[^}]*background:\s*var\(--accent-dim\);[^}]*color:\s*var\(--text\);/s.test(scoreCss), 'selected and keyboard-active options remain highlighted');
assert(/\.score-modal-fields\s*\{[^}]*width:\s*100%;[^}]*min-width:\s*0;[^}]*flex:\s*0 0 auto;/s.test(scoreCss));
assert(/\.score-modal-action-buttons\s*\{[^}]*width:\s*100%;/s.test(scoreCss), 'action button row spans the footer');
overlay.controls.streamerInput.dispatch('click');
assert.strictEqual(overlay.controls.scoreStreamerOptions.hidden, false, 'combobox opens its listbox');
let listEscapePrevented = false;
overlay.controls.streamerInput.dispatch('keydown', { key: 'Escape', preventDefault() { listEscapePrevented = true; }, stopPropagation() {} });
assert(listEscapePrevented);
assert.strictEqual(overlay.controls.scoreStreamerOptions.hidden, true, 'Escape closes the listbox without closing the score modal');
overlay.controls.streamerInput.click();
overlay.controls.streamerInput.dispatch('keydown', { key: 'ArrowDown', preventDefault() {}, stopPropagation() {} });
overlay.controls.streamerInput.dispatch('keydown', { key: 'Enter', preventDefault() {}, stopPropagation() {} });
assert.strictEqual(overlay.controls.streamerInput.dataset.streamerValue, 'Xtian', 'arrow and Enter select a streamer by keyboard');
assert.strictEqual(overlay.controls.streamerInput.attributes['aria-expanded'], 'false');
assert.strictEqual(overlay.controls.scoreStreamerOptions.hidden, true);
overlay.controls.streamerInput.click();
overlay.controls.streamerInput.dispatch('keydown', { key: 'Tab' });
assert.strictEqual(overlay.controls.scoreStreamerOptions.hidden, true, 'Tab closes the listbox and returns focus flow to the modal controls');
overlay.controls.btnCancelScore.onclick();
assert.strictEqual(document.body.children.length, 0, 'Cancel closes the modal');
assert.strictEqual(document.activeElement, opener, 'Cancel restores focus to Enter Score');
assert.strictEqual(document.body.style.overflow, 'auto');

// Escape closes and focus-trap wraps keyboard focus inside the dialog.
overlay = openGame();
let prevented = false;
document.listeners.keydown({ key: 'Tab', shiftKey: true, preventDefault() { prevented = true; } });
assert(prevented);
assert.strictEqual(document.activeElement.id, 'btnSaveScore');
document.listeners.keydown({ key: 'Escape', preventDefault() {} });
assert.strictEqual(document.body.children.length, 0, 'Escape closes the modal');
assert.strictEqual(document.activeElement, opener, 'Escape restores focus to Enter Score');

// BYE rows have no entry point, and the modal method rejects a direct BYE request.
const bye = season.schedule[0].matchups[1];
assert(!context.AdminScheduleView._renderMatchupRow(season, bye).includes('data-action="enter-score"'));
context.AdminScheduleView._openScoreModal(container, season, bye.id, opener);
assert.strictEqual(document.body.children.length, 0, 'BYEs cannot open score entry');

// Invalid results retain the dialog and entered values; streamer remains required.
overlay = openGame();
overlay.controls.scoreAInput.value = '88';
overlay.controls.scoreBInput.value = '88';
chooseStreamer(overlay, 'Gigs');
await overlay.controls.btnSaveScore.onclick();
assert(overlay.isConnected, 'validation failure leaves the modal open');
assert.strictEqual(overlay.controls.scoreAInput.value, '88');
assert(overlay.controls.scoreError.textContent.includes('Tied scores are not allowed'));
overlay.controls.scoreAInput.value = '90';
overlay.controls.scoreBInput.value = '80';
overlay.controls.streamerInput.dataset.streamerValue = '';
await overlay.controls.btnSaveScore.onclick();
assert(overlay.isConnected, 'required streamer validation leaves the modal open');
assert(overlay.controls.scoreError.textContent.includes('Streamer is required'));
overlay.controls.btnCancelScore.onclick();

// A failed cloud write keeps modal fields and error visible; retry persists completion and standings.
overlay = openGame();
overlay.controls.scoreAInput.value = '101';
overlay.controls.scoreBInput.value = '99';
chooseStreamer(overlay, 'Jordan');
failNextWrite = true;
await overlay.controls.btnSaveScore.onclick();
assert(overlay.isConnected, 'cloud-save failure leaves the modal open');
assert.strictEqual(overlay.controls.scoreAInput.value, '101');
assert(overlay.controls.scoreError.textContent.includes('network write failed'));

failNextWrite = false;
await overlay.controls.btnSaveScore.onclick();
assert(!overlay.isConnected, 'successful save closes the modal');
assert.strictEqual(renderCount, 1, 'successful save refreshes the schedule');
assert.strictEqual(document.activeElement, updatedScoreButton, 'successful save focuses the updated score control');
let savedMatch = context.FirebaseSync.getCache().seasons.season1.schedule[0].matchups[0];
assert.strictEqual(savedMatch.status, 'completed');
assert.strictEqual(savedMatch.scoreA, 101);
assert.strictEqual(savedMatch.scoreB, 99);
assert.strictEqual(savedMatch.winner, teamA);
assert.strictEqual(savedMatch.streamer, 'Jordan');
const standings = context.LeagueData.getTeamStatistics('season1');
assert.strictEqual(standings.find((row) => row.participantId === teamA).gamesPlayed, 1);
assert.strictEqual(standings.find((row) => row.participantId === teamB).gamesPlayed, 1);
assert.strictEqual(standings.find((row) => row.participantId === byeTeam).gamesPlayed, 0);

// Existing values outside the new list remain selected and can be saved unchanged.
savedMatch.streamer = 'Guest Streamer';
overlay = openGame();
assert(overlay.controls.streamerInput.dataset.streamerValue === 'Guest Streamer');
assert(overlay.controls.scoreStreamerValue.textContent.includes('Guest Streamer (saved value)'));
assert(overlay.controls.scoreStreamerOptions.options.some((option) => option.dataset.streamerValue === 'Guest Streamer'));
overlay.controls.scoreAInput.value = '101';
overlay.controls.scoreBInput.value = '99';
overlay.controls.streamerInput.dataset.streamerValue = 'Guest Streamer';
await overlay.controls.btnSaveScore.onclick();
assert.strictEqual(context.FirebaseSync.getCache().seasons.season1.schedule[0].matchups[0].streamer, 'Guest Streamer');

console.log('Score-entry modal and streamer dropdown tests passed.');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
