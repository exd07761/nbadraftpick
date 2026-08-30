/**
 * admin/nba2k-database.js — NBA 2K26 Player Database Browser
 * (Phase 2: browse/search/filter/detail. Phase 3: promote-to-Draft-Pool.)
 *
 * PURPOSE
 * Admin-only view over the `nba2k_players` Firestore collection created in
 * Phase 1. Phase 2 made this a read-only "scouting database" browser.
 * Phase 3 adds exactly one write path: promoting a selected NBA2K player
 * into the EXISTING Draft Pool player system (`league/main.players`) via
 * the existing `AdminActions.addPlayer()` — this file never writes to
 * `nba2k_players` itself, and never writes to `league/main` except
 * through that one existing, unmodified write pathway.
 *
 * SCOPE (Phase 2 — unchanged)
 * - Load all `nba2k_players` docs once per admin session (module-level
 *   cache), then search/filter/sort entirely client-side. No Firestore
 *   read is issued per keystroke or per filter change.
 * - Firestore is the only nba2k_players data source — the original JSON
 *   file is never touched here (that was Phase 1's import-only input).
 *
 * SCOPE (Phase 3 — new)
 * - "Add to Draft Pool" section at the bottom of the player detail view.
 * - Requires the commissioner to explicitly pick ONE position (from the
 *   player's `positions` array — never auto-selected) and ONE pool
 *   (Green/Blue — never auto-assigned), then confirm a summary before
 *   any write happens.
 * - Prevents double-promotion by checking `nba2kRef` on existing
 *   `league/main` players; prevents silent name collisions against
 *   players that predate this feature (which have no `nba2kRef`).
 * - Does NOT copy attributes/badges/physicals into `league/main` — only
 *   name, position (commissioner-chosen), overall, pool (commissioner-
 *   chosen), and the `nba2kRef` back-reference.
 * - Does NOT modify `nba2k_players/<slug>` in any way — promotion is a
 *   read of that document plus a write to `league/main` only.
 * - No pool-minimum-rating / Blue-composition enforcement is added here
 *   beyond what the existing single-player "Add Player" form already
 *   enforces (name required, overall 40–99) — `AdminActions.addPlayer()`
 *   itself has no additional validation today, and Phase 3 intentionally
 *   mirrors that existing behavior exactly rather than inventing new
 *   validation the rest of the app doesn't otherwise apply at add-time.
 *
 * ARCHITECTURE NOTE: all `nba2k_players` Firestore access stays
 * self-contained in this file (see Phase 2 rationale below). The Phase 3
 * promotion write goes through the existing, shared `AdminActions`/
 * `LeagueData` globals from data.js — the same objects every other admin
 * page already uses — never a new data-access path. The one change made
 * to data.js is additive: `createPlayer()`/`AdminActions.addPlayer()`
 * now accept an optional `nba2kRef` field that every existing caller
 * (CSV import, the manual Add Player form) simply never passes, so it's
 * `undefined` for every pre-existing player exactly like `variantGroup`
 * already is when omitted.
 *
 * `LeagueData.getAllPlayers()` reads from `FirebaseSync`'s live, already
 * real-time-synced local cache (see data.js) — it is a synchronous,
 * no-network call, and `FirebaseSync.save()` updates that cache
 * optimistically before the Firestore write even resolves. That means
 * every promo-status check in this file (open detail, row status pill,
 * pre-write re-check) is always working off current data with zero
 * extra fetches and zero artificial delays after a write.
 *
 * Original Phase 2 architecture note, still true: `LeagueData` is the
 * *public* read API shared with index.html, and `nba2k_players` is
 * intentionally admin-only, so its reads stay local to this file rather
 * than living on that shared object.
 *
 * Firestore rule this depends on (unchanged by this file):
 *   match /nba2k_players/{slug} {
 *     allow read, write: if request.auth != null;
 *   }
 *
 * SCOPE (Phase 4 — new)
 * The `nba2k_players` collection now holds all three source categories
 * (`curr`/`class`/`allt`, ~1,757 docs total instead of just the 528
 * `curr` ones) — this file's Firestore read is completely unchanged (it
 * already loaded the whole collection with no `where('teamType', ...)`
 * filter), so no query changed. What's new is presentation only: a
 * Current/Classics/All-Time category filter on the list, a human-
 * readable category label + read-only pool-eligibility line in the
 * detail view, and the header now reports live per-category counts
 * alongside the total. `teamType` is never rewritten to `green`/`blue`
 * anywhere — pool eligibility shown here is informational text derived
 * from `teamType` at render time, never a stored field and never a
 * write. Promotion (Phase 3) is completely unchanged in this phase: the
 * commissioner still explicitly picks a position for every promotion,
 * regardless of category, exactly as before. (Phase 5, below, changes
 * pool selection specifically — see that note.)
 *
 * SCOPE (Phase 5 — new)
 * The commissioner no longer chooses the pool when promoting — it is
 * derived solely from the source `teamType` (curr → green; class/allt →
 * blue) via `nba2kPoolForTeamType()`, displayed locked/read-only in the
 * promotion form, and re-derived (never read from a form control) again
 * immediately before every write. An unrecognized/missing `teamType`
 * blocks promotion entirely with an explicit error rather than guessing
 * a pool. Position selection is completely unchanged from Phase 3: still
 * always an explicit manual choice, never auto-selected. `nba2k_players`
 * itself is never modified by this phase — `teamType` is read-only input
 * to the pool decision, never rewritten, and no `pool` field is ever
 * added to a source document (pool lives only on the promoted
 * `league/main` player, exactly as in Phase 3).
 *
 * SCOPE (Phase 6 -- new)
 * Admin-only POSITION MANAGEMENT: the commissioner can now manually
 * correct `nba2k_players/<slug>.positions` directly from the existing
 * player detail modal, BEFORE promoting a player into the Draft Pool.
 * - New "Position Management" section in the detail modal: five
 *   checkboxes (PG/SG/SF/PF/C), pre-checked to the player's current
 *   normalized source positions, a data-quality line (check = complete,
 *   warning = missing), and a Save Positions button.
 * - `normalizeNba2kPositions()` is the single source of truth for
 *   validating + deduping + canonically ordering a position selection --
 *   used both to normalize what's shown/saved here and to normalize
 *   whatever is already stored on a source doc when comparing against it
 *   (some pre-Phase-6 records may not already be in canonical order).
 *   Invalid values (anything outside PG/SG/SF/PF/C) are silently dropped
 *   by this function rather than ever written to Firestore.
 * - Saving writes ONLY `nba2k_players/<slug>.positions` via `.update()`
 *   -- never a full-document `.set()` -- so every other field on the
 *   source record (attributes, badges, overall, images, physicals, team,
 *   teamType, lastUpdated, etc.) is completely untouched by this phase.
 * - Before writing, the source doc is re-read and its (normalized)
 *   `positions` compared against the value this editor session started
 *   from; a mismatch means another admin session changed it first, so
 *   the write is aborted with an explicit "updated elsewhere" message
 *   instead of silently overwriting a newer edit. This is a best-effort
 *   check, not a lock.
 * - A selection identical (after normalization) to what's already stored
 *   performs zero Firestore writes and shows "No position changes to
 *   save." instead.
 * - This phase NEVER writes to `league/main`, never promotes a player,
 *   and never touches an already-promoted Draft Pool player's `position`
 *   -- an existing promotion's position is historical commissioner data
 *   and is left exactly as it was, even after the NBA2K source positions
 *   it was originally chosen from are later corrected. The existing
 *   Phase 3/5 promotion section (`_renderPromotionSection` /
 *   `_bindPromotionEvents`, both otherwise unchanged) reads
 *   `player.positions` from the same in-memory cache entry this phase
 *   updates in place after a successful save, so any *future* promotion
 *   of that player automatically offers the corrected positions with no
 *   separate wiring required -- but still always requires the
 *   commissioner to explicitly pick one, exactly as before.
 * - No bulk editing, no history/audit log, and no automatic/inferred
 *   position correction of any kind -- this is intentionally a manual,
 *   one-player-at-a-time data-cleanup tool.
 *
 * SCOPE (Phase 7 — new)
 * A completely separate, temporary NBA 2K27 player-pool SELECTION layer,
 * independent of both `nba2k_players` (untouched) and the active Season
 * 4 / 2K26 Draft Pool (`league/main.players`, also untouched). This is
 * NOT promotion — "Add to 2K27 Pool" never calls `AdminActions.addPlayer()`
 * and never writes to `league/main`. It writes only to a new top-level
 * collection, `nba2k27_pool/<slug>` (slug = the same `nba2k_players`
 * document ID), holding selection/state only:
 *   { nba2kRef, pool: 'green'|'blue', selectedAt, updatedAt }
 * (ISO strings via `new Date().toISOString()`, matching the existing
 * `createPlayer()`/`FirebaseSync` convention elsewhere in this app rather
 * than `firebase.firestore.FieldValue.serverTimestamp()`.) No attributes,
 * badges, physicals, or positions are ever copied into this document —
 * `nba2k_players/<slug>` remains the sole source of that data, read live
 * at render time, so a later Phase 6 position correction (above) is
 * reflected automatically without touching the 2K27 selection — the
 * Position Management section is rendered above the 2K27 Pool section in
 * the detail modal for exactly this reason (correct positions first).
 *
 * Pool is derived via the existing `nba2kPoolForTeamType()` (Phase 5) —
 * reused, not reimplemented — both when the detail view opens AND again,
 * re-read from the freshest local player record, immediately before every
 * write. A missing/unrecognized `teamType` blocks selection entirely,
 * exactly as it blocks promotion.
 *
 * Identity/idempotency: the 2K27 doc ID is the NBA2K slug, so adding an
 * already-selected player is a no-op overwrite, never a duplicate.
 *
 * Loaded once per admin session alongside `nba2k_players` (see `_load()`)
 * into a plain in-memory map (`_pool27`), mutated locally after every
 * add/remove — no re-fetch of the collection is ever issued after the
 * initial load.
 *
 * Firestore rule this depends on (NOT present in this repo — firestore.
 * rules is not tracked here, so it cannot be edited by this change; see
 * the Phase 7 final report for the exact rule that must be added by hand,
 * matching the existing `nba2k_players` rule):
 *   match /nba2k27_pool/{slug} {
 *     allow read, write: if request.auth != null;
 *   }
 */

// Human-readable labels for the source teamType, plus which Draft Pool
// each category is informationally "eligible" for. This is a read-only,
// derived label the UI shows — it is never written back to Firestore,
// never changes `nba2k_players/<slug>.teamType`, and never triggers or
// gates a promotion in any way; the commissioner still always picks the
// pool manually in the Phase 3 promotion form regardless of this label.
const NBA2K_CATEGORY_META = {
  curr:  { label: 'Current',   poolEligible: 'Green Pool eligible' },
  class: { label: 'Classics',  poolEligible: 'Blue Pool eligible' },
  allt:  { label: 'All-Time',  poolEligible: 'Blue Pool eligible' },
};
function nba2kCategoryLabel(teamType) {
  return (NBA2K_CATEGORY_META[teamType] || {}).label || teamType || 'Unknown';
}
function nba2kPoolEligibilityLabel(teamType) {
  return (NBA2K_CATEGORY_META[teamType] || {}).poolEligible || null;
}

// Phase 5: authoritative pool derivation for promotion. Pool eligibility
// is determined SOLELY by the source teamType — never by overall rating,
// and never by a value supplied from the UI. Returns 'green' | 'blue' |
// null (null = unknown/missing teamType — promotion must be blocked, not
// guessed). This is the single source of truth both the promotion form
// and the pre-write recheck call, so the two can never disagree.
function nba2kPoolForTeamType(teamType) {
  if (teamType === 'curr') return 'green';
  if (teamType === 'class' || teamType === 'allt') return 'blue';
  return null;
}

// Phase 6: the ONLY five position values this app ever accepts, in the
// authoritative canonical order (confirmed by commissioner correction
// after Phase 6's initial ship): PG, SG, SF, PF, C. This single order is
// used both for the checkbox render order in the editor UI AND for
// normalized STORAGE order — the two are intentionally the same list.
//
// NOTE — historical note on a since-corrected discrepancy: the original
// Phase 6 brief's worked examples (e.g. ["PF","C","PF"] -> ["C","PF"])
// implied C sorting before PF, contradicting that same brief's stated
// canonical-order list. The commissioner has since confirmed the stated
// list (PF before C) is authoritative and the worked examples were
// wrong. This implementation now follows PG/SG/SF/PF/C throughout.
const NBA2K_VALID_POSITIONS = ['PG', 'SG', 'SF', 'PF', 'C'];

