/**
 * admin/roster.js — Phase 4A: Current Roster management
 *
 * Responsibilities:
 * - Display the rating cap for the current season and allow the admin to change it.
 * - Initialize currentRosters from the completed playerDraftPicks (one-time or
 *   re-initialize if needed).
 * - Display all participants' current rosters with per-roster total rating,
 *   cap usage bar, and remaining cap.
 *
 * What this view does NOT do (future phases):
 * - Trades, pool swaps, transaction fees, pot money, or scheduling.
 *
 * Architecture notes:
 * - All reads go through LeagueData (public read API).
 * - All writes go through AdminActions behind AuthBoundary.requireAuth().
 * - Renders into the shared #adminViewContainer, same as every other admin view.
 * - No global state is kept beyond the view object itself.
 */

/**
 * ⚠ SECURITY NOTE — same caveat as _DELETE_ALL_PLAYERS_PIN in admin/players.js.
 *
 * This is a plain constant shipped in this frontend JS file, not a real
 * second authorization layer — it's trivially readable by anyone who opens
 * dev tools, and it does NOT protect against a signed-in-but-malicious or
 * compromised admin session. The actual write gate remains Firebase Auth +
 * firestore.rules (AuthBoundary.requireAuth(), already required before this
 * PIN step ever appears). What it DOES do: add a deliberate speed bump
 * against an *accidental* click that would overwrite manual roster changes
 * (trades/swaps/Joker designations) made since the last initialization.
 * Kept as its own isolated constant, same pattern as players.js, so each
 * destructive action's PIN can be changed independently.
 *
 * Set your own PIN here.
 */
const _REINIT_ROSTERS_PIN = '7761';

/**
 * ⚠ SECURITY NOTE — Revision 2 (Manual Roster Edit).
 *
 * Deliberately reuses _DELETE_ALL_PLAYERS_PIN from js/admin/players.js
 * rather than a second PIN constant, per the revision spec ("Do not
 * create a second PIN. Do not duplicate the PIN value into another
 * file."). This works because admin.html loads js/admin/players.js
 * before js/admin/roster.js — both are plain (non-module) <script> tags,
 * so top-level `const` declarations share one global lexical scope and
 * a later script can reference an earlier one's constant directly. If
 * that load order ever changes, this reference breaks loudly (a
 * ReferenceError) rather than silently — there is intentionally no local
 * fallback/duplicate value here.
 *
 * Same caveat as everywhere else this PIN is used: it's a frontend speed
 * bump against an accidental click by someone already signed in as
 * admin, not a second real authorization layer. See players.js's fuller
 * note on _DELETE_ALL_PLAYERS_PIN.
 */

