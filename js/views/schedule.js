/**
 * views/schedule.js — Public regular-season schedule view.
 *
 * Read-only mirror of the admin scheduler (js/admin/schedule.js): round
 * tabs, matchups, and completed results (score + streamer). No write
 * operations occur here.
 */
const ScheduleView = {
  _selectedRound: 1,

  render(container) {
    const season = LeagueData.getCurrentSeason();
    if (!season) {
      container.innerHTML = `
        <div class="empty-state future">
          <div class="empty-icon">📅</div>
          <h2>Schedule</h2>
          <p>No active season yet.</p>
        </div>`;
      return;
    }

    const rounds = LeagueData.getSchedule(season.id);
    if (!rounds.length) {
      container.innerHTML = `
        <div class="empty-state future">
          <div class="empty-icon">📅</div>
          <h2>Schedule</h2>
          <p>The regular-season schedule will appear here once the commissioner generates it.</p>
          <span class="coming-soon">Not yet generated</span>
        </div>`;
      return;
    }

    if (!rounds.find((r) => r.round === this._selectedRound)) {
      this._selectedRound = rounds[0].round;
    }
    const activeRound = rounds.find((r) => r.round === this._selectedRound);
    const isGroupStage = season.scheduleFormat === 'groupStage';
    const activeStage = activeRound.matchups[0]?.stage || null;

    container.innerHTML = `
      <div class="schedule-view" style="max-width:none;">
        <h2 class="section-title">Regular Season Schedule${isGroupStage ? ' — Group Stage' : ''}</h2>
        ${isGroupStage ? `<p class="helper-text">Stage ${activeStage} of 2 — 4 groups of 4, 3 games/team per stage.</p>` : ''}

        <div class="round-tabs" id="roundTabs">
          ${rounds.map((r) => `
            <button class="round-tab ${r.round === this._selectedRound ? 'active' : ''}" data-round="${r.round}">
              Round ${r.round}${isGroupStage ? ` · Stage ${r.matchups[0]?.stage || ''}` : ''}
            </button>`).join('')}
        </div>

        <div class="schedule-grid">
          ${activeRound.matchups.map((m) => this._renderMatchupCard(season, m)).join('')}
        </div>
      </div>`;

    container.querySelector('#roundTabs').addEventListener('click', (e) => {
      const btn = e.target.closest('.round-tab');
      if (!btn) return;
      this._selectedRound = Number(btn.dataset.round);
      this.render(container);
    });
  },

  _renderMatchupCard(season, m) {
    const nameFor = (pid) => pid ? escapeHtml(season.participants[pid]?.name || '') : '';
    const abbrFor = (pid) => pid ? season.nbaTeamAssignments[pid] : null;

    if (m.teamB === null) {
      return `
        <div class="matchup-card is-bye">
          <div class="matchup-card-top">
            <span class="matchup-card-status status-bye">BYE</span>
          </div>
          <div class="matchup-card-body">
            ${teamBadge(abbrFor(m.teamA), { size: 'md', showName: false })}
            <span>${nameFor(m.teamA)} sits out this round</span>
          </div>
        </div>`;
    }

    const isCompleted = m.status === 'completed';
    const aWins = m.winner === m.teamA;
    const bWins = m.winner === m.teamB;

    return `
      <div class="matchup-card ${isCompleted ? 'is-completed' : ''}">
        <div class="matchup-card-top">
          <span class="matchup-card-status ${isCompleted ? 'status-complete' : 'status-scheduled'}">
            ${isCompleted ? 'Final' : 'Scheduled'}
          </span>
          ${m.group ? `<span class="matchup-card-streamer">Group ${m.group}</span>` : ''}
          ${isCompleted ? `<span class="matchup-card-streamer">🎥 ${escapeHtml(m.streamer)}</span>` : ''}
        </div>
        <div class="matchup-card-body">
          <div class="matchup-side ${aWins ? 'winner' : ''}">
            ${teamBadge(abbrFor(m.teamA), { size: 'md' })}
            <span class="matchup-side-name">${nameFor(m.teamA)}</span>
            ${isCompleted ? `<span class="matchup-side-score">${m.scoreA}</span>` : ''}
          </div>
          <span class="matchup-vs-divider">${isCompleted ? '–' : 'VS'}</span>
          <div class="matchup-side reverse ${bWins ? 'winner' : ''}">
            ${isCompleted ? `<span class="matchup-side-score">${m.scoreB}</span>` : ''}
            <span class="matchup-side-name">${nameFor(m.teamB)}</span>
            ${teamBadge(abbrFor(m.teamB), { size: 'md' })}
          </div>
        </div>
      </div>`;
  },
};
