/**
 * admin/draft-order.js
 *
 * Handles TWO completely independent DuckRace order entry processes:
 *
 * 1. Player Draft Order (playerDraftOrder)
 *    — Who picks first in the player draft
 *    — Entered from the first DuckRace result
 *
 * 2. NBA Team Assignment Order (teamAssignmentOrder)
 *    — Who picks first in the NBA team assignment
 *    — Entered from the SECOND DuckRace result
 *    — Completely independent. Must NOT be assumed to equal playerDraftOrder.
 *
 * Neither order is ever randomized by this application.
 */
const AdminDraftOrderView = {
  render(container) {
    const season = LeagueData.getCurrentSeason();
    if (!season) {
      container.innerHTML = `<div class="empty-state"><p>No current season. Create a season first.</p></div>`;
      return;
    }

    const participants = LeagueData.getParticipants(season.id);
    if (!participants.length) {
      container.innerHTML = `<div class="empty-state"><p>Add participants before setting draft order.</p></div>`;
      return;
    }

    const draftOrder = LeagueData.getPlayerDraftOrder(season.id);
    const teamOrder = LeagueData.getTeamAssignmentOrder(season.id);

    container.innerHTML = `
      <div class="admin-section">
        <h2>DuckRace Orders — ${escapeHtml(season.name)}</h2>
        <p class="helper-text">
          Enter both DuckRace results manually. These two orders are completely independent of each other.
          This application does not randomize either order.
        </p>

        <div class="orders-grid">

          <!-- Process 1: Player Draft Order -->
          <div class="order-card">
            <div class="order-card-header">
              <h3>Process 1 — Player Draft Order</h3>
              <span class="order-badge">DuckRace #1</span>
            </div>
            <p class="helper-text">
              Enter the DuckRace result for the player draft.
              This sets who picks first in each round of the snake draft.
            </p>

            ${draftOrder.length ? `
            <div class="order-current">
              <h4>Current Order</h4>
              <ol class="order-list">
                ${draftOrder.map(p => `<li>${escapeHtml(p.name)}</li>`).join('')}
              </ol>
            </div>` : ''}

            <div class="order-editor">
              <h4>Import DuckRace Result</h4>
              <p class="helper-text">Paste the DuckRace results exactly as copied. Example: 1st,Gigs. One participant per line; rank numbers, commas, bullets, and ranking text are automatically ignored.</p>
              <textarea class="duckrace-input" id="draftDuckRaceInput" rows="7" placeholder="Example:
1st,Gigs
2nd,Caster
3rd,Jordan
4th,Rere"></textarea>
              <div class="form-actions duckrace-actions">
                <button class="btn btn-primary" data-action="applyDraftDuckRace">Apply DuckRace Result</button>
                <button class="btn btn-ghost" data-action="clearDraftDuckRace">Clear</button>
              </div>

              <h4 class="order-editor-subheading">Adjust Order Manually</h4>
              <p class="helper-text">After importing, you can still drag participants if a correction is needed.</p>
              <ul class="drag-list" id="draftDragList" data-type="draft">
                ${this._renderDragItems(participants, draftOrder, 'draft')}
              </ul>
              <button class="btn btn-primary" data-action="saveDraftOrder">Save Draft Order</button>
            </div>
          </div>

          <!-- Process 2: Team Assignment Order -->
          <div class="order-card">
            <div class="order-card-header">
              <h3>Process 2 — NBA Team Assignment Order</h3>
              <span class="order-badge">DuckRace #2</span>
            </div>
            <p class="helper-text">
              Enter the <strong>separate</strong> DuckRace result for NBA team assignment.
              This is a distinct process run after the player draft is complete.
            </p>

            ${teamOrder.length ? `
            <div class="order-current">
              <h4>Current Order</h4>
              <ol class="order-list">
                ${teamOrder.map(p => `<li>${escapeHtml(p.name)}</li>`).join('')}
              </ol>
            </div>` : ''}

            <div class="order-editor">
              <h4>Import DuckRace Result</h4>
              <p class="helper-text">Paste the SECOND DuckRace result exactly as copied. Example: 1st,Rere. It is completely independent from the player draft order.</p>
              <textarea class="duckrace-input" id="teamDuckRaceInput" rows="7" placeholder="Example:
1st,Rere
2nd,Mac
3rd,Gigs
4th,Lau"></textarea>
              <div class="form-actions duckrace-actions">
                <button class="btn btn-primary" data-action="applyTeamDuckRace">Apply DuckRace Result</button>
                <button class="btn btn-ghost" data-action="clearTeamDuckRace">Clear</button>
              </div>

              <h4 class="order-editor-subheading">Adjust Order Manually</h4>
              <p class="helper-text">After importing, you can still drag participants if a correction is needed.</p>
              <ul class="drag-list" id="teamDragList" data-type="team">
                ${this._renderDragItems(participants, teamOrder, 'team')}
              </ul>
              <button class="btn btn-primary" data-action="saveTeamOrder">Save Team Assignment Order</button>
            </div>
          </div>

        </div>

        <!-- Snake Draft Preview -->
        ${draftOrder.length ? `
        <div class="snake-preview">
          <h3>Snake Draft Preview</h3>
          <p class="helper-text">Based on current player draft order. Actual number of rounds depends on roster size.</p>
          ${this._renderSnakePreview(draftOrder, 3)}
        </div>` : ''}
      </div>`;

    // Wire up drag-and-drop for both lists
    this._initDragList(container.querySelector('#draftDragList'));
    this._initDragList(container.querySelector('#teamDragList'));

    container.querySelectorAll('[data-action]').forEach(btn => {
      btn.onclick = () => {
        AuthBoundary.requireAuth();
        const action = btn.dataset.action;

        if (action === 'applyDraftDuckRace') {
          this._applyDuckRaceText(container.querySelector('#draftDuckRaceInput'), container.querySelector('#draftDragList'), participants);
        } else if (action === 'clearDraftDuckRace') {
          container.querySelector('#draftDuckRaceInput').value = '';
        } else if (action === 'applyTeamDuckRace') {
          this._applyDuckRaceText(container.querySelector('#teamDuckRaceInput'), container.querySelector('#teamDragList'), participants);
        } else if (action === 'clearTeamDuckRace') {
          container.querySelector('#teamDuckRaceInput').value = '';
        } else if (action === 'saveDraftOrder') {
          const ids = this._getOrderedIds(container.querySelector('#draftDragList'));
          AdminActions.setPlayerDraftOrder(season.id, ids);
          showToast('Player draft order saved.', 'success');
          AdminApp.renderView('draftOrder');
        } else if (action === 'saveTeamOrder') {
          const ids = this._getOrderedIds(container.querySelector('#teamDragList'));
          AdminActions.setTeamAssignmentOrder(season.id, ids);
          showToast('Team assignment order saved.', 'success');
          AdminApp.renderView('draftOrder');
        }
      };
    });
  },

  _renderDragItems(participants, currentOrder, prefix) {
    // If an order exists, show it; otherwise show participants in addition order
    const ordered = currentOrder.length
      ? currentOrder
      : participants;
    return ordered.map((p, i) => `
      <li class="drag-item" draggable="true" data-id="${p.id}">
        <span class="drag-handle">⠿</span>
        <span class="drag-num">${i + 1}</span>
        <span class="drag-name">${escapeHtml(p.name)}</span>
      </li>`).join('');
  },

  _applyDuckRaceText(textarea, list, participants) {
    const raw = textarea?.value || '';
    const lines = raw
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);

    if (!lines.length) {
      showToast('Paste the DuckRace result first.', 'error');
      return;
    }

    const normalizedParticipants = participants.map(p => ({
      participant: p,
      key: this._normalizeParticipantName(p.name),
    }));

    const ordered = [];
    const used = new Set();
    const unmatched = [];

    for (const line of lines) {
      const cleaned = line
        // Supports DuckRace exports such as `1st,Gigs`, `2nd, Caster`,
        // `3rd. Jordan`, `4. Rere`, and simple bullet/name lines.
        .replace(/^\s*(?:#?\d+\s*(?:st|nd|rd|th)?|\d+\.)\s*[,.)\-:–—]*\s*/i, '')
        .replace(/^\s*[•*▪●→]+\s*/, '')
        .trim();
      const key = this._normalizeParticipantName(cleaned);

      let match = normalizedParticipants.find(x => !used.has(x.participant.id) && x.key === key);
      if (!match) {
        match = normalizedParticipants.find(x => !used.has(x.participant.id) && (
          x.key.includes(key) || key.includes(x.key)
        ));
      }

      if (match) {
        ordered.push(match.participant);
        used.add(match.participant.id);
      } else {
        unmatched.push(cleaned);
      }
    }

    if (unmatched.length) {
      showToast(`Could not match: ${unmatched.join(', ')}`, 'error');
      return;
    }

    if (ordered.length !== participants.length) {
      const missing = participants
        .filter(p => !used.has(p.id))
        .map(p => p.name);
      showToast(`Missing participant(s): ${missing.join(', ')}`, 'error');
      return;
    }

    list.innerHTML = this._renderDragItems(participants, ordered, list.dataset.type);
    showToast('DuckRace order imported. Review it, then save.', 'success');
  },

  _normalizeParticipantName(name) {
    return String(name || '')
      .normalize('NFKC')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  },

  _getOrderedIds(list) {
    return [...list.querySelectorAll('.drag-item')].map(el => el.dataset.id);
  },

  _renderSnakePreview(draftOrder, numRounds) {
    const n = draftOrder.length;
    let html = '';
    for (let round = 1; round <= numRounds; round++) {
      const order = round % 2 === 0 ? [...draftOrder].reverse() : [...draftOrder];
      const pickStart = (round - 1) * n + 1;
      html += `
        <div class="snake-round">
          <div class="snake-round-label">Round ${round} ${round % 2 === 0 ? '↑' : '↓'}</div>
          <div class="snake-picks">
            ${order.map((p, i) => `
              <div class="snake-pick">
                <span class="pick-num">${pickStart + i}</span>
                <span class="pick-name">${escapeHtml(p.name)}</span>
              </div>`).join('')}
          </div>
        </div>`;
    }
    return html;
  },

  _initDragList(list) {
    if (!list) return;
    let dragging = null;

    list.addEventListener('dragstart', e => {
      dragging = e.target.closest('.drag-item');
      if (dragging) dragging.classList.add('dragging');
    });
    list.addEventListener('dragend', () => {
      if (dragging) dragging.classList.remove('dragging');
      dragging = null;
      // Update position numbers
      list.querySelectorAll('.drag-item').forEach((el, i) => {
        el.querySelector('.drag-num').textContent = i + 1;
      });
    });
    list.addEventListener('dragover', e => {
      e.preventDefault();
      const target = e.target.closest('.drag-item');
      if (!target || target === dragging) return;
      const rect = target.getBoundingClientRect();
      const mid = rect.top + rect.height / 2;
      if (e.clientY < mid) {
        list.insertBefore(dragging, target);
      } else {
        list.insertBefore(dragging, target.nextSibling);
      }
    });
  },
};
