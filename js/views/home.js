/**
 * views/home.js — Public home / dashboard view.
 *
 * Phase 10: rebuilt as the site's showcase page. Every number here comes
 * from an existing LeagueData read method — nothing is invented. When a
 * season has no schedule/standings/playoffs data yet, the relevant
 * section is simply omitted rather than faked.
 */
const HomeView = {
  render(container) {
    const season = LeagueData.getCurrentSeason();
    const allSeasons = LeagueData.getAllSeasons();

    if (!season && allSeasons.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">🏀</div>
          <h2>No Season Yet</h2>
          <p>The league commissioner hasn't set up a season yet. Check back soon.</p>
        </div>`;
      return;
    }

    const s = season || allSeasons[0];
    const participants = LeagueData.getParticipants(s.id);
    const assignments = LeagueData.getNBATeamAssignments(s.id);
    const allPlayers = LeagueData.getAllPlayers();
    const greenCount = allPlayers.filter(p => p.pool === 'green').length;
    const blueCount = allPlayers.filter(p => p.pool === 'blue').length;

    const stats = LeagueData.getTeamStatistics(s.id);
    const playoffs = LeagueData.getPlayoffs(s.id);
    const scheduleRounds = LeagueData.getSchedule(s.id);
    const nextRound = this._pickPreviewRound(scheduleRounds);

    // Phase 6 addition: live Draft status, read-only (LeagueData.getDraftState
    // is the exact same read the public Draft page and admin board already
    // use — no new data source, no write). Only shown while the season is
    // actually in its draft phase and a pick is still pending.
    const draftOrder = LeagueData.getPlayerDraftOrder(s.id);
    const draftState = (s.status === 'draft' && draftOrder.length) ? LeagueData.getDraftState(s.id) : null;
    const draftLive = draftState && !draftState.draftComplete && draftState.currentParticipantId;

    container.innerHTML = `
      <div class="dashboard">

        <div class="league-hero">
          <div class="league-hero-eyebrow">NBA2K26 Draft Pick</div>
          <h1 class="league-hero-title">${escapeHtml(s.name)}</h1>
          <div class="league-hero-meta">
            <span class="status-chip status-${s.status}">${formatStatus(s.status)}</span>
            <span>${participants.length} team${participants.length !== 1 ? 's' : ''}</span>
            ${playoffs?.champion ? `<span>🏆 Champion: ${escapeHtml(s.participants[playoffs.champion]?.name || '')}</span>` : ''}
          </div>
        </div>

        ${draftLive ? `
          <a href="#draft" class="dash-draft-live" data-route="draft">
            <span class="dash-draft-live-dot"></span>
            <span class="dash-draft-live-text">
              <span class="dash-draft-live-eyebrow">Draft in progress · Round ${draftState.currentRound} · Pick ${draftState.currentPickOverall}</span>
              <span class="dash-draft-live-name">${escapeHtml(draftState.currentParticipant?.name || 'On the clock')}</span>
            </span>
            <span class="dash-draft-live-cta">Watch Live →</span>
          </a>` : ''}

        <div class="stats-row">
          <div class="stat-card">
            <span class="stat-num">${participants.length}</span>
            <span class="stat-label">Teams</span>
          </div>
          <div class="stat-card">
            <span class="stat-num">${LeagueData.getDraftPicks(s.id).length}</span>
            <span class="stat-label">Draft Picks Made</span>
          </div>
          <div class="stat-card">
            <span class="stat-num">${Object.keys(assignments).length}</span>
            <span class="stat-label">Teams Assigned</span>
          </div>
          <div class="stat-card">
            <span class="stat-num" style="color:var(--pool-green)">${greenCount}</span>
            <span class="stat-label">Green Pool Players</span>
          </div>
          <div class="stat-card">
            <span class="stat-num" style="color:var(--pool-blue)">${blueCount}</span>
            <span class="stat-label">Blue Pool Players</span>
          </div>
        </div>

        <div class="dashboard-grid">
          <div class="dashboard-col">

            ${participants.length ? `
            <section class="section">
              <div class="section-header-row">
                <h2 class="section-title">Rosters</h2>
                <a class="section-link nav-link" data-route="rosters" href="#rosters">View all →</a>
              </div>
              <div class="team-grid">
                ${participants.map(p => {
                  const teamAbbr = assignments[p.id];
                  const team = teamAbbr ? LeagueData.getNBATeam(teamAbbr) : null;
                  return `
                    <div class="team-card">
                      ${teamBadge(teamAbbr, { size: 'md' })}
                      <div class="team-details">
                        <span class="team-owner">${escapeHtml(p.name)}</span>
                        ${team ? `<span class="team-nba">${escapeHtml(team.name)}</span>` : '<span class="team-nba muted">No team assigned</span>'}
                      </div>
                    </div>`;
                }).join('')}
              </div>
            </section>` : ''}

            ${nextRound ? `
            <section class="section">
              <div class="section-header-row">
                <h2 class="section-title">${nextRound.allCompleted ? 'Latest Results — Round ' : 'Upcoming — Round '}${nextRound.round}</h2>
                <a class="section-link nav-link" data-route="schedule" href="#schedule">Full schedule →</a>
              </div>
              <div class="mini-schedule">
                ${nextRound.matchups.slice(0, 5).map(m => this._miniScheduleRow(s, m)).join('')}
              </div>
            </section>` : ''}

          </div>

          <div class="dashboard-col">

            ${stats.length ? `
            <section class="section">
              <div class="section-header-row">
                <h2 class="section-title">Standings</h2>
                <a class="section-link nav-link" data-route="standings" href="#standings">Full table →</a>
              </div>
              <div class="mini-standings">
                ${this._rankedTop(stats, 6).map(row => `
                  <div class="mini-standings-row">
                    <span class="mini-standings-rank ${row.rank <= 4 ? 'top4' : ''}">${row.rank}</span>
                    ${teamBadge(row.nbaTeam, { size: 'sm' })}
                    <span class="mini-standings-name">${escapeHtml(row.participantName || '—')}</span>
                    <span class="mini-standings-record">${row.wins}-${row.losses}</span>
                  </div>`).join('')}
              </div>
            </section>` : ''}

            ${playoffs ? `
            <section class="section">
              <div class="section-header-row">
                <h2 class="section-title">Playoffs</h2>
                <a class="section-link nav-link" data-route="playoffs" href="#playoffs">Bracket →</a>
              </div>
              ${playoffs.champion
                ? `<div class="bracket-champion-banner" style="margin:0;">🏆 ${escapeHtml(s.participants[playoffs.champion]?.name || '')}</div>`
                : `<p class="muted" style="font-size:0.85rem;">Bracket is set — ${this._playoffStatusLabel(playoffs.status)}.</p>`}
            </section>` : ''}

            ${allSeasons.length > 1 ? `
            <section class="section">
              <h2 class="section-title">All Seasons</h2>
              <div class="seasons-list">
                ${allSeasons.map(s2 => `
                  <div class="season-row ${s2.id === s.id ? 'active' : ''}">
                    <span>${escapeHtml(s2.name)}</span>
                    <span class="status-chip status-${s2.status}">${formatStatus(s2.status)}</span>
                  </div>`).join('')}
              </div>
            </section>` : ''}

          </div>
        </div>
      </div>`;

    // Section-link nav items reuse the same client-side router as the main nav.
    container.querySelectorAll('.section-link[data-route], .dash-draft-live[data-route]').forEach(el => {
      el.addEventListener('click', e => { e.preventDefault(); navigate(el.dataset.route); });
    });
  },

  // Picks the most relevant round to preview: the first round with any
  // not-yet-completed real matchup, or the final round if everything is done.
  _pickPreviewRound(rounds) {
    if (!rounds.length) return null;
    const inProgress = rounds.find(r => r.matchups.some(m => m.teamB !== null && m.status !== 'completed'));
    if (inProgress) return { ...inProgress, allCompleted: false };
    const last = rounds[rounds.length - 1];
    return { ...last, allCompleted: true };
  },

  _rankedTop(stats, n) {
    let rank = 0;
    return stats.slice(0, n).map((s, i) => {
      const prev = stats[i - 1];
      const isTie = prev && prev.winPct === s.winPct && prev.pointDifferential === s.pointDifferential;
      if (!isTie) rank = i + 1;
      return { ...s, rank };
    });
  },

  _playoffStatusLabel(status) {
    const map = {
      seeded: 'Round 1 not yet started',
      round1_in_progress: 'Round 1 in progress',
      round2_in_progress: 'Round 2 in progress',
      finals_semifinals_complete: 'Semifinals complete',
      finals_in_progress: 'Semifinals in progress',
      championship_in_progress: 'Championship in progress',
    };
    return map[status] || status;
  },

  _miniScheduleRow(season, m) {
    const nameFor = pid => pid ? escapeHtml(season.participants[pid]?.name || '') : '';
    const abbrFor = pid => pid ? season.nbaTeamAssignments[pid] : null;

    if (m.teamB === null) {
      return `
        <div class="mini-schedule-row">
          <span class="mini-schedule-teams">${teamBadge(abbrFor(m.teamA), { size: 'sm' })}<span>${nameFor(m.teamA)}</span></span>
          <span class="status-chip status-bye">BYE</span>
        </div>`;
    }
    const isCompleted = m.status === 'completed';
    const { leftId, rightId, leftScore, rightScore, hasHomeCourt } = matchupHomeAway(m);
    return `
      <div class="mini-schedule-row">
        <span class="mini-schedule-teams">
          ${teamBadge(abbrFor(leftId), { size: 'sm' })}<span>${hasHomeCourt ? '🏠 ' : ''}${nameFor(leftId)}</span>
          <span class="matchup-vs-divider">vs</span>
          ${teamBadge(abbrFor(rightId), { size: 'sm' })}<span>${nameFor(rightId)}</span>
        </span>
        ${isCompleted
          ? `<span class="matchup-score">${leftScore}–${rightScore}</span>`
          : `<span class="status-chip status-scheduled">Scheduled</span>`}
      </div>`;
  },
};
