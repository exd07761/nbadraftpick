'use strict';
/**
 * Public Old Season Roster Viewer — regression tests.
 *
 * Covers js/views/roster.js (`PublicRosterView`), which now lets a public
 * visitor pick any season from LeagueData.getAllSeasons() instead of only
 * ever showing LeagueData.getCurrentSeason(). Every getter it calls
 * (getRosterSummary, getNBATeamAssignments, getSeason) already existed and
 * is untouched here — this suite exercises the VIEW's season-selection
 * logic (_resolveSeasonId, the dropdown wiring, and the render output)
 * against a realistic two-season fixture with a historical manual roster
 * replacement (a "trade") recorded in the old season.
 *
 * Same vm-sandbox pattern as tests_f6/pick_color_display_test.js and
 * tests_p9/p10/p11: load data.js (+ shared-utils.js, which roster.js's
 * escapeHtml/teamBadge/classificationBadge globals come from) into one
 * vm context, then load js/views/roster.js into the SAME context so
 * PublicRosterView can see LeagueData et al. as globals, exactly as it
 * does in the browser via <script> tags on index.html.
 *
 * DOM is a minimal hand-rolled stub (FakeContainer/FakeSelectStub) — just
 * enough to capture innerHTML and the one addEventListener('change', ...)
 * call roster.js makes on '#rosterSeasonSelect'. No real browser needed;
 * this exercises the actual render()/_bindSeasonSelect() code path, not a
 * re-implementation of it.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const dataJsPath = path.join(__dirname, '..', 'js', 'data.js');
const sharedUtilsPath = path.join(__dirname, '..', 'js', 'shared-utils.js');
const rosterViewPath = path.join(__dirname, '..', 'js', 'views', 'roster.js');

const dataSrc = fs.readFileSync(dataJsPath, 'utf8');
const sharedUtilsSrc = fs.readFileSync(sharedUtilsPath, 'utf8');
const rosterViewSrc = fs.readFileSync(rosterViewPath, 'utf8');

// ─── Minimal fake DOM — just enough for roster.js's own DOM usage ─────────
// roster.js only ever does: container.innerHTML = '...'; then
// container.querySelector('#rosterSeasonSelect').addEventListener('change', fn).
class FakeSelectStub {
  constructor() { this._handlers = {}; }
  addEventListener(type, fn) { this._handlers[type] = fn; }
  trigger(type, evt) {
    if (!this._handlers[type]) throw new Error(`No '${type}' handler registered on the season select`);
    this._handlers[type](evt);
  }
}
class FakeContainer {
  constructor() { this._html = ''; this._selectStub = null; }
  set innerHTML(html) {
    this._html = html;
    // A fresh stub every render — mirrors a real DOM re-rendering the
    // <select> node from scratch each time innerHTML is reassigned.
    this._selectStub = html.includes('id="rosterSeasonSelect"') ? new FakeSelectStub() : null;
  }
  get innerHTML() { return this._html; }
  querySelector(sel) {
    if (sel === '#rosterSeasonSelect') return this._selectStub;
    return null;
  }
}

function makeSandbox() {
  const sandbox = {
    console,
    firebase: {
      firestore: () => ({
        collection: () => ({ doc: () => ({ onSnapshot: () => {}, set: () => Promise.resolve() }) }),
      }),
    },
    showToast: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(dataSrc, sandbox, { filename: 'data.js' });
  vm.runInContext(sharedUtilsSrc, sandbox, { filename: 'shared-utils.js' });
  vm.runInContext(rosterViewSrc, sandbox, { filename: 'roster.js' });
  vm.runInContext(
    'this.LeagueData = LeagueData; this.AdminActions = AdminActions; ' +
    'this.FirebaseSync = FirebaseSync; this.getDefaultData = getDefaultData; ' +
    'this.PublicRosterView = PublicRosterView;',
    sandbox, { filename: 'export.js' }
  );

  let cache = sandbox.getDefaultData();
  let writeCount = 0;
  sandbox.FirebaseSync.getCache = () => cache;
  sandbox.FirebaseSync.save = (data) => { cache = data; writeCount++; };
  sandbox._getWriteCount = () => writeCount;
  sandbox._resetWriteCount = () => { writeCount = 0; };
  return sandbox;
}

let pass = 0, fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ok - ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL - ${name}`);
    console.log(`         ${e.message}`);
  }
}
function assertTruthy(val, msg) {
  if (!val) throw new Error(msg || `expected truthy, got ${JSON.stringify(val)}`);
}
function assertFalsy(val, msg) {
  if (val) throw new Error(msg || `expected falsy, got ${JSON.stringify(val)}`);
}
function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'assertion failed'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function assertIncludes(haystack, needle, msg) {
  if (!haystack.includes(needle)) {
    throw new Error(`${msg || 'expected string to include ' + JSON.stringify(needle)}`);
  }
}
function assertNotIncludes(haystack, needle, msg) {
  if (haystack.includes(needle)) {
    throw new Error(`${msg || 'expected string NOT to include ' + JSON.stringify(needle)}`);
  }
}

console.log('Public Old Season Roster Viewer tests:');

const sandbox = makeSandbox();
const { AdminActions, LeagueData, PublicRosterView } = sandbox;

// ─── Fixture: two full seasons, drafted + rosters initialized ─────────────
// Season A is created first (createSeason auto-selects it as current,
// since none existed yet), then Season B is created and explicitly made
// current — leaving A as the "old" season for every test below.
const seasonA = AdminActions.createSeason('2K24 Legacy Season');
const teamA1 = AdminActions.addParticipant(seasonA.id, 'Team Alpha');
const teamA2 = AdminActions.addParticipant(seasonA.id, 'Team Bravo');

const pAlpha1 = AdminActions.addPlayer({ name: 'Alpha One', position: 'PG', overall: 82, pool: 'green' });
const pAlpha2 = AdminActions.addPlayer({ name: 'Alpha Two', position: 'SF', overall: 80, pool: 'green' });
const pBravo1 = AdminActions.addPlayer({ name: 'Bravo One', position: 'C', overall: 79, pool: 'green' });
const pBravo2 = AdminActions.addPlayer({ name: 'Bravo Two', position: 'SG', overall: 78, pool: 'green' });
// Incoming player for the historical manual replace ("trade") below — not
// on anyone's original draft-pick list.
const pIncoming = AdminActions.addPlayer({ name: 'Traded-In Player', position: 'PG', overall: 85, pool: 'green' });

{
  const cache = sandbox.FirebaseSync.getCache();
  const s = cache.seasons[seasonA.id];
  s.playerDraftPicks = [
    { round: 1, pick: 1, participantId: teamA1.id, playerId: pAlpha1.id },
    { round: 1, pick: 2, participantId: teamA2.id, playerId: pBravo1.id },
    { round: 2, pick: 1, participantId: teamA1.id, playerId: pAlpha2.id },
    { round: 2, pick: 2, participantId: teamA2.id, playerId: pBravo2.id },
  ];
  s.draftComplete = true;
  sandbox.FirebaseSync.save(cache);
}
AdminActions.initializeRostersFromDraft(seasonA.id);
AdminActions.assignNBATeam(seasonA.id, teamA1.id, 'LAL');
AdminActions.assignNBATeam(seasonA.id, teamA2.id, 'BOS');
AdminActions.setRatingCap(seasonA.id, 700);
// A historical trade/manual roster change recorded IN THE OLD SEASON,
// before the new season even exists — exactly the "old season has
// rostersInitialized === true, show currentRosters including historical
// trades" case from the brief.
AdminActions.manualReplacePlayerOnRoster(seasonA.id, teamA1.id, pAlpha1.id, pIncoming.id);

const seasonB = AdminActions.createSeason('2K25 Current Season');
const teamB1 = AdminActions.addParticipant(seasonB.id, 'Team Charlie');
const teamB2 = AdminActions.addParticipant(seasonB.id, 'Team Delta');

const pCharlie1 = AdminActions.addPlayer({ name: 'Charlie One', position: 'PF', overall: 88, pool: 'green' });
const pCharlie2 = AdminActions.addPlayer({ name: 'Charlie Two', position: 'PG', overall: 84, pool: 'green' });
const pDelta1 = AdminActions.addPlayer({ name: 'Delta One', position: 'C', overall: 83, pool: 'green' });
const pDelta2 = AdminActions.addPlayer({ name: 'Delta Two', position: 'SG', overall: 81, pool: 'green' });

{
  const cache = sandbox.FirebaseSync.getCache();
  const s = cache.seasons[seasonB.id];
  s.playerDraftPicks = [
    { round: 1, pick: 1, participantId: teamB1.id, playerId: pCharlie1.id },
    { round: 1, pick: 2, participantId: teamB2.id, playerId: pDelta1.id },
    { round: 2, pick: 1, participantId: teamB1.id, playerId: pCharlie2.id },
    { round: 2, pick: 2, participantId: teamB2.id, playerId: pDelta2.id },
  ];
  s.draftComplete = true;
  sandbox.FirebaseSync.save(cache);
}
AdminActions.initializeRostersFromDraft(seasonB.id);
AdminActions.assignNBATeam(seasonB.id, teamB1.id, 'MIA');
AdminActions.assignNBATeam(seasonB.id, teamB2.id, 'NYK');
AdminActions.setRatingCap(seasonB.id, 850);
AdminActions.setCurrentSeason(seasonB.id);

assertEqual(LeagueData.getCurrentSeasonId(), seasonB.id, 'fixture sanity: Season B is current');
assertEqual(LeagueData.getAllSeasons().length, 2, 'fixture sanity: two seasons exist');

// ─── 1. Multiple seasons exist + current season selected by default ──────
check('1. Multiple seasons exist and the dropdown lists both', () => {
  const container = new FakeContainer();
  PublicRosterView._selectedSeasonId = null; // simulate a fresh page load
  PublicRosterView.render(container);
  assertIncludes(container.innerHTML, '2K24 Legacy Season');
  assertIncludes(container.innerHTML, '2K25 Current Season');
});

check('2. Current season is selected automatically on first render', () => {
  const container = new FakeContainer();
  PublicRosterView._selectedSeasonId = null;
  PublicRosterView.render(container);
  assertEqual(PublicRosterView._selectedSeasonId, seasonB.id);
  assertIncludes(container.innerHTML, 'Team Charlie');
  assertIncludes(container.innerHTML, 'Team Delta');
  assertNotIncludes(container.innerHTML, 'Past season', 'current season must never be labeled as an old/past season');
});

// ─── 3. Selecting an old season retrieves that season's roster ───────────
check('3. Selecting the old season via the dropdown shows its roster', () => {
  const container = new FakeContainer();
  PublicRosterView._selectedSeasonId = null;
  PublicRosterView.render(container); // initial render -> current season, wires the listener
  container._selectStub.trigger('change', { target: { value: seasonA.id } });
  assertEqual(PublicRosterView._selectedSeasonId, seasonA.id);
  assertIncludes(container.innerHTML, 'Past season', 'an old season must be clearly indicated');
  assertNotIncludes(container.innerHTML, '>Current<', 'an old season must never be labeled "current"');
});

// ─── 4. Old season participant names come from the old season ────────────
check('4. Old season participant names come from the old season, not the current one', () => {
  const container = new FakeContainer();
  PublicRosterView._selectedSeasonId = seasonA.id;
  PublicRosterView.render(container);
  assertIncludes(container.innerHTML, 'Team Alpha');
  assertIncludes(container.innerHTML, 'Team Bravo');
  assertNotIncludes(container.innerHTML, 'Team Charlie');
  assertNotIncludes(container.innerHTML, 'Team Delta');
});

// ─── 5. Old season NBA team assignments come from the old season ─────────
check('5. Old season NBA team assignments come from the old season', () => {
  const container = new FakeContainer();
  PublicRosterView._selectedSeasonId = seasonA.id;
  PublicRosterView.render(container);
  assertIncludes(container.innerHTML, 'Lakers');
  assertIncludes(container.innerHTML, 'Celtics');
  assertNotIncludes(container.innerHTML, 'Heat');
  assertNotIncludes(container.innerHTML, 'Knicks');
});

// ─── 6. Old season rating cap comes from the old season ───────────────────
check('6. Old season rating cap (700) is used, not the current season\'s (850)', () => {
  const container = new FakeContainer();
  PublicRosterView._selectedSeasonId = seasonA.id;
  PublicRosterView.render(container);
  assertIncludes(container.innerHTML, 'cap: 700');
  assertNotIncludes(container.innerHTML, 'cap: 850');
});

// ─── 7. A trade/swap recorded in an old season is reflected ──────────────
check('7. A historical manual roster replace ("trade") in the old season is reflected', () => {
  const container = new FakeContainer();
  PublicRosterView._selectedSeasonId = seasonA.id;
  PublicRosterView.render(container);
  assertIncludes(container.innerHTML, 'Traded-In Player', 'the incoming player from the historical replace should be shown');
  assertNotIncludes(container.innerHTML, '>Alpha One<', 'the outgoing player should no longer be shown on that roster slot');
});

// ─── 8. Switching back to the current season restores the current roster ─
check('8. Switching back to the current season restores the current roster', () => {
  const container = new FakeContainer();
  PublicRosterView._selectedSeasonId = null;
  PublicRosterView.render(container);
  container._selectStub.trigger('change', { target: { value: seasonA.id } });
  assertEqual(PublicRosterView._selectedSeasonId, seasonA.id);
  container._selectStub.trigger('change', { target: { value: seasonB.id } });
  assertEqual(PublicRosterView._selectedSeasonId, seasonB.id);
  assertIncludes(container.innerHTML, 'Team Charlie');
  assertIncludes(container.innerHTML, 'Team Delta');
  assertIncludes(container.innerHTML, 'cap: 850');
  assertNotIncludes(container.innerHTML, 'Past season');
});

// ─── 9. Selecting an invalid/missing season ID falls back to current ─────
check('9. An invalid/missing season id safely falls back to the current season', () => {
  const container = new FakeContainer();
  PublicRosterView._selectedSeasonId = null;
  PublicRosterView.render(container);
  container._selectStub.trigger('change', { target: { value: 'does-not-exist' } });
  assertEqual(PublicRosterView._selectedSeasonId, seasonB.id, 'an unknown season id must resolve back to the current season');
  assertIncludes(container.innerHTML, 'Team Charlie');
  assertNotIncludes(container.innerHTML, 'Past season');
});

check('9b. A previously-selected season that no longer exists (e.g. deleted) falls back to current on the next render', () => {
  const container = new FakeContainer();
  // Simulate stale state from a prior visit pointing at a season id that
  // is no longer in LeagueData.getAllSeasons() (covers "navigate away,
  // the season gets deleted, navigate back").
  PublicRosterView._selectedSeasonId = 'some-deleted-season-id';
  PublicRosterView.render(container);
  assertEqual(PublicRosterView._selectedSeasonId, seasonB.id);
  assertIncludes(container.innerHTML, 'Team Charlie');
});

// ─── 10. Rendering the old season performs no writes ──────────────────────
check('10. Rendering / selecting the old season performs no writes (read-only)', () => {
  const container = new FakeContainer();
  PublicRosterView._selectedSeasonId = null;
  sandbox._resetWriteCount();
  PublicRosterView.render(container);
  container._selectStub.trigger('change', { target: { value: seasonA.id } });
  container._selectStub.trigger('change', { target: { value: seasonB.id } });
  assertEqual(sandbox._getWriteCount(), 0, 'no FirebaseSync.save() call should happen from rendering or switching seasons');
});

// ─── Data-layer confirmation: old season's data is untouched by any of ───
// the above (nothing above should have mutated currentRosters, playerDraftPicks,
// participants, nbaTeamAssignments, or currentSeasonId beyond the explicit
// AdminActions setup calls at the top of this file).
check('11. Season A itself was never mutated by any render/selection above', () => {
  const cache = sandbox.FirebaseSync.getCache();
  const sA = cache.seasons[seasonA.id];
  assertEqual(Object.keys(sA.participants).length, 2);
  assertEqual(sA.currentRosters[teamA1.id].length, 2);
  assertEqual(sA.currentRosters[teamA1.id].find(e => e.playerId === pIncoming.id) !== undefined, true);
  assertEqual(sA.ratingCap, 700);
  assertEqual(cache.settings.currentSeasonId, seasonB.id, 'currentSeasonId must still point at Season B, never mutated by viewing Season A');
});

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