// Single source of truth for turning an arbitrary (possibly messy,
// possibly attacker-supplied) list of position strings into a clean
// array: invalid values dropped, duplicates collapsed, canonical order
// enforced. Never throws — an empty/garbage input simply normalizes to
// `[]`, and callers are responsible for rejecting an empty result where
// "at least one position" is required (this function's job is shaping,
// not that policy). Pure and side-effect-free so it's usable both to
// normalize a UI selection and to normalize whatever a Firestore read
// returns, without ever needing the DOM or a network call.
function normalizeNba2kPositions(positions) {
  const input = Array.isArray(positions) ? positions : [];
  const present = new Set(input.filter(p => NBA2K_VALID_POSITIONS.includes(p)));
  return NBA2K_VALID_POSITIONS.filter(p => present.has(p));
}

// Compares two position lists for equality AFTER normalizing both sides
// — so a stored `["PF", "C", "PF"]` and a freshly-selected `["C", "PF"]`
// are correctly treated as "no change" even though the raw arrays differ.
function nba2kPositionsEqual(a, b) {
  const na = normalizeNba2kPositions(a);
  const nb = normalizeNba2kPositions(b);
  return na.length === nb.length && na.every((p, i) => p === nb[i]);
}

// Phase 6 "optional data quality indicator" — deliberately only ever
// reports whether position data exists at all. It NEVER infers anything
// from overall/attributes/badges/height/weight/team/name: the
// commissioner remains the sole authority on whether a position is
// *correct*, this only flags whether one is *present*.
function nba2kPositionStatus(positions) {
  const normalized = normalizeNba2kPositions(positions);
  return normalized.length > 0
    ? { icon: '\u2713', label: 'Position data complete', cls: 'ok' }
    : { icon: '\u26A0', label: 'Position missing', cls: 'warn' };
}

// Attribute display metadata: source field name -> label, grouped into
// the five sections requested. Exactly the 35 stored attribute keys —
// nothing added, nothing renamed in storage, this is presentation only.
const NBA2K_ATTRIBUTE_GROUPS = [
  {
    title: 'Finishing',
    keys: [
      ['closeShot', 'Close Shot'],
      ['layup', 'Driving Layup'],
      ['drivingDunk', 'Driving Dunk'],
      ['standingDunk', 'Standing Dunk'],
      ['postHook', 'Post Hook'],
      ['postFade', 'Post Fade'],
      ['postControl', 'Post Control'],
      ['drawFoul', 'Draw Foul'],
      ['hands', 'Hands'],
    ],
  },
  {
    title: 'Shooting',
    keys: [
      ['midRangeShot', 'Mid-Range Shot'],
      ['threePointShot', 'Three-Point Shot'],
      ['freeThrow', 'Free Throw'],
      ['shotIQ', 'Shot IQ'],
      ['offensiveConsistency', 'Offensive Consistency'],
    ],
  },
  {
    title: 'Playmaking',
    keys: [
      ['passAccuracy', 'Pass Accuracy'],
      ['ballHandle', 'Ball Handle'],
      ['speedWithBall', 'Speed With Ball'],
      ['passIQ', 'Pass IQ'],
      ['passVision', 'Pass Vision'],
    ],
  },
  {
    title: 'Physicals',
    keys: [
      ['speed', 'Speed'],
      ['agility', 'Agility'],
      ['strength', 'Strength'],
      ['vertical', 'Vertical'],
      ['stamina', 'Stamina'],
      ['hustle', 'Hustle'],
      ['overallDurability', 'Overall Durability'],
    ],
  },
  {
    title: 'Defense / Rebounding',
    keys: [
      ['interiorDefense', 'Interior Defense'],
      ['perimeterDefense', 'Perimeter Defense'],
      ['steal', 'Steal'],
      ['block', 'Block'],
      ['helpDefenseIQ', 'Help Defense IQ'],
      ['passPerception', 'Pass Perception'],
      ['defensiveConsistency', 'Defensive Consistency'],
      ['offensiveRebound', 'Offensive Rebound'],
      ['defensiveRebound', 'Defensive Rebound'],
    ],
  },
];

const NBA2K_BADGE_TIER_ORDER = ['Legendary', 'Hall of Fame', 'Gold', 'Silver', 'Bronze'];

const NBA2K_OVERALL_FILTERS = [
  { value: '', label: 'All Overalls' },
  { value: '90', label: '90+' },
  { value: '85', label: '85+' },
  { value: '80', label: '80+' },
  { value: '75', label: '75+' },
];

function nba2kOvrTierClass(ovr) {
  return ovr >= 90 ? 'pos-ovr-elite' : ovr >= 80 ? 'pos-ovr-good' : 'pos-ovr-role';
}

function nba2kAttrTierClass(v) {
  return v >= 90 ? 'nba2k-attr-elite' : v >= 80 ? 'nba2k-attr-good' : v >= 70 ? 'nba2k-attr-mid' : 'nba2k-attr-low';
}

