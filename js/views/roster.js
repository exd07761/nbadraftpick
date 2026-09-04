/**
 * views/roster.js — Public "All Rosters" view (Phase 10.4 redesign;
 * Public Old Season Roster Viewer revision).
 *
 * Read-only. No writes. Safe to include on index.html.
 *
 * This is now the ONE public roster presentation — every participant's
 * roster renders as its own card in a single responsive grid (no
 * sidebar/detail split, no second roster UI anywhere else on the public
 * site; the Teams page no longer shows roster data — see views/teams.js).
 *
 * Uses LeagueData.getRosterSummary(seasonId) exactly as the previous
 * sidebar version did — same data, same cap/remaining/isOverCap
 * calculation, same rosterEntries shape ({ playerId, source, player }).
 * This file only changes how that data is laid out.
 *
 * Old-season viewer: visitors can pick any season from
 * LeagueData.getAllSeasons() via the header dropdown; everything for the
 * selected season (roster summary, NBA team assignments, rating cap,
 * participant order) is re-fetched from that season only, exactly the
 * way LeagueData.getRosterSummary/getCurrentRoster already fall back to
 * a season's own draft picks when rostersInitialized is still false —
 * this view never branches on that flag itself, it just always asks for
 * the selected season's data and lets the data layer decide. No new
 * storage, no route, and no write path — this only changes what
 * `_selectedSeasonId` is passed into the existing read-only getters.
 *
 * Selection is kept as view-local state (`_selectedSeasonId`) rather
 * than a URL/query param, per the feature brief. It is re-validated on
 * every render() (see _resolveSeasonId): a season that's gone (deleted,
 * or simply never selected yet) always falls back to
 * LeagueData.getCurrentSeasonId(), so a stale/invalid id can never stick
 * around — including across a FirebaseSync remote-change refresh (same
 * render() call) or a navigate-away-and-back (a fresh call with
 * container cleared, same validation logic).
 */
