/**
 * views/nba2k27.js — Phase 11: Public, read-only NBA 2K27 Player View.
 *
 * PURPOSE
 * Lets league participants browse and inspect NBA2K player data for
 * players currently selected in the NBA 2K27 pool (Phase 7/10), ahead of
 * the eventual 2K27 draft/migration. Entirely VIEW-ONLY — see "READ-ONLY
 * GUARANTEE" below.
 *
 * AUDIT FINDINGS (read before changing anything here)
 * - There was no existing public NBA2K/2K27 UI anywhere in the
 *   repository prior to this phase (confirmed: no "nba2k"/"2k27"
 *   reference in any js/views/*.js, public-router.js, shell.js, or
 *   index.html). This file and its route are new, not an extension of
 *   something that already existed publicly.
 * - A top-level `js/nba2k-database.js` (612 lines, Phase 2/3-era
 *   content) exists in the repository but is NOT loaded by index.html
 *   OR admin.html — dead code, unrelated to this phase, left exactly as
 *   found. Do not confuse it with `js/admin/nba2k-database.js`, which
 *   IS the real, current, Phase 2–10 admin NBA2K module and remains the
 *   authoritative reference for the field names/behavior this file
 *   mirrors on the public side.
 * - `nba2k_players` and `nba2k27_pool` are ordinary top-level Firestore
 *   collections, completely separate from `league/main` (the single
 *   document `FirebaseSync`/`LeagueData` — data.js — read/write for
 *   every S4 Draft Pool feature). This file never touches `LeagueData`,
 *   `FirebaseSync`, or `league/main` in any way.
 * - The public site (index.html) has no Firebase Auth integration at
 *   all — confirmed in index.html's own script-loading comment ("Public
 *   site: read-only, no auth SDK piece needed here"). The existing rule
 *   `nba2k_players: allow read, write: if request.auth != null` (see
 *   js/admin/nba2k-database.js's own header) therefore genuinely blocks
 *   ALL public reads of that collection today, including this file's.
 *
 * PUBLIC DATA ARCHITECTURE (the central design decision of this phase)
 * The brief's "Option A" — expose only the players currently selected
 * for 2K27, keep the full admin source collection protected — is
 * implemented WITHOUT a new collection and WITHOUT any new write path,
 * via a security-RULE-level join instead of a data-mirroring one:
 *
 *   match /nba2k27_pool/{slug} {
 *     allow read: if true;                    // no sensitive fields — see below
 *     allow write: if request.auth != null;   // UNCHANGED from Phase 7
 *   }
 *   match /nba2k_players/{slug} {
 *     // UNCHANGED write rule. Read is now also granted when — and ONLY
 *     // when — this exact slug is currently selected in nba2k27_pool.
 *     allow read: if request.auth != null
 *       || exists(/databases/$(database)/documents/nba2k27_pool/$(slug));
 *     allow write: if request.auth != null;   // UNCHANGED from Phase 1
 *   }
 *
 * Why this, over a mirrored public collection: a mirror would need every
 * Phase 7 (individual add) and Phase 10 (bulk initialize) write path to
 * ALSO write a public copy of the full player record on every add/
 * correct, which the brief explicitly asks to leave "exactly" preserved
 * — and a stale mirror is exactly how "Phase 6 position correction must
 * appear publicly" (a hard requirement below) would silently break. The
 * rule-level join instead always reads the live `nba2k_players` document
 * — so a Phase 6 position edit is visible here immediately — while an
 * unselected player's document stays completely inaccessible to any
 * public request, with ZERO changes to any existing admin write path.
 * `nba2k27_pool` documents contain no attributes/badges/physicals/
 * positions/images (see Phase 7's own doc-shape comment) — only
 * `{ nba2kRef, pool, selectedAt, updatedAt }` — so making that one
 * collection fully public reveals nothing beyond "this slug is
 * selected, for this pool, as of this timestamp," which is exactly the
 * information this whole feature exists to surface publicly anyway.
 *
 * `firestore.rules` is NOT tracked in this repository (confirmed by
 * inspection, same finding as every prior NBA2K phase's audit) — per
 * the Phase 11 brief, this file therefore does NOT invent a rules file.
 * The rule above must be applied by hand in the Firebase Console before
 * this feature can actually return data in production. Until it is,
 * every read below fails closed (see `_ensureLoaded`/`_loadError`) and
 * the page shows an explanatory empty state — it never crashes and
 * never falls back to guessing at data.
 *
 * READ-ONLY GUARANTEE
 * This file contains NO `.set(`, `.update(`, `.delete(`, `.add(`, or
 * batch/write call of any kind, and never references `AdminActions`,
 * `AuthBoundary`, or `FirebaseSync.save`. It only ever calls `.get()`
 * on `nba2k27_pool` and `nba2k_players`. Clicking "View Player",
 * opening/closing the detail modal, and searching/filtering/sorting all
 * operate purely on the in-memory cache built once per page load — none
 * of them touch Firestore again afterward.
 *
 * PERFORMANCE / LOAD PATTERN
 * One `.get()` on the (typically small) `nba2k27_pool` collection, then
 * the corresponding `nba2k_players` documents ONLY — never the full
 * ~1,757-player source collection — fetched via chunked `where(
 * FieldPath.documentId(), 'in', chunk)` queries (`in` queries are
 * limited to 10 comparison values per query in the Firestore compat SDK
 * used by this project — see `NBA2K27_PUBLIC_CHUNK_SIZE`). Both results
 * are cached at module scope for the lifetime of the page load, exactly
 * like `js/admin/nba2k-database.js`'s own `_players`/`_pool27` cache —
 * search, filter, sort, and opening/closing the detail modal never
 * re-fetch. In the worst case (every source player selected), this is
 * on the order of ~176 requests made once at first page load, not
 * "hundreds of requests without reason" repeated per interaction.
 *
 * SHARED RENDERING DESIGN, INTENTIONALLY DUPLICATED (not imported) FROM
 * js/admin/nba2k-database.js: `NBA2K_ATTRIBUTE_GROUPS` (attribute
 * grouping/labels), `NBA2K_BADGE_TIER_ORDER` (badge tier order/
 * dedup-by-tier), and the OVR/attribute tier-class thresholds are
 * byte-for-byte identical to that file's own copies, so this page's
 * attribute bars and badge chips group and tier exactly the way the
 * admin detail modal's already do. They are duplicated, not imported,
 * because index.html cannot load js/admin/nba2k-database.js itself: it
 * both depends on `AuthBoundary`/`AdminActions` (undefined on the public
 * page — it would throw immediately) and contains the Position
 * Management editor, 2K27 Pool add/remove, and Draft Pool promotion UI,
 * none of which this read-only page may ever expose. If the admin
 * file's attribute grouping or badge tiers ever change, this block must
 * be updated to match by hand — flagged here for exactly that reason.
 * The Phase 10 pool label/dot metadata (`NBA2K27_POOL_META`) is
 * similarly duplicated from that file. `nba2kPoolForTeamType()` /
 * `nba2k27PoolForTeamType()` (teamType -> pool DERIVATION) are
 * deliberately NOT duplicated here: this page only ever DISPLAYS the
 * pool value already stored in `nba2k27_pool`, never re-derives one —
 * the exact same "stored pool is authoritative" rule Phase 8/9 already
 * follow.
 *
 * PRESERVATION OF PHASES 6–10 (all unmodified by this file)
 * - Phase 6 (position editor): this file only ever reads
 *   `nba2k_players/<slug>.positions` as currently stored — never edits
 *   it, so a commissioner's correction appears here automatically on
 *   next load with no code change needed.
 * - Phase 7 (pool selection): read-only join against `nba2k27_pool`;
 *   never adds/removes/writes a selection.
 * - Phase 8 (pool management): the admin page is untouched; this is an
 *   entirely separate, public-only view, not a relocation of it.
 * - Phase 9 (validator): never validates, repairs, or rewrites anything.
 * - Phase 10 (initialization): never initializes/modifies the pool;
 *   displays whatever the existing Current/All-Time/Classics ->
 *   Green/Blue/White mapping already produced.
 */

