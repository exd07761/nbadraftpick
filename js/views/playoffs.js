/**
 * views/playoffs.js — Public playoff bracket view.
 *
 * Phase 10: presentation-only rebuild into a connected visual bracket.
 * Still fully read-only, still derived entirely from LeagueData.getPlayoffs
 * — no score entry, no selection buttons, no regenerate, nothing written.
 *
 * The Phase 9 data shape is unchanged and is mapped straight onto the
 * bracket columns:
 *   Round 1 (BO1, 4 matches)  -> Round 2 (BO3, 4 series across 2 pools)
 *   -> Finals semifinals (2)  -> Championship (1) -> champion
 * finals.semifinals[0] is always sourced from the "top" pool (seed 3/4),
 * finals.semifinals[1] from the "bottom" pool (seed 1/2) — see
 * buildPlayoffsSkeleton in data.js — so the vertical grouping below
 * (top pool rows above, bottom pool rows below) lines up with which
 * semifinal each round-2 series feeds, with no guessing involved.
 */
const PlayoffsView = {
  render(container) {
    const season = LeagueData.getCurrentSeason();
    if (!season) {
      container.innerHTML = `
        <div class="empty-state future">
          <div class="empty-icon">🏆</div>
          <h2>Playoffs</h2>
          <p>No active season yet.</p>
        </div>`;
      return;
    }

    const playoffs = LeagueData.getPlayoffs(season.id);
    if (!playoffs) {
      container.innerHTML = `
        <div class="empty-state future">
          <div class="empty-icon">🏆</div>
          <h2>Playoffs</h2>
          <p>The playoff bracket will appear here once the commissioner generates it.</p>
          <span class="coming-soon">Not yet generated</span>
        </div>`;
      return;
    }

    const topPool = playoffs.round2.pools.find(p => p.name === 'top');
    const bottomPool = playoffs.round2.pools.find(p => p.name === 'bottom');
    const [r1_5v12, r1_6v11, r1_7v10, r1_8v9] = playoffs.round1.matches;
    const [sfTop, sfBottom] = playoffs.finals.semifinals;

    container.innerHTML = `
      <div class="playoffs-view" style="max-width:none;">
        <h2 class="section-title">Playoffs</h2>

        ${playoffs.champion ? `
          <div class="bracket-champion-banner">
            🏆 Champion: ${this._teamLabel(season, playoffs.champion)}
          </div>` : ''}

        <div class="bracket-jump" id="bracketJump">
          <button type="button" class="bracket-jump-btn" data-jump="0">Round 1</button>
          <button type="button" class="bracket-jump-btn" data-jump="1">Round 2</button>
          <button type="button" class="bracket-jump-btn" data-jump="2">Semifinals</button>
          <button type="button" class="bracket-jump-btn" data-jump="3">Championship</button>
        </div>

        <div class="bracket-scroll" id="bracketScroll">
          <div class="bracket">

            <div class="bracket-col">
              <div class="bracket-col-header">Round 1<span class="bracket-col-sub">Best of 1</span></div>
              <div class="bracket-slot" style="flex:1;">${this._round1Card(season, r1_5v12)}</div>
              <div class="bracket-slot" style="flex:1;">${this._round1Card(season, r1_6v11)}</div>
              <div class="bracket-slot" style="flex:1;">${this._round1Card(season, r1_7v10)}</div>
              <div class="bracket-slot" style="flex:1;">${this._round1Card(season, r1_8v9)}</div>
            </div>

            <div class="bracket-col">
              <div class="bracket-col-header">Round 2<span class="bracket-col-sub">Best of 3</span></div>
              <div class="bracket-slot" style="flex:1;">${this._round2Card(season, playoffs, topPool, 0, 'Seed 3 picks')}</div>
              <div class="bracket-slot" style="flex:1;">${this._round2Card(season, playoffs, topPool, 1, 'Seed 4 — leftover')}</div>
              <div class="bracket-slot" style="flex:1;">${this._round2Card(season, playoffs, bottomPool, 0, 'Seed 1 picks')}</div>
              <div class="bracket-slot" style="flex:1;">${this._round2Card(season, playoffs, bottomPool, 1, 'Seed 2 — leftover')}</div>
            </div>

            <div class="bracket-col">
              <div class="bracket-col-header">Semifinals<span class="bracket-col-sub">Best of 3</span></div>
              <div class="bracket-slot" style="flex:2;">${this._seriesCard(season, sfTop)}</div>
              <div class="bracket-slot" style="flex:2;">${this._seriesCard(season, sfBottom)}</div>
            </div>

            <div class="bracket-col">
              <div class="bracket-col-header">Championship<span class="bracket-col-sub">Best of 3</span></div>
              <div class="bracket-slot" style="flex:4;">
                ${playoffs.finals.championship
                  ? this._seriesCard(season, playoffs.finals.championship)
                  : `<div class="bracket-card"><div class="bracket-card-tbd">Waiting on both semifinals</div></div>`}
              </div>
            </div>

          </div>
        </div>
      </div>`;

    // Phase 6 addition: mobile round quick-jump — scrolls the existing
    // .bracket-scroll container to the chosen column instead of leaving a
    // phone user to swipe through every round to find the current one.
    // Purely a scroll-position convenience; reads no new data, writes
    // nothing, and the underlying horizontal-scroll bracket (kept as the
    // brief allows) works exactly as before with JS disabled.
    const jumpRow = container.querySelector('#bracketJump');
    const scrollEl = container.querySelector('#bracketScroll');
    const cols = scrollEl ? scrollEl.querySelectorAll('.bracket-col') : [];
    if (jumpRow && cols.length) {
      const currentIdx = this._currentRoundIndex(playoffs);
      jumpRow.querySelectorAll('.bracket-jump-btn').forEach((btn, i) => {
        btn.classList.toggle('current', i === currentIdx);
        btn.addEventListener('click', () => {
          cols[i]?.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' });
        });
      });
    }
  },

  // Display-only heuristic (not written anywhere) for which bracket
  // column to highlight/jump to by default: the first round that still
  // has an undecided match, or Championship once everything is decided.
  _currentRoundIndex(playoffs) {
    if (!playoffs.round1.matches.every(m => m.winner)) return 0;
    const round2Decided = playoffs.round2.pools.every(p => p.series.every(s => s.winner));
    if (!round2Decided) return 1;
    const semisDecided = playoffs.finals.semifinals.every(s => s.winner);
    if (!semisDecided) return 2;
    return 3;
  },

  _teamLabel(season, participantId) {
    if (!participantId) return 'TBD';
    const p = season.participants[participantId];
    return escapeHtml(p?.name || '');
  },

  _teamAbbr(season, participantId) {
    return participantId ? season.nbaTeamAssignments[participantId] : null;
  },

  _lastGameLine(games) {
    const played = (games || []).filter(g => g && g.status === 'completed');
    if (!played.length) return '';
    const g = played[played.length - 1];
    return `<div class="bracket-format-tag">G${g.gameNumber}: ${g.scoreA}–${g.scoreB} · 🎥 ${escapeHtml(g.streamer)}</div>`;
  },

  _round1Card(season, m) {
    const decided = !!m.winner;
    return `
      <div class="bracket-card ${decided ? 'decided' : m.games.length ? 'active' : ''}">
        <div class="bracket-card-row ${m.winner === m.teamA ? 'won' : ''}">
          <span class="bracket-seed">${m.seedA}</span>
          ${teamBadge(this._teamAbbr(season, m.teamA), { size: 'sm' })}
          <span class="bracket-team-name">${this._teamLabel(season, m.teamA)}</span>
          <span class="bracket-team-score">${m.winner ? this._score(m, 'A') : ''}</span>
        </div>
        <div class="bracket-card-row ${m.winner === m.teamB ? 'won' : ''}">
          <span class="bracket-seed">${m.seedB}</span>
          ${teamBadge(this._teamAbbr(season, m.teamB), { size: 'sm' })}
          <span class="bracket-team-name">${this._teamLabel(season, m.teamB)}</span>
          <span class="bracket-team-score">${m.winner ? this._score(m, 'B') : ''}</span>
        </div>
        ${this._lastGameLine(m.games)}
      </div>`;
  },

  _score(match, side) {
    const g = (match.games || []).find(g => g && g.status === 'completed');
    if (!g) return '';
    return side === 'A' ? g.scoreA : g.scoreB;
  },

  _round2Card(season, playoffs, pool, seriesIndex, subtitle) {
    if (!pool) return `<div class="bracket-card"><div class="bracket-card-tbd">—</div></div>`;
    const series = pool.series[seriesIndex];
    const seedParticipant = this._bySeed(playoffs, series.seed);

    return `
      <div class="bracket-card ${series.winner ? 'decided' : series.games.length ? 'active' : ''}">
        <div class="bracket-card-row ${series.winner === seedParticipant ? 'won' : ''}">
          <span class="bracket-seed">${series.seed}</span>
          ${teamBadge(this._teamAbbr(season, seedParticipant), { size: 'sm' })}
          <span class="bracket-team-name">${this._teamLabel(season, seedParticipant)}</span>
        </div>
        <div class="bracket-card-row ${series.winner && series.winner === series.opponent ? 'won' : ''}">
          <span class="bracket-seed"></span>
          ${series.opponent ? teamBadge(this._teamAbbr(season, series.opponent), { size: 'sm' }) : `<span class="team-badge team-badge-sm team-badge-empty">?</span>`}
          <span class="bracket-team-name">${series.opponent ? this._teamLabel(season, series.opponent) : 'TBD'}</span>
        </div>
        <div class="bracket-format-tag">${escapeHtml(subtitle)}</div>
      </div>`;
  },

  _bySeed(playoffs, seed) {
    return playoffs.seeds.find(s => s.seed === seed)?.participantId || null;
  },

  // Generic BO3 series/semifinal/championship card — shows both sides,
  // games-won tally, and highlights the winner once decided.
  _seriesCard(season, series) {
    if (!series.teamA && !series.teamB) {
      return `<div class="bracket-card"><div class="bracket-card-tbd">Waiting on prior round</div></div>`;
    }
    const played = (series.games || []).filter(g => g && g.status === 'completed');
    const winsA = played.filter(g => g.winner === series.teamA).length;
    const winsB = played.filter(g => g.winner === series.teamB).length;

    return `
      <div class="bracket-card ${series.winner ? 'decided' : played.length ? 'active' : ''}">
        <div class="bracket-card-row ${series.winner === series.teamA ? 'won' : ''}">
          ${teamBadge(this._teamAbbr(season, series.teamA), { size: 'sm' })}
          <span class="bracket-team-name">${this._teamLabel(season, series.teamA)}</span>
          <span class="bracket-team-score">${played.length ? winsA : ''}</span>
        </div>
        <div class="bracket-card-row ${series.winner === series.teamB ? 'won' : ''}">
          ${teamBadge(this._teamAbbr(season, series.teamB), { size: 'sm' })}
          <span class="bracket-team-name">${this._teamLabel(season, series.teamB)}</span>
          <span class="bracket-team-score">${played.length ? winsB : ''}</span>
        </div>
        ${played.length ? `<div class="bracket-format-tag">${played.length} game${played.length !== 1 ? 's' : ''} played</div>` : ''}
      </div>`;
  },
};
