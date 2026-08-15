/**
 * admin/participants.js — Participant (team owner) management
 */
const AdminParticipantsView = {
  render(container) {
    const season = LeagueData.getCurrentSeason();
    if (!season) {
      container.innerHTML = `<div class="empty-state"><p>No current season. Create a season first.</p></div>`;
      return;
    }

    const participants = LeagueData.getParticipants(season.id);
    const assignments = LeagueData.getNBATeamAssignments(season.id);

    container.innerHTML = `
      <div class="admin-section">
        <div class="admin-section-header">
          <h2>Participants — ${escapeHtml(season.name)}</h2>
          <button class="btn btn-primary" id="btnAddParticipant">+ Add Participant</button>
        </div>

        <div id="addParticipantForm" class="inline-form hidden">
          <input type="text" id="newParticipantName" class="input" placeholder="Name (e.g. Simon)" maxlength="40">
          <button class="btn btn-primary" id="btnCreateParticipant">Add</button>
          <button class="btn btn-ghost" id="btnCancelParticipant">Cancel</button>
        </div>

        <p class="helper-text">${participants.length} participant${participants.length !== 1 ? 's' : ''} — league supports any number of teams</p>

        ${participants.length === 0 ? `
        <div class="empty-state"><p>No participants yet.</p></div>` : `
        <ul class="participant-list">
          ${participants.map((p, i) => {
            const teamAbbr = assignments[p.id];
            const team = teamAbbr ? LeagueData.getNBATeam(teamAbbr) : null;
            return `
              <li class="participant-row" data-id="${p.id}">
                <span class="p-num">${i + 1}</span>
                <span class="p-name" id="pName_${p.id}">${escapeHtml(p.name)}</span>
                ${team ? `<span class="p-team">${teamBadge(teamAbbr, { size: 'sm' })} ${escapeHtml(team.name)}</span>` : '<span class="p-team muted">No team</span>'}
                <div class="p-actions">
                  <button class="btn btn-sm btn-ghost" data-action="editP" data-id="${p.id}">Rename</button>
                  <button class="btn btn-sm btn-danger" data-action="removeP" data-id="${p.id}" data-name="${escapeHtml(p.name)}">Remove</button>
                </div>
              </li>`;
          }).join('')}
        </ul>`}
      </div>`;

    container.querySelector('#btnAddParticipant').onclick = () => {
      container.querySelector('#addParticipantForm').classList.remove('hidden');
      container.querySelector('#newParticipantName').focus();
    };
    container.querySelector('#btnCancelParticipant').onclick = () => {
      container.querySelector('#addParticipantForm').classList.add('hidden');
    };
    container.querySelector('#btnCreateParticipant').onclick = () => {
      AuthBoundary.requireAuth();
      const name = container.querySelector('#newParticipantName').value.trim();
      if (!name) { showToast('Enter a name.', 'error'); return; }
      AdminActions.addParticipant(season.id, name);
      showToast(`${name} added.`, 'success');
      AdminApp.renderView('participants');
    };

    container.querySelectorAll('[data-action]').forEach(btn => {
      btn.onclick = () => {
        AuthBoundary.requireAuth();
        const { action, id, name } = btn.dataset;
        if (action === 'editP') {
          const newName = prompt('New name:', name || LeagueData.getParticipant(season.id, id)?.name);
          if (newName && newName.trim()) {
            AdminActions.updateParticipant(season.id, id, newName.trim());
            showToast('Name updated.', 'success');
            AdminApp.renderView('participants');
          }
        } else if (action === 'removeP') {
          if (!confirm(`Remove "${name}" from this season?`)) return;
          AdminActions.removeParticipant(season.id, id);
          showToast(`${name} removed.`, 'success');
          AdminApp.renderView('participants');
        }
      };
    });
  }
};