const AdminRosterView = {
  _manualEditUnlocked: false, // Revision 2 — gated by _DELETE_ALL_PLAYERS_PIN (players.js), unlocks only roster-editing below, never general Superadmin access
  _manualAddTarget: null,     // participantId currently showing the "add player" picker, or null
  _manualAddPool: 'green',    // active pool tab inside the add-player picker
  _manualReplaceOutgoing: null, // playerId being replaced, when the picker is in "Replace" mode (null = plain Add)
  _manualFillSlot: null,      // draftSlot number being filled, when the picker is in "Fill Slot" mode (null = plain Add/Replace) — see manualAddPlayerToRoster's targetDraftSlot
  _manualJokerFor: null,      // { participantId, playerId } currently showing the Joker Swap position picker, or null
  _manualSearch: '',          // search text inside the add/replace picker
  _manualSelectedPlayer: null,
  _manualTransferOwner: null,

  render(container) {
    const season = LeagueData.getCurrentSeason();
    if (!season) {
      container.innerHTML = `<div class="empty-state"><p>No current season. Create a season first.</p></div>`;
      return;
    }

    const summary = LeagueData.getRosterSummary(season.id);
    const cap = season.ratingCap ?? 875;
    const assignments = LeagueData.getNBATeamAssignments(season.id);
    const rostersInitialized = season.rostersInitialized ?? false;
    const draftComplete = season.draftComplete ?? false;
    const totalParticipants = summary.length;
    const initializedCount = rostersInitialized
      ? Object.keys(season.currentRosters || {}).filter(
          pid => (season.currentRosters[pid] || []).length > 0
        ).length
      : 0;

    container.innerHTML = `
      <div class="admin-section">
        <div class="admin-section-header">
          <h2>Current Rosters — ${escapeHtml(season.name)}</h2>
          <div class="header-actions">
            <button class="btn btn-ghost" id="btnValidateRosters">✓ Validate Rosters</button>
            ${this._manualEditUnlocked
              ? `<button class="btn btn-ghost" id="btnLockManualEdit">🔓 Manual Roster Editor Active — Exit</button>`
              : `<button class="btn btn-ghost header-danger-action" id="btnUnlockManualEdit">🔒 Edit Roster Manually</button>`
            }
          </div>
        </div>

        <!-- Status banner -->
        ${this._renderStatusBanner(draftComplete, rostersInitialized, totalParticipants, initializedCount)}
        ${this._manualEditUnlocked ? `
        <div class="info-banner warn-banner">
          <strong>🔓 Manual Roster Override Active.</strong>
          Manual corrections are not blocked by roster rules. Use <strong>✓ Validate Rosters</strong> to review
          rating caps, position limits, minimum ratings, and pool composition after editing.
          Removed signed players return to the available pool when no draft history or active roster assignment reserves them.
          Player ownership and basic data-integrity checks (no duplicate assignment, no invalid player records)
          remain enforced. Use <strong>✓ Validate Rosters</strong> above to review the final state when you're done.
          ${!rostersInitialized ? ' Rosters have not been initialized from the draft yet, so there is nothing to edit until that\'s done below.' : ''}
        </div>` : ''}

        <!-- Controls row -->
        <div class="roster-controls-row">

          <!-- Rating cap control -->
          <div class="roster-cap-control card-form">
            <h3>Rating Cap</h3>
            <p class="helper-text">
              Maximum combined OVR allowed per roster this season.
              Changing this does not remove any players.
            </p>
            <div class="form-row">
              <div class="form-group">
                <label for="ratingCapInput">Cap (OVR)</label>
                <input type="number" id="ratingCapInput" class="input"
                  min="1" max="9999" value="${cap}" style="width:120px">
              </div>
              <div class="form-group" style="align-self:flex-end">
                <button class="btn btn-ghost" id="btnSaveCap">Update Cap</button>
              </div>
            </div>
          </div>

          <!-- Initialize button -->
          <div class="roster-init-control card-form">
            <h3>Initialize from Draft</h3>
            <p class="helper-text">
              Copies completed draft picks into the mutable current rosters.
              Draft history is never modified.
              ${rostersInitialized ? 'Re-initializing will overwrite any manual changes made since the last init.' : ''}
            </p>
            <button class="btn btn-primary" id="btnInitRosters"
              ${draftComplete ? '' : 'disabled'}>
              ${rostersInitialized ? 'Re-initialize Rosters from Draft' : 'Initialize Rosters from Draft'}
            </button>
            ${!draftComplete ? `<p class="error-text" style="margin-top:0.5rem">Draft must be marked complete first.</p>` : ''}
          </div>

        </div>

        <!-- Roster grid -->
        <div class="roster-grid-section">
          <h3>All Rosters
            <span class="helper-text" style="font-weight:400;font-size:0.85rem">
              — cap: <strong>${cap}</strong> OVR per roster
            </span>
          </h3>
          ${summary.length === 0
            ? `<div class="empty-state"><p>No participants yet.</p></div>`
            : `<div class="roster-cards">${summary.map(s => this._renderRosterCard(s, cap, assignments[s.participant.id], season.id)).join('')}</div>`
          }
        </div>

      </div>`;

    this._mountReplaceModal(season.id);
    this._bindEvents(container, season);
  },

  _renderStatusBanner(draftComplete, rostersInitialized, total, initialized) {
    if (!draftComplete) {
      return `<div class="info-banner">
        ℹ Draft not yet complete. Complete the player draft before initializing rosters.
      </div>`;
    }
    if (!rostersInitialized) {
      return `<div class="info-banner warn-banner">
        ⚠ Draft complete. Rosters have not been initialized yet.
        Click <strong>Initialize Rosters from Draft</strong> to create the current rosters.
      </div>`;
    }
    return `<div class="success-banner">
      ✓ Rosters initialized. Showing current rosters for ${total} participant${total !== 1 ? 's' : ''}.
    </div>`;
  },

  /**
   * Classification badge for the roster tables — thin wrapper around the
   * shared classificationBadge() in shared-utils.js so both admin and
   * public roster views render RED/YELLOW/PINK identically.
   */
  _classificationBadge(classification) {
    return classificationBadge(classification);
  },

  _renderRosterCard(summary, cap, abbr, seasonId) {
    const { participant, rosterEntries, totalRating, remaining, isOverCap } = summary;
    const pct = cap > 0 ? Math.min(100, (totalRating / cap) * 100) : 0;
    const barClass = isOverCap ? 'cap-bar-fill--over'
      : pct >= 85 ? 'cap-bar-fill--warn'
      : 'cap-bar-fill--ok';

    const editing = this._manualEditUnlocked;
    const filledCount = rosterEntries.filter(e => e.player).length;
    const jokerEligibleIds = editing
      ? new Set(LeagueData.getJokerEligiblePlayers(seasonId, participant.id).map(e => e.playerId))
      : new Set();
    const playerRows = rosterEntries.length
      ? rosterEntries.map((e) => {
          const p = e.player;
          const isEmpty = e.source === 'empty';
          const slotLabel = e.displayPickNumber ?? e.draftSlot ?? '—';
          if (isEmpty) {
            return `
              <tr class="roster-row-empty">
                <td class="roster-pick-num">${slotLabel}</td>
                <td colspan="5" class="muted"><em>EMPTY — draft slot vacated</em></td>
                ${editing ? `<td class="roster-manual-actions">
                  <button type="button" class="btn btn-ghost" style="padding:0.15rem 0.5rem;font-size:0.75rem;" data-manual-action="fillSlot" data-participant-id="${participant.id}" data-draft-slot="${e.draftSlot}">+ Fill Slot</button>
                </td>` : '<td></td>'}
              </tr>`;
          }
          const canJoker = editing && p && jokerEligibleIds.has(p.id);
          return `
            <tr ${editing && p ? `class="roster-manual-edit-row" data-manual-action="openRosterEntry" data-participant-id="${escapeHtml(participant.id)}" data-player-id="${escapeHtml(p.id)}" data-can-joker="${canJoker ? 'true' : 'false'}" tabindex="0" aria-label="Edit roster entry: ${escapeHtml(p.name)}"` : ''}>
              <td class="roster-pick-num">${slotLabel}</td>
              <td>${p ? escapeHtml(p.name) : '<span class="muted">(removed)</span>'}</td>
              <td>${p ? poolLabel(p.pool) : '—'}</td>
              <td>${this._classificationBadge(e.isJoker ? 'PINK' : e.classification)}</td>
              <td>${p ? escapeHtml(e.effectivePosition || p.position || '—') : '—'}${e.isJoker ? ' <span title="Joker-assigned position">🃏</span>' : ''}</td>
              <td class="ovr">${p ? p.overall : '—'}</td>
              <td class="muted" style="font-size:0.75rem">${e.source === 'signed' ? 'Signed' : escapeHtml(e.source)}</td>
              ${editing ? `<td class="roster-manual-actions">
                ${p ? `
                ${canJoker ? `<button type="button" class="btn-icon-sm" title="Joker Swap (position change)" data-manual-action="jokerSwap" data-participant-id="${participant.id}" data-player-id="${p.id}">🃏</button>` : ''}
                <button type="button" class="btn-icon-sm" title="Replace" data-manual-action="replace" data-participant-id="${participant.id}" data-player-id="${p.id}">⇄</button>
                <button type="button" class="btn-icon-sm" title="Remove" data-manual-action="remove" data-participant-id="${participant.id}" data-player-id="${p.id}" data-player-name="${escapeHtml(p.name)}">✕</button>
                ` : ''}
              </td>` : ''}
            </tr>`;
        }).join('')
      : `<tr><td colspan="${editing ? 8 : 7}" class="muted" style="padding:0.75rem">No players.</td></tr>`;

    const showPicker = editing && this._manualAddTarget === participant.id;
    const showJokerPicker = editing && this._manualJokerFor
      && this._manualJokerFor.participantId === participant.id;

    return `
      <div class="roster-card ${isOverCap ? 'roster-card--over' : ''}">
        <div class="roster-card-header">
          <span class="roster-card-name">${escapeHtml(participant.name)}</span>
          <span class="roster-card-count">${filledCount} player${filledCount !== 1 ? 's' : ''}</span>
        </div>
        <div class="roster-card-team">
          ${teamBadge(abbr, { size: 'lg', showName: true })}
        </div>

        <!-- Rating bar -->
        <div class="cap-bar-wrap">
          <div class="cap-bar-labels">
            <span class="cap-bar-current ${isOverCap ? 'cap-over-text' : ''}">${totalRating} OVR</span>
            <span class="cap-bar-cap">cap: ${cap}</span>
          </div>
          <div class="cap-bar-track">
            <div class="cap-bar-fill ${barClass}" style="width:${pct.toFixed(1)}%"></div>
          </div>
          <div class="cap-bar-remaining ${isOverCap ? 'cap-over-text' : ''}">
            ${isOverCap
              ? `⚠ Over cap by ${totalRating - cap}`
              : `${remaining} remaining`}
          </div>
        </div>

        <!-- Player table -->
        <div class="table-scroll">
        <table class="roster-table">
          <thead>
            <tr><th>Pick #</th><th>Player</th><th>Pool</th><th>Color</th><th>Pos</th><th>OVR</th><th>Source</th>${editing ? '<th></th>' : ''}</tr>
          </thead>
          <tbody>${playerRows}</tbody>
        </table>
        </div>

        ${editing ? `
        <div class="roster-manual-editor-controls">
          ${showPicker ? '' : `<button type="button" class="btn btn-ghost" data-manual-action="openAdd" data-participant-id="${participant.id}">+ Add Player</button>`}
        </div>
        ${showJokerPicker ? this._renderJokerSwapPicker(participant.id, this._manualJokerFor.playerId, seasonId) : ''}
        ` : ''}
      </div>`;
  },

  _renderReplaceModal(seasonId) {
    if (!this._manualAddTarget) return '';
    const isReplacement = !!this._manualReplaceOutgoing;
    const isFillSlot = this._manualFillSlot != null;
    const player = isReplacement ? LeagueData.getPlayer(this._manualReplaceOutgoing, seasonId) : null;
    const destination = LeagueData.getRosterSummary(seasonId).find(s => s.participant.id === this._manualAddTarget)?.participant;
    const modalTitle = isReplacement ? 'Replace Player' : isFillSlot ? `Fill Draft Slot #${this._manualFillSlot}` : 'Sign Player';
    const selected = this._manualSelectedPlayer ? LeagueData.getPlayer(this._manualSelectedPlayer, seasonId) : null;
    const q = (this._manualSearch || '').trim().toLowerCase();
    const candidates = this._getManualReplaceCandidates(seasonId)
      .filter(p => this._matchesManualPlayerSearch(p, q));
    const selectedCandidate = candidates.find(p => p.id === this._manualSelectedPlayer)
      || (selected ? this._getManualReplaceCandidates(seasonId, selected.pool).find(p => p.id === this._manualSelectedPlayer) : null);
    const transferPending = !!selected && this._manualTransferOwner?.playerId === selected.id;
    return `<div id="manualReplacePlayerOverlay" class="modal-overlay manual-replace-overlay" data-manual-action="modalBackdrop">
      <section class="modal-card manual-replace-modal" role="dialog" aria-modal="true" aria-labelledby="replacePlayerTitle" tabindex="-1">
        <header class="manual-roster-modal-header"><div><span class="modal-eyebrow">ROSTER EDIT</span><h2 id="replacePlayerTitle">${escapeHtml(modalTitle)}</h2></div>
          <button type="button" class="btn-icon-sm" aria-label="Close replace player dialog" data-manual-action="closePicker">✕</button></header>
        <div class="manual-roster-modal-body">${isReplacement ? `<p class="helper-text">Replacing <strong>${escapeHtml(player?.name || 'player')}</strong> · ${player?.overall ?? '—'} OVR</p>` : `<p class="helper-text">Signing to <strong>${escapeHtml(destination?.name || 'participant')}</strong>${isFillSlot ? ` · Draft slot #${this._manualFillSlot}` : ''}</p>`}
          <div class="pool-tabs"><button type="button" class="pool-tab pool-tab-green ${this._manualAddPool === 'green' ? 'active' : ''}" data-manual-pool="green">Green</button><button type="button" class="pool-tab pool-tab-blue ${this._manualAddPool === 'blue' ? 'active' : ''}" data-manual-pool="blue">Blue</button><button type="button" class="pool-tab pool-tab-white ${this._manualAddPool === 'white' ? 'active' : ''}" data-manual-pool="white">White</button></div>
          <label class="sr-only" for="manualPickerSearch">Search available players</label><input type="search" class="input" id="manualPickerSearch" placeholder="Search available players…" value="${escapeHtml(this._manualSearch)}">
          <div class="manual-roster-candidates">${this._renderManualCandidateButtons(candidates, selected?.id)}</div>
          ${selected ? `<div class="manual-roster-selected"><span>Selected</span><strong>${escapeHtml(selected.name)}</strong><b>${selected.overall ?? '—'} OVR</b>${selectedCandidate?.ownerId ? `<small>Owned by ${escapeHtml(selectedCandidate.ownerName)}</small>` : ''}</div>` : '<p class="muted">Select a player to continue.</p>'}
          ${transferPending ? `<div class="manual-transfer-warning" role="alert"><strong>Transfer ${escapeHtml(selected.name)}?</strong><p>Currently owned by <strong>${escapeHtml(this._manualTransferOwner.ownerName)}</strong>. Transfer to <strong>${escapeHtml(this._manualTransferOwner.destinationName)}</strong>${isReplacement ? ` and replace ${escapeHtml(player?.name || 'the outgoing player')}` : isFillSlot ? ` and fill draft slot #${this._manualFillSlot}` : ''}?</p><button type="button" class="btn btn-ghost" data-manual-action="cancelReplaceTransfer">Cancel</button> <button type="button" class="btn btn-primary" data-manual-action="confirmReplaceTransfer">Transfer &amp; Sign</button></div>` : ''}
        </div><footer class="manual-roster-modal-footer"><button type="button" class="btn btn-ghost" data-manual-action="closePicker">Cancel</button><button type="button" class="btn btn-primary" data-manual-action="${isReplacement ? 'modalConfirmReplace' : 'modalConfirmSign'}" ${selected && !transferPending ? '' : 'disabled'}>${isReplacement ? 'Confirm Replace' : isFillSlot ? 'Sign to Draft Slot' : 'Sign Player'}</button></footer>
      </section></div>`;
  },

  _matchesManualPlayerSearch(player, query) {
    if (!query) return true;
    return [player.name, player.position, player.team]
      .some(value => String(value || '').toLowerCase().includes(query));
  },

  _renderManualCandidateButtons(candidates, selectedPlayerId) {
    return candidates.length ? candidates.map(p => `<button type="button" class="manual-roster-candidate ${selectedPlayerId === p.id ? 'is-selected' : ''}" aria-pressed="${selectedPlayerId === p.id}" data-manual-action="selectReplace" data-player-id="${escapeHtml(p.id)}"><span class="manual-candidate-main"><strong>${escapeHtml(p.name)}</strong><small>${escapeHtml(p.team || 'Team unavailable')} · ${escapeHtml(p.position || '—')} · ${escapeHtml(poolLabel(p.pool))}</small><small class="manual-candidate-owner ${p.ownerId ? 'is-owned' : 'is-available'}">${p.ownerId ? `OWNED BY ${escapeHtml(p.ownerName)}` : 'AVAILABLE · UNOWNED'}</small></span><strong class="manual-candidate-ovr">${p.overall ?? '—'} <small>OVR</small></strong></button>`).join('') : '<p class="muted">No available players match.</p>';
  },

  _getManualReplaceCandidates(seasonId, pool = this._manualAddPool) {
    const season = LeagueData.getSeason(seasonId) || LeagueData.getCurrentSeason();
    const selectedPool = String(pool || '').toLowerCase();
    const participantId = this._manualAddTarget;
    const poolCandidates = LeagueData.getSwapEligibleReplacements(seasonId, selectedPool);
    const candidates = poolCandidates
      .map(p => ({ ...p, ownerId: null, ownerName: null }));
    const byId = new Map(candidates.map(p => [p.id, p]));
    LeagueData.getRosterSummary(seasonId).forEach(summary => {
      if (summary.participant.id === participantId) return;
      summary.rosterEntries.forEach(entry => {
        const p = entry.player || LeagueData.getPlayer(entry.playerId, seasonId);
        if (!p || entry.source === 'empty' || !p.id || String(p.pool || '').toLowerCase() !== selectedPool) return;
        // A current roster can still own an old per-season seeded record
        // after the live pool has switched to synthetic IDs. Let that owned
        // record through only when the selected season's current pool has
        // the same stable source slug and pool; this supports an in-season
        // transfer without exposing unrelated out-of-scope players.
        if (season?.playerPoolScope && p.seasonId != null && p.seasonId !== season.playerPoolScope) {
          const scopedMatch = p.nba2kRef && poolCandidates.find(candidate =>
            candidate.nba2kRef === p.nba2kRef
            && String(candidate.pool || '').toLowerCase() === selectedPool
          );
          if (!scopedMatch) return;
          // Keep the owner's actual roster ID for confirmation and expected-
          // owner validation, and avoid showing the matching live ID twice.
          if (scopedMatch.id !== p.id) byId.delete(scopedMatch.id);
        }
        const ownedCandidate = { ...p, ownerId: summary.participant.id, ownerName: summary.participant.name };
        // Roster ownership is authoritative if a stale availability snapshot
        // also contains this ID: keep one row and route it through transfer.
        byId.set(p.id, ownedCandidate);
      });
    });
    byId.delete(this._manualReplaceOutgoing);
    return [...byId.values()];
  },

  _mountReplaceModal(seasonId) {
    const previousOverlay = document.getElementById('manualReplacePlayerOverlay');
    const activeElement = document.activeElement;
    const focusState = previousOverlay?.contains(activeElement) ? {
      action: activeElement.dataset?.manualAction || null,
      playerId: activeElement.dataset?.playerId || null,
      pool: activeElement.dataset?.manualPool || null,
      inputId: activeElement.id || null,
      selectionStart: activeElement.id === 'manualPickerSearch' ? activeElement.selectionStart : null,
      selectionEnd: activeElement.id === 'manualPickerSearch' ? activeElement.selectionEnd : null,
    } : null;
    previousOverlay?.remove();
    if (!this._manualAddTarget) {
      if (this._replaceModalActive) this._restoreReplaceModal();
      return;
    }
    const portal = document.createElement('div');
    portal.innerHTML = this._renderReplaceModal(seasonId);
    const overlay = portal.firstElementChild;
    document.body.appendChild(overlay);
    if (focusState) this._restoreReplaceModalFocus(overlay, focusState);
    // Delegate from the body-mounted overlay so option clicks keep working
    // across searches and pool changes that replace the option nodes.
    overlay.addEventListener('click', e => {
      const action = e.target.closest?.('[data-manual-action]');
      if (e.target === overlay) { this._closeManualPicker(); AdminApp.renderView('roster'); return; }
      if (!action || !overlay.contains(action)) return;
      switch (action.dataset.manualAction) {
        case 'selectReplace':
          e.preventDefault();
          this._manualSelectedPlayer = action.dataset.playerId;
          this._manualTransferOwner = null;
          AdminApp.renderView('roster');
          break;
        case 'modalConfirmReplace':
          e.preventDefault();
          this._requestManualReplace(seasonId);
          break;
        case 'modalConfirmSign':
          e.preventDefault();
          this._requestManualSign(seasonId);
          break;
        case 'cancelReplaceTransfer':
          e.preventDefault();
          this._manualTransferOwner = null;
          AdminApp.renderView('roster');
          break;
        case 'confirmReplaceTransfer':
          e.preventDefault();
          this._confirmManualTransferReplace(seasonId);
          break;
        case 'closePicker':
          e.preventDefault();
          this._closeManualPicker();
          AdminApp.renderView('roster');
          break;
      }
    });
    if (!this._replaceModalActive) {
      this._replaceModalActive = true;
      this._previousBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
  },

  _restoreReplaceModalFocus(overlay, focusState) {
    let target = null;
    if (focusState.playerId) {
      target = [...overlay.querySelectorAll('[data-manual-action="selectReplace"]')]
        .find(element => element.dataset.playerId === focusState.playerId) || null;
    } else if (focusState.pool) {
      target = [...overlay.querySelectorAll('[data-manual-pool]')]
        .find(element => element.dataset.manualPool === focusState.pool) || null;
    } else if (focusState.inputId) {
      target = overlay.querySelector(`#${focusState.inputId}`);
    } else if (focusState.action) {
      target = overlay.querySelector(`[data-manual-action="${focusState.action}"]`);
    }

    if (target?.disabled) target = null;
    if (!target && this._manualTransferOwner) {
      target = overlay.querySelector('[data-manual-action="cancelReplaceTransfer"]');
    }
    if (!target && this._manualSelectedPlayer) {
      target = [...overlay.querySelectorAll('[data-manual-action="selectReplace"]')]
        .find(element => element.dataset.playerId === this._manualSelectedPlayer) || null;
    }
    target ||= overlay.querySelector('#manualPickerSearch')
      || overlay.querySelector('[role="dialog"]');
    target?.focus();
    if (target?.id === 'manualPickerSearch' && focusState.inputId === 'manualPickerSearch'
      && focusState.selectionStart != null && focusState.selectionEnd != null) {
      target.setSelectionRange(focusState.selectionStart, focusState.selectionEnd);
    }
  },

  _openManualRosterEntryModal(season, participantId, playerId, canJoker) {
    this._closeManualRosterEntryModal();
    const participant = LeagueData.getParticipant(season.id, participantId)
      || LeagueData.getRosterSummary(season.id).find(s => s.participant.id === participantId)?.participant;
    const entry = LeagueData.getRosterSummary(season.id)
      .find(s => s.participant.id === participantId)?.rosterEntries.find(e => e.playerId === playerId);
    const player = LeagueData.getPlayer(playerId, season.id) || entry?.player;
    if (!player?.id || !participant) return;

    const overlay = document.createElement('div');
    overlay.id = 'manualRosterEntryOverlay';
    overlay.className = 'modal-overlay manual-roster-entry-overlay';
    overlay.innerHTML = `<section class="modal-card manual-roster-entry-modal" role="dialog" aria-modal="true" aria-labelledby="manualRosterEntryTitle" tabindex="-1">
      <header class="manual-roster-modal-header"><div><span class="modal-eyebrow">ROSTER ENTRY</span><h2 id="manualRosterEntryTitle">${escapeHtml(player.name)}</h2></div>
        <button type="button" class="btn-icon-sm" aria-label="Close roster entry dialog" data-entry-action="close">✕</button></header>
      <div class="manual-roster-modal-body"><div class="manual-roster-entry-facts">
        <div><span>OVR</span><strong>${player.overall ?? '—'}</strong></div><div><span>Position</span><strong>${escapeHtml(entry?.effectivePosition || player.position || '—')}</strong></div>
        <div><span>Pool</span><strong>${escapeHtml(poolLabel(player.pool))}</strong></div><div><span>Current owner</span><strong>${escapeHtml(participant.name)}</strong></div>
        <div><span>Roster source</span><strong>${entry?.source === 'signed' ? 'Signed' : escapeHtml(entry?.source || '—')}</strong></div>
        <div><span>Draft slot</span><strong>${entry?.draftSlot ?? '—'}</strong></div>
      </div><p class="helper-text">Choose an action for this roster entry.</p></div>
      <footer class="manual-roster-entry-actions"><button type="button" class="btn btn-ghost" data-entry-action="close">Cancel</button>
        ${canJoker ? '<button type="button" class="btn btn-ghost" data-entry-action="joker">Joker Swap</button>' : ''}
        <button type="button" class="btn btn-ghost" data-entry-action="remove">Remove</button>
        <button type="button" class="btn btn-primary" data-entry-action="replace">Replace Player</button></footer>
    </section>`;
    document.body.appendChild(overlay);
    const dialog = overlay.querySelector('[role="dialog"]');
    overlay.addEventListener('click', event => {
      if (event.target === overlay) { this._closeManualRosterEntryModal(); return; }
      const action = event.target.closest?.('[data-entry-action]');
      if (!action || !overlay.contains(action)) return;
      event.preventDefault();
      const actionName = action.dataset.entryAction;
      this._closeManualRosterEntryModal();
      if (actionName === 'replace') {
        this._manualAddTarget = participantId;
        this._manualReplaceOutgoing = playerId;
        this._manualFillSlot = null;
        this._manualJokerFor = null;
        this._manualSearch = '';
        this._manualSelectedPlayer = null;
        this._manualTransferOwner = null;
        AdminApp.renderView('roster');
      } else if (actionName === 'remove') {
        this._openManualRemoveConfirm(season, participantId, playerId, player.name);
      } else if (actionName === 'joker') {
        this._manualAddTarget = null;
        this._manualReplaceOutgoing = null;
        this._manualFillSlot = null;
        this._manualJokerFor = { participantId, playerId };
        AdminApp.renderView('roster');
      }
    });
    this._manualRosterEntryKeydown = event => {
      if (event.key === 'Escape') { event.preventDefault(); this._closeManualRosterEntryModal(); return; }
      if (event.key !== 'Tab') return;
      const controls = [...(dialog?.querySelectorAll('button:not([disabled])') || [])];
      if (!controls.length) return;
      if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1).focus(); }
      else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0].focus(); }
    };
    document.addEventListener('keydown', this._manualRosterEntryKeydown);
    this._previousEntryBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog?.focus();
  },

  _closeManualRosterEntryModal() {
    document.getElementById('manualRosterEntryOverlay')?.remove();
    if (this._manualRosterEntryKeydown) {
      document.removeEventListener('keydown', this._manualRosterEntryKeydown);
      this._manualRosterEntryKeydown = null;
      document.body.style.overflow = this._previousEntryBodyOverflow || '';
    }
  },

  // ── Revision — Add Joker Swap to Manual Roster Edit: reuses
  // AdminActions.designateJoker unmodified (the same function
  // admin/trades.js's Joker tab calls) — this is just an alternate entry
  // point into that existing logic, not a second Joker implementation.
  // Pool-agnostic already (Green and Blue both eligible), so no pool
  // branching is needed here either. ─────────────────────────────────────
  _renderJokerSwapPicker(participantId, playerId, seasonId) {
    const player = LeagueData.getPlayer ? LeagueData.getPlayer(playerId) : null;
    const currentJoker = LeagueData.getJoker(seasonId, participantId);
    const isCurrentJoker = currentJoker && currentJoker.playerId === playerId;
    const positions = ['PG', 'SG', 'SF', 'PF', 'C'];
    return `
      <div class="roster-manual-picker card-form" style="margin-top:0.75rem;">
        <div class="roster-manual-picker-header">
          <strong>🃏 Joker Swap${player ? ` — ${escapeHtml(player.name)}` : ''}</strong>
          <button type="button" class="btn btn-ghost" data-manual-action="closeJokerPicker">Cancel</button>
        </div>
        <p class="helper-text">
          ${isCurrentJoker
            ? `Already this participant's Joker (currently ${escapeHtml(currentJoker.jokerPosition || '')}) — pick a new position to reposition them.`
            : `Designating a new Joker replaces this participant's current Joker, if any. The Joker keeps their own pool/identity and draft slot — only their roster position changes.`}
        </p>
        <div class="form-group">
          <label>Assigned position</label>
          <select class="input" id="manualJokerPositionSelect" style="max-width:160px">
            <option value="">Select position…</option>
            ${positions.map(p => `<option value="${p}">${p}</option>`).join('')}
          </select>
        </div>
        <p id="manualJokerError" class="error-text"></p>
        <button type="button" class="btn btn-primary" data-manual-action="confirmJokerSwap" data-participant-id="${participantId}" data-player-id="${playerId}">Apply Joker Swap</button>
      </div>`;
  },

  // ── Revision 2: inline available-player picker, shown inside a roster
  // card when that participant's "+ Add Player" (or a row's "⇄ Replace")
  // has been clicked. Reuses LeagueData.getSwapEligibleReplacements —
  // the exact same "currently unowned by any currentRosters entry" pool
  // Phase 5 swaps already use — so this never invents a second notion of
  // "available", and it is generic across Green/Blue/Classics/All-Time/
  // any future pool since it reads the global player database, not a
  // hard-coded list. ───────────────────────────────────────────────────
  _renderManualPicker(participantId, seasonId) {
    const pool = this._manualAddPool;
    const q = (this._manualSearch || '').trim().toLowerCase();
    const candidates = this._getManualReplaceCandidates(seasonId, pool)
      .filter(p => !q || p.name.toLowerCase().includes(q) || (p.position || '').toLowerCase().includes(q));

    const headerLabel = 'Add Player';

    return `
      <div class="roster-manual-picker card-form" style="margin-top:0.75rem;">
        <div class="roster-manual-picker-header">
          <strong>${headerLabel}</strong>
          <button type="button" class="btn btn-ghost" data-manual-action="closePicker">Cancel</button>
        </div>
        <div class="pool-tabs" style="margin:0.5rem 0;">
          <button type="button" class="pool-tab pool-tab-green ${pool === 'green' ? 'active' : ''}" data-manual-pool="green">Green Pool</button>
          <button type="button" class="pool-tab pool-tab-blue ${pool === 'blue' ? 'active' : ''}" data-manual-pool="blue">Blue Pool</button>
          <button type="button" class="pool-tab pool-tab-white ${pool === 'white' ? 'active' : ''}" data-manual-pool="white">White Pool</button>
        </div>
        ${this._manualTransferOwner ? `<div class="manual-transfer-warning" role="alert"><strong>Transfer ${escapeHtml(LeagueData.getPlayer(this._manualTransferOwner.playerId, seasonId)?.name || 'player')}?</strong><p>Currently belongs to ${escapeHtml(this._manualTransferOwner.name)}. The assignment moves to ${escapeHtml(this._manualTransferOwner.destinationName)} after confirmation.</p><button type="button" class="btn btn-ghost" data-manual-action="cancelTransfer">Cancel</button> <button type="button" class="btn btn-primary" data-manual-action="confirmTransfer">Transfer &amp; Sign</button></div>` : ''}
        <input type="text" class="input" id="manualPickerSearch" placeholder="Search available players…" value="${escapeHtml(this._manualSearch || '')}" style="margin-bottom:0.5rem;width:100%;">
        <div class="table-scroll" style="max-height:260px;overflow-y:auto;">
          <table class="roster-table">
            <thead><tr><th>Player</th><th>Pos</th><th>OVR</th><th></th></tr></thead>
            <tbody>
              ${candidates.length ? candidates.map(p => `
                <tr>
                  <td>${escapeHtml(p.name)}${p.ownerId ? `<small class="muted"> · ${escapeHtml(p.ownerName)}</small>` : ''}</td>
                  <td>${p.position || '—'}</td>
                  <td class="ovr">${p.overall ?? '—'}</td>
                  <td><button type="button" class="btn btn-primary" style="padding:0.25rem 0.6rem;font-size:0.8rem;" data-manual-action="${p.ownerId ? 'requestTransfer' : 'confirmSign'}" data-participant-id="${participantId}" data-player-id="${p.id}" data-owner-id="${p.ownerId || ''}" data-owner-name="${escapeHtml(p.ownerName || '')}">${p.ownerId ? 'Transfer…' : 'Sign'}</button></td>
                </tr>`).join('') : `<tr><td colspan="4" class="muted" style="padding:0.5rem">No eligible players${q ? ' match your search' : ' in this pool'}.</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>`;
  },

  _bindEvents(container, season) {
    // Update rating cap
    container.querySelector('#btnSaveCap').onclick = () => {
      AuthBoundary.requireAuth();
      const val = parseInt(container.querySelector('#ratingCapInput').value, 10);
      if (isNaN(val) || val < 1) { showToast('Enter a valid cap value.', 'error'); return; }
      try {
        AdminActions.setRatingCap(season.id, val);
        showToast(`Rating cap set to ${val}.`, 'success');
        AdminApp.renderView('roster');
      } catch (e) {
        showToast(e.message, 'error');
      }
    };

    // Initialize rosters
    container.querySelector('#btnInitRosters').onclick = () => {
      AuthBoundary.requireAuth();
      const season2 = LeagueData.getCurrentSeason();
      if (season2?.rostersInitialized) {
        // Destructive path (would overwrite manual changes) — PIN-gated,
        // same three-stage flow as "Delete All Players" in admin/players.js.
        this._openReinitConfirm1(season);
        return;
      }
      // First-time initialization has nothing to lose — proceed directly,
      // same behavior as before.
      this._runInitializeRosters(season);
    };

    // ── Revision 3: Validate Rosters — read-only, always available (does
    // not require Manual Roster Edit to be unlocked, and never writes). ──
    container.querySelector('#btnValidateRosters')?.addEventListener('click', () => {
      const result = LeagueData.validateAllRosters(season.id);
      this._openValidateRostersModal(result);
    });

    // ── Revision 2: Manual Roster Edit ─────────────────────────────────
    container.querySelector('#btnUnlockManualEdit')?.addEventListener('click', () => {
      AuthBoundary.requireAuth();
      this._openManualEditPinStep(season);
    });

    container.querySelector('#btnLockManualEdit')?.addEventListener('click', () => {
      this._manualEditUnlocked = false;
      this._manualAddTarget = null;
      this._manualReplaceOutgoing = null;
      this._manualFillSlot = null;
      this._manualJokerFor = null;
      this._manualSearch = '';
      AdminApp.renderView('roster');
    });

    if (this._manualEditUnlocked) {
      this._bindManualEditActions(container, season);
    }
  },

  // Delegated handlers for every [data-manual-action] control rendered
  // inside _renderRosterCard/_renderManualPicker while the manual editor
  // is unlocked. A full re-render (AdminApp.renderView('roster')) after
  // each write keeps this in sync with roster.js's existing pattern
  // everywhere else in this file (setRatingCap, initializeRostersFromDraft).
  _bindManualEditActions(container, season) {
    container.querySelectorAll('[data-manual-action="openAdd"]').forEach(btn => {
      btn.onclick = () => {
        this._manualAddTarget = btn.dataset.participantId;
        this._manualReplaceOutgoing = null;
        this._manualFillSlot = null;
        this._manualJokerFor = null;
        this._manualSearch = '';
        this._manualSelectedPlayer = null;
        this._manualTransferOwner = null;
        AdminApp.renderView('roster');
      };
    });

    container.querySelectorAll('[data-manual-action="fillSlot"]').forEach(btn => {
      btn.onclick = () => {
        this._manualAddTarget = btn.dataset.participantId;
        this._manualReplaceOutgoing = null;
        this._manualFillSlot = Number(btn.dataset.draftSlot);
        this._manualJokerFor = null;
        this._manualSearch = '';
        this._manualSelectedPlayer = null;
        this._manualTransferOwner = null;
        AdminApp.renderView('roster');
      };
    });

    container.querySelectorAll('[data-manual-action="replace"]').forEach(btn => {
      btn.onclick = () => {
        this._manualAddTarget = btn.dataset.participantId;
        this._manualReplaceOutgoing = btn.dataset.playerId;
        this._manualFillSlot = null;
        this._manualJokerFor = null;
        this._manualSearch = '';
        this._manualSelectedPlayer = null;
        AdminApp.renderView('roster');
      };
    });

    this._bindManualRosterEntryRows(container, season);

    const replaceModal = document.getElementById('manualReplacePlayerOverlay');
    if (replaceModal && !this._replaceEscape) {
      this._replaceEscape = e => {
        if (e.key === 'Escape') { this._closeManualPicker(); AdminApp.renderView('roster'); return; }
        if (e.key === 'Tab') {
          const dialog = document.querySelector('#manualReplacePlayerOverlay .manual-replace-modal');
          const items = [...(dialog?.querySelectorAll('button:not([disabled]), input:not([disabled])') || [])];
          if (!items.length) return;
          const first = items[0], last = items[items.length - 1];
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
      };
      document.addEventListener('keydown', this._replaceEscape);
      replaceModal.querySelector('#manualPickerSearch')?.focus();
    } else if (!replaceModal && this._replaceEscape) this._restoreReplaceModal();

    container.querySelectorAll('[data-manual-action="jokerSwap"]').forEach(btn => {
      btn.onclick = () => {
        this._manualAddTarget = null;
        this._manualReplaceOutgoing = null;
        this._manualFillSlot = null;
        this._manualJokerFor = { participantId: btn.dataset.participantId, playerId: btn.dataset.playerId };
        AdminApp.renderView('roster');
      };
    });

    container.querySelectorAll('[data-manual-action="closeJokerPicker"]').forEach(btn => {
      btn.onclick = () => {
        this._manualJokerFor = null;
        AdminApp.renderView('roster');
      };
    });

    container.querySelectorAll('[data-manual-action="confirmJokerSwap"]').forEach(btn => {
      btn.onclick = () => {
        AuthBoundary.requireAuth();
        const select = document.getElementById('manualJokerPositionSelect');
        const position = select ? select.value : '';
        const errEl = document.getElementById('manualJokerError');
        if (!position) {
          if (errEl) errEl.textContent = 'Select a position.';
          return;
        }
        try {
          // Reuses the exact same AdminActions.designateJoker call
          // admin/trades.js's Joker tab uses — no separate Joker logic.
          // Revision 3: passes bypassRosterRules so a manual Joker
          // correction isn't blocked by the resulting-position check —
          // own-pick #1-10 eligibility (inside designateJoker itself) is
          // never bypassed. See designateJoker's doc comment in data.js.
          AdminActions.designateJoker(
            season.id, btn.dataset.participantId, btn.dataset.playerId, position,
            { bypassRosterRules: true }
          );
          showToast('Joker Swap applied.', 'success');
          this._manualJokerFor = null;
          AdminApp.renderView('roster');
        } catch (e) {
          if (errEl) errEl.textContent = e.message;
          else showToast(e.message, 'error');
        }
      };
    });

    container.querySelectorAll('[data-manual-action="closePicker"]').forEach(btn => {
      btn.onclick = () => {
        this._manualTransferOwner = null;
        this._closeManualPicker();
        AdminApp.renderView('roster');
      };
    });

    [...(replaceModal?.querySelectorAll('[data-manual-pool]') || []), ...container.querySelectorAll('[data-manual-pool]')].forEach(btn => {
      btn.onclick = () => {
        this._manualAddPool = btn.dataset.manualPool;
        AdminApp.renderView('roster');
      };
    });

    const searchInput = replaceModal?.querySelector('#manualPickerSearch') || container.querySelector('#manualPickerSearch');
    if (searchInput) {
      const candidates = replaceModal ? this._getManualReplaceCandidates(season.id) : [];
      searchInput.oninput = (e) => {
        this._manualSearch = e.target.value;
        const filteredCandidates = candidates
          .filter(player => this._matchesManualPlayerSearch(player, this._manualSearch.trim().toLowerCase()));
        const list = replaceModal?.querySelector('.manual-roster-candidates');
        if (list) list.innerHTML = this._renderManualCandidateButtons(filteredCandidates, this._manualSelectedPlayer);
      };
    }

    container.querySelectorAll('[data-manual-action="requestTransfer"]').forEach(btn => {
      btn.onclick = () => {
        this._manualTransferOwner = { id: btn.dataset.ownerId, name: btn.dataset.ownerName, playerId: btn.dataset.playerId, destinationId: btn.dataset.participantId, destinationName: LeagueData.getRosterSummary(season.id).find(s => s.participant.id === btn.dataset.participantId)?.participant.name || 'this participant' };
        AdminApp.renderView('roster');
      };
    });
    container.querySelector('[data-manual-action="cancelTransfer"]')?.addEventListener('click', () => { this._manualTransferOwner = null; AdminApp.renderView('roster'); });
    container.querySelector('[data-manual-action="confirmTransfer"]')?.addEventListener('click', () => {
      const owner = this._manualTransferOwner;
      try { AuthBoundary.requireAuth(); AdminActions.manualSignPlayerToRoster(season.id, owner.destinationId, owner.playerId, true, null, owner.id); showToast('Player transferred and signed.', 'success'); this._manualTransferOwner = null; this._closeManualPicker(); AdminApp.renderView('roster'); }
      catch (e) { this._manualTransferOwner = null; showToast(e.message, 'error'); AdminApp.renderView('roster'); }
    });
    container.querySelectorAll('[data-manual-action="confirmSign"]').forEach(btn => {
      btn.onclick = () => {
        AuthBoundary.requireAuth();
        try {
          const targetSlot = btn.dataset.draftSlot != null ? Number(btn.dataset.draftSlot) : null;
          AdminActions.manualSignPlayerToRoster(season.id, btn.dataset.participantId, btn.dataset.playerId, false, targetSlot);
          showToast(targetSlot != null ? `Player signed to Pick #${targetSlot}.` : 'Player signed to roster.', 'success');
          this._manualAddTarget = null;
          this._manualFillSlot = null;
          this._manualSearch = '';
          AdminApp.renderView('roster');
        } catch (e) {
          showToast(e.message, 'error');
        }
      };
    });

    container.querySelectorAll('[data-manual-action="confirmReplace"]').forEach(btn => {
      btn.onclick = () => {
        AuthBoundary.requireAuth();
        try {
          AdminActions.manualReplacePlayerOnRoster(
            season.id, btn.dataset.participantId, this._manualReplaceOutgoing, btn.dataset.playerId
          );
          showToast('Player replaced on roster — original draft-pick slot preserved.', 'success');
          this._manualAddTarget = null;
          this._manualReplaceOutgoing = null;
          this._manualFillSlot = null;
          this._manualSearch = '';
          AdminApp.renderView('roster');
        } catch (e) {
          showToast(e.message, 'error');
        }
      };
    });

    // Remove — requires explicit confirmation (own modal), never removes
    // silently. See _openManualRemoveConfirm.
    container.querySelectorAll('[data-manual-action="remove"]').forEach(btn => {
      btn.onclick = () => {
        this._openManualRemoveConfirm(
          season, btn.dataset.participantId, btn.dataset.playerId, btn.dataset.playerName
        );
      };
    });
  },

  _bindManualRosterEntryRows(container, season) {
    container.querySelectorAll('tr[data-manual-action="openRosterEntry"]').forEach(row => {
      const open = event => {
        if (event.type === 'click' && event.target.closest?.('button, a, input, select, textarea')) return;
        if (event.type === 'keydown' && !['Enter', ' '].includes(event.key)) return;
        if (event.type === 'keydown') event.preventDefault();
        this._openManualRosterEntryModal(season, row.dataset.participantId, row.dataset.playerId, row.dataset.canJoker === 'true');
      };
      row.addEventListener('click', open);
      row.addEventListener('keydown', open);
    });
  },

  _closeManualPicker() {
    this._manualAddTarget = null;
    this._manualReplaceOutgoing = null;
    this._manualFillSlot = null;
    this._manualSelectedPlayer = null;
    this._manualSearch = '';
    this._restoreReplaceModal();
  },

  _confirmManualReplace(season) {
    AuthBoundary.requireAuth();
    try {
      const selectedPlayer = LeagueData.getPlayer(this._manualSelectedPlayer, season.id);
      if (!selectedPlayer?.id) throw new Error('Select an available player first.');
      AdminActions.manualReplacePlayerOnRoster(season.id, this._manualAddTarget, this._manualReplaceOutgoing, selectedPlayer.id);
      showToast('Player replaced — original draft-pick slot preserved.', 'success');
      this._closeManualPicker(); AdminApp.renderView('roster');
    } catch (e) { showToast(e.message, 'error'); }
  },

  _requestManualSign(seasonId) {
    const selected = LeagueData.getPlayer(this._manualSelectedPlayer, seasonId);
    if (!selected?.id) { showToast('Select a player first.', 'error'); return; }
    const candidate = this._getManualReplaceCandidates(seasonId, selected.pool).find(p => p.id === selected.id);
    if (!candidate) { showToast('That player is no longer available for this roster slot.', 'error'); return; }
    if (candidate.ownerId) {
      const destination = LeagueData.getRosterSummary(seasonId).find(s => s.participant.id === this._manualAddTarget)?.participant;
      this._manualTransferOwner = {
        playerId: selected.id,
        ownerId: candidate.ownerId,
        ownerName: candidate.ownerName,
        destinationId: this._manualAddTarget,
        destinationName: destination?.name || this._manualAddTarget,
      };
      AdminApp.renderView('roster');
      return;
    }
    try {
      AuthBoundary.requireAuth();
      AdminActions.manualSignPlayerToRoster(seasonId, this._manualAddTarget, selected.id, false, this._manualFillSlot);
      showToast(this._manualFillSlot != null ? `Player signed to draft slot #${this._manualFillSlot}.` : 'Player signed to roster.', 'success');
      this._manualTransferOwner = null;
      this._closeManualPicker();
      AdminApp.renderView('roster');
    } catch (e) { showToast(e.message, 'error'); }
  },

  _requestManualReplace(seasonId) {
    const selected = LeagueData.getPlayer(this._manualSelectedPlayer, seasonId);
    if (!selected?.id) { showToast('Select a player first.', 'error'); return; }
    const candidate = this._getManualReplaceCandidates(seasonId, selected.pool).find(p => p.id === selected.id);
    if (!candidate) { showToast('That player is no longer available for this replacement.', 'error'); return; }
    if (!candidate.ownerId) { this._confirmManualReplace(LeagueData.getSeason(seasonId) || LeagueData.getCurrentSeason()); return; }
    const destination = LeagueData.getRosterSummary(seasonId).find(s => s.participant.id === this._manualAddTarget)?.participant;
    this._manualTransferOwner = {
      playerId: selected.id,
      ownerId: candidate.ownerId,
      ownerName: candidate.ownerName,
      destinationId: this._manualAddTarget,
      destinationName: destination?.name || this._manualAddTarget,
    };
    AdminApp.renderView('roster');
  },

  _confirmManualTransferReplace(seasonId) {
    const transfer = this._manualTransferOwner;
    if (!transfer || transfer.playerId !== this._manualSelectedPlayer) return;
    try {
      AuthBoundary.requireAuth();
      if (!this._manualReplaceOutgoing) {
        AdminActions.manualSignPlayerToRoster(
          seasonId, transfer.destinationId, transfer.playerId, true, this._manualFillSlot, transfer.ownerId
        );
        showToast(this._manualFillSlot != null
          ? `Player transferred and signed to draft slot #${this._manualFillSlot}.`
          : 'Player transferred and signed.', 'success');
      } else {
        AdminActions.manualReplacePlayerOnRoster(
          seasonId, transfer.destinationId, this._manualReplaceOutgoing, transfer.playerId,
          { transferOwnerId: transfer.ownerId }
        );
        showToast('Player transferred and signed — original draft-pick slots preserved.', 'success');
      }
      this._manualTransferOwner = null;
      this._closeManualPicker();
      AdminApp.renderView('roster');
    } catch (e) { showToast(e.message, 'error'); }
  },

  _restoreReplaceModal() {
    if (!this._replaceModalActive) return;
    document.body.style.overflow = this._previousBodyOverflow || '';
    document.removeEventListener('keydown', this._replaceEscape);
    this._replaceEscape = null;
    this._replaceModalActive = false;
  },

  // ── Revision 3: Validate Rosters — read-only diagnostic modal. Never
  // calls any AdminActions write, never requires the PIN/AuthBoundary —
  // it only renders whatever LeagueData.validateAllRosters() (a pure read)
  // returns. Separate from, and independent of, Manual Roster Edit. ─────
  _openValidateRostersModal(result) {
    document.getElementById('validateRostersOverlay')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'validateRostersOverlay';
    overlay.className = 'modal-overlay';
    const errCount = result.errors.length;
    const warnCount = result.warnings.length;
    const headline = result.valid
      ? '✓ Rosters Valid'
      : `❌ ${errCount} error${errCount !== 1 ? 's' : ''} found`;
    overlay.innerHTML = `
      <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="validateRostersTitle" style="max-width:640px;max-height:80vh;overflow-y:auto;">
        <div class="modal-eyebrow">Roster Validation</div>
        <div class="modal-player-name" id="validateRostersTitle">${escapeHtml(headline)}</div>
        <p class="modal-prompt">
          ${result.teamsChecked} team${result.teamsChecked !== 1 ? 's' : ''} checked —
          ${errCount} error${errCount !== 1 ? 's' : ''}, ${warnCount} warning${warnCount !== 1 ? 's' : ''}.
        </p>
        ${this._renderValidationFindings(result)}
        <div class="modal-actions">
          <button class="btn btn-primary" id="validateRostersCloseBtn">Close</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    document.getElementById('validateRostersCloseBtn').onclick = close;
  },

  // Groups the flat errors/warnings arrays by team name (league-wide
  // findings — e.g. a duplicate player owned by two teams — have
  // teamId/teamName null and are shown under their own heading).
  _renderValidationFindings(result) {
    if (result.valid && !result.warnings.length) {
      return `<div class="success-banner">✓ No roster errors or warnings found.</div>`;
    }
    const groups = new Map();
    const bucketFor = (item) => {
      const key = item.teamName || 'League-wide';
      if (!groups.has(key)) groups.set(key, { errors: [], warnings: [] });
      return groups.get(key);
    };
    result.errors.forEach(e => bucketFor(e).errors.push(e));
    result.warnings.forEach(w => bucketFor(w).warnings.push(w));

    return `<div class="validate-rosters-groups">
      ${[...groups.entries()].map(([name, findings]) => `
        <div style="margin-bottom:0.85rem;">
          <div style="font-weight:700;margin-bottom:0.25rem;">${escapeHtml(name)}</div>
          <ul style="margin:0;padding-left:1.15rem;font-size:0.85rem;">
            ${findings.errors.map(e => `<li class="error-text">❌ ${escapeHtml(e.message)}</li>`).join('')}
            ${findings.warnings.map(w => `<li style="color:var(--nb-gold,#c9a227)">⚠ ${escapeHtml(w.message)}</li>`).join('')}
          </ul>
        </div>`).join('')}
    </div>`;
  },

  // ── Manual Roster Edit — PIN step, reusing _DELETE_ALL_PLAYERS_PIN from
  // admin/players.js (see the file-level security note above). Single
  // confirm→PIN step (no "final confirmation" stage) since unlocking the
  // editor is itself non-destructive — every actual write inside it
  // (Add/Replace/Remove) is separately validated and Remove has its own
  // confirmation dialog. ───────────────────────────────────────────────
  _openManualEditPinStep(season) {
    document.getElementById('manualEditPinOverlay')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'manualEditPinOverlay';
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="manualEditPinTitle">
        <div class="modal-eyebrow">🔒 Protected Action</div>
        <div class="modal-player-name" id="manualEditPinTitle">Enter Admin PIN</div>
        <p class="modal-prompt">Enter the admin PIN to unlock manual roster editing. This uses the same PIN as Delete All Players and only unlocks roster corrections here — not general Superadmin access.</p>
        <div class="form-group">
          <input type="password" id="manualEditPinInput" class="input" autocomplete="off" placeholder="PIN">
        </div>
        <p class="error-text" id="manualEditPinError"></p>
        <div class="modal-actions">
          <button class="btn btn-ghost" id="manualEditPinCancelBtn">Cancel</button>
          <button class="btn btn-primary" id="manualEditPinSubmitBtn">Verify</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    document.getElementById('manualEditPinCancelBtn').onclick = close;

    const pinInput = document.getElementById('manualEditPinInput');
    pinInput.focus();
    const submit = () => {
      const entered = pinInput.value;
      pinInput.value = ''; // never leave the PIN sitting in the DOM after a check
      if (entered !== _DELETE_ALL_PLAYERS_PIN) {
        document.getElementById('manualEditPinError').textContent = 'Incorrect PIN.';
        return;
      }
      close();
      this._manualEditUnlocked = true;
      showToast('Manual roster editing unlocked.', 'success');
      AdminApp.renderView('roster');
    };
    document.getElementById('manualEditPinSubmitBtn').onclick = submit;
    pinInput.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
  },

  // ── Remove confirmation — required before any manual removal; the
  // player is returned to the available pool, never deleted. ───────────
  _openManualRemoveConfirm(season, participantId, playerId, playerName) {
    document.getElementById('manualRemoveConfirmOverlay')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'manualRemoveConfirmOverlay';
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="manualRemoveTitle">
        <div class="modal-eyebrow">Remove Player</div>
        <div class="modal-player-name" id="manualRemoveTitle">Remove ${escapeHtml(playerName || 'this player')}?</div>
        <p class="modal-prompt">This player will be removed from the roster and returned to the available draft pool. They can be selected again.</p>
        <div class="modal-actions">
          <button class="btn btn-ghost" id="manualRemoveCancelBtn">Cancel</button>
          <button class="btn btn-danger" id="manualRemoveConfirmBtn">Remove Player</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    document.getElementById('manualRemoveCancelBtn').onclick = close;
    document.getElementById('manualRemoveConfirmBtn').onclick = () => {
      AuthBoundary.requireAuth();
      try {
        AdminActions.manualRemovePlayerFromRoster(season.id, participantId, playerId);
        showToast(`${playerName || 'Player'} removed and returned to the available pool.`, 'success');
        close();
        AdminApp.renderView('roster');
      } catch (e) {
        showToast(e.message, 'error');
        close();
      }
    };
  },

  _runInitializeRosters(season) {
    try {
      AdminActions.initializeRostersFromDraft(season.id);
      showToast('Rosters initialized from draft picks.', 'success');
      AdminApp.renderView('roster');
    } catch (e) {
      showToast(e.message, 'error');
    }
  },

  // ── Re-initialize Rosters (destructive) ──────────────────────────────────
  // Three-stage destructive-action flow: confirm → PIN → final confirm.
  // See _REINIT_ROSTERS_PIN above for what this PIN does and does not protect.
  _openReinitConfirm1(season) {
    document.getElementById('reinitRostersOverlay')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'reinitRostersOverlay';
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="reinitTitle1">
        <div class="modal-eyebrow">⚠ Destructive Action</div>
        <div class="modal-player-name" id="reinitTitle1">Re-initialize Rosters from Draft</div>
        <p class="modal-prompt">This will overwrite the current rosters with a fresh copy of the draft picks. Any manual changes made since the last initialization — trades, swaps, Joker designations — will be lost. This cannot be undone.</p>
        <div class="modal-actions">
          <button class="btn btn-ghost" id="reinitCancelBtn1">Cancel</button>
          <button class="btn btn-danger" id="reinitContinueBtn1">Continue</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    document.getElementById('reinitCancelBtn1').onclick = close;
    document.getElementById('reinitContinueBtn1').onclick = () => {
      close();
      this._openReinitPinStep(season);
    };
  },

  _openReinitPinStep(season) {
    document.getElementById('reinitRostersOverlay')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'reinitRostersOverlay';
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="reinitPinTitle">
        <div class="modal-eyebrow">⚠ Destructive Action</div>
        <div class="modal-player-name" id="reinitPinTitle">Enter Admin PIN</div>
        <p class="modal-prompt">Enter the admin PIN to continue re-initializing rosters.</p>
        <div class="form-group">
          <input type="password" id="reinitPinInput" class="input" autocomplete="off" placeholder="PIN">
        </div>
        <p class="error-text" id="reinitPinError"></p>
        <div class="modal-actions">
          <button class="btn btn-ghost" id="reinitPinCancelBtn">Cancel</button>
          <button class="btn btn-danger" id="reinitPinSubmitBtn">Verify</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    document.getElementById('reinitPinCancelBtn').onclick = close;

    const pinInput = document.getElementById('reinitPinInput');
    pinInput.focus();
    const submit = () => {
      const entered = pinInput.value;
      pinInput.value = ''; // never leave the PIN sitting in the DOM after a check
      if (entered !== _REINIT_ROSTERS_PIN) {
        document.getElementById('reinitPinError').textContent = 'Incorrect PIN.';
        return;
      }
      close();
      this._openReinitConfirm2(season);
    };
    document.getElementById('reinitPinSubmitBtn').onclick = submit;
    pinInput.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
  },

  _openReinitConfirm2(season) {
    document.getElementById('reinitRostersOverlay')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'reinitRostersOverlay';
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="reinitTitle2">
        <div class="modal-eyebrow">⚠ Final Confirmation</div>
        <div class="modal-player-name" id="reinitTitle2">Are you absolutely sure?</div>
        <p class="modal-prompt">This will overwrite the current rosters from draft picks. Manual changes since the last initialization will be lost. This cannot be undone.</p>
        <div class="modal-actions">
          <button class="btn btn-ghost" id="reinitCancelBtn2">Cancel</button>
          <button class="btn btn-danger" id="reinitConfirmBtn2">Re-initialize Rosters</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    document.getElementById('reinitCancelBtn2').onclick = close;
    document.getElementById('reinitConfirmBtn2').onclick = () => {
      AuthBoundary.requireAuth();
      try {
        AdminActions.initializeRostersFromDraft(season.id);
        close();
        showToast('Rosters initialized from draft picks.', 'success');
        AdminApp.renderView('roster');
      } catch (e) {
        // Leave the UI in a recoverable state — modal stays open with a
        // clear error rather than a false success message.
        document.querySelector('#reinitRostersOverlay .modal-prompt').insertAdjacentHTML(
          'afterend', `<p class="error-text">Re-initialize failed: ${escapeHtml(e.message)}</p>`
        );
      }
    };
  },
};
