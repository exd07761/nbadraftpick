/**
 * admin/seasons.js — Season management view
 */
const AdminSeasonsView = {
  render(container) {
    const seasons = LeagueData.getAllSeasons();
    const currentId = LeagueData.getCurrentSeasonId();

    container.innerHTML = `
      <div class="admin-section">
        <div class="admin-section-header">
          <h2>Seasons</h2>
          <button class="btn btn-primary" id="btnNewSeason">+ New Season</button>
        </div>

        <div id="newSeasonForm" class="inline-form hidden">
          <input type="text" id="newSeasonName" class="input" placeholder="Season name (e.g. Season 4)" maxlength="60">
          <input type="number" id="newSeasonEntryFee" class="input input-sm" placeholder="Entry Fee" min="0" step="1" value="300" title="Entry Fee (₱)">
          <input type="number" id="newSeasonFreeTrades" class="input input-sm" placeholder="Free Trades" min="0" step="1" value="2" title="Free Trades">
          <input type="number" id="newSeasonFreeSwaps" class="input input-sm" placeholder="Free Swaps" min="0" step="1" value="2" title="Free Swaps">
          <button class="btn btn-primary" id="btnCreateSeason">Create</button>
          <button class="btn btn-ghost" id="btnCancelSeason">Cancel</button>
        </div>

        ${seasons.length === 0 ? `
        <div class="empty-state">
          <p>No seasons yet. Create one to get started.</p>
        </div>` : `
        <div class="table-scroll">
        <table class="admin-table">
          <thead>
            <tr>
              <th>Season</th><th>Status</th><th>Participants</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${seasons.map(s => {
              const count = LeagueData.getParticipants(s.id).length;
              return `
                <tr class="${s.id === currentId ? 'row-active' : ''}">
                  <td>
                    ${escapeHtml(s.name)}
                    ${s.id === currentId ? '<span class="badge-current">CURRENT</span>' : ''}
                  </td>
                  <td><span class="status-chip status-${s.status}">${formatStatus(s.status)}</span></td>
                  <td>${count}</td>
                  <td class="action-cell">
                    ${s.id !== currentId ? `<button class="btn btn-sm btn-ghost" data-action="setCurrent" data-id="${s.id}">Set Current</button>` : ''}
                    <button class="btn btn-sm btn-danger" data-action="deleteSeason" data-id="${s.id}" data-name="${escapeHtml(s.name)}">Delete</button>
                  </td>
                </tr>`;
            }).join('')}
          </tbody>
        </table>
        </div>`}
      </div>`;

    // New season toggle
    container.querySelector('#btnNewSeason').onclick = () => {
      container.querySelector('#newSeasonForm').classList.remove('hidden');
      container.querySelector('#newSeasonName').focus();
    };
    container.querySelector('#btnCancelSeason').onclick = () => {
      container.querySelector('#newSeasonForm').classList.add('hidden');
    };
    container.querySelector('#btnCreateSeason').onclick = () => {
      AuthBoundary.requireAuth();
      const name = container.querySelector('#newSeasonName').value.trim();
      if (!name) { showToast('Enter a season name.', 'error'); return; }

      // Entry Fee / Free Trades / Free Swaps — F1 schema fields only, no
      // financial behavior wired to these values yet. Blank inputs fall
      // back to createSeason()'s own defaults (300/2/2) rather than being
      // sent as overrides.
      const entryFeeVal = container.querySelector('#newSeasonEntryFee').value.trim();
      const freeTradesVal = container.querySelector('#newSeasonFreeTrades').value.trim();
      const freeSwapsVal = container.querySelector('#newSeasonFreeSwaps').value.trim();
      const financialSettings = {};
      if (entryFeeVal !== '') financialSettings.entryFee = entryFeeVal;
      if (freeTradesVal !== '') financialSettings.freeTrades = freeTradesVal;
      if (freeSwapsVal !== '') financialSettings.freeSwaps = freeSwapsVal;

      try {
        AdminActions.createSeason(name, financialSettings);
        showToast(`"${name}" created.`, 'success');
        AdminApp.renderView('seasons');
      } catch (e) {
        showToast(e.message, 'error');
      }
    };

    // Table actions
    container.querySelectorAll('[data-action]').forEach(btn => {
      btn.onclick = () => {
        AuthBoundary.requireAuth();
        const { action, id, name } = btn.dataset;
        if (action === 'setCurrent') {
          AdminActions.setCurrentSeason(id);
          showToast('Current season updated.', 'success');
          AdminApp.renderView('seasons');
        } else if (action === 'deleteSeason') {
          if (!confirm(`Delete season "${name}"? This cannot be undone.`)) return;
          AdminActions.deleteSeason(id);
          showToast(`Season deleted.`, 'success');
          AdminApp.renderView('seasons');
        }
      };
    });
  }
};
