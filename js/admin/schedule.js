/**
 * admin/schedule.js
 *
 * Phase 7 — Regular Season Scheduler + Match Results.
 *
 * Generates a round-robin schedule from the existing NBA Team Assignment
 * data (Phase 3) and lets the admin enter/edit scores + streamer per
 * matchup. Does NOT implement standings — see Phase 8.
 */
const AdminScheduleView = {
  _selectedRound: 1,

  render(container) {
    const season = LeagueData.getCurrentSeason();
    if (!season) {
      container.innerHTML = `<div class="empty-state"><p>No current season.</p></div>`;
      return;
    }

    if (!season.teamAssignmentComplete) {
      container.innerHTML = `
        <div class="empty-state">
          <p>Complete NBA Team Assignment before generating the schedule.</p>
          <button class="btn btn-primary" data-action="goTeamAssignment">Go to Team Assignment</button>
        </div>`;
      container.querySelector('[data-action="goTeamAssignment"]').onclick =
        () => AdminApp.renderView('teamAssignment');
      return;
    }

    const state = LeagueData.getScheduleState(season.id);

    if (!state.generated) {
      container.innerHTML = `
        <div class="admin-section">
          <div class="admin-section-header">
            <h2>Regular Season Schedule — ${escapeHtml(season.name)}</h2>
          </div>
          <div class="empty-state">
            <p>No schedule has been generated yet. This will create a single
              round-robin schedule from the ${Object.keys(season.nbaTeamAssignments).length}
              assigned NBA teams.</p>
            <button class="btn btn-primary" data-action="generate">Generate Schedule</button>
          </div>
        </div>`;
      container.querySelector('[data-action="generate"]').onclick = () => {
        AuthBoundary.requireAuth();
        try {
          AdminActions.generateSchedule(season.id);
          showToast('Schedule generated.', 'success');
          this._selectedRound = 1;
          this.render(container);
        } catch (e) {
          showToast(e.message, 'error');
        }
      };
      return;
    }

    this._renderGenerated(container, season, state);
  },

  _renderGenerated(container, season, state) {
    const rounds = LeagueData.getSchedule(season.id);
    if (!rounds.find((r) => r.round === this._selectedRound)) {
      this._selectedRound = rounds[0].round;
    }
    const activeRound = rounds.find((r) => r.round === this._selectedRound);
    const generatedDate = state.generatedAt
      ? new Date(state.generatedAt).toLocaleString()
      : '';

    container.innerHTML = `
      <div class="admin-section">
        <div class="admin-section-header">
          <h2>Regular Season Schedule — ${escapeHtml(season.name)}</h2>
          <button class="btn btn-sm btn-ghost" data-action="regenerate"
            ${state.hasCompletedGames ? 'disabled title="Regeneration is disabled once any game has been completed."' : ''}>
            Regenerate Schedule
          </button>
        </div>
        <p class="helper-text">
          Generated ${generatedDate} — ${state.totalRounds} rounds,
          ${state.completedCount} of ${state.realMatchupCount} games completed.
        </p>

        <div class="round-tabs" id="roundTabs">
          ${rounds.map((r) => `
            <button class="round-tab ${r.round === this._selectedRound ? 'active' : ''}" data-round="${r.round}">
              Round ${r.round}
            </button>`).join('')}
        </div>

        <div class="matchup-list" id="matchupList">
          ${activeRound.matchups.map((m) => this._renderMatchupRow(season, m)).join('')}
        </div>

        <div id="scorePanel" class="score-panel hidden"></div>
      </div>`;

    container.querySelector('#roundTabs').addEventListener('click', (e) => {
      const btn = e.target.closest('.round-tab');
      if (!btn) return;
      this._selectedRound = Number(btn.dataset.round);
      this._renderGenerated(container, season, state);
    });

    container.querySelector('[data-action="regenerate"]')?.addEventListener('click', () => {
      if (state.hasCompletedGames) return;
      if (!confirm('Regenerate the schedule? This replaces all currently scheduled (not-yet-played) matchups.')) return;
      AuthBoundary.requireAuth();
      try {
        AdminActions.generateSchedule(season.id);
        showToast('Schedule regenerated.', 'success');
        this._selectedRound = 1;
        this.render(container);
      } catch (e) {
        showToast(e.message, 'error');
      }
    });

    container.querySelectorAll('[data-action="enter-score"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this._openScorePanel(container, season, btn.dataset.matchupId);
      });
    });
  },

  _renderMatchupRow(season, m) {
    const nameFor = (pid) => {
      if (!pid) return null;
      const p = season.participants[pid];
      const abbr = season.nbaTeamAssignments[pid];
      return `${teamBadge(abbr, { size: 'sm' })}<span>${escapeHtml(p?.name || '')}</span>`;
    };

    if (m.teamB === null) {
      return `
        <div class="matchup-row bye">
          <span class="matchup-teams">${nameFor(m.teamA)}</span>
          <span class="matchup-status status-chip status-bye">BYE</span>
        </div>`;
    }

    const isCompleted = m.status === 'completed';
    return `
      <div class="matchup-row ${isCompleted ? 'completed' : ''}">
        <div class="matchup-teams">
          <span class="${m.winner === m.teamA ? 'winner' : ''}">${nameFor(m.teamA)}</span>
          <span class="matchup-vs">vs</span>
          <span class="${m.winner === m.teamB ? 'winner' : ''}">${nameFor(m.teamB)}</span>
        </div>
        ${isCompleted ? `
          <div class="matchup-result">
            <span class="matchup-score">${m.scoreA} – ${m.scoreB}</span>
            <span class="matchup-streamer">🎥 ${escapeHtml(m.streamer)}</span>
          </div>
          <button class="btn btn-sm btn-ghost" data-action="enter-score" data-matchup-id="${m.id}">Edit</button>
        ` : `
          <span class="matchup-status status-chip status-scheduled">Scheduled</span>
          <button class="btn btn-sm btn-primary" data-action="enter-score" data-matchup-id="${m.id}">Enter Score</button>
        `}
      </div>`;
  },

  _openScorePanel(container, season, matchupId) {
    const found = LeagueData.getMatchup(season.id, matchupId);
    if (!found) return;
    const { matchup: m } = found;
    const nameFor = (pid) => season.participants[pid]?.name || '—';

    const panel = container.querySelector('#scorePanel');
    panel.classList.remove('hidden');
    panel.innerHTML = `
      <h4>${escapeHtml(nameFor(m.teamA))} vs ${escapeHtml(nameFor(m.teamB))}</h4>
      <div class="score-entry-row">
        <div class="form-group">
          <label>${escapeHtml(nameFor(m.teamA))} Score</label>
          <input type="number" min="0" step="1" class="input" id="scoreAInput" value="${m.scoreA ?? ''}">
        </div>
        <div class="form-group">
          <label>${escapeHtml(nameFor(m.teamB))} Score</label>
          <input type="number" min="0" step="1" class="input" id="scoreBInput" value="${m.scoreB ?? ''}">
        </div>
      </div>
      <div class="form-group">
        <label>Streamer</label>
        <input type="text" class="input" id="streamerInput" value="${m.streamer ? escapeHtml(m.streamer) : ''}" placeholder="Who streamed this game?">
      </div>
      <p id="scoreError" class="error-text"></p>
      <div class="form-actions">
        <button class="btn btn-primary" id="btnSaveScore">Save Result</button>
        <button class="btn btn-ghost" id="btnCancelScore">Cancel</button>
      </div>`;

    panel.querySelector('#btnCancelScore').onclick = () => panel.classList.add('hidden');
    panel.querySelector('#btnSaveScore').onclick = () => {
      AuthBoundary.requireAuth();
      const scoreA = panel.querySelector('#scoreAInput').value;
      const scoreB = panel.querySelector('#scoreBInput').value;
      const streamer = panel.querySelector('#streamerInput').value;
      try {
        AdminActions.recordMatchResult(season.id, matchupId, { scoreA, scoreB, streamer });
        showToast('Result saved.', 'success');
        this.render(container);
      } catch (e) {
        panel.querySelector('#scoreError').textContent = e.message;
      }
    };
  },
};