const PublicRosterView = {
  _selectedSeasonId: null,

  /**
   * Resolves which season id this render should use: the requested one
   * if it still exists among `seasons`, otherwise the season's current
   * default. Pure/side-effect-free so it's directly testable.
   */
  _resolveSeasonId(seasons, requestedSeasonId, currentSeasonId) {
    if (requestedSeasonId && seasons.some((s) => s.id === requestedSeasonId)) {
      return requestedSeasonId;
    }
    return currentSeasonId;
  },

  render(container) {
    const seasons = LeagueData.getAllSeasons();
    if (!seasons.length) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">📋</div>
          <h2>No Active Season</h2>
          <p>Check back once the commissioner has set up a season.</p>
        </div>`;
      return;
    }

    const currentSeasonId = LeagueData.getCurrentSeasonId();
    this._selectedSeasonId = this._resolveSeasonId(seasons, this._selectedSeasonId, currentSeasonId);
    const selectedSeasonId = this._selectedSeasonId;
    const season = LeagueData.getSeason(selectedSeasonId);

    if (!season) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">📋</div>
          <h2>No Active Season</h2>
          <p>Check back once the commissioner has set up a season.</p>
        </div>`;
      return;
    }

    const summary = LeagueData.getRosterSummary(selectedSeasonId);
    const cap = season.ratingCap ?? 875;
    const assignments = LeagueData.getNBATeamAssignments(selectedSeasonId);
    const isCurrent = selectedSeasonId === currentSeasonId;
    const header = this._renderHeader(seasons, season, cap, isCurrent);

    if (!summary.length) {
      container.innerHTML = `
        <div class="all-rosters-view" style="max-width:none;">
          ${header}
          <div class="empty-state">
            <div class="empty-icon">👥</div>
            <h2>No Teams Yet</h2>
            <p>Teams will appear here once the commissioner sets up the season.</p>
          </div>
        </div>`;
      this._bindSeasonSelect(container);
      return;
    }

    container.innerHTML = `
      <div class="all-rosters-view" style="max-width:none;">
        ${header}

        <div class="roster-card-grid">
          ${summary.map(s => this._renderRosterCard(s, cap, assignments[s.participant.id])).join('')}
        </div>
      </div>`;

    this._bindSeasonSelect(container);
  },

  _renderHeader(seasons, season, cap, isCurrent) {
    const hasMultiple = seasons.length > 1;
    return `
      <div class="all-rosters-header">
        <h1 class="all-rosters-title">All Rosters</h1>
        <label class="all-rosters-season-label" for="rosterSeasonSelect">
          Season:
          <select id="rosterSeasonSelect" class="all-rosters-season-picker" ${hasMultiple ? '' : 'disabled'}>
            ${seasons.map(s => `<option value="${escapeHtml(s.id)}" ${s.id === season.id ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}
          </select>
        </label>
        ${!isCurrent ? '<span class="all-rosters-old-season-badge">Past season</span>' : ''}
        <span class="all-rosters-cap-note">cap: ${cap} OVR per roster</span>
      </div>`;
  },

  _bindSeasonSelect(container) {
    const select = container.querySelector('#rosterSeasonSelect');
    if (!select) return;
    select.addEventListener('change', (e) => {
      this._selectedSeasonId = e.target.value;
      this.render(container);
    });
  },

  _renderRosterCard(s, cap, abbr) {
    const { participant, rosterEntries, totalRating, remaining, isOverCap } = s;
    const pct = cap > 0 ? Math.min(100, (totalRating / cap) * 100) : 0;
    const barClass = isOverCap ? 'cap-bar-fill--over'
      : pct >= 85 ? 'cap-bar-fill--warn'
      : 'cap-bar-fill--ok';

    return `
      <div class="roster-card">
        <div class="roster-card-head">
          <span class="roster-card-name">${escapeHtml(participant.name)}</span>
          <span class="roster-card-count">${rosterEntries.filter(e => e.player).length} player${rosterEntries.filter(e => e.player).length !== 1 ? 's' : ''}</span>
        </div>
        <div class="roster-card-team">
          ${teamBadge(abbr, { size: 'lg', showName: true })}
        </div>

        <div class="roster-card-cap">
          <div class="roster-card-cap-labels">
            <span class="roster-card-ovr-total ${isOverCap ? 'cap-over-text' : ''}">${totalRating} OVR</span>
            <span class="roster-card-cap-value">cap: ${cap}</span>
          </div>
          <div class="cap-bar-track">
            <div class="cap-bar-fill ${barClass}" style="width:${pct.toFixed(1)}%"></div>
          </div>
          <div class="roster-card-remaining ${isOverCap ? 'cap-over-text' : ''}">
            ${isOverCap ? `⚠ ${Math.abs(remaining)} over cap` : `${remaining} remaining`}
          </div>
        </div>

        ${rosterEntries.length ? `
        <div class="table-scroll">
        <table class="roster-table roster-card-table">
          <thead>
            <tr>
              <th>Pick #</th><th>Player</th><th>Pool</th><th>Color</th><th>Pos</th><th>OVR</th><th>Source</th>
            </tr>
          </thead>
          <tbody>
            ${rosterEntries.map((e) => {
              const p = e.player;
              const slotLabel = e.draftSlot != null ? e.draftSlot : '—';
              if (e.source === 'empty') {
                return `
                  <tr class="roster-row-empty">
                    <td>${slotLabel}</td>
                    <td colspan="6" class="muted"><em>EMPTY — draft slot vacated</em></td>
                  </tr>`;
              }
              return `
                <tr>
                  <td>${slotLabel}</td>
                  <td>${p ? escapeHtml(p.name) : '<span class="muted">(removed)</span>'}</td>
                  <td>${p ? (p.pool === 'green' ? 'Green' : p.pool === 'blue' ? 'Blue' : '—') : '—'}</td>
                  <td>${classificationBadge(e.isJoker ? 'PINK' : e.classification)}</td>
                  <td>${p ? escapeHtml(e.effectivePosition || p.position || '—') : '—'}${e.isJoker ? ' <span title="Joker-assigned position">🃏</span>' : ''}</td>
                  <td class="ovr">${p ? p.overall : '—'}</td>
                  <td class="roster-card-source">${escapeHtml(e.source || '—')}</td>
                </tr>`;
            }).join('')}
          </tbody>
        </table>
        </div>` : `
        <div class="empty-roster">
          <p>No players on this roster yet.</p>
        </div>`}
      </div>`;
  },
};
