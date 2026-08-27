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
const _REINIT_ROSTERS_PIN = 'CHANGE-ME-PIN';

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
          🔓 Manual Roster Editor unlocked. Add/Remove/Replace actions below write directly to current rosters —
          removed players return to the available pool immediately.
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
          const slotLabel = e.draftSlot != null ? e.draftSlot : '—';
          if (isEmpty) {
            return `
              <tr class="roster-row-empty">
                <td class="roster-pick-num">${slotLabel}</td>
                <td colspan="4" class="muted"><em>EMPTY — draft slot vacated</em></td>
                ${editing ? `<td class="roster-manual-actions">
                  <button type="button" class="btn btn-ghost" style="padding:0.15rem 0.5rem;font-size:0.75rem;" data-manual-action="fillSlot" data-participant-id="${participant.id}" data-draft-slot="${e.draftSlot}">+ Fill Slot</button>
                </td>` : '<td></td>'}
              </tr>`;
          }
          const canJoker = editing && p && jokerEligibleIds.has(p.id);
          return `
            <tr>
              <td class="roster-pick-num">${slotLabel}</td>
              <td>${p ? escapeHtml(p.name) : '<span class="muted">(removed)</span>'}</td>
              <td>${p ? (p.pool === 'green' ? 'Green' : p.pool === 'blue' ? 'Blue' : '—') : '—'}</td>
              <td>${p ? escapeHtml(e.effectivePosition || p.position || '—') : '—'}${e.isJoker ? ' <span title="Joker-assigned position">🃏</span>' : ''}</td>
              <td class="ovr">${p ? p.overall : '—'}</td>
              <td class="muted" style="font-size:0.75rem">${escapeHtml(e.source)}</td>
              ${editing ? `<td class="roster-manual-actions">
                ${p ? `
                ${canJoker ? `<button type="button" class="btn-icon-sm" title="Joker Swap (position change)" data-manual-action="jokerSwap" data-participant-id="${participant.id}" data-player-id="${p.id}">🃏</button>` : ''}
                <button type="button" class="btn-icon-sm" title="Replace" data-manual-action="replace" data-participant-id="${participant.id}" data-player-id="${p.id}">⇄</button>
                <button type="button" class="btn-icon-sm" title="Remove" data-manual-action="remove" data-participant-id="${participant.id}" data-player-id="${p.id}" data-player-name="${escapeHtml(p.name)}">✕</button>
                ` : ''}
              </td>` : ''}
            </tr>`;
        }).join('')
      : `<tr><td colspan="${editing ? 7 : 6}" class="muted" style="padding:0.75rem">No players.</td></tr>`;

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
            <tr><th>Pick #</th><th>Player</th><th>Pool</th><th>Pos</th><th>OVR</th><th>Source</th>${editing ? '<th></th>' : ''}</tr>
          </thead>
          <tbody>${playerRows}</tbody>
        </table>
        </div>

        ${editing ? `
        <div class="roster-manual-editor-controls">
          ${showPicker ? '' : `<button type="button" class="btn btn-ghost" data-manual-action="openAdd" data-participant-id="${participant.id}">+ Add Player</button>`}
        </div>
        ${showPicker ? this._renderManualPicker(participant.id, seasonId) : ''}
        ${showJokerPicker ? this._renderJokerSwapPicker(participant.id, this._manualJokerFor.playerId, seasonId) : ''}
        ` : ''}
      </div>`;
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
    const replacingId = this._manualReplaceOutgoing;
    const fillSlot = this._manualFillSlot;
    const pool = this._manualAddPool;
    const q = (this._manualSearch || '').trim().toLowerCase();
    const eligible = LeagueData.getSwapEligibleReplacements(seasonId, pool)
      .filter(p => !q || p.name.toLowerCase().includes(q) || (p.position || '').toLowerCase().includes(q));

    const headerLabel = replacingId ? 'Replace with…' : fillSlot != null ? `Fill Draft Slot #${fillSlot} with…` : 'Add Player';
    const action = replacingId ? 'confirmReplace' : 'confirmAdd';
    const slotAttr = fillSlot != null ? ` data-draft-slot="${fillSlot}"` : '';

    return `
      <div class="roster-manual-picker card-form" style="margin-top:0.75rem;">
        <div class="roster-manual-picker-header">
          <strong>${headerLabel}</strong>
          <button type="button" class="btn btn-ghost" data-manual-action="closePicker">Cancel</button>
        </div>
        <div class="pool-tabs" style="margin:0.5rem 0;">
          <button type="button" class="pool-tab pool-tab-green ${pool === 'green' ? 'active' : ''}" data-manual-pool="green">Green Pool</button>
          <button type="button" class="pool-tab pool-tab-blue ${pool === 'blue' ? 'active' : ''}" data-manual-pool="blue">Blue Pool</button>
        </div>
        <input type="text" class="input" id="manualPickerSearch" placeholder="Search available players…" value="${escapeHtml(this._manualSearch || '')}" style="margin-bottom:0.5rem;width:100%;">
        <div class="table-scroll" style="max-height:260px;overflow-y:auto;">
          <table class="roster-table">
            <thead><tr><th>Player</th><th>Pos</th><th>OVR</th><th></th></tr></thead>
            <tbody>
              ${eligible.length ? eligible.map(p => `
                <tr>
                  <td>${escapeHtml(p.name)}</td>
                  <td>${p.position || '—'}</td>
                  <td class="ovr">${p.overall ?? '—'}</td>
                  <td><button type="button" class="btn btn-primary" style="padding:0.25rem 0.6rem;font-size:0.8rem;" data-manual-action="${action}" data-participant-id="${participantId}" data-player-id="${p.id}"${slotAttr}>${replacingId ? 'Replace' : 'Add'}</button></td>
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
        AdminApp.renderView('roster');
      };
    });

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
          AdminActions.designateJoker(season.id, btn.dataset.participantId, btn.dataset.playerId, position);
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
        this._manualAddTarget = null;
        this._manualReplaceOutgoing = null;
        this._manualFillSlot = null;
        this._manualSearch = '';
        AdminApp.renderView('roster');
      };
    });

    container.querySelectorAll('[data-manual-pool]').forEach(btn => {
      btn.onclick = () => {
        this._manualAddPool = btn.dataset.manualPool;
        AdminApp.renderView('roster');
      };
    });

    const searchInput = container.querySelector('#manualPickerSearch');
    if (searchInput) {
      searchInput.oninput = (e) => {
        this._manualSearch = e.target.value;
        // Re-render just the picker's own card would be ideal, but a full
        // re-render keeps this file's single "mutate state → re-render
        // whole view" pattern consistent with everything else here; the
        // search box regains focus below.
        AdminApp.renderView('roster');
        const el = document.getElementById('manualPickerSearch');
        if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
      };
    }

    container.querySelectorAll('[data-manual-action="confirmAdd"]').forEach(btn => {
      btn.onclick = () => {
        AuthBoundary.requireAuth();
        try {
          const targetSlot = btn.dataset.draftSlot != null ? Number(btn.dataset.draftSlot) : null;
          AdminActions.manualAddPlayerToRoster(season.id, btn.dataset.participantId, btn.dataset.playerId, targetSlot);
          showToast(targetSlot != null ? `Player added to Pick #${targetSlot}.` : 'Player added to roster.', 'success');
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
