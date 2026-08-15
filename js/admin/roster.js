/**
 * admin/roster.js — Phase 4A: Current Roster management
 *
 * Responsibilities:
 * - Display the rating cap for the current season and allow the admin to change it.
 * - Initialize currentRosters from the completed playerDraftPicks (one-time or
 *   re-initialize if needed).
 * - Display all participants' current rosters with per-roster total rating,
 *   cap usage bar, and remaining cap.
 *
 * What this view does NOT do (future phases):
 * - Trades, pool swaps, transaction fees, pot money, or scheduling.
 *
 * Architecture notes:
 * - All reads go through LeagueData (public read API).
 * - All writes go through AdminActions behind AuthBoundary.requireAuth().
 * - Renders into the shared #adminViewContainer, same as every other admin view.
 * - No global state is kept beyond the view object itself.
 */
const AdminRosterView = {
  render(container) {
    const season = LeagueData.getCurrentSeason();
    if (!season) {
      container.innerHTML = `<div class="empty-state"><p>No current season. Create a season first.</p></div>`;
      return;
    }

    const summary = LeagueData.getRosterSummary(season.id);
    const cap = season.ratingCap ?? 875;
    const rostersInitialized = season.rostersInitialized ?? false;
    const draftComplete = season.draftComplete ?? false;
    const totalParticipants = summary.length;
    const initializedCount = rostersInitialized
      ? Object.keys(season.currentRosters || {}).filter(
          pid => (season.currentRosters[pid] || []).length > 0
        ).length
      : 0;

    container.innerHTML = `
      <div class="admin-section">
        <div class="admin-section-header">
          <h2>Current Rosters — ${escapeHtml(season.name)}</h2>
        </div>

        <!-- Status banner -->
        ${this._renderStatusBanner(draftComplete, rostersInitialized, totalParticipants, initializedCount)}

        <!-- Controls row -->
        <div class="roster-controls-row">

          <!-- Rating cap control -->
          <div class="roster-cap-control card-form">
            <h3>Rating Cap</h3>
            <p class="helper-text">
              Maximum combined OVR allowed per roster this season.
              Changing this does not remove any players.
            </p>
            <div class="form-row">
              <div class="form-group">
                <label for="ratingCapInput">Cap (OVR)</label>
                <input type="number" id="ratingCapInput" class="input"
                  min="1" max="9999" value="${cap}" style="width:120px">
              </div>
              <div class="form-group" style="align-self:flex-end">
                <button class="btn btn-ghost" id="btnSaveCap">Update Cap</button>
              </div>
            </div>
          </div>

          <!-- Initialize button -->
          <div class="roster-init-control card-form">
            <h3>Initialize from Draft</h3>
            <p class="helper-text">
              Copies completed draft picks into the mutable current rosters.
              Draft history is never modified.
              ${rostersInitialized ? 'Re-initializing will overwrite any manual changes made since the last init.' : ''}
            </p>
            <button class="btn btn-primary" id="btnInitRosters"
              ${draftComplete ? '' : 'disabled'}>
              ${rostersInitialized ? 'Re-initialize Rosters from Draft' : 'Initialize Rosters from Draft'}
            </button>
            ${!draftComplete ? `<p class="error-text" style="margin-top:0.5rem">Draft must be marked complete first.</p>` : ''}
          </div>

        </div>

        <!-- Roster grid -->
        <div class="roster-grid-section">
          <h3>All Rosters
            <span class="helper-text" style="font-weight:400;font-size:0.85rem">
              — cap: <strong>${cap}</strong> OVR per roster
            </span>
          </h3>
          ${summary.length === 0
            ? `<div class="empty-state"><p>No participants yet.</p></div>`
            : `<div class="roster-cards">${summary.map(s => this._renderRosterCard(s, cap)).join('')}</div>`
          }
        </div>

      </div>`;

    this._bindEvents(container, season);
  },

  _renderStatusBanner(draftComplete, rostersInitialized, total, initialized) {
    if (!draftComplete) {
      return `<div class="info-banner">
        ℹ Draft not yet complete. Complete the player draft before initializing rosters.
      </div>`;
    }
    if (!rostersInitialized) {
      return `<div class="info-banner warn-banner">
        ⚠ Draft complete. Rosters have not been initialized yet.
        Click <strong>Initialize Rosters from Draft</strong> to create the current rosters.
      </div>`;
    }
    return `<div class="success-banner">
      ✓ Rosters initialized. Showing current rosters for ${total} participant${total !== 1 ? 's' : ''}.
    </div>`;
  },

  _renderRosterCard(summary, cap) {
    const { participant, rosterEntries, totalRating, remaining, isOverCap } = summary;
    const pct = cap > 0 ? Math.min(100, (totalRating / cap) * 100) : 0;
    const barClass = isOverCap ? 'cap-bar-fill--over'
      : pct >= 85 ? 'cap-bar-fill--warn'
      : 'cap-bar-fill--ok';

    const playerRows = rosterEntries.length
      ? rosterEntries.map((e, i) => {
          const p = e.player;
          return `
            <tr>
              <td class="roster-pick-num">${i + 1}</td>
              <td>${p ? escapeHtml(p.name) : '<span class="muted">(removed)</span>'}</td>
              <td>${p ? (p.pool === 'green' ? 'Green' : p.pool === 'blue' ? 'Blue' : '—') : '—'}</td>
              <td>${p ? (p.position || '—') : '—'}</td>
              <td class="ovr">${p ? p.overall : '—'}</td>
              <td class="muted" style="font-size:0.75rem">${escapeHtml(e.source)}</td>
            </tr>`;
        }).join('')
      : `<tr><td colspan="6" class="muted" style="padding:0.75rem">No players.</td></tr>`;

    return `
      <div class="roster-card ${isOverCap ? 'roster-card--over' : ''}">
        <div class="roster-card-header">
          <span class="roster-card-name">${escapeHtml(participant.name)}</span>
          <span class="roster-card-count">${rosterEntries.length} player${rosterEntries.length !== 1 ? 's' : ''}</span>
        </div>

        <!-- Rating bar -->
        <div class="cap-bar-wrap">
          <div class="cap-bar-labels">
            <span class="cap-bar-current ${isOverCap ? 'cap-over-text' : ''}">${totalRating} OVR</span>
            <span class="cap-bar-cap">cap: ${cap}</span>
          </div>
          <div class="cap-bar-track">
            <div class="cap-bar-fill ${barClass}" style="width:${pct.toFixed(1)}%"></div>
          </div>
          <div class="cap-bar-remaining ${isOverCap ? 'cap-over-text' : ''}">
            ${isOverCap
              ? `⚠ Over cap by ${totalRating - cap}`
              : `${remaining} remaining`}
          </div>
        </div>

        <!-- Player table -->
        <div class="table-scroll">
        <table class="roster-table">
          <thead>
            <tr><th>#</th><th>Player</th><th>Pool</th><th>Pos</th><th>OVR</th><th>Source</th></tr>
          </thead>
          <tbody>${playerRows}</tbody>
        </table>
        </div>
      </div>`;
  },

  _bindEvents(container, season) {
    // Update rating cap
    container.querySelector('#btnSaveCap').onclick = () => {
      AuthBoundary.requireAuth();
      const val = parseInt(container.querySelector('#ratingCapInput').value, 10);
      if (isNaN(val) || val < 1) { showToast('Enter a valid cap value.', 'error'); return; }
      try {
        AdminActions.setRatingCap(season.id, val);
        showToast(`Rating cap set to ${val}.`, 'success');
        AdminApp.renderView('roster');
      } catch (e) {
        showToast(e.message, 'error');
      }
    };

    // Initialize rosters
    container.querySelector('#btnInitRosters').onclick = () => {
      AuthBoundary.requireAuth();
      const season2 = LeagueData.getCurrentSeason();
      if (season2?.rostersInitialized) {
        if (!confirm('Re-initialize rosters from draft picks? Any manual changes to rosters will be lost.')) return;
      }
      try {
        AdminActions.initializeRostersFromDraft(season.id);
        showToast('Rosters initialized from draft picks.', 'success');
        AdminApp.renderView('roster');
      } catch (e) {
        showToast(e.message, 'error');
      }
    };
  },
};
