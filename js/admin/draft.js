/**
 * admin/draft.js — Phase 2 draft engine + Phase 4B draft experience,
 * redesigned Phase 10.3 into a 2K-style draft console.
 *
 * DATA LAYER — UNCHANGED, reused as-is:
 *   - LeagueData.getDraftState(seasonId)            — round/pick/current participant, derived every render
 *   - LeagueData.getDraftPoolStatus(seasonId, pid)   — every player + status: available/drafted/variant-locked/position-locked/no-position
 *   - LeagueData.getParticipantRoster(seasonId, pid) — that participant's picks, filtered from the
 *                                                       append-only season.playerDraftPicks log in the
 *                                                       order they were made — this IS chronological pick
 *                                                       order already; the Draft Roster panel below renders
 *                                                       this array as-is and never re-sorts it by position.
 *   - LeagueData.getPositionState(seasonId, pid)     — { filled, missing, allFilled } for the Position
 *                                                       Needs panel; this file never recomputes that logic.
 *   - AdminActions.makeDraftPick / undoLastDraftPick / markDraftComplete — unchanged; this file only adds
 *     a confirmation step and a search dropdown in front of the same makeDraftPick call.
 *
 * VISUAL LAYER — Phase 10.3: the five position columns now render through
 * the shared positionPoolGrid()/_positionPoolRow() component
 * (shared-utils.js, mode:'draft') — the same component the Players pages
 * use — so drafted/locked players stay visible (never removed from the
 * DOM) with a clear status tag, and available players are clickable
 * rows that open a confirmation modal instead of an inline "Draft"
 * button. The left sidebar (On the Clock / Draft Roster / Position
 * Needs) and the search-as-you-type suggestion dropdown are new in
 * Phase 10.3; the old stacked pool sections + bottom round-by-round
 * Draft History panel were replaced by this sidebar (draft history is
 * still fully intact in the data — season.playerDraftPicks — this is a
 * presentation change only, nothing was deleted from the data model).
 */
