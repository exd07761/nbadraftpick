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

    // Group Stage standings are scoped to Stage + Group (see
    // _renderGroupStageSection) and must never be combined into one
    // season-wide table — that would rank teams from different groups
    // against each other, which this league does not define. The
    // combined table/cards below are Round Robin only.
    const isGroupStage = season.scheduleFormat === 'groupStage' && !!season.groupStageState;

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

        ${isGroupStage ? '' : `
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
        `}

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

    // Group Stage only: the group cards' collapse/expand toggle (mobile
    // only — see the .is-collapsed rule, which only exists inside the
    // ≤700px media query in css/main.css, so this click handler has no
    // visible effect at all above that width).
    if (isGroupStage) {
      container.querySelectorAll('.group-card-summary').forEach((el) => {
        el.addEventListener('click', () => this._toggleGroupCard(el));
        el.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this._toggleGroupCard(el); }
        });
      });
    }
  },

  _toggleGroupCard(summaryEl) {
    const card = summaryEl.closest('.group-card');
    const collapsed = card.classList.toggle('is-collapsed');
    summaryEl.setAttribute('aria-expanded', String(!collapsed));
  },

  /**
   * Group Stage only: renders every stage that has data (Stage 1, and
   * Stage 2 once it's been generated) as its own row of 4 independent
   * Group tables — Stage → Group → Team, never combined across groups
   * or across stages. Each table's standings come straight from
   * LeagueData.getGroupStageStandings(seasonId, stage), which already
   * scopes matchups to that exact stage + group (see data.js) — this
   * function does no filtering of its own.
   *
   * Returns '' for a Round Robin season, so that season's rendering is
   * byte-for-byte what it always was. If Stage 2 doesn't exist yet for
   * an existing Group Stage season, only Stage 1 is rendered — nothing
   * is fabricated.
   */
  _renderGroupStageSection(season) {
    if (season.scheduleFormat !== 'groupStage' || !season.groupStageState) return '';

    let hasStage2 = false;
    const stageSections = [1, 2].map((stageNum) => {
      const standings = LeagueData.getGroupStageStandings(season.id, stageNum);
      if (!standings) return '';
      if (stageNum === 2) hasStage2 = true;

      return `
        <h4 class="section-title" style="font-size:0.95rem;margin:${stageNum === 1 ? '0' : '1.25rem'} 0 0.5rem;">
          Stage ${stageNum}
        </h4>
        <div class="group-stage-grid" style="margin-bottom:0.5rem;">
          ${['A', 'B', 'C', 'D'].map((g) => {
            const expanded = g === 'A' || g === 'B';
            return `
            <div class="group-card${expanded ? '' : ' is-collapsed'}">
              <div class="group-card-summary" role="button" tabindex="0" aria-expanded="${expanded}">Group ${g}</div>
              <div class="group-card-body">
                <div class="table-scroll">
                  <table class="standings-table group-standings-table">
                    <thead>
                      <tr><th>#</th><th>Team</th><th>W</th><th>L</th><th>+/-</th></tr>
                    </thead>
                    <tbody>
                      ${(standings[g] || []).map((row, i) => `
                        <tr>
                          <td>${i + 1}</td>
                          <td>
                            <div class="group-team-cell">
                              ${teamBadge(row.nbaTeam, { size: 'sm' })}
                              <span class="group-team-name">${escapeHtml(row.participantName || '—')}</span>
                            </div>
                          </td>
                          <td>${row.wins}</td>
                          <td>${row.losses}</td>
                          <td class="${row.pointDifferential > 0 ? 'pd-pos' : row.pointDifferential < 0 ? 'pd-neg' : ''}">
                            ${row.pointDifferential > 0 ? '+' : ''}${row.pointDifferential}
                          </td>
                        </tr>`).join('')}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>`;
          }).join('')}
        </div>`;
    }).join('');

    if (!stageSections) return '';

    return `
      <h3 class="section-title" style="margin-bottom:0.5rem;">
        Group Stage Standings
      </h3>
      ${stageSections}
      <p class="helper-text" style="margin-bottom:1.5rem;">
        Stage 1 standings reflect Stage 1 games only.${hasStage2 ? ' Stage 2 standings are cumulative — each team\'s Stage 1 record carries forward into their new Stage 2 group, so a Stage 2 row shows the combined Stage 1 + Stage 2 record.' : ''} Groups never combine with each other.
      </p>`;
  },
};
