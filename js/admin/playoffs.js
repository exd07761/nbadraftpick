/**
 * admin/playoffs.js
 *
 * Phase 9 — Playoffs / Championship.
 *
 * Round 1 (BO1) -> Round 2 (4x BO3, two selection pools) -> Finals
 * (2x BO3 semifinals -> 1x BO3 Championship) -> Champion.
 *
 * Reuses Phase 7's score-entry philosophy (tie-invalid, winner-derived,
 * streamer required, edit-in-place) via AdminActions.recordPlayoffGameResult.
 * Nothing here computes a winner itself — that's always done in js/data.js.
 */
const AdminPlayoffsView = {
  render(container) {
    const season = LeagueData.getCurrentSeason();
    if (!season) {
      container.innerHTML = `<div class="empty-state"><p>No current season.</p></div>`;
      return;
    }

    const playoffs = LeagueData.getPlayoffs(season.id);

    if (!playoffs) {
      const stats = LeagueData.getTeamStatistics(season.id);
      const enoughTeams = stats.length >= 12;
      const scheduleState = LeagueData.getScheduleState(season.id);
      const seasonComplete = scheduleState.generated
        && scheduleState.realMatchupCount > 0
        && scheduleState.completedCount >= scheduleState.realMatchupCount;
      const enough = enoughTeams && seasonComplete;

      let blockedReason = '';
      if (!seasonComplete) {
        if (!scheduleState.generated) {
          blockedReason = 'No regular-season schedule has been created yet.';
        } else if (scheduleState.realMatchupCount === 0) {
          blockedReason = 'The regular-season schedule contains no games.';
        } else {
          blockedReason = `The regular season is not yet complete
            (${scheduleState.completedCount} of ${scheduleState.realMatchupCount} games played).`;
        }
      } else if (!enoughTeams) {
        blockedReason = `At least 12 ranked teams are required to generate the playoff bracket
          (currently ${stats.length}).`;
      }

      container.innerHTML = `
        <div class="admin-section">
          <div class="admin-section-header"><h2>Playoffs — ${escapeHtml(season.name)}</h2></div>
          <div class="empty-state">
            ${enough
              ? `<p>Generate the 12-team playoff bracket from the current standings.</p>
                 <button class="btn btn-primary" data-action="generate">Generate Playoffs</button>`
              : `<p>${blockedReason}</p>`}
          </div>
        </div>`;
      if (enough) {
        container.querySelector('[data-action="generate"]').onclick = () => {
          AuthBoundary.requireAuth();
          try {
            AdminActions.generatePlayoffs(season.id);
            showToast('Playoff bracket generated.', 'success');
            this.render(container);
          } catch (e) {
            showToast(e.message, 'error');
          }
        };
      }
      return;
    }

    this._renderBracket(container, season, playoffs);
  },

  _teamLabel(season, participantId) {
    if (!participantId) return 'TBD';
    const p = season.participants[participantId];
    const abbr = season.nbaTeamAssignments[participantId];
    return abbr ? `${abbr} — ${escapeHtml(p?.name || '')}` : escapeHtml(p?.name || '');
  },

  _renderBracket(container, season, playoffs) {
    const hasAnyGame = playoffs.round1.matches.some((m) => m.games.length > 0)
      || playoffs.round2.pools.some((p) => p.series.some((s) => s.games.length > 0))
      || playoffs.finals.semifinals.some((s) => s.games.length > 0)
      || (playoffs.finals.championship && playoffs.finals.championship.games.length > 0);

    container.innerHTML = `
      <div class="admin-section playoffs-admin">
        <div class="admin-section-header">
          <h2>Playoffs — ${escapeHtml(season.name)}</h2>
          <button class="btn btn-sm btn-ghost" data-action="regenerate"
            ${hasAnyGame ? 'disabled title="Regeneration is disabled once any playoff game has been played."' : ''}>
            Regenerate Bracket
          </button>
        </div>

        ${playoffs.champion ? `
          <div class="champion-banner">🏆 Champion: ${this._teamLabel(season, playoffs.champion)}</div>
        ` : ''}

        <h3 class="section-title">Round 1 — Best of 1</h3>
        <div id="r1List" class="playoff-item-list"></div>

        <h3 class="section-title" style="margin-top:1.5rem">Round 2 — Best of 3</h3>
        <div id="r2List"></div>

        <h3 class="section-title" style="margin-top:1.5rem">Finals — Best of 3</h3>
        <div id="finalsList"></div>

        <div id="scorePanel" class="score-panel hidden"></div>
      </div>`;

    container.querySelector('[data-action="regenerate"]')?.addEventListener('click', () => {
      if (hasAnyGame) return;
      if (!confirm('Regenerate the playoff bracket from current standings? This replaces the existing bracket.')) return;
      AuthBoundary.requireAuth();
      try {
        AdminActions.generatePlayoffs(season.id);
        showToast('Playoff bracket regenerated.', 'success');
        this.render(container);
      } catch (e) {
        showToast(e.message, 'error');
      }
    });

    this._renderRound1(container, season, playoffs);
    this._renderRound2(container, season, playoffs);
    this._renderFinals(container, season, playoffs);
  },

  _renderRound1(container, season, playoffs) {
    const list = container.querySelector('#r1List');
    list.innerHTML = playoffs.round1.matches.map((m) => this._itemCard(season, {
      id: m.id, kind: 'round1', format: 'bo1',
      sideAId: m.teamA, sideBId: m.teamB,
      sideALabel: `#${m.seedA} ${this._teamLabel(season, m.teamA)}`,
      sideBLabel: `#${m.seedB} ${this._teamLabel(season, m.teamB)}`,
      games: m.games, winner: m.winner, status: m.status,
    })).join('');
    this._wireItemCards(container, season);
  },

  _renderRound2(container, season, playoffs) {
    const wrap = container.querySelector('#r2List');
    wrap.innerHTML = playoffs.round2.pools.map((pool) => {
      const [srcA, srcB] = pool.sourceMatchIds.map((id) => playoffs.round1.matches.find((m) => m.id === id));
      const bothDone = srcA.winner && srcB.winner;

      let selectionUI = '';
      if (!bothDone) {
        selectionUI = `<p class="helper-text">Waiting on both Round 1 results in this pool.</p>`;
      } else if (!pool.selection) {
        selectionUI = `
          <p class="helper-text">Seed ${pool.chooserSeed}: choose your opponent.</p>
          <div class="selection-choices">
            <button class="btn btn-sm btn-primary" data-select-pool="${pool.name}" data-select-team="${srcA.winner}">
              ${this._teamLabel(season, srcA.winner)}
            </button>
            <button class="btn btn-sm btn-primary" data-select-pool="${pool.name}" data-select-team="${srcB.winner}">
              ${this._teamLabel(season, srcB.winner)}
            </button>
          </div>`;
      } else {
        const locked = pool.series.some((s) => s.games.length > 0);
        selectionUI = `
          <p class="helper-text">
            Seed ${pool.chooserSeed} selected ${this._teamLabel(season, pool.selection)}.
            ${locked ? '' : `<button class="btn btn-sm btn-ghost" data-reselect-pool="${pool.name}" data-opt-a="${srcA.winner}" data-opt-b="${srcB.winner}">Change selection</button>`}
          </p>`;
      }

      const seriesCards = pool.selection ? pool.series.map((s) => this._itemCard(season, {
        id: s.id, kind: 'round2', format: 'bo3',
        sideAId: this._bySeed(playoffs, s.seed), sideBId: s.opponent,
        sideALabel: `#${s.seed} ${this._teamLabel(season, this._bySeed(playoffs, s.seed))}`,
        sideBLabel: this._teamLabel(season, s.opponent),
        games: s.games, winner: s.winner, status: s.status,
      })).join('') : '';

      return `
        <div class="playoff-pool-card">
          <h4>${pool.name === 'top' ? 'Top Pool (5v12 / 6v11)' : 'Bottom Pool (7v10 / 8v9)'}</h4>
          ${selectionUI}
          <div class="playoff-item-list">${seriesCards}</div>
        </div>`;
    }).join('');

    wrap.querySelectorAll('[data-select-pool]').forEach((btn) => {
      btn.addEventListener('click', () => {
        AuthBoundary.requireAuth();
        try {
          AdminActions.selectPlayoffOpponent(season.id, btn.dataset.selectPool, btn.dataset.selectTeam);
          showToast('Selection saved.', 'success');
          this.render(container);
        } catch (e) {
          showToast(e.message, 'error');
        }
      });
    });
    wrap.querySelectorAll('[data-reselect-pool]').forEach((btn) => {
      btn.addEventListener('click', () => {
        AuthBoundary.requireAuth();
        const options = [btn.dataset.optA, btn.dataset.optB];
        const nameA = this._teamLabel(season, options[0]);
        const nameB = this._teamLabel(season, options[1]);
        const pick = prompt(`Change selection to which team?\n1) ${nameA}\n2) ${nameB}\n\nEnter 1 or 2:`);
        const chosen = pick && pick.trim() === '1' ? options[0] : pick && pick.trim() === '2' ? options[1] : null;
        if (!chosen) return;
        try {
          AdminActions.selectPlayoffOpponent(season.id, btn.dataset.reselectPool, chosen);
          showToast('Selection updated.', 'success');
          this.render(container);
        } catch (e) {
          showToast(e.message, 'error');
        }
      });
    });
    this._wireItemCards(container, season);
  },

  _bySeed(playoffs, seed) {
    return playoffs.seeds.find((s) => s.seed === seed)?.participantId || null;
  },

  _renderFinals(container, season, playoffs) {
    const wrap = container.querySelector('#finalsList');
    const sfCards = playoffs.finals.semifinals.map((sf, i) => this._itemCard(season, {
      id: sf.id, kind: 'semifinal', format: 'bo3',
      sideAId: sf.teamA, sideBId: sf.teamB,
      sideALabel: this._teamLabel(season, sf.teamA),
      sideBLabel: this._teamLabel(season, sf.teamB),
      games: sf.games, winner: sf.winner, status: sf.status,
      title: `Semifinal ${i + 1}`,
    })).join('');

    const champ = playoffs.finals.championship;
    const champCard = champ ? this._itemCard(season, {
      id: champ.id, kind: 'championship', format: 'bo3',
      sideAId: champ.teamA, sideBId: champ.teamB,
      sideALabel: this._teamLabel(season, champ.teamA),
      sideBLabel: this._teamLabel(season, champ.teamB),
      games: champ.games, winner: champ.winner, status: champ.status,
      title: 'Championship',
    }) : `<div class="playoff-item-card"><p class="helper-text">Championship will be set once both semifinals are complete.</p></div>`;

    wrap.innerHTML = `<div class="playoff-item-list">${sfCards}${champCard}</div>`;
    this._wireItemCards(container, season);
  },

  _itemCard(season, cfg) {
    const { id, format, sideAId, sideBId, sideALabel, sideBLabel, games, winner, status, title } = cfg;
    const maxGames = format === 'bo1' ? 1 : 3;
    const rows = [];
    for (let g = 1; g <= maxGames; g++) {
      const existing = games[g - 1];
      if (existing) {
        rows.push(`
          <div class="playoff-game-row completed">
            <span>Game ${g}: ${existing.scoreA} – ${existing.scoreB}</span>
            <span class="matchup-streamer">🎥 ${escapeHtml(existing.streamer)}</span>
            <button class="btn btn-sm btn-ghost" data-open-panel="${id}" data-game="${g}" data-side-a="${sideAId || ''}" data-side-b="${sideBId || ''}">Edit</button>
          </div>`);
      } else if (status !== 'completed' && sideAId && sideBId) {
        // Only offer the NEXT game in sequence.
        if (g === games.length + 1 && (format === 'bo1' || g < 3 || this._tiedOneOne(games, sideAId, sideBId))) {
          rows.push(`
            <div class="playoff-game-row">
              <span>Game ${g}: not yet played</span>
              <button class="btn btn-sm btn-primary" data-open-panel="${id}" data-game="${g}" data-side-a="${sideAId}" data-side-b="${sideBId}">Enter Score</button>
            </div>`);
        }
        break;
      } else {
        break;
      }
    }

    return `
      <div class="playoff-item-card ${status === 'completed' ? 'completed' : ''}">
        ${title ? `<h5>${escapeHtml(title)}</h5>` : ''}
        <div class="matchup-teams">
          <span class="${winner === sideAId ? 'winner' : ''}">${sideALabel}</span>
          <span class="matchup-vs">vs</span>
          <span class="${winner === sideBId ? 'winner' : ''}">${sideBLabel}</span>
        </div>
        ${sideAId && sideBId ? rows.join('') : '<p class="helper-text">Waiting on prior round.</p>'}
      </div>`;
  },

  _tiedOneOne(games, sideAId, sideBId) {
    const winsA = games.filter((g) => g.winner === sideAId).length;
    const winsB = games.filter((g) => g.winner === sideBId).length;
    return winsA === 1 && winsB === 1;
  },

  _wireItemCards(container, season) {
    container.querySelectorAll('[data-open-panel]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this._openScorePanel(container, season, {
          itemId: btn.dataset.openPanel,
          gameNumber: Number(btn.dataset.game),
          sideAId: btn.dataset.sideA,
          sideBId: btn.dataset.sideB,
        });
      });
    });
  },

  _openScorePanel(container, season, { itemId, gameNumber, sideAId, sideBId }) {
    const found = LeagueData.getPlayoffItem(season.id, itemId);
    if (!found) return;
    const existing = found.item.games[gameNumber - 1];
    const nameA = this._teamLabel(season, sideAId);
    const nameB = this._teamLabel(season, sideBId);

    const panel = container.querySelector('#scorePanel');
    panel.classList.remove('hidden');
    panel.innerHTML = `
      <h4>Game ${gameNumber}: ${nameA} vs ${nameB}</h4>
      <div class="score-entry-row">
        <div class="form-group">
          <label>${nameA} Score</label>
          <input type="number" min="0" step="1" class="input" id="pfScoreA" value="${existing ? existing.scoreA : ''}">
        </div>
        <div class="form-group">
          <label>${nameB} Score</label>
          <input type="number" min="0" step="1" class="input" id="pfScoreB" value="${existing ? existing.scoreB : ''}">
        </div>
      </div>
      <div class="form-group">
        <label>Streamer</label>
        <input type="text" class="input" id="pfStreamer" value="${existing ? escapeHtml(existing.streamer) : ''}">
      </div>
      <p id="pfError" class="error-text"></p>
      <div class="form-actions">
        <button class="btn btn-primary" id="pfSave">Save Result</button>
        <button class="btn btn-ghost" id="pfCancel">Cancel</button>
      </div>`;

    panel.querySelector('#pfCancel').onclick = () => panel.classList.add('hidden');
    panel.querySelector('#pfSave').onclick = () => {
      AuthBoundary.requireAuth();
      const scoreA = panel.querySelector('#pfScoreA').value;
      const scoreB = panel.querySelector('#pfScoreB').value;
      const streamer = panel.querySelector('#pfStreamer').value;
      try {
        AdminActions.recordPlayoffGameResult(season.id, itemId, gameNumber, { scoreA, scoreB, streamer });
        showToast('Result saved.', 'success');
        this.render(container);
      } catch (e) {
        panel.querySelector('#pfError').textContent = e.message;
      }
    };
  },
};
