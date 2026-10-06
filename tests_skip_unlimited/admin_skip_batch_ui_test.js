'use strict';

/** Focused UI tests for the Admin Draft batched Skip confirmation. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const { JSDOM } = require('jsdom');

const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'admin', 'draft.js'), 'utf8');

function makeView(state) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const calls = [];
  const sandbox = {
    document: dom.window.document,
    LeagueData: { getDraftState: () => state },
    AdminActions: { skipDraftPick: (...args) => calls.push(args) },
    AuthBoundary: { requireAuth: () => {} },
    AdminApp: { renderView: () => {} },
    showToast: () => {},
    escapeHtml: (value) => String(value),
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'js/admin/draft.js' });
  sandbox.view = vm.runInContext('AdminDraftView', sandbox);
  return { dom, view: sandbox.view, calls };
}

const trigger = { disabled: false };

{
  const { dom, view, calls } = makeView({
    currentParticipant: { name: 'Participant One' },
    picksNeededThisTurn: 4,
    picksTakenThisTurn: 1,
  });
  view._openSkipConfirm({ id: 's1' }, trigger);
  const overlay = dom.window.document.getElementById('skipConfirmOverlay');
  assert.ok(overlay.textContent.includes('3 pick opportunities remaining'));
  assert.ok(overlay.textContent.includes('Skip all 3 remaining opportunities now?'));
  assert.strictEqual(overlay.querySelector('#skipModalConfirmBtn').textContent.trim(), 'Skip All 3');
  overlay.querySelector('#skipModalConfirmBtn').click();
  assert.deepStrictEqual(calls, [['s1', 3]], 'one confirmation submits all three currently remaining opportunities');
}

{
  const { dom, view, calls } = makeView({
    currentParticipant: { name: 'Participant Two' },
    picksNeededThisTurn: 1,
    picksTakenThisTurn: 0,
  });
  view._openSkipConfirm({ id: 's1' }, trigger);
  const overlay = dom.window.document.getElementById('skipConfirmOverlay');
  assert.ok(overlay.textContent.includes('1 pick opportunity remaining'));
  assert.strictEqual(overlay.querySelector('#skipModalConfirmBtn').textContent.trim(), 'Skip Opportunity');
  overlay.querySelector('#skipModalConfirmBtn').click();
  assert.deepStrictEqual(calls, [['s1', 1]], 'single-opportunity confirmation preserves one-skip behavior');
}

console.log('Admin Draft skip batch UI tests passed.');
