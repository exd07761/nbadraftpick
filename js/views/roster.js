/**
 * views/roster.js — Public "All Rosters" view (Phase 10.4 redesign).
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
 */
const PublicRosterView = {
  render(container) {
    const season = LeagueData.getCurrentSeason();
    if (!season) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">📋</div>
          <h2>No Active Season</h2>
          <p>Check back once the commissioner has set up a season.</p>
        </div>`;
      return;
    }

    const summary = LeagueData.getRosterSummary(season.id);
    const cap = season.ratingCap ?? 875;
    const assignments = LeagueData.getNBATeamAssignments(season.id);

    if (!summary.length) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">👥</div>
          <h2>No Teams Yet</h2>
          <p>Teams will appear here once the commissioner sets up the season.</p>
        </div>`;
      return;
    }

    container.innerHTML = `
      <div class="all-rosters-view" style="max-width:none;">
        <div class="all-rosters-header">
          <h1 class="all-rosters-title">All Rosters</h1>
          <span class="all-rosters-cap-note">cap: ${cap} OVR per roster</span>
        </div>

        <div class="roster-card-grid">
          ${summary.map(s => this._renderRosterCard(s, cap, assignments[s.participant.id])).join('')}
        </div>
      </div>`;
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
          <span class="roster-card-count">${rosterEntries.length} player${rosterEntries.length !== 1 ? 's' : ''}</span>
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
              <th>#</th><th>Player</th><th>Pool</th><th>Pos</th><th>OVR</th><th>Source</th>
            </tr>
          </thead>
          <tbody>
            ${rosterEntries.map((e, i) => {
              const p = e.player;
              return `
                <tr>
                  <td>${i + 1}</td>
                  <td>${p ? escapeHtml(p.name) : '<span class="muted">(removed)</span>'}</td>
                  <td>${p ? (p.pool === 'green' ? 'Green' : p.pool === 'blue' ? 'Blue' : '—') : '—'}</td>
                  <td>${p ? (p.position || '—') : '—'}</td>
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