// Firestore 'in' queries (used here to fetch exactly the selected
// players' source documents by ID, and nothing else) are limited to 10
// comparison values per query in the compat SDK — chunk to that limit
// rather than assuming today's dataset size.
const NBA2K27_PUBLIC_CHUNK_SIZE = 10;

// ── Duplicated presentation design from js/admin/nba2k-database.js ─────
// See file header "SHARED RENDERING DESIGN" for why these are copied
// rather than imported. Keep these in sync with that file by hand.
const PUBLIC_NBA2K_CATEGORY_LABELS = { curr: 'Current', class: 'Classics', allt: 'All-Time' };
function publicNba2kCategoryLabel(teamType) {
  return PUBLIC_NBA2K_CATEGORY_LABELS[teamType] || teamType || 'Unknown';
}

const PUBLIC_NBA2K_ATTRIBUTE_GROUPS = [
  {
    title: 'Finishing',
    keys: [
      ['closeShot', 'Close Shot'], ['layup', 'Driving Layup'], ['drivingDunk', 'Driving Dunk'],
      ['standingDunk', 'Standing Dunk'], ['postHook', 'Post Hook'], ['postFade', 'Post Fade'],
      ['postControl', 'Post Control'], ['drawFoul', 'Draw Foul'], ['hands', 'Hands'],
    ],
  },
  {
    title: 'Shooting',
    keys: [
      ['midRangeShot', 'Mid-Range Shot'], ['threePointShot', 'Three-Point Shot'],
      ['freeThrow', 'Free Throw'], ['shotIQ', 'Shot IQ'], ['offensiveConsistency', 'Offensive Consistency'],
    ],
  },
  {
    title: 'Playmaking',
    keys: [
      ['passAccuracy', 'Pass Accuracy'], ['ballHandle', 'Ball Handle'], ['speedWithBall', 'Speed With Ball'],
      ['passIQ', 'Pass IQ'], ['passVision', 'Pass Vision'],
    ],
  },
  {
    title: 'Physicals',
    keys: [
      ['speed', 'Speed'], ['agility', 'Agility'], ['strength', 'Strength'], ['vertical', 'Vertical'],
      ['stamina', 'Stamina'], ['hustle', 'Hustle'], ['overallDurability', 'Overall Durability'],
    ],
  },
  {
    title: 'Defense / Rebounding',
    keys: [
      ['interiorDefense', 'Interior Defense'], ['perimeterDefense', 'Perimeter Defense'], ['steal', 'Steal'],
      ['block', 'Block'], ['helpDefenseIQ', 'Help Defense IQ'], ['passPerception', 'Pass Perception'],
      ['defensiveConsistency', 'Defensive Consistency'], ['offensiveRebound', 'Offensive Rebound'],
      ['defensiveRebound', 'Defensive Rebound'],
    ],
  },
];
const PUBLIC_NBA2K_BADGE_TIER_ORDER = ['Legendary', 'Hall of Fame', 'Gold', 'Silver', 'Bronze'];

