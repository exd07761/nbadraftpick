/**
 * admin/team-assignment.js
 *
 * NBA Team Assignment process.
 * This runs AFTER the player draft is complete.
 * Uses teamAssignmentOrder (the second DuckRace result) — not playerDraftOrder.
 *
 * Each participant chooses an available NBA team in their assigned order.
 */
const AdminTeamAssignmentView = {
  render(container) {
    const season = LeagueData.getCurrentSeason();
    if (!season) {
      container.innerHTML = `<div class="empty-state"><p>No current season.</p></div>`;
      return;
    }

    const teamOrder = LeagueData.getTeamAssignmentOrder(season.id);
    const assignments = LeagueData.getNBATeamAssignments(season.id);
    const allTeams = LeagueData.getNBATeams();
    const availableTeams = LeagueData.getAvailableNBATeams(season.id);

    if (!teamOrder.length) {
      container.innerHTML = `
        <div class="empty-state">
          <p>Set the NBA Team Assignment Order (DuckRace #2) before assigning teams.</p>
          <button class="btn btn-primary" data-action="goDraftOrder">Go to DuckRace Orders</button>
        </div>`;
      container.querySelector('[data-action="goDraftOrder"]').onclick = () => AdminApp.renderView('draftOrder');
      return;
    }

    container.innerHTML = `
      <div class="admin-section">
        <div class="admin-section-header">
          <h2>NBA Team Assignment — ${escapeHtml(season.name)}</h2>
        </div>
        <p class="helper-text">
          Assign an NBA team to each participant in the order below (DuckRace #2).
          Each team can only be assigned once.
        </p>

        <div class="assignment-layout">

          <!-- Assignment Queue -->
          <div class="assignment-queue">
            <h3>Assignment Order</h3>
            <div class="queue-list">
              ${teamOrder.map((p, i) => {
                const assigned = assignments[p.id];
                const team = assigned ? LeagueData.getNBATeam(assigned) : null;
                const isNext = !assigned && !teamOrder.slice(0, i).some(prev => !assignments[prev.id]);
                return `
                  <div class="queue-row ${assigned ? 'done' : ''} ${isNext ? 'next' : ''}">
                    <span class="queue-num">${i + 1}</span>
                    <span class="queue-name">${escapeHtml(p.name)}</span>
                    ${assigned ? `
                      <span class="queue-assigned">${teamBadge(assigned, { size: 'sm' })} ${team ? escapeHtml(team.name) : ''}</span>
                      <button class="btn btn-sm btn-ghost" data-action="unassign" data-pid="${p.id}">Clear</button>
                    ` : `
                      <span class="queue-pending">${isNext ? '← picking now' : 'waiting'}</span>
                    `}
                  </div>`;
              }).join('')}
            </div>
          </div>

          <!-- Team Picker -->
          <div class="team-picker">
            <h3>Available NBA Teams</h3>
            <p class="helper-text">${availableTeams.length} of ${allTeams.length} teams available</p>
            <div class="nba-team-grid">
              ${allTeams.map(team => {
                const takenBy = Object.entries(assignments).find(([, abbr]) => abbr === team.abbr);
                const takenParticipant = takenBy ? LeagueData.getParticipant(season.id, takenBy[0]) : null;
                const isTaken = !!takenBy;
                return `
                  <div class="nba-team-tile ${isTaken ? 'taken' : 'available'}"
                       data-abbr="${team.abbr}"
                       title="${isTaken ? `Taken by ${takenParticipant?.name}` : 'Available'}">
                    ${teamBadge(team.abbr, { size: 'md' })}
                    <span class="tile-name">${escapeHtml(team.name)}</span>
                    ${isTaken ? `<span class="tile-owner">${escapeHtml(takenParticipant?.name || '')}</span>` : ''}
                  </div>`;
              }).join('')}
            </div>

            <!-- Assignment Panel -->
            <div id="assignPanel" class="assign-panel hidden">
              <h4>Assign to: <span id="assignToName"></span></h4>
              <select id="teamSelect" class="input">
                <option value="">— Select NBA Team —</option>
                ${availableTeams.map(t => `<option value="${t.abbr}">${t.abbr} — ${escapeHtml(t.name)}</option>`).join('')}
              </select>
              <div class="form-actions">
                <button class="btn btn-primary" id="btnAssignTeam">Assign</button>
                <button class="btn btn-ghost" id="btnCancelAssign">Cancel</button>
              </div>
            </div>
          </div>
        </div>

        ${Object.keys(assignments).length === teamOrder.length && teamOrder.length > 0 ? `
        <div class="success-banner">
          ✓ All teams assigned! You can mark team assignment as complete.
          <button class="btn btn-primary" data-action="markComplete">Mark Complete</button>
        </div>` : ''}
      </div>`;

    // Next participant to assign
    const nextParticipant = teamOrder.find(p => !assignments[p.id]);

    // Quick-assign: click an available tile
    container.querySelectorAll('.nba-team-tile.available').forEach(tile => {
      tile.onclick = () => {
        if (!nextParticipant) { showToast('All participants have been assigned.', 'info'); return; }
        const panel = container.querySelector('#assignPanel');
        container.querySelector('#assignToName').textContent = nextParticipant.name;
        container.querySelector('#teamSelect').value = tile.dataset.abbr;
        panel.classList.remove('hidden');
        panel.dataset.pid = nextParticipant.id;
      };
    });

    container.querySelector('#btnCancelAssign')?.addEventListener('click', () => {
      container.querySelector('#assignPanel').classList.add('hidden');
    });

    container.querySelector('#btnAssignTeam')?.addEventListener('click', () => {
      AuthBoundary.requireAuth();
      const panel = container.querySelector('#assignPanel');
      const pid = panel.dataset.pid;
      const abbr = container.querySelector('#teamSelect').value;
      if (!abbr) { showToast('Select a team.', 'error'); return; }
      try {
        AdminActions.assignNBATeam(season.id, pid, abbr);
        showToast(`Team assigned.`, 'success');
        AdminApp.renderView('teamAssignment');
      } catch (e) {
        showToast(e.message, 'error');
      }
    });

    container.querySelectorAll('[data-action="unassign"]').forEach(btn => {
      btn.onclick = () => {
        AuthBoundary.requireAuth();
        const pid = btn.dataset.pid;
        AdminActions.unassignNBATeam(season.id, pid);
        showToast('Assignment cleared.', 'success');
        AdminApp.renderView('teamAssignment');
      };
    });

    container.querySelector('[data-action="markComplete"]')?.addEventListener('click', () => {
      AuthBoundary.requireAuth();
      AdminActions.markTeamAssignmentComplete(season.id);
      showToast('Team assignment marked complete!', 'success');
      AdminApp.renderView('teamAssignment');
    });
  }
};
