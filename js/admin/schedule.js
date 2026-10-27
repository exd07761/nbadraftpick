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
 *   - Group Stage: three stages of four equal groups playing one round robin each.
 *     Round 1 groups are auto-assigned from the existing team order
 *     (adjustable). Round 2 and Round 3 groups are entered manually by the
 *     commissioner after running an external online roulette — this file
 *     never computes or suggests later-round group membership.
 *     See data.js's Group Stage section for the actual scheduling logic —
 *     this file is UI only.
 */
const AdminScheduleView = {
  _selectedRound: 1,
  _pendingFormat: 'roundRobin', // which format is selected in the pre-generation picker
  _pendingGroups: null,         // { A:[...], B:[...], C:[...], D:[...] } — draft Round 1 group assignment, not yet saved
  _pendingRound2Groups: null,   // draft manual Round 2 assignment
  _round2Error: null,           // last Round 2 validation error
  _pendingRound3Groups: null,   // draft manual Round 3 assignment
  _round3Error: null,           // last Round 3 validation error
  _pendingConferences: null,    // { A:[...], B:[...] } — draft Conference Round Robin conference split, not yet saved
  _scoreModalClose: null,

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
    const assignedCount = season.teamAssignmentOrder.filter((pid) => !!season.nbaTeamAssignments[pid]).length;
    const isGroupStage = this._pendingFormat === 'groupStage';
    const isConferenceRoundRobin = this._pendingFormat === 'conferenceRoundRobin';

    if (isGroupStage && !this._pendingGroups) {
      this._pendingGroups = this._autoAssignGroups(season);
    }
    if (isConferenceRoundRobin && !this._pendingConferences) {
      this._pendingConferences = this._autoAssignConferences(season);
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
            <button type="button" class="pool-tab ${this._pendingFormat === 'conferenceRoundRobin' ? 'active' : ''}" data-format="conferenceRoundRobin">Conference Round Robin</button>
          </div>
        </div>

        ${this._pendingFormat === 'roundRobin' ? `
          <p class="helper-text">Every team plays every other team exactly once
            (${assignedCount} teams → ${assignedCount > 1 ? assignedCount * (assignedCount - 1) / 2 : 0} games,
            ${assignedCount > 1 ? assignedCount - 1 : 0} games/team).</p>
          <button class="btn btn-primary" data-action="generateRoundRobin">Generate Schedule</button>
        ` : isConferenceRoundRobin ? this._renderConferenceRoundRobinSetup(season, assignedCount) : this._renderGroupStageSetup(season, assignedCount)}
      </div>`;

    container.querySelector('#formatTabs').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-format]');
      if (!btn) return;
      this._pendingFormat = btn.dataset.format;
      if (this._pendingFormat === 'groupStage' && !this._pendingGroups) {
        this._pendingGroups = this._autoAssignGroups(season);
      }
      if (this._pendingFormat === 'conferenceRoundRobin' && !this._pendingConferences) {
        this._pendingConferences = this._autoAssignConferences(season);
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
    this._bindConferenceRoundRobinSetupEvents(container, season);
  },

  /** Automatic assignment: teamAssignmentOrder split in half — first half into Conference A, second half into Conference B. An odd assigned count gives Conference A the extra team. Purely a starting point; the commissioner can move teams between conferences before generating. */
  _autoAssignConferences(season) {
    const teamIds = season.teamAssignmentOrder.filter((pid) => !!season.nbaTeamAssignments[pid]);
    const mid = Math.ceil(teamIds.length / 2);
    return {
      A: teamIds.slice(0, mid),
      B: teamIds.slice(mid),
    };
  },

  _renderConferenceRoundRobinSetup(season, assignedCount) {
    const validCount = assignedCount >= 4;
    const nameFor = (pid) => season.participants[pid]?.name || '—';
    const abbrFor = (pid) => season.nbaTeamAssignments[pid];

    const gamesFor = (n) => (n > 1 ? (n * (n - 1)) / 2 : 0);
    const confACount = (this._pendingConferences?.A || []).length;
    const confBCount = (this._pendingConferences?.B || []).length;
    const totalGames = gamesFor(confACount) + gamesFor(confBCount);

    const conferenceCols = CONFERENCE_NAMES.map((c) => {
      const teamIds = this._pendingConferences[c] || [];
      const countOk = teamIds.length >= 2;
      return `
        <div class="roster-card" style="min-width:220px;">
          <div class="roster-card-header">
            <span class="roster-card-name">Conference ${c}</span>
            <span class="roster-card-count ${countOk ? '' : 'cap-over-text'}">${teamIds.length}</span>
          </div>
          <div class="table-scroll">
            <table class="roster-table">
              <tbody>
                ${teamIds.map((pid) => `
                  <tr>
                    <td>${teamBadge(abbrFor(pid), { size: 'sm' })}</td>
                    <td>${escapeHtml(nameFor(pid))}</td>
                    <td style="text-align:right;">
                      <select class="input" style="padding:0.15rem 0.4rem;font-size:0.8rem;" data-move-conference-team="${pid}" data-from-conference="${c}">
                        ${CONFERENCE_NAMES.map((c2) => `<option value="${c2}" ${c2 === c ? 'selected' : ''}>${c2}</option>`).join('')}
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
          Conference Round Robin requires at least 4 teams with an assigned NBA team, split into two
          conferences of at least 2 (this season has ${assignedCount}). Use Round Robin instead, or
          adjust NBA Team Assignment.
        </div>`;
    }

    return `
      <div class="info-banner" style="margin-bottom:0.75rem;">
        Each team plays every other team in its own conference exactly once. A Conference A team never
        plays a Conference B team in this stage. Current split: Conference A (${confACount} teams,
        ${gamesFor(confACount)} games), Conference B (${confBCount} teams, ${gamesFor(confBCount)} games) —
        <strong>Total: ${totalGames} games</strong>.
      </div>
      <p class="helper-text">Conferences are auto-assigned from the existing NBA Team Assignment order,
        split in half. Use the dropdown next to a team to move them to the other conference before generating.</p>
      <div class="roster-cards" id="conferenceSetupCols" style="display:flex;gap:0.75rem;flex-wrap:wrap;">
        ${conferenceCols}
      </div>
      <p id="conferenceSetupError" class="error-text"></p>
      <button class="btn btn-primary" data-action="generateConferenceRoundRobin" style="margin-top:0.75rem;">Generate Conference Round Robin</button>`;
  },

  _bindConferenceRoundRobinSetupEvents(container, season) {
    container.querySelectorAll('[data-move-conference-team]').forEach((select) => {
      select.onchange = () => {
        const pid = select.dataset.moveConferenceTeam;
        const fromConference = select.dataset.fromConference;
        const toConference = select.value;
        if (toConference === fromConference) return;
        this._pendingConferences[fromConference] = this._pendingConferences[fromConference].filter((id) => id !== pid);
        this._pendingConferences[toConference] = [...(this._pendingConferences[toConference] || []), pid];
        this.render(container);
      };
    });

    container.querySelector('[data-action="generateConferenceRoundRobin"]')?.addEventListener('click', () => {
      AuthBoundary.requireAuth();
      const errEl = container.querySelector('#conferenceSetupError');
      try {
        AdminActions.generateConferenceRoundRobinSchedule(season.id, this._pendingConferences);
        showToast('Conference Round Robin generated.', 'success');
        this._selectedRound = 1;
        this._pendingConferences = null;
        this.render(container);
      } catch (e) {
        if (errEl) errEl.textContent = e.message;
        else showToast(e.message, 'error');
      }
    });
  },

  _groupStageConfig(teamCount) {
    if (!Number.isInteger(teamCount) || teamCount < 8 || teamCount % 4 !== 0) return null;
    const teamsPerGroup = teamCount / 4;
    return {
      teamsPerGroup,
      gamesPerGroup: teamsPerGroup * (teamsPerGroup - 1) / 2,
      gamesPerTeam: teamsPerGroup - 1,
      roundsPerStage: teamsPerGroup % 2 === 0 ? teamsPerGroup - 1 : teamsPerGroup,
      gamesPerStage: 4 * teamsPerGroup * (teamsPerGroup - 1) / 2,
      availableStages: teamsPerGroup > 4 ? 1 : 3,
    };
  },

  /** Automatic assignment: teamAssignmentOrder split into four consecutive equal groups. */
  _autoAssignGroups(season) {
    const teamIds = season.teamAssignmentOrder.filter((pid) => !!season.nbaTeamAssignments[pid]);
    const teamsPerGroup = Math.ceil(teamIds.length / 4);
    return Object.fromEntries(GROUP_NAMES.map((g, index) => [
      g,
      teamIds.slice(index * teamsPerGroup, (index + 1) * teamsPerGroup),
    ]));
  },

  _renderGroupStageSetup(season, assignedCount) {
    const config = this._groupStageConfig(assignedCount);
    const validCount = !!config;
    const nameFor = (pid) => season.participants[pid]?.name || '—';
    const abbrFor = (pid) => season.nbaTeamAssignments[pid];

    const groupCols = GROUP_NAMES.map((g) => {
      const teamIds = this._pendingGroups[g] || [];
      const countOk = !!config && teamIds.length === config.teamsPerGroup;
      return `
        <div class="roster-card" style="min-width:220px;">
          <div class="roster-card-header">
            <span class="roster-card-name">Group ${g}</span>
            <span class="roster-card-count ${countOk ? '' : 'cap-over-text'}">${teamIds.length}/${config?.teamsPerGroup ?? '—'}</span>
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
          Group Stage requires at least 8 teams with assigned NBA teams, with a total divisible by 4
          so Groups A–D can be equal (this season has ${assignedCount}). Use Round Robin instead, or adjust NBA Team Assignment.
        </div>`;
    }

    return `
      <div class="info-banner" style="margin-bottom:0.75rem;">
        ${assignedCount} teams → 4 groups of ${config.teamsPerGroup} → ${config.roundsPerStage} rounds/stage →
        ${config.gamesPerStage} games per stage (${config.gamesPerTeam} games/team/stage) across ${config.availableStages} available stage${config.availableStages === 1 ? '' : 's'} →
        <strong>Total: ${config.gamesPerStage * config.availableStages} games, ${config.gamesPerTeam * config.availableStages} games/team</strong>.
      </div>
      ${config.teamsPerGroup > GROUP_NAMES.length ? `<div class="info-banner warn-banner" style="margin-bottom:0.75rem;">
        Strict Stage 2 rematch protection makes later stages impossible with ${config.teamsPerGroup} teams per group: four Stage 1 groups cannot be repartitioned into four groups this large without repeating opponents. Stage 1 can still be generated, but Stage 2 and Stage 3 will be unavailable.
      </div>` : ''}
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
   * Group Stage-only panel shown above the round tabs. Each later stage uses
   * the same external-roulette assignment flow as Round 2, and standings
   * are cumulative through the currently displayed stage.
   */
  _renderGroupStagePanel(season, state) {
    const gs = season.groupStageState;
    const assignedCount = season.teamAssignmentOrder.filter((pid) => !!season.nbaTeamAssignments[pid]).length;
    const config = this._groupStageConfig(assignedCount);
    const stageSummary = config
      ? `(${config.gamesPerStage} games, ${config.gamesPerTeam}/team across ${config.roundsPerStage} rounds)`
      : '';
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
                  ${(standings?.[g] || []).map((row, i) => `
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

    const renderGroups = (title, groups) => `
      <div class="roster-cards" style="display:flex;gap:0.75rem;flex-wrap:wrap;">
        ${['A', 'B', 'C', 'D'].map((g) => `
          <div class="roster-card" style="min-width:200px;">
            <div class="roster-card-header"><span class="roster-card-name">${title} — Group ${g}</span></div>
            <div class="table-scroll">
              <table class="roster-table"><tbody>
                ${(groups?.[g] || []).map((pid) => `<tr><td>${escapeHtml(nameFor(pid))}</td></tr>`).join('')}
              </tbody></table>
            </div>
          </div>`).join('')}
      </div>`;

    if (gs.stage === 1) {
      const round1Matchups = season.schedule.flatMap((r) => r.matchups).filter((m) => m.stage === 1 && m.teamB !== null);
      const round1Complete = round1Matchups.every((m) => m.status === 'completed');
      return `
        <div class="info-banner" style="margin:0.75rem 0;">
          <strong>Stage 1 — Round 1 Group Play</strong> ${stageSummary}.
          ${round1Complete
            ? config?.availableStages === 1
              ? 'Stage 1 is complete. Later stages are unavailable because strict rematch protection cannot be satisfied with this group size.'
              : 'Round 1 is complete. Run the external online roulette, then enter the Round 2 groups manually below.'
            : 'Complete all Round 1 games, then run the roulette to assign Round 2 groups.'}
        </div>
        ${groupTable(LeagueData.getGroupStageStandings(season.id, 1))}
        ${round1Complete && config?.availableStages > 1 ? this._renderLaterRoundAssignment(season, 2) : ''}`;
    }

    if (gs.stage === 2) {
      const stage2Matchups = season.schedule.flatMap((r) => r.matchups).filter((m) => m.stage === 2 && m.teamB !== null);
      const stage2Complete = stage2Matchups.every((m) => m.status === 'completed');
      return `
        <div class="info-banner" style="margin:0.75rem 0;">
          <strong>Stage 2 — Round 2 Group Play</strong> ${stageSummary}.
          ${stage2Complete
            ? 'Round 2 is complete. Run the external online roulette, then enter the Round 3 groups manually below.'
            : 'Complete all Round 2 games before generating Round 3.'}
        </div>
        <details style="margin-bottom:0.75rem;">
          <summary style="cursor:pointer;">Round 1 final standings (reference only)</summary>
          <div style="margin-top:0.5rem;">${groupTable(LeagueData.getGroupStageStandings(season.id, 1))}</div>
        </details>
        ${renderGroups('Round 2', gs.round2Groups)}
        <details style="margin-top:0.75rem;">
          <summary style="cursor:pointer;">Round 2 cumulative standings</summary>
          <div style="margin-top:0.5rem;">${groupTable(LeagueData.getGroupStageStandings(season.id, 2))}</div>
        </details>
        ${stage2Complete ? this._renderLaterRoundAssignment(season, 3) : ''}`;
    }

    return `
      <div class="info-banner" style="margin:0.75rem 0;">
        <strong>Stage 3 — Round 3 Group Play</strong> ${stageSummary}.
        Round 3 standings carry forward the complete Round 1 + Round 2 W/L/+/- record.
      </div>
      ${renderGroups('Round 3', gs.round3Groups)}
      <details style="margin-top:0.75rem;">
        <summary style="cursor:pointer;">Final cumulative Group Stage standings</summary>
        <div style="margin-top:0.5rem;">${groupTable(LeagueData.getGroupStageStandings(season.id, 3))}</div>
      </details>`;
  },

  _renderLaterRoundAssignment(season, stage) {
    const key = stage === 2 ? '_pendingRound2Groups' : '_pendingRound3Groups';
    const errorKey = stage === 2 ? '_round2Error' : '_round3Error';
    const assignedTeamIds = season.teamAssignmentOrder.filter((pid) => !!season.nbaTeamAssignments[pid]);
    const config = this._groupStageConfig(assignedTeamIds.length);
    const teamsPerGroup = config?.teamsPerGroup || Math.ceil(assignedTeamIds.length / 4);
    if (!this[key]) {
      this[key] = Object.fromEntries(GROUP_NAMES.map((g) => [g, Array(teamsPerGroup).fill(null)]));
    }
    const nameFor = (pid) => season.participants[pid]?.name || '—';
    const allSelected = GROUP_NAMES.flatMap((g) => this[key][g]).filter((pid) => pid != null);
    const assignedCount = allSelected.length;
    const groupCols = GROUP_NAMES.map((g) => {
      const slots = this[key][g];
      return `
        <div class="roster-card" style="min-width:220px;">
          <div class="roster-card-header">
            <span class="roster-card-name">Group ${g}</span>
            <span class="roster-card-count ${slots.filter((s) => s != null).length === teamsPerGroup ? '' : 'cap-over-text'}">${slots.filter((s) => s != null).length}/${teamsPerGroup}</span>
          </div>
          <div class="table-scroll"><table class="roster-table"><tbody>
            ${slots.map((pid, i) => `
              <tr><td>
                <select class="input" style="width:100%;" data-later-stage="${stage}" data-later-group="${g}" data-later-index="${i}">
                  <option value="">Select Team…</option>
                  ${assignedTeamIds.map((tid) => {
                    const isThisSlot = tid === pid;
                    const isUsedElsewhere = !isThisSlot && allSelected.includes(tid);
                    return `<option value="${tid}" ${isThisSlot ? 'selected' : ''} ${isUsedElsewhere ? 'disabled' : ''}>${escapeHtml(nameFor(tid))}</option>`;
                  }).join('')}
                </select>
              </td></tr>`).join('')}
          </tbody></table></div>
        </div>`;
    }).join('');

    return `
      <div style="margin-top:1rem;">
        <h3 class="section-title" style="font-size:1rem;margin-bottom:0.5rem;">Round ${stage} Group Assignment (from external roulette)</h3>
        <p class="helper-text">Enter the roulette result below. Assigned: ${assignedCount}/${assignedTeamIds.length}.</p>
        ${stage === 2 && config && config.teamsPerGroup > GROUP_NAMES.length
          ? `<div class="info-banner warn-banner">Stage 2 cannot be generated while strict rematch protection is enabled. With ${config.teamsPerGroup} teams per group but only ${GROUP_NAMES.length} Stage 1 groups, every Stage 2 group must repeat at least one Stage 1 opponent.</div>`
          : ''}
        <div class="roster-cards" id="round${stage}AssignmentCols" style="display:flex;gap:0.75rem;flex-wrap:wrap;">${groupCols}</div>
        ${this[errorKey] ? `<p class="error-text" style="margin-top:0.5rem;">${escapeHtml(this[errorKey])}</p>` : ''}
        <button class="btn btn-primary" data-action="generateLaterRound" data-stage="${stage}" style="margin-top:0.75rem;" ${stage === 2 && config && config.teamsPerGroup > GROUP_NAMES.length ? 'disabled' : ''}>Generate Round ${stage}</button>
      </div>`;
  },

  // Backward-compatible name retained for any existing internal callers.
  _renderRound2Assignment(season) {
    return this._renderLaterRoundAssignment(season, 2);
  },

  /**
   * Conference Round Robin-only panel shown above the round tabs: the
   * two conferences' standings, side by side. This panel is standings-only
   * for now; playoff qualification is intentionally not displayed until
   * the conference playoff system is implemented.
   */
  _renderConferenceRoundRobinPanel(season) {
    const standings = LeagueData.getConferenceRoundRobinStandings(season.id);
    if (!standings) return '';

    const confTable = (rows) => `
      <div class="roster-card" style="min-width:260px;">
        <div class="table-scroll">
          <table class="roster-table">
            <thead><tr><th>#</th><th>Team</th><th>W-L</th><th>+/-</th></tr></thead>
            <tbody>
              ${rows.map((row, i) => `
                <tr>
                  <td>${i + 1}</td>
                  <td>${escapeHtml(row.participantName || '—')}</td>
                  <td>${row.wins}-${row.losses}</td>
                  <td>${row.pointDifferential > 0 ? '+' : ''}${row.pointDifferential}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>`;

    return `
      <div class="info-banner" style="margin:0.75rem 0;">
        <strong>Conference Round Robin</strong> — each conference plays its own round robin.
        Conference A teams do not play Conference B teams in the regular season.
      </div>
      <div class="roster-cards" style="display:flex;gap:0.75rem;flex-wrap:wrap;margin-bottom:0.75rem;">
        ${CONFERENCE_NAMES.map((c) => `
          <div>
            <h3 class="section-title" style="font-size:0.95rem;margin-bottom:0.35rem;">Conference ${c}</h3>
            ${confTable(standings[c] || [])}
          </div>`).join('')}
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
    const isConferenceRoundRobin = season.scheduleFormat === 'conferenceRoundRobin' && !!season.conferenceRoundRobinState;
    const roundStage = isGroupStage
      ? (activeRound.matchups.find((m) => m.stage)?.stage || season.groupStageState.stage)
      : null;
    const formatLabel = isGroupStage ? ' (Group Stage)' : isConferenceRoundRobin ? ' (Conference Round Robin)' : '';

    container.innerHTML = `
      <div class="admin-section">
        <div class="admin-section-header">
          <h2>Regular Season Schedule — ${escapeHtml(season.name)}${formatLabel}</h2>
          <button class="btn btn-sm btn-ghost" data-action="regenerate"
            ${state.hasCompletedGames ? 'disabled title="Regeneration is disabled once any game has been completed."' : ''}>
            Regenerate Schedule
          </button>
          <button class="btn btn-sm btn-ghost" data-action="resetSchedule" style="color:var(--red,#e74c3c);">
            Reset Schedule
          </button>
        </div>
        <p class="helper-text">
          Generated ${generatedDate} — ${state.totalRounds} rounds,
          ${state.completedCount} of ${state.realMatchupCount} games completed.
        </p>

        ${isGroupStage ? this._renderGroupStagePanel(season, state) : ''}
        ${isConferenceRoundRobin ? this._renderConferenceRoundRobinPanel(season) : ''}

        <div class="round-tabs" id="roundTabs">
          ${rounds.map((r) => `
            <button class="round-tab ${r.round === this._selectedRound ? 'active' : ''}" data-round="${r.round}">
              Round ${r.round}${isGroupStage ? ` <span class="muted" style="font-size:0.7em;">· Stage ${r.matchups[0]?.stage || ''}</span>` : ''}
            </button>`).join('')}
        </div>

        <div class="matchup-list" id="matchupList">
          ${activeRound.matchups.map((m) => this._renderMatchupRow(season, m)).join('')}
        </div>

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
      if (isConferenceRoundRobin) {
        // Same reasoning as Group Stage above: reopen the conference-
        // assignment screen pre-filled with the current split, rather than
        // an immediate one-click regenerate.
        this._pendingFormat = 'conferenceRoundRobin';
        this._pendingConferences = season.conferenceRoundRobinState.conferences;
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
        this._pendingRound3Groups = null;
        this._round3Error = null;
        this._pendingConferences = null;
        this._selectedRound = 1;
        this.render(container);
      } catch (e) {
        showToast(e.message, 'error');
      }
    });

    container.querySelectorAll('[data-later-stage]').forEach((select) => {
      select.onchange = () => {
        const stage = Number(select.dataset.laterStage);
        const key = stage === 2 ? '_pendingRound2Groups' : '_pendingRound3Groups';
        const errorKey = stage === 2 ? '_round2Error' : '_round3Error';
        const g = select.dataset.laterGroup;
        const idx = Number(select.dataset.laterIndex);
        this[key][g][idx] = select.value || null;
        this[errorKey] = null;
        this._renderGenerated(container, season, state);
      };
    });

    container.querySelector('[data-action="generateLaterRound"]')?.addEventListener('click', () => {
      AuthBoundary.requireAuth();
      const stage = Number(container.querySelector('[data-action="generateLaterRound"]').dataset.stage);
      const key = stage === 2 ? '_pendingRound2Groups' : '_pendingRound3Groups';
      const errorKey = stage === 2 ? '_round2Error' : '_round3Error';
      const groups = this[key];
      const config = this._groupStageConfig(season.teamAssignmentOrder.filter((pid) => !!season.nbaTeamAssignments[pid]).length);
      const summary = ['A', 'B', 'C', 'D']
        .map((g) => `Group ${g}:\n${groups[g].map((pid) => '  - ' + (season.participants[pid]?.name || '(empty)')).join('\n')}`)
        .join('\n\n');
      if (!confirm(
        `Generate Round ${stage} with these groups?\n\n${summary}\n\nExpected games: ${config?.gamesPerStage ?? '?'} (${config?.gamesPerTeam ?? '?'} per team). ` +
        `This locks all earlier Group Stage results — they can no longer be edited afterward.`
      )) return;
      try {
        const newRounds = AdminActions[`generateGroupStageRound${stage}`](season.id, groups);
        showToast(`Round ${stage} generated.`, 'success');
        this._selectedRound = newRounds[0]?.round || this._selectedRound;
        this[key] = null;
        this[errorKey] = null;
        this.render(container);
      } catch (e) {
        this[errorKey] = e.message;
        this._renderGenerated(container, season, state);
      }
    });

    container.querySelectorAll('[data-action="enter-score"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this._openScoreModal(container, season, btn.dataset.matchupId, btn);
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
    const round1Locked = m.stage && season.groupStageState && season.groupStageState.stage > m.stage;
    const groupBadge = m.group
      ? `<span class="status-chip" style="margin-right:0.5rem;">Group ${m.group}</span>`
      : m.conference
        ? `<span class="status-chip" style="margin-right:0.5rem;">Conference ${m.conference}</span>`
        : '';
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
            ? `<span class="muted" style="font-size:0.75rem;" title="A later Group Stage round has been generated from these standings">🔒 Locked</span>`
            : `<button class="btn btn-sm btn-ghost" data-action="enter-score" data-matchup-id="${m.id}">Edit</button>`}
        ` : `
          <span class="matchup-status status-chip status-scheduled">Scheduled</span>
          <button class="btn btn-sm btn-primary" data-action="enter-score" data-matchup-id="${m.id}">Enter Score</button>
        `}
      </div>`;
  },

  _openScoreModal(container, season, matchupId, opener = document.activeElement) {
    const found = LeagueData.getMatchup(season.id, matchupId);
    if (!found || found.matchup.teamB === null) return;
    const { matchup: m } = found;
    const nameFor = (pid) => season.participants[pid]?.name || '—';
    const hasHomeCourt = m.home != null && m.away != null;
    const tagFor = (pid) => hasHomeCourt ? (pid === m.home ? ' (Home)' : ' (Away)') : '';
    const streamerNames = ['Gigs', 'Xtian', 'Jordan', 'Ham', 'Lau', 'Err'];
    const currentStreamer = String(m.streamer || '');
    const streamerOptions = streamerNames.map((name) => ({ value: name, label: name }));
    if (currentStreamer && !streamerNames.includes(currentStreamer)) {
      streamerOptions.push({ value: currentStreamer, label: `${currentStreamer} (saved value)` });
    }
    const currentStreamerLabel = streamerOptions.find((option) => option.value === currentStreamer)?.label || 'Select streamer…';
    const teamInfo = (pid) => {
      const nbaTeam = season.nbaTeamAssignments[pid];
      const homeAway = tagFor(pid).trim().replace(/[()]/g, '') || 'Team';
      return `<div class="score-modal-team"><span>Participant · NBA team</span><strong>${escapeHtml(nameFor(pid))}${nbaTeam ? ` · ${escapeHtml(nbaTeam)}` : ''}</strong><small>${escapeHtml(homeAway)}</small></div>`;
    };
    const gameDetails = [
      found.round != null ? `Round ${found.round}` : '',
      m.stage != null ? `Stage ${m.stage}` : '',
      m.group ? `Group ${m.group}` : '',
      m.conference ? `Conference ${m.conference}` : '',
    ].filter(Boolean).join(' · ');

    // Mount at document.body so admin layout stacking contexts cannot cover
    // the modal or receive keyboard/pointer input.
    this._scoreModalClose?.(false);
    const previousBodyOverflow = document.body.style.overflow;
    const overlay = document.createElement('div');
    overlay.id = 'regularSeasonScoreOverlay';
    overlay.className = 'modal-overlay regular-season-score-overlay';
    overlay.innerHTML = `
      <section class="modal-card regular-season-score-modal" role="dialog" aria-modal="true" aria-labelledby="scoreModalTitle" aria-describedby="scoreModalContext" tabindex="-1">
        <header class="score-modal-header">
          <div><span class="modal-eyebrow">REGULAR SEASON</span><h2 id="scoreModalTitle">Enter Score</h2></div>
        </header>
        <p class="score-modal-context" id="scoreModalContext">${escapeHtml(gameDetails || 'Game result')}</p>
        <div class="score-modal-teams">${teamInfo(m.teamA)}${teamInfo(m.teamB)}</div>
        <div class="score-modal-body">
          <div class="score-entry-row">
            <div class="form-group">
              <label for="scoreAInput">${escapeHtml(nameFor(m.teamA))}${escapeHtml(tagFor(m.teamA))} Score</label>
              <input type="number" min="0" step="1" class="input" id="scoreAInput" value="${m.scoreA ?? ''}">
            </div>
            <div class="form-group">
              <label for="scoreBInput">${escapeHtml(nameFor(m.teamB))}${escapeHtml(tagFor(m.teamB))} Score</label>
              <input type="number" min="0" step="1" class="input" id="scoreBInput" value="${m.scoreB ?? ''}">
            </div>
          </div>
        </div>
        <footer class="score-modal-actions">
          <div class="score-modal-fields">
            <div class="form-group score-modal-streamer">
              <label id="streamerLabel" for="streamerInput">Streamer</label>
              <button type="button" class="input score-streamer-trigger" id="streamerInput" role="combobox"
                aria-haspopup="listbox" aria-autocomplete="none" aria-expanded="false" aria-controls="scoreStreamerOptions" aria-describedby="scoreError"
                data-streamer-value="${escapeHtml(currentStreamer)}">
                <span id="scoreStreamerValue">${escapeHtml(currentStreamerLabel)}</span><span aria-hidden="true">▾</span>
              </button>
              <div class="score-streamer-options" id="scoreStreamerOptions" role="listbox" aria-labelledby="streamerLabel" hidden>
                ${streamerOptions.map((option, index) => `
                  <div class="score-streamer-option" id="scoreStreamerOption${index}" role="option" tabindex="-1"
                    aria-selected="${option.value === currentStreamer}" data-streamer-value="${escapeHtml(option.value)}">
                    ${escapeHtml(option.label)}
                  </div>`).join('')}
              </div>
            </div>
            <p id="scoreError" class="error-text" role="alert" aria-live="polite"></p>
          </div>
          <div class="score-modal-action-buttons">
            <button type="button" class="btn btn-ghost" id="btnCancelScore">Cancel</button>
            <button type="button" class="btn btn-primary" id="btnSaveScore">Save Score</button>
          </div>
        </footer>
      </section>`;
    document.body.appendChild(overlay);

    const dialog = overlay.querySelector('[role="dialog"]');
    const close = (restoreFocus = true) => {
      document.removeEventListener('keydown', onKeydown);
      overlay.remove();
      document.body.style.overflow = previousBodyOverflow;
      if (this._scoreModalClose === close) this._scoreModalClose = null;
      if (restoreFocus && opener?.isConnected) opener.focus();
    };
    const onKeydown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== 'Tab') return;
      const controls = [...dialog.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')];
      if (!controls.length) { event.preventDefault(); dialog.focus(); return; }
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    this._scoreModalClose = close;
    document.addEventListener('keydown', onKeydown);
    document.body.style.overflow = 'hidden';
    dialog?.querySelector('#scoreAInput')?.focus();

    const streamerTrigger = overlay.querySelector('#streamerInput');
    const streamerValue = overlay.querySelector('#scoreStreamerValue');
    const streamerListbox = overlay.querySelector('#scoreStreamerOptions');
    const streamerChoices = [...streamerListbox.querySelectorAll('[role="option"]')];
    let activeStreamerIndex = -1;
    const closeStreamerList = () => {
      streamerListbox.hidden = true;
      streamerTrigger.setAttribute('aria-expanded', 'false');
      streamerTrigger.removeAttribute('aria-activedescendant');
      activeStreamerIndex = -1;
    };
    const setActiveStreamer = (index) => {
      if (!streamerChoices.length) return;
      activeStreamerIndex = (index + streamerChoices.length) % streamerChoices.length;
      const active = streamerChoices[activeStreamerIndex];
      streamerTrigger.setAttribute('aria-activedescendant', active.id);
      streamerChoices.forEach((choice, choiceIndex) => {
        if (choiceIndex === activeStreamerIndex) choice.setAttribute('data-active', 'true');
        else choice.removeAttribute('data-active');
      });
      active.scrollIntoView?.({ block: 'nearest' });
    };
    const openStreamerList = (direction = 1) => {
      streamerListbox.hidden = false;
      streamerTrigger.setAttribute('aria-expanded', 'true');
      const selectedIndex = streamerChoices.findIndex((choice) => choice.dataset.streamerValue === streamerTrigger.dataset.streamerValue);
      setActiveStreamer(selectedIndex >= 0 ? selectedIndex : direction > 0 ? 0 : streamerChoices.length - 1);
    };
    const chooseStreamer = (choice) => {
      streamerTrigger.dataset.streamerValue = choice.dataset.streamerValue;
      streamerValue.textContent = choice.textContent.trim();
      streamerChoices.forEach((option) => option.setAttribute('aria-selected', String(option === choice)));
      closeStreamerList();
      streamerTrigger.focus();
    };
    streamerTrigger.addEventListener('click', () => {
      if (streamerListbox.hidden) openStreamerList();
      else closeStreamerList();
    });
    streamerTrigger.addEventListener('keydown', (event) => {
      if (event.key === 'Tab' && !streamerListbox.hidden) {
        closeStreamerList();
      } else if (event.key === 'Escape' && !streamerListbox.hidden) {
        event.preventDefault();
        event.stopPropagation();
        closeStreamerList();
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        event.stopPropagation();
        const direction = event.key === 'ArrowDown' ? 1 : -1;
        if (streamerListbox.hidden) openStreamerList(direction);
        else setActiveStreamer(activeStreamerIndex + direction);
      } else if (event.key === 'Home' || event.key === 'End') {
        if (streamerListbox.hidden) return;
        event.preventDefault();
        event.stopPropagation();
        setActiveStreamer(event.key === 'Home' ? 0 : streamerChoices.length - 1);
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        event.stopPropagation();
        if (streamerListbox.hidden) openStreamerList();
        else if (activeStreamerIndex >= 0) chooseStreamer(streamerChoices[activeStreamerIndex]);
      } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        const query = event.key.toLocaleLowerCase();
        const startAt = activeStreamerIndex + 1;
        const matchOffset = streamerChoices.slice(startAt).concat(streamerChoices.slice(0, startAt))
          .findIndex((choice) => choice.textContent.trim().toLocaleLowerCase().startsWith(query));
        if (matchOffset >= 0) {
          event.preventDefault();
          event.stopPropagation();
          if (streamerListbox.hidden) openStreamerList();
          setActiveStreamer((startAt + matchOffset) % streamerChoices.length);
        }
      }
    });
    streamerChoices.forEach((choice) => choice.addEventListener('click', () => chooseStreamer(choice)));

    overlay.querySelector('#btnCancelScore').onclick = () => close();
    overlay.querySelector('#btnSaveScore').onclick = async () => {
      AuthBoundary.requireAuth();
      const scoreA = overlay.querySelector('#scoreAInput').value;
      const scoreB = overlay.querySelector('#scoreBInput').value;
      const streamer = streamerTrigger.dataset.streamerValue;
      try {
        AdminActions.recordMatchResult(season.id, matchupId, { scoreA, scoreB, streamer });
        const activeSync = window.USE_SUPABASE_SYNC ? SupabaseSync : FirebaseSync;
        await activeSync.waitForPendingSave();
        close(false);
        showToast('Result saved.', 'success');
        this.render(container);
        const updatedScoreButton = [...container.querySelectorAll('[data-action="enter-score"]')]
          .find((button) => button.dataset.matchupId === matchupId);
        updatedScoreButton?.focus();
      } catch (e) {
        overlay.querySelector('#scoreError').textContent = e.message;
      }
    };
  },
};
