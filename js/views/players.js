/**
 * views/players.js — Phase 10 (redesigned 10.1): Public, read-only player
 * pool browser, styled as a 2K-Ratings-style position-column table.
 *
 * Phase 15 — DATA SOURCE SWITCHED TO NBA 2K27:
 * This page now sources its player list from the live NBA 2K27 pool
 * (`nba2k27_pool` + `nba2k_players`, joined by slug) instead of the old
 * NBA 2K26 promoted pool (`league/main.players` via LeagueData.
 * getAllPlayers()). The read pattern (module-level cache, chunked
 * `where(FieldPath.documentId(), 'in', chunk)` joins against
 * `nba2k_players`, effective name/overall override resolution) is
 * duplicated from — not imported from — js/views/nba2k27.js, matching
 * that file's own documented reasoning: index.html loads each public
 * view file independently, and this keeps that page and this one
 * decoupled rather than introducing new cross-file coupling.
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
const PUBLIC_PLAYERS_CHUNK_SIZE = 10; // Firestore compat-SDK 'in'-query limit — see views/nba2k27.js

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

  // Read-only. Same two Firestore calls, same chunking, as
  // views/nba2k27.js's _ensureLoaded(): the (typically small)
  // nba2k27_pool collection once, then nba2k_players fetched ONLY by
  // the specific slugs that collection returned, chunked to the
  // 'in'-query limit and fired in parallel.
  async _ensureLoaded() {
    if (this._pool27) return;
    if (this._loadPromise) { await this._loadPromise; return; }
    this._loadPromise = (async () => {
      try {
        const poolSnap = await firebase.firestore().collection('nba2k27_pool').get();
        const pool27 = {};
        poolSnap.docs.forEach((d) => { pool27[d.id] = d.data(); });
        this._pool27 = pool27;
      } catch (err) {
        // Collection-level failure (e.g. a security rule not yet
        // applied) — fail closed, show an explanatory empty state,
        // never guess at or fabricate pool data.
        this._pool27 = {};
        this._players27 = {};
        this._loadError = (err && err.code === 'permission-denied') ? 'permission-denied' : 'error';
        return;
      }

      const slugs = Object.keys(this._pool27);
      const chunks = [];
      for (let i = 0; i < slugs.length; i += PUBLIC_PLAYERS_CHUNK_SIZE) {
        chunks.push(slugs.slice(i, i + PUBLIC_PLAYERS_CHUNK_SIZE));
      }
      const chunkResults = await Promise.all(chunks.map((chunk) =>
        firebase.firestore().collection('nba2k_players')
          .where(firebase.firestore.FieldPath.documentId(), 'in', chunk)
          .get()
          .then((snap) => ({ ok: true, snap }))
          .catch((err) => ({ ok: false, err }))
      ));
      const players = {};
      chunkResults.forEach((result) => {
        if (result.ok) result.snap.docs.forEach((d) => { players[d.id] = { id: d.id, ...d.data() }; });
      });
      this._players27 = players;
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

    container.innerHTML = `
      <div class="players-view" style="max-width:none;">
        <div class="player-db-header">
          <h1 class="player-db-title">Player Pool</h1>
          <p class="player-db-subtitle">
            All NBA 2K27 players in the league pool. Green Pool are current NBA 2K27 players.
            Blue Pool are legendary and all-time great versions of the player.
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
        </div>

        <div id="publicPlayersGrid">
          ${this._renderGrid(this._activePool === 'green' ? green : blue)}
        </div>

        <div class="drafted-note">
          <span class="swatch"></span>
          Grayed-out, struck-through players are already drafted and no longer available.
        </div>

        <div class="pool-legend-footer">
          <span class="legend-item"><span class="legend-dot green"></span> Green Pool: Current NBA 2K27 players.</span>
          <span class="legend-item"><span class="legend-dot blue"></span> Blue Pool: Legends and all-time great versions of players.</span>
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