const Nba2kDatabaseView = {
  // Session-level cache: populated once, reused across every render() call
  // for the lifetime of this page load (admin.js re-renders views often —
  // e.g. on every FirebaseSync remote-change — so re-fetching on every
  // render would defeat the "load once" requirement).
  _players: null,
  _loadPromise: null,
  _loadError: null,

  // Phase 7: 2K27 pool-selection cache — a plain object keyed by
  // nba2k_players slug -> { nba2kRef, pool, selectedAt, updatedAt }.
  // Loaded once (in `_load()`, alongside `nba2k_players`) and mutated
  // locally after every add/remove; never re-fetched afterward.
  _pool27: null,

  // Phase 8: optional callback set by Nba2k27PoolView (js/admin/
  // nba2k-database.js, same file) while its page is open. Invoked after
  // every successful `nba2k27_pool` write made through THIS file's own
  // add/remove handlers below (`_bind2k27Events`), so the separate NBA
  // 2K27 Pool Management view — which reads the exact same `_pool27`/
  // `_players` cache rather than holding its own copy — can re-render
  // without polling or re-fetching. `null` whenever that view isn't the
  // one currently on screen (including throughout every Phase 7 test in
  // tests_p7/, which never sets this), so this is always a guarded
  // no-op unless that view opted in. This is the ONLY Phase 8 change
  // inside the Phase 7 add/remove write paths — no existing write,
  // read, validation, or UI output changes.
  _onPool27Changed: null,

  _search: '',
  _filterPos: '',
  _filterTeam: '',
  _filterOvr: '',
  _filterCategory: '', // '' = All, else 'curr' | 'class' | 'allt'
  _filter27: '', // Phase 7: '' = All, 'selected' | 'not-selected'
  _filter27Pool: '', // Phase 7 (optional pool filter): '' | 'green' | 'blue'
  _sortMode: 'ovr-desc',

  render(container) {
    if (this._players) {
      this._renderShell(container);
    } else {
      container.innerHTML = `
        <div class="admin-section">
          <div class="admin-section-header"><h2>NBA 2K26 Database</h2></div>
          <p class="backup-muted">Loading NBA 2K26 players…</p>
        </div>`;
      this._load(container);
    }
  },

  // Phase 8: the fetch itself, pulled out of `_load()` unchanged so
  // `Nba2k27PoolView` (below) can await the exact same load — same
  // in-flight promise if one is already running, same "never re-fetch
  // once `_players` is populated" guarantee — without needing a
  // `container` of its own. `_load()` below is now a thin wrapper of
  // this plus its container-specific render call; nothing about the
  // fetch, its caching, or its error handling changed.
  _ensureLoaded() {
    if (this._players) return Promise.resolve(); // already loaded this session — never re-fetch
    if (!this._loadPromise) {
      // Phase 7: load `nba2k27_pool` alongside `nba2k_players` in the same
      // pass — one read per collection, both cached for the admin session.
      // This does not change the existing `nba2k_players` query at all.
      this._loadPromise = Promise.all([
        firebase.firestore().collection('nba2k_players').get(),
        firebase.firestore().collection('nba2k27_pool').get(),
      ])
        .then(([playersSnap, pool27Snap]) => {
          this._players = playersSnap.docs.map(d => ({ id: d.id, ...d.data() }));
          this._pool27 = {};
          pool27Snap.docs.forEach(d => { this._pool27[d.id] = d.data(); });
          this._loadError = null;
        })
        .catch(err => {
          this._players = null;
          this._pool27 = null;
          // Never surface raw Firebase error text to the admin.
          this._loadError = err && err.code === 'permission-denied'
            ? "You don't have permission to access the NBA 2K26 database."
            : 'Unable to load the NBA 2K26 database.';
        })
        .finally(() => { this._loadPromise = null; });
    }
    return this._loadPromise;
  },

  async _load(container) {
    await this._ensureLoaded();
    // The admin may have navigated to a different view while this was
    // in flight — only render if this view's container is still live.
    if (document.body.contains(container)) {
      this._renderShell(container);
    }
  },

  _renderShell(container) {
    if (this._loadError) {
      container.innerHTML = `
        <div class="admin-section">
          <div class="admin-section-header"><h2>NBA 2K26 Database</h2></div>
          <div class="backup-result backup-result-error">${escapeHtml(this._loadError)}</div>
        </div>`;
      return;
    }

    const players = this._players || [];
    const positions = [...new Set(players.flatMap(p => Array.isArray(p.positions) ? p.positions : []))].sort();
    const teams = [...new Set(players.map(p => p.team).filter(Boolean))].sort();
    const categoryCounts = players.reduce((acc, p) => {
      const key = NBA2K_CATEGORY_META[p.teamType] ? p.teamType : 'other';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    const categoryTabs = [
      { value: '', label: 'All' },
      { value: 'curr', label: `Current${categoryCounts.curr ? ` (${categoryCounts.curr})` : ''}` },
      { value: 'class', label: `Classics${categoryCounts.class ? ` (${categoryCounts.class})` : ''}` },
      { value: 'allt', label: `All-Time${categoryCounts.allt ? ` (${categoryCounts.allt})` : ''}` },
    ].filter(t => t.value === '' || categoryCounts[t.value]); // don't show an empty category tab

    // Phase 7: 2K27 pool summary — derived from the actual `_pool27` cache
    // and the loaded player list every render, never hardcoded.
    const pool27Counts = this._computePool27Counts(players);

    container.innerHTML = `
      <div class="admin-section nba2k-db">
        <div class="admin-section-header">
          <h2>NBA 2K26 Database</h2>
        </div>
        <p class="nba2k-db-subtitle">
          Current · Classics · All-Time
          <span class="player-count">${players.length} Players</span>
        </p>

        ${players.length === 0 ? '' : `
          <div class="nba2k27-summary">
            <span class="nba2k27-summary-title">NBA 2K27 Pool</span>
            <span class="nba2k27-summary-stat">Total Selected: <strong>${pool27Counts.total}</strong></span>
            <span class="nba2k27-summary-stat">🟢 Green: <strong>${pool27Counts.green}</strong></span>
            <span class="nba2k27-summary-stat">🔵 Blue: <strong>${pool27Counts.blue}</strong></span>
            <span class="nba2k27-summary-stat">Not Selected: <strong>${pool27Counts.notSelected}</strong></span>
          </div>
        `}

        ${players.length === 0 ? `
          <p class="backup-muted">No NBA 2K26 players found.</p>
        ` : `
          <div class="nba2k-category-tabs" role="tablist" aria-label="Filter by category">
            ${categoryTabs.map(t => `
              <button type="button" class="btn ${this._filterCategory === t.value ? 'btn-primary' : 'btn-ghost'} btn-sm nba2k-category-tab"
                data-category="${escapeHtml(t.value)}" aria-pressed="${this._filterCategory === t.value}">${escapeHtml(t.label)}</button>
            `).join('')}
          </div>

          <div class="table-controls nba2k-controls">
            <input type="text" id="nba2kSearch" class="input search-input"
              placeholder="Search players…" value="${escapeHtml(this._search)}">

            <select id="nba2kPosFilter" class="input">
              <option value="">All Positions</option>
              ${positions.map(p => `<option value="${escapeHtml(p)}" ${this._filterPos === p ? 'selected' : ''}>${escapeHtml(p)}</option>`).join('')}
            </select>

            <select id="nba2kTeamFilter" class="input">
              <option value="">All Teams</option>
              ${teams.map(t => `<option value="${escapeHtml(t)}" ${this._filterTeam === t ? 'selected' : ''}>${escapeHtml(t)}</option>`).join('')}
            </select>

            <select id="nba2kOvrFilter" class="input">
              ${NBA2K_OVERALL_FILTERS.map(o => `<option value="${o.value}" ${this._filterOvr === o.value ? 'selected' : ''}>${o.label}</option>`).join('')}
            </select>

            <select id="nba2k27StatusFilter" class="input">
              <option value="" ${this._filter27 === '' ? 'selected' : ''}>2K27: All</option>
              <option value="selected" ${this._filter27 === 'selected' ? 'selected' : ''}>2K27: Selected</option>
              <option value="not-selected" ${this._filter27 === 'not-selected' ? 'selected' : ''}>2K27: Not Selected</option>
            </select>

            <select id="nba2k27PoolFilter" class="input">
              <option value="" ${this._filter27Pool === '' ? 'selected' : ''}>2K27 Pool: All</option>
              <option value="green" ${this._filter27Pool === 'green' ? 'selected' : ''}>2K27 Pool: 🟢 Green</option>
              <option value="blue" ${this._filter27Pool === 'blue' ? 'selected' : ''}>2K27 Pool: 🔵 Blue</option>
            </select>

            <select id="nba2kSort" class="input" style="max-width:200px;">
              <option value="ovr-desc" ${this._sortMode === 'ovr-desc' ? 'selected' : ''}>Sort: OVR (High–Low)</option>
              <option value="ovr-asc" ${this._sortMode === 'ovr-asc' ? 'selected' : ''}>Sort: OVR (Low–High)</option>
              <option value="name-asc" ${this._sortMode === 'name-asc' ? 'selected' : ''}>Sort: Name (A–Z)</option>
              <option value="team-asc" ${this._sortMode === 'team-asc' ? 'selected' : ''}>Sort: Team (A–Z)</option>
            </select>
          </div>

          <div id="nba2kListWrap"></div>
        `}
      </div>
      <div id="nba2kDetailMount"></div>`;

    if (players.length === 0) return;

    container.querySelectorAll('.nba2k-category-tab').forEach(btn => {
      btn.onclick = () => { this._filterCategory = btn.dataset.category; this._renderShell(container); };
    });
    container.querySelector('#nba2kSearch').oninput = e => { this._search = e.target.value; this._refreshList(container); };
    container.querySelector('#nba2kPosFilter').onchange = e => { this._filterPos = e.target.value; this._refreshList(container); };
    container.querySelector('#nba2kTeamFilter').onchange = e => { this._filterTeam = e.target.value; this._refreshList(container); };
    container.querySelector('#nba2kOvrFilter').onchange = e => { this._filterOvr = e.target.value; this._refreshList(container); };
    container.querySelector('#nba2k27StatusFilter').onchange = e => { this._filter27 = e.target.value; this._refreshList(container); };
    container.querySelector('#nba2k27PoolFilter').onchange = e => { this._filter27Pool = e.target.value; this._refreshList(container); };
    container.querySelector('#nba2kSort').onchange = e => { this._sortMode = e.target.value; this._refreshList(container); };

    this._refreshList(container);
  },

  _getVisiblePlayers() {
    const q = this._search.trim().toLowerCase();
    const minOvr = this._filterOvr ? Number(this._filterOvr) : null;

    let list = (this._players || []).filter(p => {
      if (this._filterCategory && p.teamType !== this._filterCategory) return false;
      if (q) {
        const hay = `${p.name || ''} ${p.team || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (this._filterPos) {
        const positions = Array.isArray(p.positions) ? p.positions : [];
        if (!positions.includes(this._filterPos)) return false;
      }
      if (this._filterTeam && p.team !== this._filterTeam) return false;
      if (minOvr !== null && !(Number(p.overall) >= minOvr)) return false;
      // Phase 7 filters — 2K27 selection status and (optional) 2K27 pool,
      // combined with every existing filter above via the same AND chain.
      if (this._filter27) {
        const selected = !!this._get2k27Entry(p.id);
        if (this._filter27 === 'selected' && !selected) return false;
        if (this._filter27 === 'not-selected' && selected) return false;
      }
      if (this._filter27Pool) {
        // Derived from teamType, same as promotion — never a stored
        // eligibility field, so a `curr` player can never match 'blue'.
        if (nba2kPoolForTeamType(p.teamType) !== this._filter27Pool) return false;
      }
      return true;
    });

    list = list.slice().sort((a, b) => {
      switch (this._sortMode) {
        case 'ovr-asc': return (a.overall ?? 0) - (b.overall ?? 0);
        case 'name-asc': return (a.name || '').localeCompare(b.name || '');
        case 'team-asc': return (a.team || '').localeCompare(b.team || '') || (b.overall ?? 0) - (a.overall ?? 0);
        case 'ovr-desc':
        default: return (b.overall ?? 0) - (a.overall ?? 0);
      }
    });

    return list;
  },

  _refreshList(container) {
    const wrap = container.querySelector('#nba2kListWrap');
    if (!wrap) return;
    const visible = this._getVisiblePlayers();

    if (!visible.length) {
      wrap.innerHTML = `<p class="backup-muted">No players match these filters.</p>`;
      return;
    }

    wrap.innerHTML = `
      <table class="admin-table nba2k-table">
        <thead>
          <tr>
            <th>Player</th>
            <th>OVR</th>
            <th>Position</th>
            <th>Team</th>
          </tr>
        </thead>
        <tbody>
          ${visible.map(p => this._renderRow(p)).join('')}
        </tbody>
      </table>`;

    wrap.querySelectorAll('[data-slug]').forEach(row => {
      const open = () => this._openDetail(container, row.dataset.slug);
      row.addEventListener('click', open);
      row.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    });
  },

  // ── Phase 3: promotion status/lookup helpers ──────────────────────────
  // Both read from LeagueData.getAllPlayers(), which is a synchronous,
  // no-network read of the already-live-synced local league cache (see
  // file header) — safe to call on every row render and every detail
  // open without worrying about staleness or extra Firestore traffic.

  _findPromotedEntry(slug) {
    return LeagueData.getAllPlayers().find(p => p.nba2kRef === slug) || null;
  },

  _findNameConflict(name) {
    const key = normalizePlayerName(name);
    return LeagueData.getAllPlayers().find(p => !p.nba2kRef && normalizePlayerName(p.name) === key) || null;
  },

  // ── Phase 7: 2K27 pool-selection lookup helpers ───────────────────────
  // Reads only the local `_pool27` cache (see `_load()`/file header) —
  // never Firestore — so these are safe to call on every row/detail
  // render just like the Phase 3 lookups above.

  _get2k27Entry(slug) {
    return (this._pool27 && this._pool27[slug]) || null;
  },

  _computePool27Counts(players) {
    let green = 0, blue = 0;
    for (const p of players) {
      const entry = this._get2k27Entry(p.id);
      if (!entry) continue;
      if (entry.pool === 'green') green++;
      else if (entry.pool === 'blue') blue++;
    }
    const total = green + blue;
    return { total, green, blue, notSelected: players.length - total };
  },

  _renderRow(p) {
    const positions = Array.isArray(p.positions) && p.positions.length ? p.positions.join(', ') : '—';
    const ovr = Number(p.overall) || 0;
    const promoted = this._findPromotedEntry(p.id);
    const statusHtml = promoted
      ? `<span class="nba2k-status-pill nba2k-status-pill-${promoted.pool || 'none'}">In Draft Pool${promoted.pool ? ` · ${promoted.pool === 'green' ? 'Green' : 'Blue'}` : ''}</span>`
      : '';
    // Phase 7: independent 2K27-selection badge — never conflated with
    // the Phase 3 Draft Pool status pill above; a player can show either,
    // both, or neither.
    const entry27 = this._get2k27Entry(p.id);
    const status27Html = entry27
      ? `<span class="nba2k27-status-pill nba2k27-status-pill-${entry27.pool || 'none'}">2K27 · ${entry27.pool === 'green' ? 'Green' : 'Blue'}</span>`
      : '';
    const categoryLabel = nba2kCategoryLabel(p.teamType);
    return `
      <tr data-slug="${escapeHtml(p.id)}" class="nba2k-row" tabindex="0" role="button" aria-label="View ${escapeHtml(p.name)} details">
        <td data-label="Player" class="nba2k-cell-player">${escapeHtml(p.name)}${statusHtml}${status27Html}</td>
        <td data-label="OVR" class="nba2k-cell-ovr"><span class="pos-ovr ${nba2kOvrTierClass(ovr)}">${ovr}</span></td>
        <td data-label="Position">${escapeHtml(positions)}</td>
        <td data-label="Team">${escapeHtml(p.team || '—')} <span class="nba2k-category-chip nba2k-category-chip-${escapeHtml(p.teamType || 'other')}">${escapeHtml(categoryLabel)}</span></td>
      </tr>`;
  },

  _openDetail(container, slug) {
    const player = (this._players || []).find(p => p.id === slug);
    if (!player) return;

    const mount = container.querySelector('#nba2kDetailMount') || document.getElementById('nba2kDetailMount');
    if (!mount) return;

    const positions = Array.isArray(player.positions) && player.positions.length ? player.positions.join(', ') : '—';
    const ovr = Number(player.overall) || 0;
    const initials = (player.name || '?').split(/\s+/).map(w => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();

    const attrSections = NBA2K_ATTRIBUTE_GROUPS.map(group => {
      const rows = group.keys.map(([key, label]) => {
        const raw = player.attributes ? player.attributes[key] : undefined;
        const v = Number(raw);
        const hasValue = raw !== undefined && raw !== null && !isNaN(v);
        const pct = hasValue ? Math.max(0, Math.min(100, (v / 99) * 100)) : 0;
        return `
          <div class="nba2k-attr-row">
            <span class="nba2k-attr-label">${escapeHtml(label)}</span>
            <div class="nba2k-attr-bar-track">
              <div class="nba2k-attr-bar-fill ${hasValue ? nba2kAttrTierClass(v) : ''}" style="width:${pct}%"></div>
            </div>
            <span class="nba2k-attr-value">${hasValue ? v : '—'}</span>
          </div>`;
      }).join('');
      return `
        <div class="nba2k-attr-section">
          <h4>${escapeHtml(group.title)}</h4>
          ${rows}
        </div>`;
    }).join('');

    const badgeList = (player.badges && Array.isArray(player.badges.list)) ? player.badges.list : [];
    const badgesByTier = {};
    for (const b of badgeList) {
      if (!b || !b.tier) continue;
      (badgesByTier[b.tier] = badgesByTier[b.tier] || []).push(b);
    }
    const badgeSections = NBA2K_BADGE_TIER_ORDER
      .filter(tier => badgesByTier[tier] && badgesByTier[tier].length)
      .map(tier => `
        <div class="nba2k-badge-group">
          <h5 class="nba2k-badge-tier nba2k-badge-tier-${tier.toLowerCase().replace(/\s+/g, '-')}">${escapeHtml(tier)}</h5>
          <div class="nba2k-badge-chips">
            ${badgesByTier[tier].map(b => `<span class="nba2k-badge-chip" title="${escapeHtml(b.category || '')}">${escapeHtml(b.name)}</span>`).join('')}
          </div>
        </div>`).join('');

    mount.innerHTML = `
      <div class="modal-overlay" id="nba2kDetailOverlay">
        <div class="modal-card nba2k-detail-modal">
          <button type="button" class="nba2k-detail-close" id="nba2kDetailClose" aria-label="Close">×</button>

          <div class="nba2k-detail-header">
            <div class="nba2k-avatar">
              ${player.playerImage ? `<img src="${escapeHtml(player.playerImage)}" alt="" onerror="this.remove()">` : ''}
              <span class="nba2k-avatar-fallback">${escapeHtml(initials)}</span>
            </div>
            <div class="nba2k-detail-header-info">
              <div class="nba2k-detail-name">${escapeHtml(player.name)}</div>
              <div class="nba2k-detail-meta">
                <span class="pos-ovr ${nba2kOvrTierClass(ovr)} nba2k-detail-ovr">${ovr} OVR</span>
                <span>${escapeHtml(player.team || '—')}</span>
                <span>${escapeHtml(positions)}</span>
                <span class="nba2k-category-chip nba2k-category-chip-${escapeHtml(player.teamType || 'other')}">${escapeHtml(nba2kCategoryLabel(player.teamType).toUpperCase())}</span>
              </div>
              ${nba2kPoolEligibilityLabel(player.teamType) ? `<div class="nba2k-eligibility-label">${escapeHtml(nba2kPoolEligibilityLabel(player.teamType))}</div>` : ''}
              <div class="nba2k-detail-physicals">
                ${player.build ? `<span>${escapeHtml(player.build)}</span>` : ''}
                ${player.height ? `<span>${escapeHtml(player.height)}</span>` : ''}
                ${player.weight ? `<span>${escapeHtml(player.weight)}</span>` : ''}
                ${player.wingspan ? `<span>Wingspan ${escapeHtml(player.wingspan)}</span>` : ''}
              </div>
            </div>
          </div>

          <div class="nba2k-detail-body">
            <div class="nba2k-attr-groups">${attrSections}</div>

            <div class="nba2k-badges-section">
              <h4>Badges</h4>
              ${badgeSections || '<p class="backup-muted">No badges</p>'}
            </div>
          </div>

          ${this._renderPositionEditor(player)}

          ${this._render2k27Section(player)}

          ${this._renderPromotionSection(player)}
        </div>
      </div>`;

    const close = () => { mount.innerHTML = ''; };
    document.getElementById('nba2kDetailClose').onclick = close;
    document.getElementById('nba2kDetailOverlay').addEventListener('click', e => {
      if (e.target.id === 'nba2kDetailOverlay') close();
    });

    this._bindPositionEditorEvents(container, mount, player);
    this._bind2k27Events(container, mount, player);
    this._bindPromotionEvents(container, mount, player);
  },

  // ── Phase 6: "Position Management" section ────────────────────────────
  // Admin-only manual correction of `nba2k_players/<slug>.positions`.
  // Rendered above the Phase 3/5 promotion section so the commissioner
  // naturally corrects source data before promoting. Never auto-selects,
  // auto-corrects, or infers a position from any other field — see the
  // Phase 6 file-header note.
  _renderPositionEditor(player) {
    const current = normalizeNba2kPositions(player.positions);
    const status = nba2kPositionStatus(player.positions);
    const promoted = this._findPromotedEntry(player.id);

    return `
      <div class="nba2k-promo nba2k-posedit">
        <h4>Position Management</h4>

        <div class="nba2k-posedit-status-row">
          <span>NBA2K Source Positions</span>
          <strong>${current.length ? escapeHtml(current.join(' / ')) : '—'}</strong>
        </div>
        <div class="nba2k-posedit-status-row">
          <span>Draft Pool Position</span>
          <strong>${promoted ? escapeHtml(promoted.position || '—') : 'Not yet promoted'}</strong>
        </div>
        <div class="nba2k-posedit-quality nba2k-posedit-quality-${status.cls}">${status.icon} ${escapeHtml(status.label)}</div>

        <p class="helper-text nba2k-posedit-hint">
          Correct this NBA2K player's source positions. This never changes an
          existing Draft Pool player — only future promotions use the
          corrected positions.
        </p>

        <div class="nba2k-posedit-checks">
          ${NBA2K_VALID_POSITIONS.map(pos => `
            <label class="nba2k-posedit-check">
              <input type="checkbox" value="${pos}" ${current.includes(pos) ? 'checked' : ''}>
              <span>${pos}</span>
            </label>
          `).join('')}
        </div>

        <button type="button" class="btn btn-primary" id="nba2kPosSaveBtn">Save Positions</button>

        <div id="nba2kPosResult" class="nba2k-posedit-result"></div>
      </div>`;
  },

  _bindPositionEditorEvents(container, mount, player) {
    const root = mount.querySelector('.nba2k-posedit');
    if (!root) return;

    const checks = Array.from(root.querySelectorAll('input[type="checkbox"]'));
    const saveBtn = root.querySelector('#nba2kPosSaveBtn');
    const resultEl = root.querySelector('#nba2kPosResult');

    // Snapshot taken when this editor opened — used both as the "current"
    // side of the diff/no-change comparison and as the expected-previous
    // value for the concurrent-edit check right before the write.
    const openedPositions = normalizeNba2kPositions(player.positions);

    saveBtn.onclick = () => {
      resultEl.innerHTML = '';

      const selected = checks.filter(c => c.checked).map(c => c.value);
      const normalized = normalizeNba2kPositions(selected);

      if (normalized.length === 0) {
        resultEl.innerHTML = `<div class="backup-result backup-result-error">You must select at least one position.</div>`;
        return;
      }
      if (nba2kPositionsEqual(normalized, openedPositions)) {
        resultEl.innerHTML = `<p class="helper-text">No position changes to save.</p>`;
        return;
      }

      resultEl.innerHTML = `
        <div class="nba2k-promo-confirm-card">
          <div class="nba2k-promo-eyebrow">Position Change</div>
          <div class="nba2k-promo-confirm-row"><span>Player</span><strong>${escapeHtml(player.name)}</strong></div>
          <div class="nba2k-promo-confirm-row"><span>Current</span><strong>${openedPositions.length ? escapeHtml(openedPositions.join(', ')) : '—'}</strong></div>
          <div class="nba2k-promo-confirm-row"><span>New</span><strong>${escapeHtml(normalized.join(', '))}</strong></div>
          <div class="form-actions">
            <button type="button" class="btn btn-primary" id="nba2kPosConfirmBtn">Save Positions</button>
            <button type="button" class="btn btn-ghost" id="nba2kPosCancelBtn">Cancel</button>
          </div>
        </div>`;

      resultEl.querySelector('#nba2kPosCancelBtn').onclick = () => {
        resultEl.innerHTML = '';
      };

      resultEl.querySelector('#nba2kPosConfirmBtn').onclick = async () => {
        const confirmBtn = resultEl.querySelector('#nba2kPosConfirmBtn');
        const cancelBtn = resultEl.querySelector('#nba2kPosCancelBtn');
        confirmBtn.disabled = true;
        cancelBtn.disabled = true;
        confirmBtn.textContent = 'Saving…';

        try {
          AuthBoundary.requireAuth();
          await this._savePositions(player.id, normalized, openedPositions);

          // Update the in-memory cache entry in place — the same object
          // every row render, filter, and the Phase 3/5 promotion section
          // read from — so everything reflects this instantly with zero
          // extra Firestore reads and no page reload.
          player.positions = normalized;

          showToast('Positions updated', 'success');
          this._openDetail(container, player.id);
          this._refreshList(container);
        } catch (err) {
          resultEl.innerHTML = `<div class="backup-result backup-result-error">${escapeHtml(err.message || 'Unable to save positions. Please try again.')}</div>`;
        }
      };
    };
  },

  // Writes ONLY the `positions` field of `nba2k_players/<slug>` via
  // `.update()` — never `.set()`, so every other field on the document is
  // guaranteed untouched. Re-reads the document first and compares its
  // (normalized) `positions` against `expectedPrevious` (the value this
  // editor session started from); a mismatch means another admin session
  // changed it first, so the write is aborted rather than silently
  // clobbering a newer edit. Never surfaces a raw Firebase error message.
  async _savePositions(slug, normalized, expectedPrevious) {
    const ref = firebase.firestore().collection('nba2k_players').doc(slug);

    let snap;
    try {
      snap = await ref.get();
    } catch (err) {
      throw new Error(err && err.code === 'permission-denied'
        ? "You don't have permission to save positions."
        : 'Unable to save positions. Please try again.');
    }

    if (!snap.exists) {
      throw new Error('This NBA2K player could not be found.');
    }

    const serverPositions = normalizeNba2kPositions(snap.data().positions);
    if (!nba2kPositionsEqual(serverPositions, expectedPrevious)) {
      throw new Error('This player was updated elsewhere. Please reload the player before saving.');
    }

    try {
      await ref.update({ positions: normalized });
    } catch (err) {
      throw new Error(err && err.code === 'permission-denied'
        ? "You don't have permission to save positions."
        : 'Unable to save positions. Please try again.');
    }
  },


  // ── Phase 7: "2K27 Pool" section ────────────────────────────────────────
  // Completely independent of the Phase 3/5 "Add to Draft Pool" section
  // below: this never calls AdminActions.addPlayer(), never touches
  // `league/main`, and never modifies `nba2k_players`. Three mutually
  // exclusive states: undeterminable pool (error only, no button — same
  // rule as promotion), selected (status + Remove), or not selected
  // (locked pool preview + Add). Pool is always derived from `teamType`
  // via the existing `nba2kPoolForTeamType()` — never a separate stored
  // eligibility field, and never a manual Green/Blue choice.
  _render2k27Section(player) {
    const pool = nba2kPoolForTeamType(player.teamType);
    if (!pool) {
      return `
        <div class="nba2k-promo nba2k27-section">
          <h4>2K27 Pool</h4>
          <div class="backup-result backup-result-error">
            Cannot determine pool eligibility for this NBA2K player.
          </div>
        </div>`;
    }

    const entry = this._get2k27Entry(player.id);

    if (entry) {
      const entryPool = entry.pool === 'green' ? 'green' : entry.pool === 'blue' ? 'blue' : pool;
      const entryLabel = entryPool === 'green' ? 'Green' : 'Blue';
      const entryDot = entryPool === 'green' ? '🟢' : '🔵';
      return `
        <div class="nba2k-promo nba2k27-section" data-pool27-state="selected">
          <h4>2K27 Pool</h4>
          <div class="nba2k-promo-row">
            <label>Status</label>
            <div class="nba2k-promo-pool-locked nba2k-promo-pool-locked-${escapeHtml(entryPool)}">
              <span class="nba2k-promo-pool-dot">${entryDot}</span>
              <span><strong>${escapeHtml(entryLabel)} Pool</strong><span class="nba2k-promo-pool-sublabel">Selected</span></span>
            </div>
          </div>
          <button type="button" class="btn btn-ghost" id="nba2k27RemoveBtn">Remove from 2K27 Pool</button>
          <div id="nba2k27Confirm" class="hidden"></div>
        </div>`;
    }

    const poolLabel = pool === 'green' ? 'Green' : 'Blue';
    const poolDot = pool === 'green' ? '🟢' : '🔵';
    return `
      <div class="nba2k-promo nba2k27-section" data-pool27-state="not-selected">
        <h4>2K27 Pool</h4>
        <div class="nba2k-promo-row">
          <label>Pool</label>
          <div class="nba2k-promo-pool-locked nba2k-promo-pool-locked-${escapeHtml(pool)}">
            <span class="nba2k-promo-pool-dot">${poolDot}</span>
            <span><strong>${escapeHtml(poolLabel)} Pool</strong><span class="nba2k-promo-pool-sublabel">Not Selected</span></span>
          </div>
        </div>
        <button type="button" class="btn btn-primary" id="nba2k27AddBtn">Add to 2K27 Pool</button>
        <div id="nba2k27Confirm" class="hidden"></div>
      </div>`;
  },

  _bind2k27Events(container, mount, player) {
    const addBtn = mount.querySelector('#nba2k27AddBtn');
    const removeBtn = mount.querySelector('#nba2k27RemoveBtn');
    const confirmEl = mount.querySelector('#nba2k27Confirm');
    if (!confirmEl) return; // undeterminable-pool state — nothing to wire

    if (addBtn) {
      addBtn.onclick = () => {
        // Pool shown here is only a preview for the confirmation card —
        // the actual write always re-derives it below, never trusts this.
        const previewPool = nba2kPoolForTeamType(player.teamType);
        if (!previewPool) return; // belt-and-suspenders; button shouldn't exist otherwise
        const previewLabel = previewPool === 'green' ? 'Green' : 'Blue';
        const positions = Array.isArray(player.positions) && player.positions.length
          ? player.positions.join(' / ') : '—';

        confirmEl.classList.remove('hidden');
        confirmEl.innerHTML = `
          <div class="nba2k-promo-confirm-card">
            <div class="nba2k-promo-eyebrow">Add to NBA 2K27 Pool</div>
            <div class="nba2k-promo-confirm-row"><span>Name</span><strong>${escapeHtml(player.name)}</strong></div>
            <div class="nba2k-promo-confirm-row"><span>Source</span><strong>${escapeHtml(nba2kCategoryLabel(player.teamType))}</strong></div>
            <div class="nba2k-promo-confirm-row"><span>Pool</span><strong>${escapeHtml(previewLabel)}</strong></div>
            <div class="nba2k-promo-confirm-row"><span>NBA2K OVR</span><strong>${escapeHtml(String(player.overall ?? '—'))}</strong></div>
            <div class="nba2k-promo-confirm-row"><span>Positions</span><strong>${escapeHtml(positions)}</strong></div>
            <p class="helper-text">This will add the player to the future NBA 2K27 pool. It will NOT change the current Season 4 pool.</p>
            <div class="form-actions">
              <button type="button" class="btn btn-primary" id="nba2k27ConfirmAddBtn">Add to 2K27 Pool</button>
              <button type="button" class="btn btn-ghost" id="nba2k27CancelBtn">Cancel</button>
            </div>
          </div>`;

        confirmEl.querySelector('#nba2k27CancelBtn').onclick = () => {
          confirmEl.classList.add('hidden');
          confirmEl.innerHTML = '';
        };

        const confirmAddBtn = confirmEl.querySelector('#nba2k27ConfirmAddBtn');
        confirmAddBtn.onclick = async () => {
          AuthBoundary.requireAuth();
          confirmAddBtn.disabled = true; // prevent a double-click duplicate write

          // Idempotent by slug — if another tab/session already selected
          // this player while the confirmation card was open, just show
          // the current state rather than writing again.
          if (this._get2k27Entry(player.id)) {
            confirmEl.classList.add('hidden');
            confirmEl.innerHTML = '';
            this._openDetail(container, player.id);
            this._refreshList(container);
            return;
          }

          // Re-derive the pool from the freshest local player record,
          // immediately before writing — never trust `previewPool` from
          // when the card opened (Phase 7 pool re-check requirement).
          const freshPlayer = (this._players || []).find(pp => pp.id === player.id) || player;
          const writePool = nba2kPoolForTeamType(freshPlayer.teamType);
          if (!writePool) {
            confirmEl.innerHTML = `<div class="backup-result backup-result-error">Cannot determine pool eligibility for this NBA2K player.</div>`;
            return;
          }

          const now = new Date().toISOString();
          const docData = { nba2kRef: player.id, pool: writePool, selectedAt: now, updatedAt: now };
          try {
            // Targeted write: only nba2k27_pool/<slug>. Never league/main,
            // never nba2k_players.
            await firebase.firestore().collection('nba2k27_pool').doc(player.id).set(docData);
            this._pool27 = this._pool27 || {};
            this._pool27[player.id] = docData;
            showToast(`${player.name} added to the 2K27 ${writePool === 'green' ? 'Green' : 'Blue'} Pool.`, 'success');
            this._openDetail(container, player.id);
            this._refreshList(container);
            // Phase 8: let the NBA 2K27 Pool Management view (if open) know
            // this cache changed — see `_onPool27Changed` declaration above.
            if (this._onPool27Changed) this._onPool27Changed();
          } catch (err) {
            confirmAddBtn.disabled = false;
            const msg = err && err.code === 'permission-denied'
              ? "You don't have permission to update the 2K27 pool."
              : 'Could not add this player to the 2K27 pool — please try again.';
            confirmEl.innerHTML = `<div class="backup-result backup-result-error">${escapeHtml(msg)}</div>`;
          }
        };
      };
    }

    if (removeBtn) {
      removeBtn.onclick = () => {
        confirmEl.classList.remove('hidden');
        confirmEl.innerHTML = `
          <div class="nba2k-promo-confirm-card">
            <div class="nba2k-promo-eyebrow">Remove from NBA 2K27 Pool?</div>
            <div class="nba2k-promo-confirm-row"><span>Name</span><strong>${escapeHtml(player.name)}</strong></div>
            <p class="helper-text">This only removes the player's 2K27 selection. It does not affect Season 4.</p>
            <div class="form-actions">
              <button type="button" class="btn btn-danger" id="nba2k27ConfirmRemoveBtn">Remove</button>
              <button type="button" class="btn btn-ghost" id="nba2k27CancelRemoveBtn">Cancel</button>
            </div>
          </div>`;

        confirmEl.querySelector('#nba2k27CancelRemoveBtn').onclick = () => {
          confirmEl.classList.add('hidden');
          confirmEl.innerHTML = '';
        };

        const confirmRemoveBtn = confirmEl.querySelector('#nba2k27ConfirmRemoveBtn');
        confirmRemoveBtn.onclick = async () => {
          AuthBoundary.requireAuth();
          confirmRemoveBtn.disabled = true;
          try {
            // Deletes ONLY nba2k27_pool/<slug> — never nba2k_players,
            // never league/main.
            await firebase.firestore().collection('nba2k27_pool').doc(player.id).delete();
            if (this._pool27) delete this._pool27[player.id];
            showToast(`${player.name} removed from the 2K27 pool.`, 'success');
            this._openDetail(container, player.id);
            this._refreshList(container);
            // Phase 8: let the NBA 2K27 Pool Management view (if open) know
            // this cache changed — see `_onPool27Changed` declaration above.
            if (this._onPool27Changed) this._onPool27Changed();
          } catch (err) {
            confirmRemoveBtn.disabled = false;
            const msg = err && err.code === 'permission-denied'
              ? "You don't have permission to update the 2K27 pool."
              : 'Could not remove this player from the 2K27 pool — please try again.';
            confirmEl.innerHTML = `<div class="backup-result backup-result-error">${escapeHtml(msg)}</div>`;
          }
        };
      };
    }
  },

  // ── Phase 3/5: "Add to Draft Pool" section ─────────────────────────────
  // Renders one of four mutually exclusive states for the selected NBA2K
  // player: already promoted (status only), a name conflict with a
  // pre-existing non-NBA2K player (warning only), an undeterminable pool
  // (error only — Phase 5), or the promotion form itself. Phase 5 change:
  // pool is now derived from `teamType` and displayed locked/read-only —
  // the commissioner can no longer pick it. Position selection is
  // unchanged from Phase 3: always an explicit manual choice.
  _renderPromotionSection(player) {
    const promoted = this._findPromotedEntry(player.id);
    if (promoted) {
      const poolLabel = promoted.pool === 'green' ? 'Green Pool' : promoted.pool === 'blue' ? 'Blue Pool' : 'no pool set';
      return `
        <div class="nba2k-promo nba2k-promo-status">
          <div class="nba2k-promo-eyebrow">In Draft Pool</div>
          <div class="nba2k-promo-pool-label">${escapeHtml(poolLabel)}</div>
          <p class="helper-text">Draft Pool Position: ${escapeHtml(promoted.position || '—')} · NBA2K Reference: <code>${escapeHtml(player.id)}</code></p>
        </div>`;
    }

    const conflict = this._findNameConflict(player.name);
    if (conflict) {
      return `
        <div class="nba2k-promo">
          <div class="backup-result backup-result-error">
            <strong>An existing Draft Pool player with this name already exists.</strong>
            <div>${escapeHtml(conflict.name)} — ${escapeHtml(conflict.position || 'no position')}, ${escapeHtml(String(conflict.overall ?? '—'))} OVR${conflict.pool ? `, ${conflict.pool === 'green' ? 'Green' : 'Blue'} Pool` : ', no pool set'}.</div>
            <div style="margin-top:0.4rem;">Resolve this manually on the Players page before promoting — no player was created.</div>
          </div>
        </div>`;
    }

    // Phase 5: pool is derived from teamType, never chosen. An
    // unrecognized/missing teamType must block promotion entirely rather
    // than guess — no position selector is shown in that case either,
    // since there is nothing valid to promote into.
    const pool = nba2kPoolForTeamType(player.teamType);
    if (!pool) {
      return `
        <div class="nba2k-promo">
          <h4>Add to Draft Pool</h4>
          <div class="backup-result backup-result-error">
            Cannot determine pool eligibility for this NBA2K player.
          </div>
        </div>`;
    }
    const poolLabel = pool === 'green' ? 'Green Pool' : 'Blue Pool';
    const poolDot = pool === 'green' ? '🟢' : '🔵';
    const poolSubtitle = pool === 'green' ? 'Current NBA Player' : 'Classics / All-Time Player';

    const sourcePositions = Array.isArray(player.positions) ? player.positions.filter(Boolean) : [];
    const noPositions = sourcePositions.length === 0;
    // Fall back to the same manual 5-position list the existing Add
    // Player form offers, only when the source has none — never an
    // automatic pick when the source DOES have positions.
    const positionOptions = noPositions ? ['PG', 'SG', 'SF', 'PF', 'C'] : sourcePositions;

    return `
      <div class="nba2k-promo" data-pool="${escapeHtml(pool)}">
        <h4>Add to Draft Pool</h4>

        <div class="nba2k-promo-row">
          <label>Pool</label>
          <div class="nba2k-promo-pool-locked nba2k-promo-pool-locked-${escapeHtml(pool)}">
            <span class="nba2k-promo-pool-dot">${poolDot}</span>
            <span>
              <strong>${escapeHtml(poolLabel)}</strong>
              <span class="nba2k-promo-pool-sublabel">${escapeHtml(poolSubtitle)}</span>
            </span>
          </div>
        </div>

        ${noPositions ? `<p class="backup-result backup-result-error" style="margin-bottom:0.75rem;">This player has no NBA2K positions on record — choose a Draft Pool position manually.</p>` : ''}

        <div class="nba2k-promo-row">
          <label for="nba2kPromoPosition">Position</label>
          <select id="nba2kPromoPosition" class="input">
            <option value="">Select position</option>
            ${positionOptions.map(pos => `<option value="${escapeHtml(pos)}">${escapeHtml(pos)}</option>`).join('')}
          </select>
        </div>
        <p class="helper-text" style="margin:-0.4rem 0 0.75rem;">Choose the position this player will use in the Draft Pool.</p>

        <button type="button" class="btn btn-primary" id="nba2kPromoOpenConfirm" disabled>Add to Draft Pool</button>

        <div id="nba2kPromoConfirm" class="hidden"></div>
      </div>`;
  },

  _bindPromotionEvents(container, mount, player) {
    const posEl = mount.querySelector('#nba2kPromoPosition');
    const confirmBtn = mount.querySelector('#nba2kPromoOpenConfirm');
    if (!posEl || !confirmBtn) return; // already-promoted, conflict, or undeterminable-pool state — nothing to wire

    const updateEnabled = () => {
      confirmBtn.disabled = !posEl.value;
    };
    posEl.onchange = updateEnabled;

    confirmBtn.onclick = () => {
      const position = posEl.value;
      // Pool is always re-derived from the source record here, never read
      // from any form control — there is no pool input to read from.
      const pool = nba2kPoolForTeamType(player.teamType);
      if (!position || !pool) return; // belt-and-suspenders; button is disabled otherwise, and this state shouldn't render a form at all

      const confirmEl = mount.querySelector('#nba2kPromoConfirm');
      const poolLabel = pool === 'green' ? 'Green' : 'Blue';
      const categoryLabel = nba2kCategoryLabel(player.teamType);
      confirmEl.classList.remove('hidden');
      confirmEl.innerHTML = `
        <div class="nba2k-promo-confirm-card">
          <div class="nba2k-promo-eyebrow">Add Player to Draft Pool</div>
          <div class="nba2k-promo-confirm-row"><span>Name</span><strong>${escapeHtml(player.name)}</strong></div>
          <div class="nba2k-promo-confirm-row"><span>NBA2K OVR</span><strong>${escapeHtml(String(player.overall ?? '—'))}</strong></div>
          <div class="nba2k-promo-confirm-row"><span>Source</span><strong>${escapeHtml(categoryLabel)}</strong></div>
          <div class="nba2k-promo-confirm-row"><span>Position</span><strong>${escapeHtml(position)}</strong></div>
          <div class="nba2k-promo-confirm-row"><span>Pool</span><strong>${escapeHtml(poolLabel)}</strong></div>
          <div class="nba2k-promo-confirm-row"><span>NBA2K Reference</span><strong><code>${escapeHtml(player.id)}</code></strong></div>
          <div class="form-actions">
            <button type="button" class="btn btn-primary" id="nba2kPromoConfirmBtn">Add Player</button>
            <button type="button" class="btn btn-ghost" id="nba2kPromoCancelBtn">Cancel</button>
          </div>
        </div>`;

      confirmEl.querySelector('#nba2kPromoCancelBtn').onclick = () => {
        confirmEl.classList.add('hidden');
        confirmEl.innerHTML = '';
      };

      confirmEl.querySelector('#nba2kPromoConfirmBtn').onclick = () => {
        AuthBoundary.requireAuth();

        // Re-check EVERYTHING against the freshest available data
        // immediately before writing: promotion status, name conflict,
        // AND pool derivation (re-derived from player.teamType again,
        // never trusted from a variable captured earlier in this
        // closure) — never trust a manually-suppliable value, per Phase
        // 5's source-category-validation requirement. LeagueData.
        // getAllPlayers() is a synchronous read of the live-synced local
        // cache, so this costs nothing and closes the window between
        // opening this detail view and confirming.
        if (this._findPromotedEntry(player.id)) {
          confirmEl.innerHTML = `<div class="backup-result backup-result-error">This player was already added to the Draft Pool (in another tab/session) — no duplicate was created.</div>`;
          setTimeout(() => this._openDetail(container, player.id), 1200);
          return;
        }
        const nowConflict = this._findNameConflict(player.name);
        if (nowConflict) {
          confirmEl.innerHTML = `<div class="backup-result backup-result-error">An existing Draft Pool player with this name already exists — no duplicate was created.</div>`;
          setTimeout(() => this._openDetail(container, player.id), 1200);
          return;
        }
        const recheckedPool = nba2kPoolForTeamType(player.teamType);
        if (!recheckedPool) {
          confirmEl.innerHTML = `<div class="backup-result backup-result-error">Cannot determine pool eligibility for this NBA2K player.</div>`;
          return;
        }

        AdminActions.addPlayer({
          name: player.name,
          position,
          overall: Number(player.overall) || 0,
          pool: recheckedPool,
          nba2kRef: player.id,
        });

        showToast(`${player.name} added to ${poolLabel} Pool.`, 'success');

        // Reflect the new status without a page reload: re-render this
        // detail view (now shows "In Draft Pool" with the position/ref
        // recorded above) and the underlying table row (status pill).
        // This re-render replaces mount.innerHTML entirely, so there is
        // no separate "success" block left behind to go stale.
        this._openDetail(container, player.id);
        this._refreshList(container);
      };
    };
  },
};

/**
 * Nba2k27PoolView — Phase 8: NBA 2K27 Pool Management
 *
 * PURPOSE
 * A dedicated, browse-only-except-for-removal admin view answering
 * "which players have I selected for NBA 2K27, which pool are they in,
 * and who is still available?" — over the SELECTIONS already created by
 * the Phase 7 "Add to 2K27 Pool" flow above. This view creates none of
 * those selections itself; it only lists, filters, sorts, inspects, and
 * removes them.
 *
 * DATA SOURCE — NO SEPARATE LOAD
 * This view holds no player/selection data of its own and issues no
 * Firestore reads directly. It reads `Nba2kDatabaseView._players` and
 * `Nba2kDatabaseView._pool27` — the exact same session-level cache
 * Phase 7 already populates from `nba2k_players` + `nba2k27_pool` — via
 * `Nba2kDatabaseView._ensureLoaded()` (see that file section for the
 * extraction; the underlying fetch/caching/error-handling is completely
 * unchanged from Phase 7). Whichever of the two views (NBA 2K26 Database
 * or NBA 2K27 Pool) the admin opens first triggers the one-time load;
 * the other reuses it with zero additional reads. The join itself
 * (`nba2kRef === slug`) happens at render time in `_buildRows()` below —
 * `nba2k27_pool` documents are never enriched with copied player fields.
 *
 * WRITES — REMOVAL ONLY, SAME SHAPE AS PHASE 7
 * The only write this view performs is
 *   firebase.firestore().collection('nba2k27_pool').doc(slug).delete()
 * after an explicit confirmation — identical in shape to the Phase 7
 * remove path, targeting only `nba2k27_pool/<slug>`. It never writes to
 * `nba2k_players`, never calls `AdminActions.addPlayer()`, and never
 * writes to `league/main`. Clicking a (non-orphaned) row opens the
 * existing shared NBA2K detail modal (`Nba2kDatabaseView._openDetail()`)
 * unmodified — same Position Management / 2K27 Pool / Add to Draft Pool
 * sections as everywhere else in the app — so "Add to 2K27 Pool" and the
 * fuller per-player editing tools stay exactly where Phase 6/7 put them;
 * this view is a management/browse layer on top, not a second copy of
 * them. When that shared modal's own 2K27 Add/Remove buttons write,
 * `Nba2kDatabaseView._onPool27Changed()` (set below, while this view is
 * open) refreshes this view's list from the same already-updated cache —
 * no re-fetch, no polling.
 *
 * DATA INTEGRITY (Phase 8, new)
 * Two data-quality states are surfaced, never auto-corrected:
 *   - Orphaned selection: an `nba2k27_pool/<slug>` doc whose
 *     `nba2k_players/<slug>` no longer exists. Shown with a "Source
 *     player not found" warning; never guessed at, never auto-deleted.
 *     It can still be manually removed via the same confirmed delete —
 *     that is an explicit admin action, not automatic cleanup.
 *   - Invalid pool value: a stored `pool` that is neither `'green'` nor
 *     `'blue'`. Shown as "Invalid Pool" — never silently coerced to a
 *     derived value — and excluded from the Green/Blue pool filter and
 *     summary counts (it still counts toward Total Selected, since it
 *     IS a selection, just one with corrupted pool metadata).
 * Note on scope: this integrity handling lives in THIS view's own
 * rendering only. The shared detail modal's existing 2K27 section
 * (`Nba2kDatabaseView._render2k27Section`, Phase 7, untouched) has its
 * own, different, already-shipped display rule for an unrecognized
 * stored pool value (falls back to the teamType-derived pool rather
 * than labeling it "Invalid Pool") — changing that fallback was not
 * required to build this view and risked altering tested Phase 7
 * behavior for a case Phase 7 was never asked to validate, so it was
 * left exactly as-is. See the Phase 8 final report for this note.
 *
 * COUNTS
 * `_computeCounts()` below is intentionally independent from the Phase 7
 * header widget's own `Nba2kDatabaseView._computePool27Counts()` — that
 * one only tallies entries with a MATCHING source player and an exactly
 * valid pool value (by construction, since it loops over `_players` and
 * looks up an entry per player). This view's "Total Selected" is meant
 * to answer "how many nba2k27_pool documents exist", which must include
 * orphans and invalid-pool entries too (that's the whole point of
 * surfacing them) — so it loops over `_pool27` itself instead. Both
 * counters are correct for what they each measure; they are simply
 * answering slightly different questions, and neither was changed to
 * match the other.
 */

/**
 * Nba2k27PoolValidator — Phase 9: NBA 2K27 Pool Validation & Readiness.
 *
 * PURPOSE
 * Answers "is the currently-selected nba2k27_pool ready for the future
 * 2K27 season?" by classifying every already-joined row (as produced by
 * `Nba2k27PoolView._buildRows()`, which itself performs no Firestore
 * access) against the existing, already-shipped rules elsewhere in this
 * app. This object is pure and read-only by construction: every method
 * here takes plain data in and returns plain data out — no Firestore
 * calls, no DOM access, no mutation of its input. It reports problems;
 * it never repairs, deletes, or rewrites anything.
 *
 * RULES REUSED (NOT REINVENTED) — see the Phase 9 final report for the
 * repository inspection that established each of these:
 *   - Position validity: the existing Phase 6 `NBA2K_VALID_POSITIONS`
 *     whitelist and `normalizeNba2kPositions()` (this file, above).
 *   - Pool derivation: the existing Phase 5 `nba2kPoolForTeamType()`
 *     (this file, above) — curr→green, class/allt→blue, else null.
 *   - Required source fields (name / team / a numeric overall): the
 *     exact required-field checks already enforced at import time in
 *     `js/admin/nba2k-import.js` `_validateAndPreview()`. This validator
 *     does NOT reuse the "overall must be 40–99" rule from
 *     `js/admin/players.js` — that is a Season-4 Draft Pool (`league/
 *     main`) add/edit-player form rule for manually-entered players,
 *     not a rule this repository applies to the `nba2k_players` source
 *     database (whose own import-time check only requires a numeric,
 *     non-NaN `overall`, with no min/max — confirmed by inspecting
 *     `nba2k-import.js` before writing this). Reusing the Draft Pool's
 *     40–99 rule here would be inventing a new rule for a collection
 *     that has never had it, so it was deliberately left out.
 *
 * ONE RULE EXTENDED, NOT INVENTED FROM SCRATCH
 * Phase 6's own `nba2kPositionStatus()` only checks "does at least one
 * valid position survive normalization" — that would let a stored
 * `["PG", "XYZ"]` pass as fine, since `normalizeNba2kPositions()` (by
 * design, for the Phase 6 editor's own purposes) silently drops `XYZ`
 * and keeps `PG`. Phase 9 additionally needs to surface that `XYZ`
 * itself is garbage data, so `_positionIssue()` below also checks the
 * RAW stored array against the existing `NBA2K_VALID_POSITIONS`
 * whitelist directly. This reuses the existing whitelist constant; it
 * does not define a new one or a new canonical order.
 *
 * CLASSIFICATION (see `classify()`) — six independent boolean flags per
 * row, `{ orphaned, unknownPoolEligibility, invalidStoredPool,
 * poolMismatch, positionIssue, dataIssue }`, plus `ready` (true only
 * when every flag is false). `positionIssue` and `dataIssue` are each
 * independent of the other flags and of each other — a row can be both
 * at once (Phase 9 test #16). The three pool-related flags
 * (`unknownPoolEligibility` / `invalidStoredPool` / `poolMismatch`),
 * however, are mutually exclusive BY CONSTRUCTION: they are three
 * different answers to the single question "does the stored pool match
 * what it should be", evaluated in this fixed priority —
 *   1. teamType doesn't resolve to a pool at all -> unknownPoolEligibility
 *      (nothing to compare the stored value against, so a look at the
 *      stored value's own validity is skipped for this row)
 *   2. else the stored pool value isn't 'green'/'blue' -> invalidStoredPool
 *   3. else stored !== derived -> poolMismatch
 *   4. else no pool problem.
 * This priority order (rather than trying to raise more than one
 * pool-related flag on the same row) is what's documented here per the
 * Phase 9 "document the counting behavior" requirement.
 *
 * SUMMARY COUNTING (`summarize()`): UNIQUE PLAYERS PER CATEGORY, per the
 * Phase 9 requirement — each of the returned counters independently
 * counts "how many selected rows have this particular flag true", not a
 * mutually-exclusive bucket partition of the whole selection. A row with
 * both `positionIssue` and `dataIssue` increments both `positionIssues`
 * and `dataIssues` by exactly one each (never twice within the same
 * counter — each counter is a single pass incrementing by at most 1 per
 * row). `ready` and the six issue counters together can therefore sum to
 * MORE than `total` when rows have multiple simultaneous issues; that is
 * expected and is why `total - ready` (not a sum of the issue counters)
 * is the correct "Issues" figure for the overall status line.
 */
const Nba2k27PoolValidator = {
  // Reuses the exact required-field checks already enforced at
  // nba2k_players import time (see file header) — never invents a new
  // required-field list for this collection.
  _dataIssue(p) {
    const hasName = typeof p.name === 'string' && p.name.trim().length > 0;
    const hasTeam = typeof p.team === 'string' && p.team.trim().length > 0;
    const overallNum = Number(p.overall);
    const hasValidOvr = p.overall !== undefined && p.overall !== null && !isNaN(overallNum);
    return !hasName || !hasTeam || !hasValidOvr;
  },

  // Reuses NBA2K_VALID_POSITIONS + normalizeNba2kPositions (Phase 6) —
  // see file header "ONE RULE EXTENDED, NOT INVENTED FROM SCRATCH" for
  // why the raw-array whitelist check is also needed here.
  _positionIssue(p) {
    const raw = Array.isArray(p.positions) ? p.positions : [];
    const normalized = normalizeNba2kPositions(p.positions);
    const hasInvalidValue = raw.some(v => !NBA2K_VALID_POSITIONS.includes(v));
    return normalized.length === 0 || hasInvalidValue;
  },

  // Classifies one row from `Nba2k27PoolView._buildRows()`. Never
  // mutates `row`; returns a new object (`row` spread, plus `issues`,
  // `ready`, `expectedPool`).
  classify(row) {
    const issues = {
      orphaned: false,
      unknownPoolEligibility: false,
      invalidStoredPool: false,
      poolMismatch: false,
      positionIssue: false,
      dataIssue: false,
    };

    if (row.orphan || !row.player) {
      issues.orphaned = true;
      return { ...row, issues, ready: false, expectedPool: null };
    }

    const p = row.player;
    issues.dataIssue = this._dataIssue(p);
    issues.positionIssue = this._positionIssue(p);

    // Pool validation — see file header for the fixed priority order.
    const derivedPool = nba2kPoolForTeamType(p.teamType);
    let expectedPool = derivedPool;
    if (!derivedPool) {
      issues.unknownPoolEligibility = true;
    } else if (!row.poolValid) {
      issues.invalidStoredPool = true;
    } else if (row.poolValue !== derivedPool) {
      issues.poolMismatch = true;
    }

    const ready = !Object.values(issues).some(Boolean);
    return { ...row, issues, ready, expectedPool };
  },

  classifyAll(rows) {
    return rows.map(r => this.classify(r));
  },

  // See file header "SUMMARY COUNTING" for exactly what these count.
  summarize(classifiedRows) {
    const counts = {
      total: classifiedRows.length,
      ready: 0,
      positionIssues: 0,
      dataIssues: 0,
      poolMismatches: 0,
      orphaned: 0,
      invalidPool: 0,
      unknownPoolEligibility: 0,
    };
    for (const r of classifiedRows) {
      if (r.ready) counts.ready++;
      if (r.issues.positionIssue) counts.positionIssues++;
      if (r.issues.dataIssue) counts.dataIssues++;
      if (r.issues.poolMismatch) counts.poolMismatches++;
      if (r.issues.orphaned) counts.orphaned++;
      if (r.issues.invalidStoredPool) counts.invalidPool++;
      if (r.issues.unknownPoolEligibility) counts.unknownPoolEligibility++;
    }
    return counts;
  },
};

const Nba2k27PoolView = {
  _search: '',
  _filterCategory: '', // '' = All, else 'curr' | 'class' | 'allt'
  _filterPool: '',     // '' = All Pools, else 'green' | 'blue'
  _sortMode: 'ovr-desc',

  // Phase 9: last computed validation report (null until "Validate 2K27
  // Pool" is clicked, or after a pool-changing write invalidates it —
  // see `_onPool27Changed` below). `{ classified, summary }`, both plain
  // data produced by `Nba2k27PoolValidator` — never persisted anywhere.
  _validation: null,
  _issueFilter: '', // '' = All, 'ready', or an `issues` key from the validator

  async render(container) {
    if (!Nba2kDatabaseView._players) {
      container.innerHTML = `
        <div class="admin-section">
          <div class="admin-section-header"><h2>NBA 2K27 Pool</h2></div>
          <p class="backup-muted">Loading NBA 2K27 pool…</p>
        </div>`;
      await Nba2kDatabaseView._ensureLoaded();
      // The admin may have navigated to a different view while this was
      // in flight — only render if this view's container is still live.
      if (!document.body.contains(container)) return;
    }
    this._renderShell(container);
  },

  // Joins `nba2k27_pool` entries to their `nba2k_players` source record
  // by `nba2kRef === slug` (slug is the doc id on both sides). Never
  // mutates either cache; never copies player fields into a pool27
  // object — the join is recomputed fresh on every render.
  _buildRows() {
    const pool27 = Nba2kDatabaseView._pool27 || {};
    const playersById = new Map((Nba2kDatabaseView._players || []).map(p => [p.id, p]));
    return Object.keys(pool27).map(slug => {
      const entry = pool27[slug] || {};
      const player = playersById.get(slug) || null;
      const poolValid = entry.pool === 'green' || entry.pool === 'blue';
      return {
        slug,
        entry,
        player,
        orphan: !player,
        poolValue: entry.pool,
        poolValid,
        category: player ? player.teamType : null,
      };
    });
  },

  // All counts are derived fresh from the current caches on every call —
  // never hardcoded, never stored as separate persisted state.
  _computeCounts(rows, totalSourcePlayers) {
    let green = 0, blue = 0;
    const categoryCounts = { curr: 0, class: 0, allt: 0 };
    for (const r of rows) {
      if (r.poolValue === 'green') green++;
      else if (r.poolValue === 'blue') blue++;
      if (r.category && Object.prototype.hasOwnProperty.call(categoryCounts, r.category)) {
        categoryCounts[r.category]++;
      }
    }
    const total = rows.length;
    return {
      total,
      green,
      blue,
      // "Available" = source players not yet selected for 2K27.
      available: Math.max(0, totalSourcePlayers - total),
      categoryCounts,
    };
  },

  // Category + Pool filters, then search (player name / NBA team), then
  // sort — every filter combines via the same AND chain, matching the
  // existing NBA2K Database view's filtering pattern.
  _getVisibleRows(rows) {
    const q = this._search.trim().toLowerCase();

    let list = rows.filter(r => {
      if (this._filterCategory && r.category !== this._filterCategory) return false;
      if (this._filterPool) {
        // Never reinterpret an invalid stored pool as a match for a
        // specific pool filter — see file header, "Data integrity".
        if (!r.poolValid || r.poolValue !== this._filterPool) return false;
      }
      if (q) {
        // Orphaned entries have no source name/team to search against.
        if (!r.player) return false;
        const hay = `${r.player.name || ''} ${r.player.team || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    list = list.slice().sort((a, b) => {
      // Rows with no matched source player have nothing to sort by —
      // push them to the end regardless of direction, rather than
      // letting a missing value silently win or lose a comparison.
      if (!a.player && !b.player) return 0;
      if (!a.player) return 1;
      if (!b.player) return -1;
      switch (this._sortMode) {
        case 'ovr-asc': return (a.player.overall ?? 0) - (b.player.overall ?? 0);
        case 'name-asc': return (a.player.name || '').localeCompare(b.player.name || '');
        case 'name-desc': return (b.player.name || '').localeCompare(a.player.name || '');
        case 'team-asc': return (a.player.team || '').localeCompare(b.player.team || '');
        case 'team-desc': return (b.player.team || '').localeCompare(a.player.team || '');
        case 'ovr-desc':
        default: return (b.player.overall ?? 0) - (a.player.overall ?? 0);
      }
    });

    return list;
  },

  _renderShell(container) {
    if (Nba2kDatabaseView._loadError) {
      container.innerHTML = `
        <div class="admin-section">
          <div class="admin-section-header"><h2>NBA 2K27 Pool</h2></div>
          <div class="backup-result backup-result-error">${escapeHtml(Nba2kDatabaseView._loadError)}</div>
        </div>`;
      return;
    }

    const players = Nba2kDatabaseView._players || [];
    const rows = this._buildRows();

    if (rows.length === 0) {
      container.innerHTML = `
        <div class="admin-section nba2k-db">
          <div class="admin-section-header"><h2>NBA 2K27 Pool</h2></div>
          <p class="backup-muted">
            No NBA 2K27 players selected yet.<br>
            Select players from the NBA2K Database to build your NBA 2K27 pool.
          </p>
        </div>`;
      return;
    }

    const counts = this._computeCounts(rows, players.length);
    const issueCount = rows.filter(r => r.orphan || !r.poolValid).length;

    const categoryTabs = [
      { value: '', label: `All (${counts.total})` },
      { value: 'curr', label: `Current (${counts.categoryCounts.curr})` },
      { value: 'class', label: `Classics (${counts.categoryCounts.class})` },
      { value: 'allt', label: `All-Time (${counts.categoryCounts.allt})` },
    ].filter(t => t.value === '' || counts.categoryCounts[t.value] > 0);

    container.innerHTML = `
      <div class="admin-section nba2k-db">
        <div class="admin-section-header"><h2>NBA 2K27 Pool</h2></div>
        <p class="nba2k-db-subtitle">Preparation pool for the future NBA 2K27 season</p>

        <div class="nba2k27-summary">
          <span class="nba2k27-summary-title">NBA 2K27 Pool</span>
          <span class="nba2k27-summary-stat">Total Selected: <strong>${counts.total}</strong></span>
          <span class="nba2k27-summary-stat">🟢 Green: <strong>${counts.green}</strong></span>
          <span class="nba2k27-summary-stat">🔵 Blue: <strong>${counts.blue}</strong></span>
          <span class="nba2k27-summary-stat">Available: <strong>${counts.available}</strong></span>
          ${issueCount > 0 ? `<span class="nba2k27-summary-stat nba2k27mgmt-summary-warn">⚠ Data issues: <strong>${issueCount}</strong></span>` : ''}
        </div>

        <div class="nba2k27val-panel">
          <button type="button" class="btn btn-primary" id="nba2k27ValidateBtn">Validate 2K27 Pool</button>
          <div id="nba2k27ValResult"></div>
        </div>

        <div class="nba2k-category-tabs" role="tablist" aria-label="Filter by category">
          ${categoryTabs.map(t => `
            <button type="button" class="btn ${this._filterCategory === t.value ? 'btn-primary' : 'btn-ghost'} btn-sm nba2k27mgmt-category-tab"
              data-category="${escapeHtml(t.value)}" aria-pressed="${this._filterCategory === t.value}">${escapeHtml(t.label)}</button>
          `).join('')}
        </div>

        <div class="table-controls nba2k-controls">
          <input type="text" id="nba2k27mgmtSearch" class="input search-input"
            placeholder="Search by player or team…" value="${escapeHtml(this._search)}">

          <select id="nba2k27mgmtPoolFilter" class="input">
            <option value="" ${this._filterPool === '' ? 'selected' : ''}>All Pools</option>
            <option value="green" ${this._filterPool === 'green' ? 'selected' : ''}>🟢 Green</option>
            <option value="blue" ${this._filterPool === 'blue' ? 'selected' : ''}>🔵 Blue</option>
          </select>

          <select id="nba2k27mgmtSort" class="input" style="max-width:220px;">
            <option value="ovr-desc" ${this._sortMode === 'ovr-desc' ? 'selected' : ''}>Sort: OVR (High–Low)</option>
            <option value="ovr-asc" ${this._sortMode === 'ovr-asc' ? 'selected' : ''}>Sort: OVR (Low–High)</option>
            <option value="name-asc" ${this._sortMode === 'name-asc' ? 'selected' : ''}>Sort: Name (A–Z)</option>
            <option value="name-desc" ${this._sortMode === 'name-desc' ? 'selected' : ''}>Sort: Name (Z–A)</option>
            <option value="team-asc" ${this._sortMode === 'team-asc' ? 'selected' : ''}>Sort: Team (A–Z)</option>
            <option value="team-desc" ${this._sortMode === 'team-desc' ? 'selected' : ''}>Sort: Team (Z–A)</option>
          </select>
        </div>

        <div id="nba2k27mgmtConfirm" class="hidden"></div>
        <div id="nba2k27mgmtListWrap"></div>
      </div>
      <div id="nba2kDetailMount"></div>`;

    container.querySelectorAll('.nba2k27mgmt-category-tab').forEach(btn => {
      btn.onclick = () => { this._filterCategory = btn.dataset.category; this._renderShell(container); };
    });
    container.querySelector('#nba2k27mgmtSearch').oninput = e => { this._search = e.target.value; this._refreshList(container); };
    container.querySelector('#nba2k27mgmtPoolFilter').onchange = e => { this._filterPool = e.target.value; this._refreshList(container); };
    container.querySelector('#nba2k27mgmtSort').onchange = e => { this._sortMode = e.target.value; this._refreshList(container); };
    container.querySelector('#nba2k27ValidateBtn').onclick = () => this._runValidation(container);

    // Whenever the shared detail modal's own 2K27 Add/Remove buttons
    // (Phase 7, `Nba2kDatabaseView._bind2k27Events`) write to
    // `nba2k27_pool`, refresh this view too — same cache, no re-fetch.
    // Overwritten harmlessly on every render of this view; guarded by
    // `document.body.contains(container)` in case this view has since
    // been navigated away from while its modal was still open.
    Nba2kDatabaseView._onPool27Changed = () => {
      if (!document.body.contains(container)) return;
      this._refreshList(container);
      // Phase 9: the selection set just changed underneath a previously
      // computed validation report — that report is now stale data, not
      // a re-derivable view, so it is discarded rather than silently
      // left on screen. The commissioner must explicitly re-validate.
      if (this._validation) {
        this._validation = null;
        this._issueFilter = '';
        const resultEl = container.querySelector('#nba2k27ValResult');
        if (resultEl) {
          resultEl.innerHTML = `<p class="helper-text">Pool selections changed — click "Validate 2K27 Pool" again to refresh this report.</p>`;
        }
      }
    };

    this._refreshList(container);
    this._renderValidationResult(container);
  },

  _refreshList(container) {
    const wrap = container.querySelector('#nba2k27mgmtListWrap');
    if (!wrap) return;

    const rows = this._buildRows();
    const visible = this._getVisibleRows(rows);

    if (!visible.length) {
      wrap.innerHTML = `<p class="backup-muted">No players match these filters.</p>`;
      return;
    }

    wrap.innerHTML = `
      <table class="admin-table nba2k27mgmt-table">
        <thead>
          <tr>
            <th>Player</th>
            <th>OVR</th>
            <th>Position</th>
            <th>NBA Team</th>
            <th>Category</th>
            <th>Pool</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          ${visible.map(r => this._renderRow(r)).join('')}
        </tbody>
      </table>`;

    wrap.querySelectorAll('.nba2k27mgmt-row').forEach(row => {
      const slug = row.dataset.slug;
      const rowData = visible.find(r => r.slug === slug);
      if (!rowData || rowData.orphan) return; // no source record to show a detail modal for
      const open = () => Nba2kDatabaseView._openDetail(container, slug);
      row.addEventListener('click', e => {
        if (e.target.closest('.nba2k27mgmt-remove-btn')) return;
        open();
      });
      row.addEventListener('keydown', e => {
        if (e.target.closest('.nba2k27mgmt-remove-btn')) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      });
    });

    wrap.querySelectorAll('.nba2k27mgmt-remove-btn').forEach(btn => {
      btn.onclick = e => {
        e.stopPropagation();
        const slug = btn.dataset.slug;
        const rowData = this._buildRows().find(r => r.slug === slug);
        if (rowData) this._showRemoveConfirm(container, rowData);
      };
    });
  },

  _renderPoolCell(row) {
    if (row.poolValid) {
      const label = row.poolValue === 'green' ? 'GREEN' : 'BLUE';
      const dot = row.poolValue === 'green' ? '🟢' : '🔵';
      return `<span class="nba2k27mgmt-pool nba2k27mgmt-pool-${row.poolValue}">${dot} ${label}</span>`;
    }
    // Never silently converted/guessed — see file header, "Data integrity".
    return `<span class="nba2k27mgmt-pool nba2k27mgmt-pool-invalid">⚠ Invalid Pool</span>`;
  },

  _renderRow(row) {
    if (row.orphan) {
      return `
        <tr class="nba2k27mgmt-row nba2k27mgmt-row-orphan" data-slug="${escapeHtml(row.slug)}">
          <td data-label="Player" class="nba2k27mgmt-cell-player">
            <code>${escapeHtml(row.slug)}</code>
            <div class="nba2k27mgmt-orphan-warning">⚠ Source player not found</div>
          </td>
          <td data-label="OVR">—</td>
          <td data-label="Position">—</td>
          <td data-label="NBA Team">—</td>
          <td data-label="Category">—</td>
          <td data-label="Pool">${this._renderPoolCell(row)}</td>
          <td data-label="Action">
            <button type="button" class="btn btn-ghost btn-sm nba2k27mgmt-remove-btn" data-slug="${escapeHtml(row.slug)}">Remove</button>
          </td>
        </tr>`;
    }

    const p = row.player;
    const ovr = Number(p.overall) || 0;
    const positions = Array.isArray(p.positions) && p.positions.length ? p.positions.join(', ') : '—';
    const categoryLabel = nba2kCategoryLabel(p.teamType);
    return `
      <tr class="nba2k27mgmt-row" data-slug="${escapeHtml(row.slug)}" tabindex="0" role="button" aria-label="View ${escapeHtml(p.name)} details">
        <td data-label="Player" class="nba2k27mgmt-cell-player">${escapeHtml(p.name)}</td>
        <td data-label="OVR"><span class="pos-ovr ${nba2kOvrTierClass(ovr)}">${ovr}</span></td>
        <td data-label="Position">${escapeHtml(positions)}</td>
        <td data-label="NBA Team">${escapeHtml(p.team || '—')}</td>
        <td data-label="Category"><span class="nba2k-category-chip nba2k-category-chip-${escapeHtml(p.teamType || 'other')}">${escapeHtml(categoryLabel.toUpperCase())}</span></td>
        <td data-label="Pool">${this._renderPoolCell(row)}</td>
        <td data-label="Action">
          <button type="button" class="btn btn-ghost btn-sm nba2k27mgmt-remove-btn" data-slug="${escapeHtml(row.slug)}">Remove</button>
        </td>
      </tr>`;
  },

  // Confirmed removal — deletes ONLY `nba2k27_pool/<slug>`. Never
  // touches `nba2k_players`, `league/main`, or any Draft Pool player;
  // same write shape as the Phase 7 remove path in the shared detail
  // modal (see file header, "Writes — removal only").
  _showRemoveConfirm(container, row) {
    const confirmEl = container.querySelector('#nba2k27mgmtConfirm');
    if (!confirmEl) return;
    const label = row.player ? row.player.name : row.slug;

    confirmEl.classList.remove('hidden');
    confirmEl.innerHTML = `
      <div class="nba2k-promo-confirm-card">
        <div class="nba2k-promo-eyebrow">Remove from NBA 2K27 Pool?</div>
        <div class="nba2k-promo-confirm-row"><span>Player</span><strong>${escapeHtml(label)}</strong></div>
        <p class="helper-text">This will remove only the NBA 2K27 pool selection. It will NOT:</p>
        <ul class="nba2k27mgmt-remove-caveats">
          <li>delete the player from <code>nba2k_players</code></li>
          <li>affect the Draft Pool</li>
          <li>affect Season 4</li>
          <li>affect <code>league/main</code></li>
          <li>affect any roster</li>
        </ul>
        <div class="form-actions">
          <button type="button" class="btn btn-danger" id="nba2k27mgmtConfirmRemoveBtn">Remove</button>
          <button type="button" class="btn btn-ghost" id="nba2k27mgmtCancelRemoveBtn">Cancel</button>
        </div>
      </div>`;

    confirmEl.querySelector('#nba2k27mgmtCancelRemoveBtn').onclick = () => {
      confirmEl.classList.add('hidden');
      confirmEl.innerHTML = '';
    };

    const confirmBtn = confirmEl.querySelector('#nba2k27mgmtConfirmRemoveBtn');
    confirmBtn.onclick = async () => {
      AuthBoundary.requireAuth();
      confirmBtn.disabled = true;
      try {
        await firebase.firestore().collection('nba2k27_pool').doc(row.slug).delete();
        if (Nba2kDatabaseView._pool27) delete Nba2kDatabaseView._pool27[row.slug];
        showToast(`${label} removed from the 2K27 pool.`, 'success');
        confirmEl.classList.add('hidden');
        confirmEl.innerHTML = '';
        this._refreshList(container);
        // Phase 9: this removal changed the selection set too — same
        // staleness reasoning as the `_onPool27Changed` hook above.
        if (this._validation) {
          this._validation = null;
          this._issueFilter = '';
          const resultEl = container.querySelector('#nba2k27ValResult');
          if (resultEl) {
            resultEl.innerHTML = `<p class="helper-text">Pool selections changed — click "Validate 2K27 Pool" again to refresh this report.</p>`;
          }
        }
      } catch (err) {
        confirmBtn.disabled = false;
        const msg = err && err.code === 'permission-denied'
          ? "You don't have permission to update the 2K27 pool."
          : 'Could not remove this player from the 2K27 pool — please try again.';
        confirmEl.innerHTML += `<div class="backup-result backup-result-error">${escapeHtml(msg)}</div>`;
      }
    };
  },

  // ── Phase 9: NBA 2K27 Pool Validation & Readiness ───────────────────
  // Everything below reads `this._buildRows()` (already-cached data,
  // zero Firestore access) and `Nba2k27PoolValidator` (pure functions,
  // zero Firestore access). Nothing in this section ever calls `.set()`,
  // `.update()`, `.delete()`, or `.add()` on any collection — see the
  // `Nba2k27PoolValidator` file header for the full read-only rationale.

  _runValidation(container) {
    const rows = this._buildRows();
    const classified = Nba2k27PoolValidator.classifyAll(rows);
    const summary = Nba2k27PoolValidator.summarize(classified);
    this._validation = { classified, summary };
    this._issueFilter = '';
    this._renderValidationResult(container);
  },

  _renderValidationResult(container) {
    const resultEl = container.querySelector('#nba2k27ValResult');
    if (!resultEl) return;

    if (!this._validation) {
      resultEl.innerHTML = '';
      return;
    }

    const { summary } = this._validation;
    const overallReady = summary.total > 0 && summary.ready === summary.total;

    const filterDefs = [
      { value: '', label: `All (${summary.total})` },
      { value: 'ready', label: `✅ Ready (${summary.ready})` },
      { value: 'positionIssue', label: `⚠️ Position Issues (${summary.positionIssues})` },
      { value: 'dataIssue', label: `⚠️ Data Issues (${summary.dataIssues})` },
      { value: 'poolMismatch', label: `❌ Pool Mismatch (${summary.poolMismatches})` },
      { value: 'invalidStoredPool', label: `❌ Invalid Pool (${summary.invalidPool})` },
      { value: 'unknownPoolEligibility', label: `❌ Unknown Eligibility (${summary.unknownPoolEligibility})` },
      { value: 'orphaned', label: `❌ Orphaned (${summary.orphaned})` },
    ];

    resultEl.innerHTML = `
      <div class="nba2k27val-summary-card">
        <div class="nba2k27val-status ${overallReady ? 'nba2k27val-status-ready' : 'nba2k27val-status-not-ready'}">
          ${overallReady ? '✅ READY' : '⚠️ NOT READY'}
        </div>
        <div class="nba2k27val-stats">
          <span>Selected Players: <strong>${summary.total}</strong></span>
          <span>Ready: <strong>${summary.ready}</strong></span>
          <span>Issues: <strong>${summary.total - summary.ready}</strong></span>
        </div>
        <div class="nba2k27val-breakdown">
          <div>⚠️ Position Issues <strong>${summary.positionIssues}</strong></div>
          <div>⚠️ Data Issues <strong>${summary.dataIssues}</strong></div>
          <div>❌ Pool Mismatches <strong>${summary.poolMismatches}</strong></div>
          <div>❌ Invalid Stored Pool <strong>${summary.invalidPool}</strong></div>
          <div>❌ Unknown Pool Eligibility <strong>${summary.unknownPoolEligibility}</strong></div>
          <div>❌ Orphaned Selections <strong>${summary.orphaned}</strong></div>
        </div>
      </div>

      <div class="nba2k-category-tabs" role="tablist" aria-label="Filter by validation issue">
        ${filterDefs.map(f => `
          <button type="button" class="btn ${this._issueFilter === f.value ? 'btn-primary' : 'btn-ghost'} btn-sm nba2k27val-issue-tab"
            data-issue="${escapeHtml(f.value)}">${escapeHtml(f.label)}</button>
        `).join('')}
      </div>

      <div id="nba2k27ValIssueListWrap"></div>`;

    resultEl.querySelectorAll('.nba2k27val-issue-tab').forEach(btn => {
      btn.onclick = () => { this._issueFilter = btn.dataset.issue; this._refreshIssueList(container); };
    });

    this._refreshIssueList(container);
  },

  // '' = all rows in the last report; 'ready' = only ready rows; any
  // other value = rows whose `issues[value]` flag is true.
  _getFilteredClassified() {
    if (!this._validation) return [];
    const { classified } = this._validation;
    if (!this._issueFilter) return classified;
    if (this._issueFilter === 'ready') return classified.filter(r => r.ready);
    return classified.filter(r => r.issues[this._issueFilter]);
  },

  _issueLabels(row) {
    if (row.ready) return 'Ready';
    const labels = [];
    if (row.issues.orphaned) labels.push('Orphaned');
    if (row.issues.unknownPoolEligibility) labels.push('Unknown Pool Eligibility');
    if (row.issues.invalidStoredPool) labels.push('Invalid Stored Pool');
    if (row.issues.poolMismatch) labels.push('Pool Mismatch');
    if (row.issues.positionIssue) labels.push('Position Issue');
    if (row.issues.dataIssue) labels.push('Data Issue');
    return labels.join(', ');
  },

  _renderIssueRow(row) {
    const storedPoolLabel = row.poolValid
      ? (row.poolValue === 'green' ? 'Green' : 'Blue')
      : (row.poolValue ? `Invalid (${row.poolValue})` : '—');
    const expectedPoolLabel = row.expectedPool ? (row.expectedPool === 'green' ? 'Green' : 'Blue') : '—';

    if (row.orphan) {
      return `
        <tr>
          <td data-label="Player"><code>${escapeHtml(row.slug)}</code></td>
          <td data-label="OVR">—</td>
          <td data-label="Position">—</td>
          <td data-label="NBA Team">—</td>
          <td data-label="Category">—</td>
          <td data-label="Stored Pool">${escapeHtml(storedPoolLabel)}</td>
          <td data-label="Expected Pool">—</td>
          <td data-label="Issue">${escapeHtml(this._issueLabels(row))}</td>
          <td data-label="Action">—</td>
        </tr>`;
    }

    const p = row.player;
    const overallValid = p.overall !== undefined && p.overall !== null && !isNaN(Number(p.overall));
    const ovrDisplay = overallValid ? Number(p.overall) : (p.overall === undefined || p.overall === null ? '—' : escapeHtml(String(p.overall)));
    const positions = Array.isArray(p.positions) && p.positions.length ? p.positions.join(', ') : '—';
    const categoryLabel = p.teamType ? nba2kCategoryLabel(p.teamType) : '—';

    return `
      <tr>
        <td data-label="Player">${escapeHtml(p.name || row.slug)}</td>
        <td data-label="OVR">${ovrDisplay}</td>
        <td data-label="Position">${escapeHtml(positions)}</td>
        <td data-label="NBA Team">${escapeHtml(p.team || '—')}</td>
        <td data-label="Category">${escapeHtml(categoryLabel)}</td>
        <td data-label="Stored Pool">${escapeHtml(storedPoolLabel)}</td>
        <td data-label="Expected Pool">${escapeHtml(expectedPoolLabel)}</td>
        <td data-label="Issue">${escapeHtml(this._issueLabels(row))}</td>
        <td data-label="Action">
          ${row.ready
            ? '—'
            : `<button type="button" class="btn btn-ghost btn-sm nba2k27val-review-btn" data-slug="${escapeHtml(row.slug)}">Review</button>`}
        </td>
      </tr>`;
  },

  _refreshIssueList(container) {
    const wrap = container.querySelector('#nba2k27ValIssueListWrap');
    if (!wrap) return;

    const rows = this._getFilteredClassified();
    if (!rows.length) {
      wrap.innerHTML = `<p class="backup-muted">No players match this filter.</p>`;
      return;
    }

    wrap.innerHTML = `
      <table class="admin-table nba2k27mgmt-table">
        <thead>
          <tr>
            <th>Player</th>
            <th>OVR</th>
            <th>Position</th>
            <th>NBA Team</th>
            <th>Category</th>
            <th>Stored Pool</th>
            <th>Expected Pool</th>
            <th>Issue</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(r => this._renderIssueRow(r)).join('')}
        </tbody>
      </table>`;

    // Reuses the existing shared detail modal (Phase 2/6/7, untouched)
    // so the commissioner corrects positions through the one existing
    // Position Management editor — this view never creates a second one.
    wrap.querySelectorAll('.nba2k27val-review-btn').forEach(btn => {
      btn.onclick = () => Nba2kDatabaseView._openDetail(container, btn.dataset.slug);
    });
  },
};
