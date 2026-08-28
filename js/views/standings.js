/**
 * views/standings.js — Public standings & statistics view.
 *
 * Fully read-only, fully derived from LeagueData.getTeamStatistics /
 * getStreamerStatistics on every render — nothing is stored here or
 * anywhere in the data layer, so an edited match result (via the admin
 * Schedule page) is reflected the next time this view renders, with no
 * separate "update standings" step.
 *
 * Ranking: Win % descending, then Point Differential descending — the
 * only ranking rule this league defines. Equal Win% AND equal PD rows
 * are shown with the same rank number rather than an invented ordering.
 */
const StandingsView = {
  render(container) {
    const season = LeagueData.getCurrentSeason();
    if (!season) {
      container.innerHTML = `
        <div class="empty-state future">
          <div class="empty-icon">📊</div>
          <h2>Standings</h2>
          <p>No active season yet.</p>
        </div>`;
      return;
    }

    const stats = LeagueData.getTeamStatistics(season.id);
    if (!stats.length) {
      container.innerHTML = `
        <div class="empty-state future">
          <div class="empty-icon">📊</div>
          <h2>Standings</h2>
          <p>Standings will appear here once teams are assigned and games are played.</p>
        </div>`;
      return;
    }

    const streamers = LeagueData.getStreamerStatistics(season.id);

    // Assign display rank: ties on BOTH Win% and PD share a rank number,
    // since no further tie-breaker exists for this league.
    let rank = 0;
    const rows = stats.map((s, i) => {
      const prev = stats[i - 1];
      const isTie = prev && prev.winPct === s.winPct && prev.pointDifferential === s.pointDifferential;
      if (!isTie) rank = i + 1;
      return { ...s, rank };
    });

    container.innerHTML = `
      <div class="standings-view" style="max-width:none;">
        <h2 class="section-title">Standings</h2>

        ${this._renderGroupStageSection(season)}

        <!-- Desktop/tablet: full table (hidden below 700px, see main.css) -->
        <div class="standings-table-wrap table-scroll">
          <table class="standings-table" id="teamStandingsTable">
            <thead>
              <tr>
                <th>#</th><th>NBA Team</th><th>Participant</th>
                <th>GP</th><th>W</th><th>L</th><th>Win%</th>
                <th>PF</th><th>PA</th><th>PD</th><th>Rem</th>
              </tr>
            </thead>
            <tbody>
              ${rows.map((s) => `
                <tr>
                  <td class="${s.rank <= 4 ? 'standings-abbr' : ''}">${s.rank}</td>
                  <td>${teamBadge(s.nbaTeam, { size: 'sm' })}</td>
                  <td>${escapeHtml(s.participantName || '—')}</td>
                  <td>${s.gamesPlayed}</td>
                  <td>${s.wins}</td>
                  <td>${s.losses}</td>
                  <td>${(s.winPct * 100).toFixed(1)}%</td>
                  <td>${s.pointsFor}</td>
                  <td>${s.pointsAgainst}</td>
                  <td class="${s.pointDifferential > 0 ? 'pd-pos' : s.pointDifferential < 0 ? 'pd-neg' : ''}">
                    ${s.pointDifferential > 0 ? '+' : ''}${s.pointDifferential}
                  </td>
                  <td>${s.gamesRemaining}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>

        <!-- Mobile: stacked cards, same data + same rank/PD emphasis (see main.css @700px) -->
        <div class="standings-cards">
          ${rows.map((s) => `
            <div class="standings-card">
              <span class="standings-card-rank ${s.rank <= 4 ? 'top4' : ''}">${s.rank}</span>
              ${teamBadge(s.nbaTeam, { size: 'md' })}
              <div class="standings-card-main">
                <div class="standings-card-owner">${escapeHtml(s.participantName || '—')}</div>
                <div class="standings-card-record">${s.wins}-${s.losses} · ${(s.winPct * 100).toFixed(1)}% · ${s.gamesPlayed} GP</div>
              </div>
              <span class="standings-card-pd ${s.pointDifferential > 0 ? 'pd-pos' : s.pointDifferential < 0 ? 'pd-neg' : ''}">
                ${s.pointDifferential > 0 ? '+' : ''}${s.pointDifferential}
              </span>
            </div>`).join('')}
        </div>

        <p class="helper-text">Ranked by Win%, then Point Differential. BYEs and unplayed games are excluded from every column.</p>

        ${streamers.length ? `
        <h3 class="section-title" style="margin-top:2rem">Streamer Leaderboard</h3>
        <div class="table-scroll">
          <table class="standings-table streamer-table" id="streamerTable">
            <thead><tr><th>Streamer</th><th>Games Streamed</th></tr></thead>
            <tbody>
              ${streamers.map((s) => `
                <tr><td>${escapeHtml(s.streamer)}</td><td>${s.gamesStreamed}</td></tr>`).join('')}
            </tbody>
          </table>
        </div>` : ''}
      </div>`;
  },

  /**
   * Group Stage only: shows the current stage's per-group standings above
   * the combined final table above (which already correctly reflects the
   * combined 6-game record once both stages exist — untouched). Returns
   * '' for a Round Robin season, so that season's rendering is byte-for-
   * byte what it always was.
   */
  _renderGroupStageSection(season) {
    if (season.scheduleFormat !== 'groupStage' || !season.groupStageState) return '';
    const gs = season.groupStageState;
    const standings = LeagueData.getGroupStageStandings(season.id, gs.stage);
    if (!standings) return '';

    return `
      <h3 class="section-title" style="margin-bottom:0.5rem;">
        Group Stage — Stage ${gs.stage} of 2
      </h3>
      <div class="standings-cards" style="display:flex;gap:0.75rem;flex-wrap:wrap;margin-bottom:1.5rem;">
        ${['A', 'B', 'C', 'D'].map((g) => `
          <div class="standings-table-wrap table-scroll" style="min-width:220px;flex:1;">
            <table class="standings-table">
              <thead><tr><th colspan="4">Group ${g}</th></tr>
                <tr><th>#</th><th>Team</th><th>W-L</th><th>PD</th></tr>
              </thead>
              <tbody>
                ${(standings[g] || []).map((row, i) => `
                  <tr>
                    <td>${i + 1}</td>
                    <td>${teamBadge(row.nbaTeam, { size: 'sm' })} ${escapeHtml(row.participantName || '—')}</td>
                    <td>${row.wins}-${row.losses}</td>
                    <td class="${row.pointDifferential > 0 ? 'pd-pos' : row.pointDifferential < 0 ? 'pd-neg' : ''}">
                      ${row.pointDifferential > 0 ? '+' : ''}${row.pointDifferential}
                    </td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>`).join('')}
      </div>
      <p class="helper-text">
        ${gs.stage === 1
          ? 'Round 1 group standings — final position determines each team\'s seed for the Round 2 re-seeded groups.'
          : 'Round 2 group standings (re-seeded from Round 1). The combined final standings across both stages are below.'}
      </p>`;
  },
};
