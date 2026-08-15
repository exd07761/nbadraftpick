/**
 * views/players.js — Phase 10 (redesigned 10.1): Public, read-only player
 * database browser, styled as a 2K-Ratings-style position-column table.
 *
 * Read-only — no admin controls, no write calls. Uses only existing
 * LeagueData read methods (getAllPlayers, getDraftPoolStatus) — no new
 * data source. Rendering is shared with the admin Players page via
 * positionPoolGrid() in shared-utils.js, so both pages look consistent;
 * this file only supplies the read-only chrome around it.
 *
 * Structure: GREEN POOL / BLUE POOL tabs only. A player with no `pool`
 * value still exists in the database but is intentionally excluded from
 * both tabs — there is no "Unassigned" tab on the public site.
 *
 * Drafted players remain visible (never removed) but render grayed out /
 * struck through, using the same drafted/variant-locked status
 * LeagueData.getDraftPoolStatus already computes for the admin draft screen.
 * With no current season (or no draft started), every player shows available.
 */
const PublicPlayersView = {
  _activePool: 'green',
  _filter: '',

  render(container) {
    const allPlayers = LeagueData.getAllPlayers();
    const season = LeagueData.getCurrentSeason();

    const statusList = season ? LeagueData.getDraftPoolStatus(season.id, null) : null;
    const statusById = {};
    if (statusList) statusList.forEach(({ player, status }) => { statusById[player.id] = status; });

    const green = allPlayers.filter(p => p.pool === 'green');
    const blue = allPlayers.filter(p => p.pool === 'blue');

    container.innerHTML = `
      <div class="players-view" style="max-width:none;">
        <div class="player-db-header">
          <h1 class="player-db-title">Player Pool</h1>
          <p class="player-db-subtitle">
            All available players in the league pool. Green Pool are active players in NBA 2K26.
            Blue Pool are legendary and other prime versions of the player.
          </p>
        </div>

        <div class="pool-info-row">
          <div class="pool-info-card pool-info-green">
            <span class="pool-info-card-title"><span class="pool-dot" style="width:9px;height:9px;border-radius:50%;background:var(--pool-green);display:inline-block;"></span> Green Pool</span>
            <span class="pool-info-card-desc">Active players in NBA 2K26. Current rosters and active in the latest season.</span>
          </div>
          <div class="pool-info-card pool-info-blue">
            <span class="pool-info-card-title"><span class="pool-dot" style="width:9px;height:9px;border-radius:50%;background:var(--pool-blue);display:inline-block;"></span> Blue Pool</span>
            <span class="pool-info-card-desc">Legends and prime versions of players. Includes all-time greats and historic primes.</span>
          </div>
        </div>

        <div class="table-controls">
          <input type="text" id="publicPlayerSearch" class="input search-input"
            placeholder="Search players by name or position…" value="${escapeHtml(this._filter)}">
        </div>

        <div class="pool-tabs">
          <button type="button" class="pool-tab pool-tab-green ${this._activePool === 'green' ? 'active' : ''}" data-pool="green">
            <span class="pool-dot"></span> Green Pool <span class="pool-tab-count">(Active Players)</span>
          </button>
          <button type="button" class="pool-tab pool-tab-blue ${this._activePool === 'blue' ? 'active' : ''}" data-pool="blue">
            <span class="pool-dot"></span> Blue Pool <span class="pool-tab-count">(Legends & Primes)</span>
          </button>
        </div>

        <div id="publicPlayersGrid">
          ${this._renderGrid(this._activePool === 'green' ? green : blue, statusById)}
        </div>

        <div class="drafted-note">
          <span class="swatch"></span>
          Grayed-out, struck-through players are already drafted and no longer available.
        </div>

        <div class="pool-legend-footer">
          <span class="legend-item"><span class="legend-dot green"></span> Green Pool: Active players in current NBA 2K26 rosters.</span>
          <span class="legend-item"><span class="legend-dot blue"></span> Blue Pool: Legends and prime versions of players.</span>
          <span class="legend-item"><span class="legend-dot live"></span> Updated in real time</span>
        </div>
      </div>`;

    this._bind(container, allPlayers, statusById);
  },

  _applyFilter(players) {
    const q = this._filter.toLowerCase();
    if (!q) return players;
    return players.filter(p =>
      p.name.toLowerCase().includes(q) ||
      (p.position || '').toLowerCase().includes(q)
    );
  },

  _renderGrid(players, statusById) {
    const filtered = this._applyFilter(players);
    const entries = filtered.map(player => ({ player, status: statusById[player.id] || 'available' }));
    return positionPoolGrid(entries, this._activePool, { admin: false, sortMode: 'ovr-desc' });
  },

  _bind(container, allPlayers, statusById) {
    container.querySelector('#publicPlayerSearch').oninput = e => {
      this._filter = e.target.value;
      const pool = this._activePool;
      const players = allPlayers.filter(p => p.pool === pool);
      container.querySelector('#publicPlayersGrid').innerHTML = this._renderGrid(players, statusById);
    };

    container.querySelectorAll('.pool-tab').forEach(tab => {
      tab.onclick = () => {
        this._activePool = tab.dataset.pool;
        this.render(container);
      };
    });
  },
};