const AdminDraftView = {
  _filter: '',
  _activePool: 'green',
  _outsideClickBound: false,

  render(container) {
    const season = LeagueData.getCurrentSeason();
    if (!season) {
      container.innerHTML = `<div class="empty-state"><p>No current season. Create a season first.</p></div>`;
      return;
    }

    const draftOrder = LeagueData.getPlayerDraftOrder(season.id);
    if (!draftOrder.length) {
      container.innerHTML = `
        <div class="empty-state">
          <p>Set the Player Draft Order (DuckRace #1) before starting the draft.</p>
          <button class="btn btn-primary" data-action="goDraftOrder">Go to DuckRace Orders</button>
        </div>`;
      container.querySelector('[data-action="goDraftOrder"]').onclick = () => AdminApp.renderView('draftOrder');
      return;
    }

    const state = LeagueData.getDraftState(season.id);
    const poolStatus = LeagueData.getDraftPoolStatus(season.id, state.currentParticipantId);
    const gridMode = state.draftComplete ? 'view' : 'draft';

    container.innerHTML = `
      <div class="admin-section draft-v2">
        <div class="admin-section-header">
          <h2>Player Draft — ${escapeHtml(season.name)}</h2>
        </div>

        ${state.draftComplete ? `
        <div class="success-banner">
          ✓ Draft marked complete. ${state.totalPicksMade} pick${state.totalPicksMade !== 1 ? 's' : ''} made.
          NBA team assignment (DuckRace #2) is a separate process — it does not start automatically.
        </div>` : ''}
        ${!state.draftComplete && state.poolExhausted ? `
        <div class="success-banner">
          All players in the database have been drafted. Add more players or mark the draft complete.
        </div>` : ''}

        <div class="draft-topbar">
          <div class="draft-search-wrap" id="draftSearchWrap">
            <span class="draft-search-icon">🔍</span>
            <input type="text" id="draftPlayerSearch" class="draft-search-input"
              placeholder="Search players by name or position…" value="${escapeHtml(this._filter)}" autocomplete="off">
            ${this._filter ? `<button type="button" class="draft-search-clear" id="draftSearchClear" title="Clear search">×</button>` : ''}
            <div class="draft-search-dropdown hidden" id="draftSearchDropdown"></div>
          </div>

          <div class="pool-tabs draft-pool-tabs" id="draftPoolTabs">
            ${this._renderPoolTabButtons(poolStatus)}
          </div>

          <div class="draft-topbar-actions">
            <button class="btn btn-ghost" id="btnUndoPick" ${state.totalPicksMade === 0 ? 'disabled' : ''}>Undo Last Pick</button>
            ${state.draftComplete
              ? ''
              : `<button class="btn btn-primary" id="btnMarkDraftComplete">Mark Draft Complete</button>`}
          </div>
        </div>

        <div class="draft-body">
          <aside class="draft-sidebar">
            ${this._renderOnClockCard(season, state)}
            ${this._renderDraftRosterCard(season, state)}
            ${this._renderPositionNeedsCard(season, state)}
          </aside>

          <main class="draft-main">
            <div id="availablePlayersWrapper">
              ${this._renderPools(this._applyFilter(poolStatus), gridMode)}
            </div>
          </main>
        </div>
      </div>`;

    this._bindEvents(container, season, state);
  },

  _applyFilter(poolStatusList) {
    const q = this._filter.toLowerCase();
    if (!q) return poolStatusList;
    return poolStatusList.filter(({ player }) =>
      player.name.toLowerCase().includes(q) ||
      (player.position || '').toLowerCase().includes(q)
    );
  },

  // ── Sidebar: On the Clock ──────────────────────────────────────────────
  _renderOnClockCard(season, state) {
    if (state.draftComplete) {
      return `
        <div class="draft-card draft-otc-card">
          <div class="draft-card-label">Draft Complete</div>
          <p class="muted" style="margin-top:0.5rem;">${state.totalPicksMade} total pick${state.totalPicksMade !== 1 ? 's' : ''} made.</p>
        </div>`;
    }
    if (!state.currentParticipantId) {
      return `
        <div class="draft-card draft-otc-card">
          <div class="draft-card-label">On the Clock</div>
          <p class="muted" style="margin-top:0.5rem;">No player pool remaining.</p>
        </div>`;
    }

    const abbr = season.nbaTeamAssignments[state.currentParticipantId];

    return `
      <div class="draft-card draft-otc-card">
        <div class="draft-card-label">On the Clock</div>
        <div class="otc-team-row">
          ${teamBadge(abbr, { size: 'lg' })}
          <div class="otc-identity">
            <span class="otc-participant-name">${escapeHtml(state.currentParticipant?.name || '')}</span>
            ${abbr ? `<span class="otc-team-name">${escapeHtml(LeagueData.getNBATeam(abbr)?.name || '')}</span>` : `<span class="otc-team-name muted">No NBA team assigned yet</span>`}
          </div>
        </div>
        <div class="otc-stats-grid">
          <div class="draft-status-chip">
            <span class="status-label">Round</span>
            <span class="status-value">${state.currentRound ?? '—'}</span>
          </div>
          <div class="draft-status-chip">
            <span class="status-label">Pick in Round</span>
            <span class="status-value">${state.currentPickInRound ?? '—'}</span>
          </div>
          <div class="draft-status-chip">
            <span class="status-label">Overall Pick</span>
            <span class="status-value">${state.currentPickOverall ?? '—'}</span>
          </div>
          <div class="draft-status-chip">
            <span class="status-label">Total Picks</span>
            <span class="status-value">${state.totalPicksMade}</span>
          </div>
        </div>
      </div>`;
  },

  // ── Sidebar: Draft Roster — chronological pick order, NEVER regrouped
  // by position. getParticipantRoster() already returns picks filtered
  // from the append-only playerDraftPicks log in the order they were
  // made, so array index + 1 IS this participant's pick number. ──────────
  _renderDraftRosterCard(season, state) {
    const participantId = state.currentParticipantId;
    if (!participantId) {
      return `
        <div class="draft-card draft-roster-card">
          <div class="draft-card-label">Draft Roster</div>
          <p class="muted" style="margin-top:0.5rem;">—</p>
        </div>`;
    }

    const roster = LeagueData.getParticipantRoster(season.id, participantId);

    return `
      <div class="draft-card draft-roster-card">
        <div class="draft-card-label">Draft Roster <span class="draft-roster-count">(${roster.length})</span></div>
        <div class="draft-roster-list">
          ${roster.length === 0
            ? `<p class="muted" style="padding:0.25rem 0;">No picks yet.</p>`
            : roster.map((r, i) => this._renderRosterRow(r, i + 1)).join('')}
        </div>
      </div>`;
  },

  _renderRosterRow(r, pickNum) {
    const p = r.player;
    if (!p) {
      return `
        <div class="draft-roster-row">
          <span class="drr-num">${pickNum}</span>
          <span class="drr-name muted">(removed player)</span>
        </div>`;
    }
    const pos = CORE_POSITIONS.includes(p.position) ? p.position : '—';
    const poolClass = p.pool === 'blue' ? 'draft-pos-chip-blue' : 'draft-pos-chip-green';
    return `
      <div class="draft-roster-row">
        <span class="drr-num">${pickNum}</span>
        <span class="draft-pos-chip ${poolClass}">${escapeHtml(pos)}</span>
        <span class="drr-name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</span>
        <span class="drr-ovr">${p.overall ?? '—'}</span>
      </div>`;
  },

  // ── Sidebar: Position Needs — reads LeagueData.getPositionState() as-is,
  // never recomputes the mandatory-first-five rule itself. ───────────────
  _renderPositionNeedsCard(season, state) {
    const participantId = state.currentParticipantId;
    if (!participantId) return '';

    const posState = LeagueData.getPositionState(season.id, participantId);

    return `
      <div class="draft-card draft-needs-card">
        <div class="draft-card-label">Position Need</div>
        <div class="position-need-row">
          ${CORE_POSITIONS.map(pos => `
            <span class="position-need-pill ${posState.filled[pos] ? 'position-need-pill--complete' : 'position-need-pill--needed'}" title="${posState.filled[pos] ? 'Filled' : 'Needed'}">
              ${pos}<span class="position-need-dot" aria-hidden="true"></span>
            </span>`).join('')}
        </div>
        ${posState.allFilled
          ? `<p class="position-complete-msg">✓ First five complete — any position now allowed.</p>`
          : ''}
        <div class="draft-needs-legend">
          <span class="legend-dot-sm complete"></span> Filled
          <span class="legend-dot-sm needed"></span> Needed
        </div>
      </div>`;
  },

  // ── Pool tab buttons (topbar) — content panes live in the main column;
  // click handler toggles both by data-pool / data-pool-pane, wherever
  // they are in the DOM, so the two can live in different containers. ────
  _renderPoolTabButtons(poolStatusList) {
    const green = poolStatusList.filter(e => e.player.pool === 'green');
    const blue = poolStatusList.filter(e => e.player.pool === 'blue');
    const active = this._activePool || 'green';
    return `
      <button type="button" class="pool-tab pool-tab-green ${active === 'green' ? 'active' : ''}" data-pool="green">
        <span class="pool-dot"></span> Green Pool <span class="pool-tab-count">${green.length}</span>
      </button>
      <button type="button" class="pool-tab pool-tab-blue ${active === 'blue' ? 'active' : ''}" data-pool="blue">
        <span class="pool-dot"></span> Blue Pool <span class="pool-tab-count">${blue.length}</span>
      </button>`;
  },

  // Players with no pool assigned still exist in the underlying data but
  // are intentionally excluded from both tabs — no user-facing
  // "Unassigned Pool" anywhere in Phase 10.
  _renderPools(poolStatusList, mode) {
    const green = poolStatusList.filter(e => e.player.pool === 'green');
    const blue = poolStatusList.filter(e => e.player.pool === 'blue');
    const active = this._activePool || 'green';

    return `
      <div class="pool-pane ${active === 'green' ? 'active' : ''}" data-pool-pane="green">
        ${positionPoolGrid(green, 'green', { mode })}
      </div>
      <div class="pool-pane ${active === 'blue' ? 'active' : ''}" data-pool-pane="blue">
        ${positionPoolGrid(blue, 'blue', { mode })}
      </div>`;
  },

  _bindEvents(container, season, state) {
    const searchInput = container.querySelector('#draftPlayerSearch');
    const dropdown = container.querySelector('#draftSearchDropdown');
    const gridMode = state.draftComplete ? 'view' : 'draft';
    const poolStatus = LeagueData.getDraftPoolStatus(season.id, state.currentParticipantId);

    const refreshBoard = () => {
      container.querySelector('#availablePlayersWrapper').innerHTML =
        this._renderPools(this._applyFilter(poolStatus), gridMode);
      this._bindBoardEvents(container, season);
    };

    searchInput.oninput = e => {
      this._filter = e.target.value;
      refreshBoard();
      this._updateSearchDropdown(container, season, poolStatus, gridMode);
    };
    searchInput.addEventListener('focus', () => this._updateSearchDropdown(container, season, poolStatus, gridMode));
    searchInput.addEventListener('keydown', e => { if (e.key === 'Escape') dropdown.classList.add('hidden'); });
    // Bound once, ever — looks up the live #draftSearchWrap by id at click
    // time rather than closing over this render's `container`, so it never
    // needs to be re-registered (and never leaks) across re-renders.
    if (!this._outsideClickBound) {
      document.addEventListener('click', (e) => {
        const wrap = document.getElementById('draftSearchWrap');
        const dd = document.getElementById('draftSearchDropdown');
        if (wrap && dd && !wrap.contains(e.target)) dd.classList.add('hidden');
      }, { capture: true });
      this._outsideClickBound = true;
    }

    container.querySelector('#draftSearchClear')?.addEventListener('click', () => {
      this._filter = '';
      AdminApp.renderView('draft');
    });

    this._bindBoardEvents(container, season);

    // Pool tabs — Green Pool / Blue Pool only, no Unassigned tab
    container.querySelectorAll('.pool-tab').forEach(tab => {
      tab.onclick = () => {
        this._activePool = tab.dataset.pool;
        container.querySelectorAll('.pool-tab').forEach(t => t.classList.toggle('active', t === tab));
        container.querySelectorAll('.pool-pane').forEach(p =>
          p.classList.toggle('active', p.dataset.poolPane === this._activePool));
      };
    });

    // Undo
    container.querySelector('#btnUndoPick').onclick = () => {
      AuthBoundary.requireAuth();
      try {
        AdminActions.undoLastDraftPick(season.id);
        showToast('Last pick undone.', 'success');
        AdminApp.renderView('draft');
      } catch (e) {
        showToast(e.message, 'error');
      }
    };

    // Mark complete
    container.querySelector('#btnMarkDraftComplete')?.addEventListener('click', () => {
      AuthBoundary.requireAuth();
      AdminActions.markDraftComplete(season.id);
      showToast('Draft marked complete.', 'success');
      AdminApp.renderView('draft');
    });
  },

  // Bind (or re-bind, after any innerHTML refresh) clicks on drafted-eligible
  // rows in the position board — opens the confirmation modal. Never calls
  // makeDraftPick directly from here; that only happens after the modal's
  // own "Draft Player" button is clicked.
  _bindBoardEvents(container, season) {
    container.querySelectorAll('[data-action="selectPlayer"]').forEach(row => {
      const open = () => {
        const player = LeagueData.getPlayer(row.dataset.playerId);
        if (player) this._openDraftConfirm(season, player);
      };
      row.onclick = open;
      row.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } };
    });
  },

  _updateSearchDropdown(container, season, poolStatus, gridMode) {
    const dropdown = container.querySelector('#draftSearchDropdown');
    const q = this._filter.trim().toLowerCase();
    if (!q) { dropdown.classList.add('hidden'); dropdown.innerHTML = ''; return; }

    const matches = poolStatus.filter(({ player }) =>
      player.name.toLowerCase().includes(q) || (player.position || '').toLowerCase().includes(q)
    ).slice(0, 6);

    if (!matches.length) {
      dropdown.innerHTML = `<div class="draft-search-empty">No players match "${escapeHtml(this._filter)}"</div>`;
      dropdown.classList.remove('hidden');
      return;
    }

    dropdown.innerHTML = `
      ${matches.map(({ player, status }) => {
        const available = status === 'available';
        const label = { drafted: 'Drafted', 'variant-locked': 'Variant taken', 'position-locked': 'Locked', 'no-position': 'No position' }[status];
        return `
          <div class="draft-search-row ${available ? '' : 'disabled'}" ${available ? `data-action="selectPlayer" data-player-id="${player.id}"` : ''}>
            <span class="dsr-name">${escapeHtml(player.name)}</span>
            <span class="dsr-pos">${player.position || '—'}</span>
            <span class="dsr-ovr">${player.overall ?? '—'}</span>
            <span class="pool-badge pool-badge-${player.pool === 'blue' ? 'blue' : 'green'}">${player.pool === 'blue' ? 'Blue' : 'Green'}</span>
            ${label ? `<span class="dsr-status">${label}</span>` : ''}
          </div>`;
      }).join('')}
      <div class="draft-search-footer" id="draftSearchViewAll">View all results for "${escapeHtml(this._filter)}"</div>`;

    dropdown.classList.remove('hidden');

    dropdown.querySelectorAll('[data-action="selectPlayer"]').forEach(row => {
      row.onclick = () => {
        const player = LeagueData.getPlayer(row.dataset.playerId);
        dropdown.classList.add('hidden');
        if (player) this._openDraftConfirm(season, player);
      };
    });
    dropdown.querySelector('#draftSearchViewAll')?.addEventListener('click', () => {
      dropdown.classList.add('hidden');
      container.querySelector('#draftPlayerSearch').blur();
    });
  },

  // ── Confirmation modal — the ONLY path that calls AdminActions.makeDraftPick.
  // Appended to document.body (not `container`) since AdminApp.renderView
  // replaces `container`'s entire innerHTML on success; the overlay is
  // explicitly removed before that happens either way. ──────────────────
  _openDraftConfirm(season, player) {
    document.getElementById('draftConfirmOverlay')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'draftConfirmOverlay';
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="draftConfirmTitle">
        <div class="modal-eyebrow">Draft Player</div>
        <div class="modal-player-name" id="draftConfirmTitle">${escapeHtml(player.name)}</div>
        <div class="modal-player-meta">
          <span>${player.position || '—'}</span> · <span>${player.overall ?? '—'} OVR</span>
          <span class="pool-badge pool-badge-${player.pool === 'blue' ? 'blue' : 'green'}" style="margin-left:0.5rem;">${player.pool === 'blue' ? 'Blue Pool' : 'Green Pool'}</span>
        </div>
        <p class="modal-prompt">Draft ${escapeHtml(player.name)}?</p>
        <div class="modal-actions">
          <button class="btn btn-ghost" id="modalCancelBtn">Cancel</button>
          <button class="btn btn-primary" id="modalConfirmBtn">Draft Player</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    document.getElementById('modalCancelBtn').onclick = close;
    const onKeydown = e => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKeydown); } };
    document.addEventListener('keydown', onKeydown);

    document.getElementById('modalConfirmBtn').onclick = () => {
      AuthBoundary.requireAuth();
      try {
        AdminActions.makeDraftPick(season.id, player.id);
        showToast(`${player.name} drafted.`, 'success');
        this._filter = ''; // clear search so the next view starts fresh
        close();
        AdminApp.renderView('draft');
      } catch (e) {
        showToast(e.message, 'error');
        close();
      }
    };
  },
};
