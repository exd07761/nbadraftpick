/**
 * views/players.js — Phase 10 (redesigned 10.1): Public, read-only player
 * pool browser, styled as a 2K-Ratings-style position-column table.
 *
 * Phase 15 — DATA SOURCE SWITCHED TO NBA 2K27:
 * This page now sources its player list from the live NBA 2K27 pool
 * (`nba2k27_pool` + `nba2k_players`, joined by slug) instead of the old
 * NBA 2K26 promoted pool (`league/main.players` via LeagueData.
 * getAllPlayers()). The read pattern (module-level cache, effective
 * name/overall override resolution) is duplicated from — not imported
 * from — js/views/nba2k27.js, matching that file's own documented
 * reasoning: index.html loads each public view file independently, and
 * this keeps that page and this one decoupled rather than introducing
 * new cross-file coupling.
 *
 * Phase 8.4 — FIRESTORE READS REPLACED WITH SUPABASE:
 * `_ensureLoaded()` now sources `nba2k27_pool`/`nba2k_players` via
 * `SupabaseReadsNba2k27` (js/supabase-reads-nba2k27.js) instead of
 * `firebase.firestore()`. This changed ONLY the data-loading boundary —
 * `_buildEntries()`, the draft-status join, search/filter, tabs, and the
 * position-column grid are all unmodified and unaware the data source
 * changed, since the resulting `_pool27`/`_players27` shape (an object
 * keyed by slug) is identical either way. Chunking the player-slug
 * lookup is now the shared module's concern, not this file's — see that
 * module for why the old 10-per-chunk Firestore `in`-query limit no
 * longer applies. The `_loadError`-based Firestore-permission
 * distinction this file never actually rendered (dead state, confirmed
 * before this phase) is simplified to a single generic failure marker —
 * see js/supabase-reads-nba2k27.js's own header for why a Postgres RLS
 * read-denial doesn't map onto Firestore's thrown `permission-denied`
 * the same way.
 *
 * UNCHANGED from Phase 10.1: page layout, Green/Blue tabs, search bar,
 * the position-column grid (positionPoolGrid() in shared-utils.js,
 * untouched), the plain "Drafted" status tag, and the
 * drafted-players-stay-visible behavior. Only the underlying player data
 * source, the pool-description copy (now describing 2K27's Current/
 * All-Time classification instead of 2K26), and the drafted/available
 * join changed.
 *
 * DRAFT STATUS — CURRENT SEASON ONLY, NO NEW LOGIC:
 * This page has never had a season selector and still doesn't — it
 * always reflects LeagueData.getCurrentSeason(), exactly as before.
 * Status itself is computed by calling the existing, unmodified
 * LeagueData.getDraftPoolStatus(seasonId, null) — the SAME call this
 * file already made pre-Phase-15, and the same one the admin draft
 * screen (js/admin/draft.js) uses. That function already scopes its
 * results to `season.playerPoolScope` internally (see data.js), and
 * every player it returns that was promoted from the 2K27 pool carries
 * `nba2kRef: <slug>` (set by the existing, unmodified AdminActions.
 * seedSeasonFromNba2k27Pool). This file's only new logic is re-keying
 * that existing result BY `nba2kRef` so it can be joined against
 * nba2k27_pool rows instead of by player id:
 *
 *   nba2k27_pool slug -> (found in current season's scoped players?)
 *     yes -> use that player's existing status ('available'/'drafted'/
 *            'variant-locked'/'position-locked'/'no-position')
 *     no  -> 'available' (never promoted into the current season yet,
 *            which is equivalent to "never drafted" from this page's
 *            perspective)
 *
 * Because the same nba2k27_pool slug can independently be promoted into
 * *different* seasons (seedSeasonFromNba2k27Pool's "already seeded"
 * check is scoped by seasonId), re-using getDraftPoolStatus's own
 * playerPoolScope filtering — rather than a naive global nba2kRef ->
 * player lookup — is what keeps this correctly season-scoped.
 *
 * OUT OF SCOPE (deliberately deferred, per feature brief):
 * - No season selector — locked to the current season only.
 * - No "drafted by <participant/team>" display — shared-utils.js's
 *   positionPoolGrid()/_positionPoolRow() is UNTOUCHED; the plain
 *   "Drafted" tag it already renders is used as-is.
 *
 * READ-ONLY GUARANTEE (same as views/nba2k27.js): this file contains no
 * `.set(`, `.update(`, `.delete(`, `.add(`, AdminActions, or
 * FirebaseSync.save call. Viewing this page can never modify
 * `nba2k27_pool`, `nba2k_players`, or `league/main` — a drafted player is
 * never removed from the master 2K27 pool, only annotated for display.
 */
