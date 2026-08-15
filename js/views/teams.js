/**
 * views/teams.js — Public Teams view (Phase 10.4: roster table removed).
 *
 * Focused on the NBA team itself — logo, name, and the participant who
 * owns it. Roster/player-list data now lives in exactly one place on the
 * public site: the Rosters page (views/roster.js, "All Rosters"). This
 * file no longer calls LeagueData.getParticipantRoster() or renders a
 * player table.
 */
const TeamsView = {
  _selectedParticipantId: null,
  _selectedSeasonId: null,

  render(container) {
    const season = LeagueData.getCurrentSeason();
    if (!season) {
      container.innerHTML = `<div class="empty-state"><div class="empty-icon">🏀</div><h2>No Active Season</h2></div>`;
      return;
    }

    this._selectedSeasonId = season.id;
    const participants = LeagueData.getParticipants(season.id);
    const assignments = LeagueData.getNBATeamAssignments(season.id);

    if (!participants.length) {
      container.innerHTML = `<div class="empty-state"><div class="empty-icon">👥</div><h2>No Teams Yet</h2><p>Teams will appear here once the commissioner sets up the season.</p></div>`;
      return;
    }

    if (!this._selectedParticipantId || !participants.find(p => p.id === this._selectedParticipantId)) {
      this._selectedParticipantId = participants[0].id;
    }

    container.innerHTML = `
      <div class="teams-layout">
        <aside class="teams-sidebar">
          <h2 class="section-title">Teams</h2>
          <ul class="team-list" id="teamList">
            ${participants.map(p => {
              const abbr = assignments[p.id];
              return `
                <li class="team-list-item ${p.id === this._selectedParticipantId ? 'selected' : ''}"
                    data-id="${p.id}">
                  ${teamBadge(abbr, { size: 'sm' })}
                  <span class="list-owner">${escapeHtml(p.name)}</span>
                </li>`;
            }).join('')}
          </ul>
        </aside>
        <main class="team-detail-panel" id="teamDetailPanel">
          ${this._renderTeamDetail(season.id, this._selectedParticipantId)}
        </main>
      </div>`;

    container.querySelector('#teamList').addEventListener('click', e => {
      const item = e.target.closest('.team-list-item');
      if (!item) return;
      this._selectedParticipantId = item.dataset.id;
      container.querySelectorAll('.team-list-item').forEach(el => el.classList.remove('selected'));
      item.classList.add('selected');
      container.querySelector('#teamDetailPanel').innerHTML = this._renderTeamDetail(season.id, this._selectedParticipantId);
      this._bindRosterLink(container);
    });

    this._bindRosterLink(container);
  },

  _bindRosterLink(container) {
    const link = container.querySelector('.team-detail-roster-link a[data-route="rosters"]');
    link?.addEventListener('click', e => {
      e.preventDefault();
      navigate('rosters');
    });
  },

  _renderTeamDetail(seasonId, participantId) {
    const participant = LeagueData.getParticipant(seasonId, participantId);
    if (!participant) return '';

    const assignments = LeagueData.getNBATeamAssignments(seasonId);
    const abbr = assignments[participantId];
    const team = abbr ? LeagueData.getNBATeam(abbr) : null;

    return `
      <div class="team-detail-hero">
        ${teamBadge(abbr, { size: 'lg' })}
        <div class="team-detail-id">
          ${team
            ? `<div class="team-detail-name">${escapeHtml(team.name)}</div>`
            : `<div class="team-detail-name muted">No NBA Team Assigned</div>`}
          <div class="team-detail-owner">Owned by ${escapeHtml(participant.name)}</div>
        </div>
      </div>

      ${team ? `
      <div class="team-detail-facts">
        <div class="team-detail-fact">
          <span class="team-detail-fact-label">Abbreviation</span>
          <span class="team-detail-fact-value">${escapeHtml(team.abbr)}</span>
        </div>
        <div class="team-detail-fact">
          <span class="team-detail-fact-label">Team Color</span>
          <span class="team-detail-fact-value">
            <span class="team-color-swatch" style="background:${team.color};"></span>
            ${escapeHtml(team.color)}
          </span>
        </div>
      </div>
      <p class="team-detail-roster-link">
        Looking for ${escapeHtml(participant.name)}'s drafted players?
        <a data-route="rosters" href="#rosters">View all rosters →</a>
      </p>` : `
      <div class="empty-roster">
        <p>This participant hasn't been assigned an NBA team yet.</p>
      </div>`}`;
  },
};
