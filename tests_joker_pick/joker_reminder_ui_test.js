'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'admin', 'draft.js'), 'utf8');
const dom = new JSDOM('<!doctype html><body></body>');
const picks = [
  { participantId: 'team-a', playerId: 'g1', isJoker: true },
  { participantId: 'team-a', playerId: 'b2' },
];
const players = {
  g1: { id: 'g1', pool: 'green' }, b2: { id: 'b2', pool: 'blue' },
  next: { id: 'next', name: 'Next Player', position: 'PG', overall: 80, pool: 'green' },
};
let submitted = false;
let toastMessage = '';
const context = {
  document: dom.window.document,
  window: dom.window,
  CORE_POSITIONS: ['PG', 'SG', 'SF', 'PF', 'C'],
  escapeHtml: value => String(value ?? ''),
  AuthBoundary: { requireAuth() {} },
  showToast(message) { toastMessage = message; },
  AdminActions: {
    makeDraftPick() {
      submitted = true;
      throw new Error("A second Joker Pick is allowed only when the participant's first four picks are all Green Pool players.");
    },
  },
  AdminApp: { renderView() {} },
  LeagueData: {
    getDraftState() { return { currentParticipantId: 'team-a' }; },
    getPlayer(id) { return players[id] || null; },
  },
};
vm.createContext(context);
vm.runInContext(`${source}\nthis.draftView = AdminDraftView;`, context, { filename: 'draft.js' });
context.draftView._openDraftConfirm({ id: 'season-1', playerDraftPicks: picks }, players.next);
const checkbox = dom.window.document.getElementById('draftJokerCheckbox');
const position = dom.window.document.getElementById('draftJokerPositionSelect');
const confirm = dom.window.document.getElementById('modalConfirmBtn');
const reminder = dom.window.document.getElementById('draftRuleReminder');
checkbox.checked = true;
position.value = 'PG';
checkbox.dispatchEvent(new dom.window.Event('change'));
assert.notEqual(reminder.style.display, 'none');
assert.match(reminder.textContent, /2nd Joker Pick/);
assert.equal(confirm.disabled, false);
confirm.click();
assert.equal(submitted, true);
assert.match(toastMessage, /first four picks are all Green Pool players/);
console.log('Second-Joker reminder renders, selection remains enabled, and submission enforces eligibility.');
