/**
 * admin/players.js — Player database management + CSV import
 *
 * Phase 10.1: visual layer restyled to match the public Players page's
 * 2K-Ratings-style position-column table (shared positionPoolGrid() in
 * shared-utils.js). Sorting/search/delete/Add Player/CSV import behavior
 * is unchanged — this file only changes how the pool contents render.
 */

/**
 * ⚠ SECURITY NOTE — read before changing this.
 *
 * This app's real write-access boundary is Firebase Authentication +
 * firestore.rules (`allow write: if request.auth != null` — see
 * js/admin/auth-boundary.js). There is no backend/server-side function
 * in this project that could verify a secret on its own, so this PIN is
 * a plain constant shipped in this frontend JS file. That means:
 *   - it is trivially readable by anyone who opens dev tools or views
 *     page source — it is NOT a secret from an authenticated admin, or
 *     from anyone who can reach this file at all
 *   - it does NOT add a real second authorization layer on top of
 *     Firebase Auth; the actual gate remains "is this browser signed in
 *     as the commissioner" (AuthBoundary.requireAuth(), already required
 *     before this PIN step ever appears)
 * What it DOES do: add a deliberate speed bump against an *accidental*
 * click by someone already signed in as admin — the same role Add
 * Player/Import/single-player-Delete already trust unconditionally.
 * If real protection against a signed-in-but-malicious or compromised
 * admin session is ever needed, that check has to move server-side —
 * e.g. a Cloud Function that verifies a secret (via Firestore custom
 * claims or a secret manager) before performing the delete, callable
 * only through `firebase.functions()` — this constant is kept isolated
 * to this one spot specifically so that swap is a one-function change
 * later, not a rewrite of the confirm flow.
 *
 * Set your own PIN here.
 */
const _DELETE_ALL_PLAYERS_PIN = '7761';

