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

  async _load(container) {
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
    await this._loadPromise;
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