const PublicPlayersView = {
  _activePool: 'green',
  _filter: '',

  // Module-level NBA 2K27 pool/source cache — loaded once per page load,
  // never re-fetched (mirrors views/nba2k27.js's own cache exactly).
  // Draft status is intentionally NOT cached here: it's recomputed fresh
  // from LeagueData on every render — including the FirebaseSync
  // remote-change re-renders public-router.js already triggers on every
  // navigate() — since that's a cheap, synchronous, already-live read.
  // Only the two Firestore collections need the one-time fetch.
  _pool27: null,
  _players27: null,
  _loadPromise: null,
  _loadError: null,

  async render(container) {
    if (!this._pool27) {
      container.innerHTML = `
        <div class="players-view" style="max-width:none;">
          <div class="player-db-header">
            <h1 class="player-db-title">Player Pool</h1>
            <p class="player-db-subtitle">Loading NBA 2K27 player pool…</p>
          </div>
        </div>`;
      await this._ensureLoaded();
      if (!document.body.contains(container)) return; // navigated away mid-load
    }
    this._renderShell(container);
  },

  // Read-only. Phase 8.4: sourced from Supabase via
  // SupabaseReadsNba2k27 (js/supabase-reads-nba2k27.js) instead of
  // Firestore — same two-step load (the pool table once, then only the
  // nba2k_players rows for the slugs that returned), same resulting
  // `_pool27`/`_players27` shape keyed by slug, so _buildEntries() below
  // needs no changes. Chunking/parallel-fetch of the player rows is now
  // the shared module's concern, not this file's.
  async _ensureLoaded() {
    if (this._pool27) return;
    if (this._loadPromise) { await this._loadPromise; return; }
    this._loadPromise = (async () => {
      try {
        this._pool27 = await SupabaseReadsNba2k27.getNba2k27PoolRows();
      } catch (err) {
        // Table-level failure — fail closed, show an explanatory empty
        // state, never guess at or fabricate pool data.
        this._pool27 = {};
        this._players27 = {};
        this._loadError = 'error';
        return;
      }

      const slugs = Object.keys(this._pool27);
      try {
        this._players27 = await SupabaseReadsNba2k27.getNba2k27PlayersBySlugs(slugs);
      } catch (err) {
        // Every chunk failed — a systemic read problem, not just "this
        // one player's doc doesn't exist" (an unresolved slug is
        // filtered out by _buildEntries()'s existing `.filter((e) =>
        // e.player.name)` check, unchanged by this phase).
        this._players27 = {};
        if (slugs.length > 0) this._loadError = 'error';
      }
    })();
    await this._loadPromise;
    this._loadPromise = null;
  },

  /**
   * Joins nba2k27_pool + nba2k_players (same effective-name/overall
   * override resolution as views/nba2k27.js) with the CURRENT season's
   * draft status from the existing, unmodified LeagueData.
   * getDraftPoolStatus() — see file header for why this is a pure
   * re-keying of an existing result, not new status-computation logic.
   * Returns [{ player: {id, name, position, overall, variantGroup},
   * pool, status }].
   */
  _buildEntries() {
    const pool27 = this._pool27 || {};
    const players27 = this._players27 || {};

    const season = LeagueData.getCurrentSeason();
    const statusList = season ? LeagueData.getDraftPoolStatus(season.id, null) : [];
    const statusByNba2kRef = {};
    statusList.forEach(({ player, status }) => {
      if (player.nba2kRef) statusByNba2kRef[player.nba2kRef] = status;
    });

    return Object.keys(pool27).map((slug) => {
      const entry = pool27[slug] || {};
      const source = players27[slug] || null;

      const nameOverride = typeof entry.nameOverride === 'string' ? entry.nameOverride.trim() : '';
      const name = nameOverride || (source && source.name) || '';

      const overallOverride = entry.overallOverride;
      const overall = (typeof overallOverride === 'number' && Number.isFinite(overallOverride))
        ? overallOverride
        : (source ? source.overall : null);

      const position = ['PG', 'SG', 'SF', 'PF', 'C'].includes(entry.position) ? entry.position : 'UNASSIGNED';

      const variantGroup = (typeof entry.variantGroupId === 'string' && entry.variantGroupId.trim())
        ? entry.variantGroupId.trim()
        : undefined;

      return {
        player: { id: slug, name, position, overall, variantGroup },
        pool: entry.pool,
        status: statusByNba2kRef[slug] || 'available',
      };
    }).filter((e) => e.player.name); // an orphan slug (no resolvable source doc or name override) has nothing to display
  },

  _renderShell(container) {
    const entries = this._buildEntries();
    const green = entries.filter((e) => e.pool === 'green');
    const blue = entries.filter((e) => e.pool === 'blue');
    const white = entries.filter((e) => e.pool === 'white');
    const byPool = { green, blue, white };

    container.innerHTML = `
      <div class="players-view" style="max-width:none;">
        <div class="player-db-header">
          <h1 class="player-db-title">Player Pool</h1>
          <p class="player-db-subtitle">
            All NBA 2K27 players in the league pool. Green Pool are current NBA 2K27 players.
            Blue Pool are legendary and all-time great versions of the player.
            White Pool are Classic editions of the player.
          </p>
        </div>

        <div class="pool-info-row">
          <div class="pool-info-card pool-info-green">
            <span class="pool-info-card-title"><span class="pool-dot" style="width:9px;height:9px;border-radius:50%;background:var(--pool-green);display:inline-block;"></span> Green Pool</span>
            <span class="pool-info-card-desc">Current NBA 2K27 players.</span>
          </div>
          <div class="pool-info-card pool-info-blue">
            <span class="pool-info-card-title"><span class="pool-dot" style="width:9px;height:9px;border-radius:50%;background:var(--pool-blue);display:inline-block;"></span> Blue Pool</span>
            <span class="pool-info-card-desc">Legends and all-time great versions of players.</span>
          </div>
          <div class="pool-info-card pool-info-white">
            <span class="pool-info-card-title"><span class="pool-dot" style="width:9px;height:9px;border-radius:50%;background:var(--pool-white, #d7dae0);display:inline-block;"></span> White Pool</span>
            <span class="pool-info-card-desc">Classic editions of players.</span>
          </div>
        </div>

        <div class="table-controls">
          <input type="text" id="publicPlayerSearch" class="input search-input"
            placeholder="Search players by name or position…" value="${escapeHtml(this._filter)}">
        </div>

        <div class="pool-tabs">
          <button type="button" class="pool-tab pool-tab-green ${this._activePool === 'green' ? 'active' : ''}" data-pool="green">
            <span class="pool-dot"></span> Green Pool <span class="pool-tab-count">(Current)</span>
          </button>
          <button type="button" class="pool-tab pool-tab-blue ${this._activePool === 'blue' ? 'active' : ''}" data-pool="blue">
            <span class="pool-dot"></span> Blue Pool <span class="pool-tab-count">(All-Time)</span>
          </button>
          <button type="button" class="pool-tab pool-tab-white ${this._activePool === 'white' ? 'active' : ''}" data-pool="white">
            <span class="pool-dot"></span> White Pool <span class="pool-tab-count">(Classics)</span>
          </button>
        </div>

        <div id="publicPlayersGrid">
          ${this._renderGrid(byPool[this._activePool] || green)}
        </div>

        <div class="drafted-note">
          <span class="swatch"></span>
          Grayed-out, struck-through players are already drafted and no longer available.
        </div>

        <div class="pool-legend-footer">
          <span class="legend-item"><span class="legend-dot green"></span> Green Pool: Current NBA 2K27 players.</span>
          <span class="legend-item"><span class="legend-dot blue"></span> Blue Pool: Legends and all-time great versions of players.</span>
          <span class="legend-item"><span class="legend-dot white"></span> White Pool: Classic editions of players.</span>
          <span class="legend-item"><span class="legend-dot live"></span> Updated in real time</span>
        </div>
      </div>`;

    this._bind(container, entries);
  },

  _applyFilter(entries) {
    const q = this._filter.toLowerCase();
    if (!q) return entries;
    return entries.filter((e) =>
      e.player.name.toLowerCase().includes(q) ||
      (e.player.position || '').toLowerCase().includes(q)
    );
  },

  _renderGrid(entries) {
    const filtered = this._applyFilter(entries);
    return positionPoolGrid(filtered, this._activePool, { admin: false, sortMode: 'ovr-desc' });
  },

  _bind(container, entries) {
    container.querySelector('#publicPlayerSearch').oninput = (e) => {
      this._filter = e.target.value;
      const pool = this._activePool;
      const filteredByPool = entries.filter((en) => en.pool === pool);
      container.querySelector('#publicPlayersGrid').innerHTML = this._renderGrid(filteredByPool);
    };

    container.querySelectorAll('.pool-tab').forEach((tab) => {
      tab.onclick = () => {
        this._activePool = tab.dataset.pool;
        this._renderShell(container);
      };
    });
  },
};