const AdminPlayersView = {
  _filter: '',
  _sortMode: 'ovr-desc',
  _activePool: 'green',

  render(container) {
    const allPlayers = LeagueData.getAllPlayers();
    const unassignedCount = allPlayers.filter(p => !p.pool).length;

    container.innerHTML = `
      <div class="admin-section">
        <div class="admin-section-header">
          <h2>Player Database</h2>
          <div class="header-actions">
            <button class="btn btn-ghost" id="btnShowAddPlayer">+ Add Player</button>
            <button class="btn btn-primary" id="btnShowImport">↑ Import CSV</button>
            <button class="btn btn-danger header-danger-action" id="btnDeleteAllPlayers">🗑 Delete All Players</button>
          </div>
        </div>

        <!-- Add Player Form -->
        <div id="addPlayerForm" class="card-form hidden">
          <h3>Add Player</h3>
          <div class="form-row">
            <div class="form-group">
              <label>Name</label>
              <input type="text" id="pName" class="input" placeholder="M. JORDAN or LEBRON JAMES (PRIME)">
            </div>
            <div class="form-group">
              <label>Position</label>
              <select id="pPos" class="input">
                <option value="">—</option>
                <option>PG</option><option>SG</option><option>SF</option>
                <option>PF</option><option>C</option>
              </select>
            </div>
            <div class="form-group">
              <label>Overall</label>
              <input type="number" id="pOvr" class="input" min="40" max="99" placeholder="99">
            </div>
            <div class="form-group">
              <label>Pool</label>
              <select id="pPool" class="input">
                <option value="">—</option>
                <option value="green">Green</option>
                <option value="blue">Blue</option>
              </select>
            </div>
            <div class="form-group">
              <label>Variant Group <span class="muted" style="font-weight:400">(optional)</span></label>
              <input type="text" id="pVariantGroup" class="input" placeholder="e.g. lebron-james">
            </div>
          </div>
          <div class="form-actions">
            <button class="btn btn-primary" id="btnSavePlayer">Save Player</button>
            <button class="btn btn-ghost" id="btnCancelPlayer">Cancel</button>
          </div>
        </div>

        <!-- CSV Import -->
        <div id="importForm" class="card-form hidden">
          <h3>Import Players from CSV</h3>
          <p class="helper-text">
            Export your Google Sheet as CSV. Expected columns:
            <code>name, position, overall, pool, variantGroup</code>
            (header row required; pool and variantGroup are optional).
            Column names are matched case-insensitively with extra spaces
            ignored — "Name", "NAME", and " Name " all work. A few common
            variants are also recognized: "Player Name" or "Player" for
            name; "Pos" for position; "OVR" or "Rating" for overall;
            "Group" or "Identity" for variantGroup. Pool must be
            <code>green</code> or <code>blue</code> — any other value (or
            blank) is left unassigned, never guessed. Players already in
            the database (matched by name, ignoring case/spacing) and
            repeated names within the same file are skipped automatically
            and listed in the import summary — nothing is ever duplicated.
          </p>
          <div class="csv-drop-zone" id="csvDropZone">
            <span>Drop CSV file here or</span>
            <label class="btn btn-ghost file-label">
              Browse
              <input type="file" id="csvFileInput" accept=".csv" class="hidden-input">
            </label>
          </div>
          <div id="csvPreview" class="hidden"></div>
          <div class="form-actions">
            <button class="btn btn-primary hidden" id="btnConfirmImport">Import Players</button>
            <button class="btn btn-ghost" id="btnCancelImport">Cancel</button>
          </div>
        </div>

        <div class="player-db-header" style="margin-top:1.75rem;">
          <p class="player-db-subtitle">
            Green Pool are active NBA 2K26 players. Blue Pool are legendary and other prime versions.
            ${unassignedCount ? `${unassignedCount} player(s) have no pool set and are not shown in either tab below — set Pool when adding/importing to bring them into view.` : ''}
          </p>
        </div>

        <!-- Search + sort + count -->
        <div class="table-controls">
          <input type="text" id="playerSearch" class="input search-input"
            placeholder="Search by name, position, or variant group…" value="${escapeHtml(this._filter)}">
          <select id="sortMode" class="input" style="max-width:200px;">
            <option value="ovr-desc" ${this._sortMode === 'ovr-desc' ? 'selected' : ''}>Sort: OVR (High–Low)</option>
            <option value="ovr-asc" ${this._sortMode === 'ovr-asc' ? 'selected' : ''}>Sort: OVR (Low–High)</option>
            <option value="name-asc" ${this._sortMode === 'name-asc' ? 'selected' : ''}>Sort: Name (A–Z)</option>
          </select>
          <span class="player-count">${allPlayers.length} players in database</span>
        </div>

        ${this._renderPoolTabs(allPlayers)}
      </div>`;

    // Wire up search
    container.querySelector('#playerSearch').oninput = e => {
      this._filter = e.target.value;
      this._refreshPane(container);
    };
    container.querySelector('#sortMode').onchange = e => {
      this._sortMode = e.target.value;
      this._refreshPane(container);
    };

    this._bindFormEvents(container);
    this._bindPoolTabEvents(container);
    this._bindTableEvents(container);
    this._bindImportEvents(container);
    this._bindDeleteAllEvents(container);
  },

  // ── Phase 10: Green Pool / Blue Pool tabs — no Unassigned tab is ever
  // rendered (players with no pool still exist in data.js, just excluded
  // from both tabs here; see the counter note above).
  _renderPoolTabs(allPlayers) {
    const green = allPlayers.filter(p => p.pool === 'green');
    const blue = allPlayers.filter(p => p.pool === 'blue');
    const active = this._activePool;
    return `
      <div class="pool-tabs">
        <button type="button" class="pool-tab pool-tab-green ${active === 'green' ? 'active' : ''}" data-pool="green">
          <span class="pool-dot"></span> Green Pool <span class="pool-tab-count">${green.length}</span>
        </button>
        <button type="button" class="pool-tab pool-tab-blue ${active === 'blue' ? 'active' : ''}" data-pool="blue">
          <span class="pool-dot"></span> Blue Pool <span class="pool-tab-count">${blue.length}</span>
        </button>
      </div>
      <div id="poolPaneWrapper">
        ${this._renderGrid(active === 'green' ? green : blue)}
      </div>`;
  },

  _refreshPane(container) {
    const allPlayers = LeagueData.getAllPlayers();
    const pool = this._activePool;
    const poolPlayers = allPlayers.filter(p => p.pool === pool);
    container.querySelector('#poolPaneWrapper').innerHTML = this._renderGrid(poolPlayers);
    this._bindTableEvents(container);
  },

  _bindPoolTabEvents(container) {
    container.querySelectorAll('.pool-tab').forEach(tab => {
      tab.onclick = () => {
        this._activePool = tab.dataset.pool;
        container.querySelectorAll('.pool-tab').forEach(t => t.classList.toggle('active', t === tab));
        this._refreshPane(container);
      };
    });
  },

  _applyFilter(players) {
    const q = this._filter.toLowerCase();
    if (!q) return players;
    return players.filter(p =>
      p.name.toLowerCase().includes(q) ||
      (p.position || '').toLowerCase().includes(q) ||
      (p.variantGroup || '').toLowerCase().includes(q)
    );
  },

  _renderGrid(players) {
    const filtered = this._applyFilter(players);
    const entries = filtered.map(player => ({ player })); // admin view: no drafted-status overlay
    return positionPoolGrid(entries, this._activePool, { admin: true, sortMode: this._sortMode });
  },

  _bindTableEvents(container) {
    container.querySelectorAll('[data-action="deletePlayer"]').forEach(btn => {
      btn.onclick = () => {
        AuthBoundary.requireAuth();
        const { id, name } = btn.dataset;
        if (!confirm(`Delete player "${name}"?`)) return;
        AdminActions.deletePlayer(id);
        showToast(`${name} deleted.`, 'success');
        AdminApp.renderView('players');
      };
    });
    container.querySelectorAll('[data-action="editPlayer"]').forEach(btn => {
      btn.onclick = () => {
        AuthBoundary.requireAuth();
        const player = LeagueData.getPlayer(btn.dataset.id);
        if (!player) return;
        this._openEditPlayerModal(container, player);
      };
    });
  },

  /**
   * Edit modal — Rating (overall) and Variant (variantGroup) ONLY.
   * Reuses the shared .modal-overlay/.modal-card pattern (see
   * js/admin/draft.js's _openDraftConfirm for the original), the same
   * "overall must be 40–99" rule already enforced in _bindFormEvents'
   * Add Player handler, and AdminActions.updatePlayer — which does
   * Object.assign(existingPlayer, fields), so id/name/position/pool and
   * any other field are left completely untouched and no new player
   * record or ID is created.
   */
  _openEditPlayerModal(container, player) {
    document.getElementById('editPlayerOverlay')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'editPlayerOverlay';
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="editPlayerTitle">
        <div class="modal-eyebrow">Edit Player</div>
        <div class="modal-player-name" id="editPlayerTitle">${escapeHtml(player.name)}</div>
        <div class="modal-player-meta">
          <span>${player.position || '—'}</span>
          <span class="pool-badge pool-badge-${player.pool === 'blue' ? 'blue' : 'green'}" style="margin-left:0.5rem;">${player.pool === 'blue' ? 'Blue Pool' : 'Green Pool'}</span>
        </div>
        <div class="form-group">
          <label>Rating (OVR)</label>
          <input type="number" id="editPlayerOvr" class="input" min="40" max="99" value="${player.overall ?? ''}">
        </div>
        <div class="form-group" style="margin-top:0.75rem;">
          <label>Variant Group <span class="muted" style="font-weight:400">(optional)</span></label>
          <input type="text" id="editPlayerVariantGroup" class="input" value="${escapeHtml(player.variantGroup || '')}" placeholder="e.g. lebron-james">
        </div>
        <p class="error-text" id="editPlayerError"></p>
        <div class="modal-actions">
          <button class="btn btn-ghost" id="editPlayerCancelBtn">Cancel</button>
          <button class="btn btn-primary" id="editPlayerSaveBtn">Save Changes</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    document.getElementById('editPlayerCancelBtn').onclick = close;
    const onKeydown = e => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKeydown); } };
    document.addEventListener('keydown', onKeydown);

    document.getElementById('editPlayerSaveBtn').onclick = () => {
      AuthBoundary.requireAuth();
      const errorEl = document.getElementById('editPlayerError');
      const overall = parseInt(document.getElementById('editPlayerOvr').value, 10);
      const variantGroup = document.getElementById('editPlayerVariantGroup').value.trim();

      if (isNaN(overall) || overall < 40 || overall > 99) {
        errorEl.textContent = 'Rating must be 40–99.';
        return;
      }

      try {
        AdminActions.updatePlayer(player.id, {
          overall,
          variantGroup: variantGroup || undefined, // '' normalizes to undefined, same as Add Player/CSV import
        });
        showToast(`${player.name} updated.`, 'success');
        close();
        this._refreshPane(container);
      } catch (e) {
        errorEl.textContent = e.message;
      }
    };
  },

  // ── Delete All Players ───────────────────────────────────────────────────
  // Three-stage destructive-action flow: confirm → PIN → final confirm.
  // See _DELETE_ALL_PLAYERS_PIN below for an explanation of what this PIN
  // does and, importantly, does NOT protect against in this app's current
  // frontend-only architecture.
  _bindDeleteAllEvents(container) {
    container.querySelector('#btnDeleteAllPlayers').onclick = () => {
      AuthBoundary.requireAuth();
      this._openDeleteAllConfirm1();
    };
  },

  _openDeleteAllConfirm1() {
    document.getElementById('deleteAllOverlay')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'deleteAllOverlay';
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="deleteAllTitle1">
        <div class="modal-eyebrow">⚠ Destructive Action</div>
        <div class="modal-player-name" id="deleteAllTitle1">Delete All Players</div>
        <p class="modal-prompt">This will permanently delete ALL players from the player database. This cannot be undone.</p>
        <div class="modal-actions">
          <button class="btn btn-ghost" id="deleteAllCancelBtn1">Cancel</button>
          <button class="btn btn-danger" id="deleteAllContinueBtn1">Continue</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    document.getElementById('deleteAllCancelBtn1').onclick = close;
    document.getElementById('deleteAllContinueBtn1').onclick = () => {
      close();
      this._openDeleteAllPinStep();
    };
  },

  _openDeleteAllPinStep() {
    document.getElementById('deleteAllOverlay')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'deleteAllOverlay';
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="deleteAllPinTitle">
        <div class="modal-eyebrow">⚠ Destructive Action</div>
        <div class="modal-player-name" id="deleteAllPinTitle">Enter Admin PIN</div>
        <p class="modal-prompt">Enter the admin PIN to continue deleting all players.</p>
        <div class="form-group">
          <input type="password" id="deleteAllPinInput" class="input" autocomplete="off" placeholder="PIN">
        </div>
        <p class="error-text" id="deleteAllPinError"></p>
        <div class="modal-actions">
          <button class="btn btn-ghost" id="deleteAllPinCancelBtn">Cancel</button>
          <button class="btn btn-danger" id="deleteAllPinSubmitBtn">Verify</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    document.getElementById('deleteAllPinCancelBtn').onclick = close;

    const pinInput = document.getElementById('deleteAllPinInput');
    pinInput.focus();
    const submit = () => {
      const entered = pinInput.value;
      pinInput.value = ''; // never leave the PIN sitting in the DOM after a check
      if (entered !== _DELETE_ALL_PLAYERS_PIN) {
        document.getElementById('deleteAllPinError').textContent = 'Incorrect PIN.';
        return;
      }
      close();
      this._openDeleteAllConfirm2();
    };
    document.getElementById('deleteAllPinSubmitBtn').onclick = submit;
    pinInput.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
  },

  _openDeleteAllConfirm2() {
    document.getElementById('deleteAllOverlay')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'deleteAllOverlay';
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="deleteAllTitle2">
        <div class="modal-eyebrow">⚠ Final Confirmation</div>
        <div class="modal-player-name" id="deleteAllTitle2">Are you absolutely sure?</div>
        <p class="modal-prompt">This will permanently delete all players. This cannot be undone.</p>
        <div class="modal-actions">
          <button class="btn btn-ghost" id="deleteAllCancelBtn2">Cancel</button>
          <button class="btn btn-danger" id="deleteAllConfirmBtn2">Delete All Players</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    document.getElementById('deleteAllCancelBtn2').onclick = close;
    document.getElementById('deleteAllConfirmBtn2').onclick = () => {
      AuthBoundary.requireAuth();
      try {
        AdminActions.deleteAllPlayers();
        close();
        showToast('All players have been deleted.', 'success');
        AdminApp.renderView('players');
      } catch (e) {
        // Leave the UI in a recoverable state — modal stays open with a
        // clear error rather than a false success message.
        document.querySelector('#deleteAllOverlay .modal-prompt').insertAdjacentHTML(
          'afterend', `<p class="error-text">Delete failed: ${escapeHtml(e.message)}</p>`
        );
      }
    };
  },

  _bindFormEvents(container) {
    container.querySelector('#btnShowAddPlayer').onclick = () => {
      container.querySelector('#addPlayerForm').classList.remove('hidden');
      container.querySelector('#importForm').classList.add('hidden');
    };
    container.querySelector('#btnCancelPlayer').onclick = () => {
      container.querySelector('#addPlayerForm').classList.add('hidden');
    };
    container.querySelector('#btnSavePlayer').onclick = () => {
      AuthBoundary.requireAuth();
      const name = container.querySelector('#pName').value.trim();
      const position = container.querySelector('#pPos').value;
      const overall = parseInt(container.querySelector('#pOvr').value, 10);
      const pool = container.querySelector('#pPool').value; // '', 'green', or 'blue'
      const variantGroup = container.querySelector('#pVariantGroup').value.trim();
      if (!name) { showToast('Player name required.', 'error'); return; }
      if (isNaN(overall) || overall < 40 || overall > 99) { showToast('Overall must be 40–99.', 'error'); return; }
      AdminActions.addPlayer({ name, position, overall, pool, variantGroup });
      showToast(`${name} added.`, 'success');
      AdminApp.renderView('players');
    };
  },

  _bindImportEvents(container) {
    let _parsedRows = [];

    container.querySelector('#btnShowImport').onclick = () => {
      container.querySelector('#importForm').classList.remove('hidden');
      container.querySelector('#addPlayerForm').classList.add('hidden');
    };
    container.querySelector('#btnCancelImport').onclick = () => {
      container.querySelector('#importForm').classList.add('hidden');
      _parsedRows = [];
    };

    const handleFile = file => {
      if (!file || !file.name.endsWith('.csv')) {
        showToast('Please select a .csv file.', 'error'); return;
      }
      const reader = new FileReader();
      reader.onload = e => {
        _parsedRows = parseCSV(e.target.result);
        const preview = container.querySelector('#csvPreview');
        const importBtn = container.querySelector('#btnConfirmImport');

        if (!_parsedRows.length) {
          preview.innerHTML = `<p class="error-text">No valid rows found.</p>`;
          preview.classList.remove('hidden');
          importBtn.classList.add('hidden');
          return;
        }

        const sample = _parsedRows.slice(0, 5);
        preview.innerHTML = `
          <p class="helper-text">${_parsedRows.length} row(s) found. Preview (first 5):</p>
          <div class="table-scroll">
          <table class="admin-table">
            <thead><tr><th>Name</th><th>Pos</th><th>OVR</th><th>Pool</th><th>Variant Group</th></tr></thead>
            <tbody>
              ${sample.map(r => {
                // Same header normalization the importer uses, so the
                // preview shown here matches what actually gets imported.
                const p = previewFields(r);
                return `
                <tr>
                  <td>${escapeHtml(p.name)}</td>
                  <td>${escapeHtml(p.position)}</td>
                  <td>${escapeHtml(p.overall)}</td>
                  <td>${escapeHtml(p.pool || '—')}</td>
                  <td>${escapeHtml(p.variantGroup || '—')}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
          </div>`;
        preview.classList.remove('hidden');
        importBtn.classList.remove('hidden');
      };
      reader.readAsText(file);
    };

    container.querySelector('#csvFileInput').onchange = e => handleFile(e.target.files[0]);

    const dropZone = container.querySelector('#csvDropZone');
    dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
    dropZone.addEventListener('drop', e => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
      handleFile(e.dataTransfer.files[0]);
    });

    container.querySelector('#btnConfirmImport').onclick = () => {
      AuthBoundary.requireAuth();
      if (!_parsedRows.length) return;
      const result = AdminActions.importPlayersFromCSV(_parsedRows);
      _parsedRows = [];

      if (result.errors.length) console.warn('Import errors:', result.errors);
      if (result.notes.length) console.warn('Import notes:', result.notes);

      // Show the full breakdown in the panel (rather than just a toast)
      // so the admin can see exactly which players were skipped as
      // duplicates before the form closes. The panel stays open —
      // AdminApp.renderView('players') is NOT called here, since that
      // would rebuild the whole view and immediately hide this summary.
      const preview = container.querySelector('#csvPreview');
      preview.innerHTML = renderImportSummary(result);
      preview.classList.remove('hidden');
      container.querySelector('#btnConfirmImport').classList.add('hidden');

      showToast(
        `Import completed. Added ${result.imported}, skipped ${result.skipped}.`,
        result.imported > 0 ? 'success' : 'info'
      );

      // Refresh the counts + grid in place so they reflect the newly
      // added players without collapsing the import panel above.
      const allPlayers = LeagueData.getAllPlayers();
      const countEl = container.querySelector('.player-count');
      if (countEl) countEl.textContent = `${allPlayers.length} players in database`;
      const greenCount = container.querySelector('.pool-tab-green .pool-tab-count');
      const blueCount = container.querySelector('.pool-tab-blue .pool-tab-count');
      if (greenCount) greenCount.textContent = allPlayers.filter(p => p.pool === 'green').length;
      if (blueCount) blueCount.textContent = allPlayers.filter(p => p.pool === 'blue').length;
      this._refreshPane(container);
    };
  },
};

/**
 * Preview-only header normalization, mirroring AdminActions.importPlayersFromCSV
 * in data.js so the preview table matches what will actually be imported.
 * Kept intentionally small and duplicated rather than shared across files —
 * this project uses plain <script> tags with no module system.
 */
function previewFields(row) {
  const normalized = {};
  for (const key in row) {
    normalized[key.toLowerCase().trim()] = row[key];
  }
  const pick = (...aliases) => {
    for (const a of aliases) {
      if (normalized[a] !== undefined) return normalized[a];
    }
    return '';
  };
  return {
    name: String(pick('name', 'player name', 'player') || '').trim(),
    position: String(pick('position', 'pos') || '').trim().toUpperCase(),
    overall: String(pick('overall', 'ovr', 'rating') || '').trim(),
    pool: String(pick('pool') || '').trim().toLowerCase(),
    variantGroup: String(pick('variantgroup', 'variant group', 'group', 'identity') || '').trim(),
  };
}

/**
 * Renders the post-import results panel: counts plus, when present, the
 * actual names/messages so the admin can identify exactly which rows
 * were skipped (required for duplicate review — a bare count isn't
 * enough to act on).
 */
function renderImportSummary(result) {
  const {
    imported, skippedExisting, skippedDuplicateInCsv, skippedInvalid,
    skippedExistingNames, skippedDuplicateInCsvNames, errors, notes,
  } = result;

  const nameList = names => {
    const MAX_SHOWN = 30;
    const shown = names.slice(0, MAX_SHOWN);
    const remaining = names.length - shown.length;
    return `<ul class="import-summary-list">
      ${shown.map(n => `<li>${escapeHtml(n)}</li>`).join('')}
      ${remaining > 0 ? `<li class="muted">…and ${remaining} more</li>` : ''}
    </ul>`;
  };

  return `
    <div class="import-summary">
      <p class="helper-text"><strong>Import completed.</strong></p>
      <table class="admin-table">
        <tbody>
          <tr><td>Added</td><td>${imported}</td></tr>
          <tr><td>Skipped — Already Exists</td><td>${skippedExisting}</td></tr>
          <tr><td>Skipped — Duplicate in CSV</td><td>${skippedDuplicateInCsv}</td></tr>
          <tr><td>Skipped — Invalid Row</td><td>${skippedInvalid}</td></tr>
          <tr><td>Errors</td><td>${errors.length}</td></tr>
        </tbody>
      </table>
      ${skippedExistingNames.length ? `
        <p class="helper-text">Skipped existing players:</p>
        ${nameList(skippedExistingNames)}` : ''}
      ${skippedDuplicateInCsvNames.length ? `
        <p class="helper-text">Skipped duplicate rows within the CSV:</p>
        ${nameList(skippedDuplicateInCsvNames)}` : ''}
      ${errors.length ? `
        <p class="error-text">Errors:</p>
        <ul class="import-summary-list">${errors.map(e => `<li>${escapeHtml(e)}</li>`).join('')}</ul>` : ''}
      ${notes.length ? `
        <p class="helper-text">Notes:</p>
        <ul class="import-summary-list">${notes.map(n => `<li>${escapeHtml(n)}</li>`).join('')}</ul>` : ''}
    </div>`;
}

/**
 * Minimal CSV parser.
 * Handles quoted fields and standard comma-delimited files.
 * For robust production use, replace with a library like PapaParse.
 */
function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];

  const headers = splitCSVRow(lines[0]).map(h => h.trim());
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const values = splitCSVRow(line);
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = (values[idx] || '').trim();
    });
    rows.push(row);
  }
  return rows;
}

function splitCSVRow(line) {
  const result = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (ch === ',' && !inQuotes) {
      result.push(cur); cur = '';
    } else {
      cur += ch;
    }
  }
  result.push(cur);
  return result;
}
