/**
 * admin/schedule.js
 *
 * Phase 7 — Regular Season Scheduler + Match Results.
 *
 * Generates a schedule from the existing NBA Team Assignment data
 * (Phase 3) and lets the admin enter/edit scores + streamer per matchup.
 * Does NOT implement standings — see Phase 8.
 *
 * Two schedule formats, both writing into the exact same season.schedule
 * shape (see AdminActions.generateSchedule / generateGroupStageSchedule
 * in data.js):
 *   - Round Robin (original, default): every team plays every other team once.
 *   - Group Stage (legacy 16-team/4-group format): two 24-game stages.
 *     Round 1 groups are auto-assigned from the existing team order
 *     (adjustable). Round 2 groups are entered manually by the
 *     commissioner after running an external online roulette (Revision —
 *     Manual Online-Roulette Assignment) — this file no longer computes
 *     or suggests Round 2 group membership; see _renderRound2Assignment.
 *     See data.js's Group Stage section for the actual scheduling logic —
 *     this file is UI only.
 */
const AdminScheduleView = {
  _selectedRound: 1,
  _pendingFormat: 'roundRobin', // which format is selected in the pre-generation picker
  _pendingGroups: null,         // { A:[...], B:[...], C:[...], D:[...] } — draft Round 1 group assignment, not yet saved
  _pendingRound2Groups: null,   // { A:[id|null x4], B:[...], C:[...], D:[...] } — draft manual Round 2 assignment (external roulette result), not yet saved
  _round2Error: null,           // last validation error string from a failed "Generate Round 2" attempt, shown until the next edit or retry

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
      this._renderFormatPicker(container, season);
      return;
    }

    this._renderGenerated(container, season, state);
  },

  // ── Pre-generation: choose Round Robin or Group Stage ──────────────────
  _renderFormatPicker(container, season) {
    const assignedCount = Object.keys(season.nbaTeamAssignments).length;
    const isGroupStage = this._pendingFormat === 'groupStage';

    if (isGroupStage && !this._pendingGroups) {
      this._pendingGroups = this._autoAssignGroups(season);
    }

    container.innerHTML = `
      <div class="admin-section">
        <div class="admin-section-header">
          <h2>Regular Season Schedule — ${escapeHtml(season.name)}</h2>
        </div>

        <div class="form-group">
          <label>Schedule Format</label>
          <div class="pool-tabs" id="formatTabs">
            <button type="button" class="pool-tab ${this._pendingFormat === 'roundRobin' ? 'active' : ''}" data-format="roundRobin">Round Robin</button>
            <button type="button" class="pool-tab ${this._pendingFormat === 'groupStage' ? 'active' : ''}" data-format="groupStage">Group Stage</button>
          </div>
        </div>

        ${this._pendingFormat === 'roundRobin' ? `
          <p class="helper-text">Every team plays every other team exactly once
            (${assignedCount} teams → ${assignedCount > 1 ? assignedCount * (assignedCount - 1) / 2 : 0} games,
            ${assignedCount > 1 ? assignedCount - 1 : 0} games/team).</p>
          <button class="btn btn-primary" data-action="generateRoundRobin">Generate Schedule</button>
        ` : this._renderGroupStageSetup(season, assignedCount)}
      </div>`;

    container.querySelector('#formatTabs').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-format]');
      if (!btn) return;
      this._pendingFormat = btn.dataset.format;
      if (this._pendingFormat === 'groupStage' && !this._pendingGroups) {
        this._pendingGroups = this._autoAssignGroups(season);
      }
      this.render(container);
    });

    container.querySelector('[data-action="generateRoundRobin"]')?.addEventListener('click', () => {
      AuthBoundary.requireAuth();
      try {
        AdminActions.generateSchedule(season.id);
        showToast('Schedule generated.', 'success');
        this._selectedRound = 1;
        this.render(container);
      } catch (e) {
        showToast(e.message, 'error');
      }
    });

    this._bindGroupStageSetupEvents(container, season);
  },

  /** Automatic assignment: teamAssignmentOrder sliced into 4 consecutive groups of 4 — the "official" existing team order (DuckRace #2), per the ticket's guidance. */
  _autoAssignGroups(season) {
    const teamIds = season.teamAssignmentOrder.filter((pid) => !!season.nbaTeamAssignments[pid]);
    return {
      A: teamIds.slice(0, 4),
      B: teamIds.slice(4, 8),
      C: teamIds.slice(8, 12),
      D: teamIds.slice(12, 16),
    };
  },

  _renderGroupStageSetup(season, assignedCount) {
    const validCount = assignedCount === 16;
    const nameFor = (pid) => season.participants[pid]?.name || '—';
    const abbrFor = (pid) => season.nbaTeamAssignments[pid];

    const groupCols = ['A', 'B', 'C', 'D'].map((g) => {
      const teamIds = this._pendingGroups[g] || [];
      const countOk = teamIds.length === 4;
      return `
        <div class="roster-card" style="min-width:220px;">
          <div class="roster-card-header">
            <span class="roster-card-name">Group ${g}</span>
            <span class="roster-card-count ${countOk ? '' : 'cap-over-text'}">${teamIds.length}/4</span>
          </div>
          <div class="table-scroll">
            <table class="roster-table">
              <tbody>
                ${teamIds.map((pid) => `
                  <tr>
                    <td>${teamBadge(abbrFor(pid), { size: 'sm' })}</td>
                    <td>${escapeHtml(nameFor(pid))}</td>
                    <td style="text-align:right;">
                      <select class="input" style="padding:0.15rem 0.4rem;font-size:0.8rem;" data-move-team="${pid}" data-from-group="${g}">
                        ${['A', 'B', 'C', 'D'].map((g2) => `<option value="${g2}" ${g2 === g ? 'selected' : ''}>${g2}</option>`).join('')}
                      </select>
                    </td>
                  </tr>`).join('') || `<tr><td class="muted" style="padding:0.5rem">Empty</td></tr>`}
              </tbody>
            </table>
          </div>
        </div>`;
    }).join('');

    if (!validCount) {
      return `
        <div class="info-banner warn-banner">
          The legacy Group Stage format requires exactly 16 teams with an assigned NBA team
          (this season has ${assignedCount}). Use Round Robin instead, or adjust NBA Team Assignment.
        </div>`;
    }

    return `
      <div class="info-banner" style="margin-bottom:0.75rem;">
        16 Teams → 4 Groups → Round 1: 24 games → reseeding → Round 2: 24 games →
        <strong>Total: 48 games, 6 games/team</strong>.
      </div>
      <p class="helper-text">Groups are auto-assigned from the existing NBA Team Assignment order.
        Use the dropdown next to a team to move them to a different group before generating.</p>
      <div class="roster-cards" id="groupStageSetupCols" style="display:flex;gap:0.75rem;flex-wrap:wrap;">
        ${groupCols}
      </div>
      <p id="groupStageSetupError" class="error-text"></p>
      <button class="btn btn-primary" data-action="generateGroupStage" style="margin-top:0.75rem;">Generate Group Stage Round 1</button>`;
  },

  _bindGroupStageSetupEvents(container, season) {
    container.querySelectorAll('[data-move-team]').forEach((select) => {
      select.onchange = () => {
        const pid = select.dataset.moveTeam;
        const fromGroup = select.dataset.fromGroup;
        const toGroup = select.value;
        if (toGroup === fromGroup) return;
        this._pendingGroups[fromGroup] = this._pendingGroups[fromGroup].filter((id) => id !== pid);
        this._pendingGroups[toGroup] = [...(this._pendingGroups[toGroup] || []), pid];
        this.render(container);
      };
    });

    container.querySelector('[data-action="generateGroupStage"]')?.addEventListener('click', () => {
      AuthBoundary.requireAuth();
      const errEl = container.querySelector('#groupStageSetupError');
      try {
        AdminActions.generateGroupStageSchedule(season.id, this._pendingGroups);
        showToast('Group Stage Round 1 generated.', 'success');
        this._selectedRound = 1;
        this._pendingGroups = null;
        this.render(container);
      } catch (e) {
        if (errEl) errEl.textContent = e.message;
        else showToast(e.message, 'error');
      }
    });
  },

  /**
   * Group Stage-only panel shown above the round tabs: current stage,
   * Round 1 standings (live during stage 1, frozen seed source once stage
   * 2 exists), the "Generate Round 2" action once Round 1 is complete,
   * and the resulting Round 2 groups once generated.
   */
  _renderGroupStagePanel(season, state) {
    const gs = season.groupStageState;
    const standings1 = LeagueData.getGroupStageStandings(season.id, 1);
    const nameFor = (pid) => season.participants[pid]?.name || '—';

    const groupTable = (standings) => `
      <div class="roster-cards" style="display:flex;gap:0.75rem;flex-wrap:wrap;">
        ${['A', 'B', 'C', 'D'].map((g) => `
          <div class="roster-card" style="min-width:200px;">
            <div class="roster-card-header"><span class="roster-card-name">Group ${g}</span></div>
            <div class="table-scroll">
              <table class="roster-table">
                <thead><tr><th>#</th><th>Team</th><th>W-L</th><th>+/-</th></tr></thead>
                <tbody>
                  ${(standings[g] || []).map((row, i) => `
                    <tr>
                      <td>${i + 1}</td>
                      <td>${escapeHtml(row.participantName || '—')}</td>
                      <td>${row.wins}-${row.losses}</td>
                      <td>${row.pointDifferential > 0 ? '+' : ''}${row.pointDifferential}</td>
                    </tr>`).join('')}
                </tbody>
              </table>
            </div>
          </div>`).join('')}
      </div>`;

    if (gs.stage === 1) {
      const round1Matchups = season.schedule.flatMap((r) => r.matchups).filter((m) => m.stage === 1);
      const round1Complete = round1Matchups.every((m) => m.status === 'completed');
      return `
        <div class="info-banner" style="margin:0.75rem 0;">
          <strong>Stage 1 — Round 1 Group Play</strong> (24 games, 3/team).
          ${round1Complete
            ? 'Round 1 is complete. Round 1 standings below are for reference only — run the external online roulette, then enter the Round 2 groups manually below.'
            : 'Complete all Round 1 games, then run the roulette to assign Round 2 groups.'}
        </div>
        ${groupTable(standings1)}
        ${round1Complete ? this._renderRound2Assignment(season) : ''}`;
    }

    // Stage 2: show the frozen Round 1 standings (informational/audit only
    // — Round 2 group membership was NOT derived from these, see
    // generateGroupStageRound2's doc comment in data.js) and the
    // commissioner's manually entered Round 2 groups.
    return `
      <div class="info-banner" style="margin:0.75rem 0;">
        <strong>Stage 2 — Round 2 Group Play</strong> (24 games, 3/team) — manually assigned via external roulette.
      </div>
      <details style="margin-bottom:0.75rem;">
        <summary style="cursor:pointer;">Round 1 final standings (reference only)</summary>
        <div style="margin-top:0.5rem;">${groupTable(standings1)}</div>
      </details>
      <div class="roster-cards" style="display:flex;gap:0.75rem;flex-wrap:wrap;">
        ${['A', 'B', 'C', 'D'].map((g) => `
          <div class="roster-card" style="min-width:200px;">
            <div class="roster-card-header"><span class="roster-card-name">Round 2 — Group ${g}</span></div>
            <div class="table-scroll">
              <table class="roster-table">
                <tbody>
                  ${gs.round2Groups[g].map((pid) => `<tr><td>${escapeHtml(nameFor(pid))}</td></tr>`).join('')}
                </tbody>
              </table>
            </div>
          </div>`).join('')}
      </div>`;
  },

  /**
   * Manual Round 2 assignment (Revision — Manual Online-Roulette
   * Assignment). The commissioner runs the actual team draw on an
   * external roulette and enters the result here — this app never
   * computes or suggests which teams go where. Every slot is a dropdown
   * (never free text) sourced from the same 16 assigned teams Round 1
   * used; a team already picked in another slot is disabled everywhere
   * else, and immediately becomes selectable again the moment it's
   * deselected — recomputed fresh on every render from
   * this._pendingRound2Groups, so there's no separate "used" list to fall
   * out of sync.
   */
  _renderRound2Assignment(season) {
    const assignedTeamIds = season.teamAssignmentOrder.filter((pid) => !!season.nbaTeamAssignments[pid]);
    if (!this._pendingRound2Groups) {
      this._pendingRound2Groups = { A: [null, null, null, null], B: [null, null, null, null], C: [null, null, null, null], D: [null, null, null, null] };
    }
    const nameFor = (pid) => season.participants[pid]?.name || '—';
    const allSelected = GROUP_NAMES.flatMap((g) => this._pendingRound2Groups[g]).filter((pid) => pid != null);
    const assignedCount = allSelected.length;

    const groupCols = GROUP_NAMES.map((g) => {
      const slots = this._pendingRound2Groups[g];
      return `
        <div class="roster-card" style="min-width:220px;">
          <div class="roster-card-header">
            <span class="roster-card-name">Group ${g}</span>
            <span class="roster-card-count ${slots.filter((s) => s != null).length === 4 ? '' : 'cap-over-text'}">${slots.filter((s) => s != null).length}/4</span>
          </div>
          <div class="table-scroll">
            <table class="roster-table"><tbody>
              ${slots.map((pid, i) => `
                <tr><td>
                  <select class="input" style="width:100%;" data-round2-group="${g}" data-round2-index="${i}">
                    <option value="">Select Team…</option>
                    ${assignedTeamIds.map((tid) => {
                      const isThisSlot = tid === pid;
                      const isUsedElsewhere = !isThisSlot && allSelected.includes(tid);
                      return `<option value="${tid}" ${isThisSlot ? 'selected' : ''} ${isUsedElsewhere ? 'disabled' : ''}>${escapeHtml(nameFor(tid))}</option>`;
                    }).join('')}
                  </select>
                </td></tr>`).join('')}
            </tbody></table>
          </div>
        </div>`;
    }).join('');

    return `
      <div style="margin-top:1rem;">
        <h3 class="section-title" style="font-size:1rem;margin-bottom:0.5rem;">Round 2 Group Assignment (from external roulette)</h3>
        <p class="helper-text">Enter the roulette result below. Assigned: ${assignedCount}/16.</p>
        <div class="roster-cards" id="round2AssignmentCols" style="display:flex;gap:0.75rem;flex-wrap:wrap;">
          ${groupCols}
        </div>
        ${this._round2Error ? `<p class="error-text" style="margin-top:0.5rem;">${escapeHtml(this._round2Error)}</p>` : ''}
        <button class="btn btn-primary" data-action="generateRound2" style="margin-top:0.75rem;">
          Generate Round 2
        </button>
      </div>`;
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
    const isGroupStage = season.scheduleFormat === 'groupStage' && !!season.groupStageState;
    const roundStage = isGroupStage
      ? (activeRound.matchups[0]?.stage || (this._selectedRound <= 3 ? 1 : 2))
      : null;

    container.innerHTML = `
      <div class="admin-section">
        <div class="admin-section-header">
          <h2>Regular Season Schedule — ${escapeHtml(season.name)}${isGroupStage ? ' (Group Stage)' : ''}</h2>
          <button class="btn btn-sm btn-ghost" data-action="regenerate"
            ${state.hasCompletedGames ? 'disabled title="Regeneration is disabled once any game has been completed."' : ''}>
            Regenerate Schedule
          </button>
          ${state.hasCompletedGames ? `
          <button class="btn btn-sm btn-ghost" data-action="resetSchedule" style="color:var(--red,#e74c3c);">
            Reset Schedule (clear test data)
          </button>` : ''}
        </div>
        <p class="helper-text">
          Generated ${generatedDate} — ${state.totalRounds} rounds,
          ${state.completedCount} of ${state.realMatchupCount} games completed.
        </p>

        ${isGroupStage ? this._renderGroupStagePanel(season, state) : ''}

        <div class="round-tabs" id="roundTabs">
          ${rounds.map((r) => `
            <button class="round-tab ${r.round === this._selectedRound ? 'active' : ''}" data-round="${r.round}">
              Round ${r.round}${isGroupStage ? ` <span class="muted" style="font-size:0.7em;">· Stage ${r.matchups[0]?.stage || ''}</span>` : ''}
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
      if (isGroupStage) {
        // Group Stage regeneration needs the group-assignment screen again
        // (pre-filled with the current groups) rather than an immediate
        // one-click regenerate, since the commissioner may want to adjust
        // groups. Round Robin's regenerate (below) is untouched.
        this._pendingFormat = 'groupStage';
        this._pendingGroups = season.groupStageState.groups;
        this._renderFormatPicker(container, season);
        return;
      }
      try {
        AdminActions.generateSchedule(season.id);
        showToast('Schedule regenerated.', 'success');
        this._selectedRound = 1;
        this.render(container);
      } catch (e) {
        showToast(e.message, 'error');
      }
    });

    container.querySelector('[data-action="resetSchedule"]')?.addEventListener('click', () => {
      const really = prompt(
        'This permanently deletes ALL games and results for this schedule (including anything already ' +
        'played) and cannot be undone. Type RESET to confirm.'
      );
      if (really !== 'RESET') return;
      AuthBoundary.requireAuth();
      try {
        AdminActions.resetSchedule(season.id);
        showToast('Schedule cleared.', 'success');
        this._pendingFormat = 'roundRobin';
        this._pendingGroups = null;
        this._pendingRound2Groups = null;
        this._round2Error = null;
        this._selectedRound = 1;
        this.render(container);
      } catch (e) {
        showToast(e.message, 'error');
      }
    });

    container.querySelectorAll('[data-round2-group]').forEach((select) => {
      select.onchange = () => {
        const g = select.dataset.round2Group;
        const idx = Number(select.dataset.round2Index);
        this._pendingRound2Groups[g][idx] = select.value || null;
        this._round2Error = null;
        this._renderGenerated(container, season, state);
      };
    });

    container.querySelector('[data-action="generateRound2"]')?.addEventListener('click', () => {
      AuthBoundary.requireAuth();
      const summary = ['A', 'B', 'C', 'D']
        .map((g) => `Group ${g}:\n${this._pendingRound2Groups[g].map((pid) => '  - ' + (season.participants[pid]?.name || '(empty)')).join('\n')}`)
        .join('\n\n');
      if (!confirm(
        `Generate Round 2 with these groups?\n\n${summary}\n\nExpected games: 24 (3/team). ` +
        `This locks Round 1 results — they can no longer be edited afterward.`
      )) return;
      try {
        AdminActions.generateGroupStageRound2(season.id, this._pendingRound2Groups);
        showToast('Round 2 generated.', 'success');
        this._selectedRound = 4;
        this._pendingRound2Groups = null;
        this._round2Error = null;
        this.render(container);
      } catch (e) {
        this._round2Error = e.message;
        this._renderGenerated(container, season, state);
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
    const round1Locked = m.stage === 1 && season.groupStageState && season.groupStageState.stage === 2;
    const groupBadge = m.group ? `<span class="status-chip" style="margin-right:0.5rem;">Group ${m.group}</span>` : '';
    const { leftId, rightId, leftScore, rightScore, leftIsWinner, rightIsWinner, hasHomeCourt } = matchupHomeAway(m);
    return `
      <div class="matchup-row ${isCompleted ? 'completed' : ''}">
        ${groupBadge}
        <div class="matchup-teams">
          <span class="${leftIsWinner ? 'winner' : ''}">${hasHomeCourt ? '🏠 ' : ''}${nameFor(leftId)}</span>
          <span class="matchup-vs">vs</span>
          <span class="${rightIsWinner ? 'winner' : ''}">${nameFor(rightId)}</span>
        </div>
        ${isCompleted ? `
          <div class="matchup-result">
            <span class="matchup-score">${leftScore} – ${rightScore}</span>
            <span class="matchup-streamer">🎥 ${escapeHtml(m.streamer)}</span>
          </div>
          ${round1Locked
            ? `<span class="muted" style="font-size:0.75rem;" title="Round 2 has been generated from these standings">🔒 Locked</span>`
            : `<button class="btn btn-sm btn-ghost" data-action="enter-score" data-matchup-id="${m.id}">Edit</button>`}
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
    const hasHomeCourt = m.home != null && m.away != null;
    const tagFor = (pid) => hasHomeCourt ? (pid === m.home ? ' (Home)' : ' (Away)') : '';

    const panel = container.querySelector('#scorePanel');
    panel.classList.remove('hidden');
    panel.innerHTML = `
      <h4>${escapeHtml(nameFor(m.teamA))}${escapeHtml(tagFor(m.teamA))} vs ${escapeHtml(nameFor(m.teamB))}${escapeHtml(tagFor(m.teamB))}</h4>
      <div class="score-entry-row">
        <div class="form-group">
          <label>${escapeHtml(nameFor(m.teamA))}${escapeHtml(tagFor(m.teamA))} Score</label>
          <input type="number" min="0" step="1" class="input" id="scoreAInput" value="${m.scoreA ?? ''}">
        </div>
        <div class="form-group">
          <label>${escapeHtml(nameFor(m.teamB))}${escapeHtml(tagFor(m.teamB))} Score</label>
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