function publicNba2kOvrTierClass(ovr) {
  return ovr >= 90 ? 'pos-ovr-elite' : ovr >= 80 ? 'pos-ovr-good' : 'pos-ovr-role';
}
function publicNba2kAttrTierClass(v) {
  return v >= 90 ? 'nba2k-attr-elite' : v >= 80 ? 'nba2k-attr-good' : v >= 70 ? 'nba2k-attr-mid' : 'nba2k-attr-low';
}

const PUBLIC_NBA2K27_POOL_META = {
  green: { label: 'Green', dot: '🟢' },
  blue:  { label: 'Blue',  dot: '🔵' },
  white: { label: 'White', dot: '⚪' },
};
function publicNba2k27PoolLabel(pool) { return (PUBLIC_NBA2K27_POOL_META[pool] || {}).label || null; }
function publicNba2k27PoolDot(pool) { return (PUBLIC_NBA2K27_POOL_META[pool] || {}).dot || ''; }
function publicNba2k27PoolValueValid(pool) { return Object.prototype.hasOwnProperty.call(PUBLIC_NBA2K27_POOL_META, pool); }

const PublicNba2k27View = {
  // Module-level cache — populated once per page load, never re-fetched
  // (see file header "PERFORMANCE / LOAD PATTERN").
  _pool27: null,       // { slug: { nba2kRef, pool, selectedAt, updatedAt } }
  _players: null,      // { slug: fullSourceDoc } — ONLY for selected slugs
  _loadPromise: null,
  _loadError: null,    // null | 'permission-denied' | 'error'

  _search: '',
  _filterPool: '',      // '' | green | blue | white
  _filterCategory: '',  // '' | curr | class | allt
  _filterPosition: '',  // '' | PG | SG | SF | PF | C
  _filterTeam: '',
  _filterOvr: '',        // '' | '90' | '85' | '80' | '75' (>= threshold)
  _sortMode: 'ovr-desc',

  // async/awaitable — matching the established pattern in
  // Nba2k27PoolView (js/admin/nba2k-database.js, Phase 8), and required
  // so callers (and tests) can reliably know when the first load has
  // actually finished rather than racing it. public-router.js's
  // `navigate()` does not await this, exactly like it doesn't await any
  // other view's render() — that's fine, because this method itself
  // synchronously paints the loading state up front and asynchronously
  // repaints with real data once `_ensureLoaded()` resolves, so the page
  // is correct either way; only tests need to actually await completion.
  async render(container) {
    if (this._pool27) {
      this._renderShell(container);
      return;
    }
    container.innerHTML = `
      <div class="pub2k27-view">
        <div class="player-db-header">
          <h1 class="player-db-title">NBA 2K27 Player Pool</h1>
        </div>
        <p class="helper-text">Loading NBA 2K27 pool…</p>
      </div>`;
    await this._ensureLoaded();
    if (document.body.contains(container)) this._renderShell(container);
  },

  _classifyError(err) {
    return (err && err.code === 'permission-denied') ? 'permission-denied' : 'error';
  },

  // Read-only. Exactly two kinds of Firestore calls happen here, both
  // `.get()`: the whole (typically small) `nba2k27_pool` collection
  // once, then `nba2k_players` fetched ONLY by the specific document IDs
  // that collection just returned, chunked to the 'in'-query limit.
  // Never a collection-wide read of `nba2k_players`.
  async _ensureLoaded() {
    if (this._pool27) return;
    if (this._loadPromise) { await this._loadPromise; return; }
    this._loadPromise = (async () => {
      try {
        const poolSnap = await firebase.firestore().collection('nba2k27_pool').get();
        const pool27 = {};
        poolSnap.docs.forEach(d => { pool27[d.id] = d.data(); });
        this._pool27 = pool27;
      } catch (err) {
        // Collection-level failure (e.g. the rule above hasn't been
        // applied yet) — fail closed, show an explanatory empty state,
        // never guess at or fabricate pool data.
        this._pool27 = {};
        this._players = {};
        this._loadError = this._classifyError(err);
        return;
      }

      const slugs = Object.keys(this._pool27);
      const players = {};
      let resolvedAny = slugs.length === 0;
      let deniedAny = false;
      for (let i = 0; i < slugs.length; i += NBA2K27_PUBLIC_CHUNK_SIZE) {
        const chunk = slugs.slice(i, i + NBA2K27_PUBLIC_CHUNK_SIZE);
        try {
          const snap = await firebase.firestore().collection('nba2k_players')
            .where(firebase.firestore.FieldPath.documentId(), 'in', chunk)
            .get();
          snap.docs.forEach(d => { players[d.id] = { id: d.id, ...d.data() }; });
          resolvedAny = true;
        } catch (err) {
          // A slug simply not resolving is handled per-row as an
          // "orphan/unavailable" card (see `_buildRows`) — this only
          // tracks whether EVERY chunk failed, which means the rule
          // change above genuinely hasn't been applied yet, distinct
          // from "this one player's doc doesn't exist."
          if (this._classifyError(err) === 'permission-denied') deniedAny = true;
        }
      }
      this._players = players;
      if (slugs.length > 0 && !resolvedAny && deniedAny) {
        this._loadError = 'permission-denied';
      }
    })();
    await this._loadPromise;
    this._loadPromise = null;
  },

  // Joins `nba2k27_pool` entries to their resolved `nba2k_players`
  // record by slug === document ID on both sides — same join shape as
  // the admin Phase 8 page, over this page's own, separately-loaded
  // (and public-rule-scoped) cache.
  _buildRows() {
    const pool27 = this._pool27 || {};
    const players = this._players || {};
    return Object.keys(pool27).map(slug => {
      const entry = pool27[slug] || {};
      const player = players[slug] || null;
      return {
        slug,
        player,
        orphan: !player,
        poolValue: entry.pool,
        poolValid: publicNba2k27PoolValueValid(entry.pool),
        category: player ? player.teamType : null,
      };
    });
  },

  _getVisibleRows(rows) {
    const q = this._search.trim().toLowerCase();
    const ovrMin = this._filterOvr ? Number(this._filterOvr) : null;

    let list = rows.filter(r => {
      if (this._filterCategory && r.category !== this._filterCategory) return false;
      if (this._filterPool) {
        if (!r.poolValid || r.poolValue !== this._filterPool) return false;
      }
      if (!r.player) {
        // Orphans have nothing to match name/position/team/OVR filters
        // against — excluded from any active filter/search, but still
        // shown under "no filters" (handled in `_renderList`).
        return !q && !this._filterPosition && !this._filterTeam && ovrMin === null;
      }
      if (q) {
        const hay = `${r.player.name || ''} ${r.player.team || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (this._filterPosition) {
        const positions = Array.isArray(r.player.positions) ? r.player.positions : [];
        if (!positions.includes(this._filterPosition)) return false;
      }
      if (this._filterTeam && r.player.team !== this._filterTeam) return false;
      if (ovrMin !== null && !(Number(r.player.overall) >= ovrMin)) return false;
      return true;
    });

    list = list.slice().sort((a, b) => {
      if (!a.player && !b.player) return 0;
      if (!a.player) return 1;
      if (!b.player) return -1;
      switch (this._sortMode) {
        case 'ovr-asc': return (Number(a.player.overall) || 0) - (Number(b.player.overall) || 0);
        case 'name-asc': return (a.player.name || '').localeCompare(b.player.name || '');
        case 'name-desc': return (b.player.name || '').localeCompare(a.player.name || '');
        case 'ovr-desc':
        default: return (Number(b.player.overall) || 0) - (Number(a.player.overall) || 0);
      }
    });

    return list;
  },

  _renderShell(container) {
    if (this._loadError) {
      container.innerHTML = `
        <div class="pub2k27-view">
          <div class="player-db-header"><h1 class="player-db-title">NBA 2K27 Player Pool</h1></div>
          <div class="empty-state">
            <h2>2K27 pool data isn't available yet</h2>
            <p>${this._loadError === 'permission-denied'
              ? "This page needs a small Firestore access rule to be enabled by the commissioner before it can show players. Nothing is broken — check back soon."
              : "Something went wrong loading the 2K27 pool. Please try again shortly."}</p>
          </div>
        </div>`;
      return;
    }

    const rows = this._buildRows();
    const teams = Array.from(new Set(rows.filter(r => r.player && r.player.team).map(r => r.player.team))).sort();

    if (rows.length === 0) {
      container.innerHTML = `
        <div class="pub2k27-view">
          <div class="player-db-header">
            <h1 class="player-db-title">NBA 2K27 Player Pool</h1>
            <p class="player-db-subtitle">Preview the players selected for the upcoming NBA 2K27 season.</p>
          </div>
          <div class="empty-state">
            <h2>No players selected yet</h2>
            <p>Check back once the commissioner has built out the NBA 2K27 pool.</p>
          </div>
        </div>`;
      return;
    }

    container.innerHTML = `
      <div class="pub2k27-view">
        <div class="player-db-header">
          <h1 class="player-db-title">NBA 2K27 Player Pool</h1>
          <p class="player-db-subtitle">Preview the players selected for the upcoming NBA 2K27 season, ahead of the draft.</p>
        </div>

        <div class="pool-info-row">
          <div class="pool-info-card pool-info-green">
            <span class="pool-info-card-title"><span class="pool-dot" style="background:var(--pool-green);"></span> Green Pool</span>
            <span class="pool-info-card-desc">Current players.</span>
          </div>
          <div class="pool-info-card pool-info-blue">
            <span class="pool-info-card-title"><span class="pool-dot" style="background:var(--pool-blue);"></span> Blue Pool</span>
            <span class="pool-info-card-desc">All-Time players.</span>
          </div>
          <div class="pool-info-card pub2k27-pool-info-white">
            <span class="pool-info-card-title"><span class="pool-dot" style="background:var(--pool-white,#d7dae0);"></span> White Pool</span>
            <span class="pool-info-card-desc">Classics players.</span>
          </div>
        </div>

        <div class="table-controls pub2k27-controls">
          <input type="text" id="pub2k27Search" class="input search-input"
            placeholder="Search by player or team…" value="${escapeHtml(this._search)}">
          <select id="pub2k27PoolFilter" class="input">
            <option value="">All Pools</option>
            <option value="green" ${this._filterPool === 'green' ? 'selected' : ''}>🟢 Green</option>
            <option value="blue" ${this._filterPool === 'blue' ? 'selected' : ''}>🔵 Blue</option>
            <option value="white" ${this._filterPool === 'white' ? 'selected' : ''}>⚪ White</option>
          </select>
          <select id="pub2k27CategoryFilter" class="input">
            <option value="">All Categories</option>
            <option value="curr" ${this._filterCategory === 'curr' ? 'selected' : ''}>Current</option>
            <option value="class" ${this._filterCategory === 'class' ? 'selected' : ''}>Classics</option>
            <option value="allt" ${this._filterCategory === 'allt' ? 'selected' : ''}>All-Time</option>
          </select>
          <select id="pub2k27PositionFilter" class="input">
            <option value="">All Positions</option>
            ${['PG', 'SG', 'SF', 'PF', 'C'].map(p => `<option value="${p}" ${this._filterPosition === p ? 'selected' : ''}>${p}</option>`).join('')}
          </select>
          <select id="pub2k27TeamFilter" class="input">
            <option value="">All Teams</option>
            ${teams.map(t => `<option value="${escapeHtml(t)}" ${this._filterTeam === t ? 'selected' : ''}>${escapeHtml(t)}</option>`).join('')}
          </select>
          <select id="pub2k27OvrFilter" class="input">
            <option value="">All Overalls</option>
            <option value="90" ${this._filterOvr === '90' ? 'selected' : ''}>90+</option>
            <option value="85" ${this._filterOvr === '85' ? 'selected' : ''}>85+</option>
            <option value="80" ${this._filterOvr === '80' ? 'selected' : ''}>80+</option>
            <option value="75" ${this._filterOvr === '75' ? 'selected' : ''}>75+</option>
          </select>
          <select id="pub2k27Sort" class="input">
            <option value="ovr-desc" ${this._sortMode === 'ovr-desc' ? 'selected' : ''}>Sort: OVR (High–Low)</option>
            <option value="ovr-asc" ${this._sortMode === 'ovr-asc' ? 'selected' : ''}>Sort: OVR (Low–High)</option>
            <option value="name-asc" ${this._sortMode === 'name-asc' ? 'selected' : ''}>Sort: Name (A–Z)</option>
            <option value="name-desc" ${this._sortMode === 'name-desc' ? 'selected' : ''}>Sort: Name (Z–A)</option>
          </select>
        </div>

        <div id="pub2k27List"></div>
      </div>
      <div id="pub2k27DetailMount"></div>`;

    container.querySelector('#pub2k27Search').oninput = e => { this._search = e.target.value; this._refreshList(container); };
    container.querySelector('#pub2k27PoolFilter').onchange = e => { this._filterPool = e.target.value; this._refreshList(container); };
    container.querySelector('#pub2k27CategoryFilter').onchange = e => { this._filterCategory = e.target.value; this._refreshList(container); };
    container.querySelector('#pub2k27PositionFilter').onchange = e => { this._filterPosition = e.target.value; this._refreshList(container); };
    container.querySelector('#pub2k27TeamFilter').onchange = e => { this._filterTeam = e.target.value; this._refreshList(container); };
    container.querySelector('#pub2k27OvrFilter').onchange = e => { this._filterOvr = e.target.value; this._refreshList(container); };
    container.querySelector('#pub2k27Sort').onchange = e => { this._sortMode = e.target.value; this._refreshList(container); };

    this._refreshList(container);
  },

  _refreshList(container) {
    const listEl = container.querySelector('#pub2k27List');
    if (!listEl) return;
    const visible = this._getVisibleRows(this._buildRows());
    if (!visible.length) {
      listEl.innerHTML = `<p class="helper-text">No players match these filters.</p>`;
      return;
    }
    listEl.innerHTML = `<div class="pub2k27-grid">${visible.map(r => this._renderCard(r)).join('')}</div>`;

    listEl.querySelectorAll('.pub2k27-card[data-slug]').forEach(card => {
      card.addEventListener('click', () => this._openDetail(container, card.dataset.slug));
      card.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this._openDetail(container, card.dataset.slug); }
      });
    });
  },

  _renderCard(row) {
    if (row.orphan) {
      return `
        <div class="pub2k27-card pub2k27-card-orphan">
          <div class="pub2k27-card-name">Player unavailable</div>
          <p class="helper-text">This selection's player data could not be found.</p>
        </div>`;
    }
    const p = row.player;
    const ovr = Number(p.overall) || 0;
    const positions = Array.isArray(p.positions) && p.positions.length ? p.positions.join(', ') : '—';
    const poolDot = row.poolValid ? publicNba2k27PoolDot(row.poolValue) : '⚠';
    const poolLabel = row.poolValid ? publicNba2k27PoolLabel(row.poolValue) : 'Unknown';
    return `
      <div class="pub2k27-card" data-slug="${escapeHtml(row.slug)}" tabindex="0" role="button" aria-label="View ${escapeHtml(p.name)} details">
        <div class="pub2k27-card-avatar">
          ${p.playerImage ? `<img src="${escapeHtml(p.playerImage)}" alt="" onerror="this.remove()">` : ''}
          <span class="pub2k27-card-avatar-fallback">${escapeHtml((p.name || '?').split(/\s+/).map(w => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase())}</span>
        </div>
        <div class="pub2k27-card-body">
          <div class="pub2k27-card-name">${escapeHtml(p.name || row.slug)}</div>
          <div class="pub2k27-card-meta">
            <span class="pos-ovr ${publicNba2kOvrTierClass(ovr)}">${ovr} OVR</span>
            <span>${escapeHtml(positions)}</span>
            <span>${escapeHtml(p.team || '—')}</span>
          </div>
          <div class="pub2k27-card-tags">
            <span class="nba2k-category-chip nba2k-category-chip-${escapeHtml(p.teamType || 'other')}">${escapeHtml(publicNba2kCategoryLabel(p.teamType).toUpperCase())}</span>
            <span class="pub2k27-pool-tag pub2k27-pool-tag-${escapeHtml(row.poolValue || 'unknown')}">${poolDot} ${escapeHtml(poolLabel)}</span>
          </div>
        </div>
      </div>`;
  },

  _openDetail(container, slug) {
    const row = this._buildRows().find(r => r.slug === slug);
    if (!row || row.orphan) return; // nothing resolvable to show a detail view for
    const p = row.player;

    const mount = container.querySelector('#pub2k27DetailMount') || document.getElementById('pub2k27DetailMount');
    if (!mount) return;

    const ovr = Number(p.overall) || 0;
    const positions = Array.isArray(p.positions) && p.positions.length ? p.positions.join(', ') : '—';
    const initials = (p.name || '?').split(/\s+/).map(w => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();

    const attrSections = PUBLIC_NBA2K_ATTRIBUTE_GROUPS.map(group => {
      const rowsHtml = group.keys.map(([key, label]) => {
        const raw = p.attributes ? p.attributes[key] : undefined;
        const v = Number(raw);
        const hasValue = raw !== undefined && raw !== null && !isNaN(v);
        const pct = hasValue ? Math.max(0, Math.min(100, (v / 99) * 100)) : 0;
        return `
          <div class="nba2k-attr-row">
            <span class="nba2k-attr-label">${escapeHtml(label)}</span>
            <div class="nba2k-attr-bar-track">
              <div class="nba2k-attr-bar-fill ${hasValue ? publicNba2kAttrTierClass(v) : ''}" style="width:${pct}%"></div>
            </div>
            <span class="nba2k-attr-value">${hasValue ? v : '—'}</span>
          </div>`;
      }).join('');
      return `<div class="nba2k-attr-section"><h4>${escapeHtml(group.title)}</h4>${rowsHtml}</div>`;
    }).join('');

    const badgeList = (p.badges && Array.isArray(p.badges.list)) ? p.badges.list : [];
    const badgesByTier = {};
    for (const b of badgeList) {
      if (!b || !b.tier) continue;
      (badgesByTier[b.tier] = badgesByTier[b.tier] || []).push(b);
    }
    const badgeSections = PUBLIC_NBA2K_BADGE_TIER_ORDER
      .filter(tier => badgesByTier[tier] && badgesByTier[tier].length)
      .map(tier => `
        <div class="nba2k-badge-group">
          <h5 class="nba2k-badge-tier nba2k-badge-tier-${tier.toLowerCase().replace(/\s+/g, '-')}">${escapeHtml(tier)}</h5>
          <div class="nba2k-badge-chips">
            ${badgesByTier[tier].map(b => `<span class="nba2k-badge-chip" title="${escapeHtml(b.category || '')}">${escapeHtml(b.name)}</span>`).join('')}
          </div>
        </div>`).join('');

    const poolDot = row.poolValid ? publicNba2k27PoolDot(row.poolValue) : '⚠';
    const poolLabel = row.poolValid ? publicNba2k27PoolLabel(row.poolValue) : 'Unknown';

    mount.innerHTML = `
      <div class="pub2k27-modal-overlay" id="pub2k27DetailOverlay">
        <div class="pub2k27-modal-card">
          <button type="button" class="pub2k27-modal-close" id="pub2k27DetailClose" aria-label="Close">×</button>

          <div class="nba2k-detail-header">
            <div class="nba2k-avatar">
              ${p.playerImage ? `<img src="${escapeHtml(p.playerImage)}" alt="" onerror="this.remove()">` : ''}
              <span class="nba2k-avatar-fallback">${escapeHtml(initials)}</span>
            </div>
            <div class="nba2k-detail-header-info">
              <div class="nba2k-detail-name">${escapeHtml(p.name || row.slug)}</div>
              <div class="nba2k-detail-meta">
                <span class="pos-ovr ${publicNba2kOvrTierClass(ovr)} nba2k-detail-ovr">${ovr} OVR</span>
                <span>${escapeHtml(p.team || '—')}</span>
                <span>${escapeHtml(positions)}</span>
                <span class="nba2k-category-chip nba2k-category-chip-${escapeHtml(p.teamType || 'other')}">${escapeHtml(publicNba2kCategoryLabel(p.teamType).toUpperCase())}</span>
                <span class="pub2k27-pool-tag pub2k27-pool-tag-${escapeHtml(row.poolValue || 'unknown')}">${poolDot} ${escapeHtml(poolLabel)} Pool</span>
              </div>
              <div class="nba2k-detail-physicals">
                ${p.build ? `<span>${escapeHtml(p.build)}</span>` : ''}
                ${p.height ? `<span>${escapeHtml(p.height)}</span>` : ''}
                ${p.weight ? `<span>${escapeHtml(p.weight)}</span>` : ''}
                ${p.wingspan ? `<span>Wingspan ${escapeHtml(p.wingspan)}</span>` : ''}
              </div>
            </div>
          </div>

          <div class="nba2k-detail-body">
            <div class="nba2k-attr-groups">${attrSections}</div>
            <div class="nba2k-badges-section">
              <h4>Badges</h4>
              ${badgeSections || '<p class="helper-text">No badges</p>'}
            </div>
          </div>
        </div>
      </div>`;

    const close = () => { mount.innerHTML = ''; };
    mount.querySelector('#pub2k27DetailClose').onclick = close;
    mount.querySelector('#pub2k27DetailOverlay').addEventListener('click', e => {
      if (e.target.id === 'pub2k27DetailOverlay') close();
    });
  },
};
