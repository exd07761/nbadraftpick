'use strict';
/**
 * views/roster-simulator.js — Public "Roster Simulator" (Phase 1).
 *
 * A manager picks themselves, sees their REAL current roster (BEFORE,
 * locked) next to an editable temporary clone (AFTER), and can remove /
 * add / replace players to see what the roster would look like — the
 * "Excel" workflow, minus the spreadsheet. Nothing is ever saved.
 *
 * ── Scope (Phase 1 only) ────────────────────────────────────────────────
 * Display + net-change detection ONLY. Deliberately NOT implemented here:
 *   - roster validation (875 cap, position limits, Blue rules, ...)
 *   - trade / swap / Joker / release / sign classification or validation
 *   - the transaction builder / "Copy Transaction to Discord" (the button
 *     is a disabled placeholder)
 *   - trades between managers (the picker only offers players that are not
 *     on any roster, plus players the manager removed in this simulation)
 * Detected changes are just "removed" and "added" — this file never decides
 * what KIND of transaction they would be.
 *
 * ── Safety / isolation ──────────────────────────────────────────────────
 * READ-ONLY toward the league. This file calls only these existing read
 * APIs and never anything that writes:
 *   LeagueData.getCurrentSeasonId / getSeason
 *   LeagueData.getRosterSummary            (BEFORE roster + classification)
 *   LeagueData.getSwapEligibleReplacements (unrostered player pool, with
 *                                           classification attached)
 *   LeagueData.getNBATeamAssignments       (team badge only)
 * It never references AdminActions, FirebaseSync.save*, Firestore or
 * Supabase writes.
 *
 * BEFORE/AFTER isolation: BEFORE is a deep-frozen, view-owned snapshot
 * built from plain copies of the display fields (never the live player
 * objects, and never frozen live objects), so nothing here can mutate
 * league state and nothing in AFTER can mutate BEFORE. AFTER is a plain
 * clone; every edit replaces an AFTER slot object rather than mutating
 * shared data. All state below lives on this view object only — in
 * memory, gone on refresh.
 *
 * ── Classification (Red / Yellow / Colorless / Pink) ────────────────────
 * No classification logic lives here. Every tag comes from the existing
 * getPlayerClassificationInfo() (data.js), via the entries returned by
 * getRosterSummary (roster players) and getSwapEligibleReplacements (pool
 * players) — rendered with the same classificationBadge() the public and
 * admin roster tables use, with the same `isJoker ? 'PINK' : classification`
 * expression as views/roster.js. A player who was on the real roster and is
 * removed then re-added gets his original entry back (Joker flag,
 * classification and all).
 *
 * KNOWN LIMITATION (by design, Phase 2 decision): in the real system a
 * manually replaced slot keeps the OLD slot's tag (classificationSourcePlayerId).
 * The simulator does not model that — an added player shows his OWN
 * existing classification, exactly what the Trade/Swap picker shows for him.
 * How tags carry over depends on the transaction type, which Phase 2 decides.
 *
 * Roster size is never assumed: AFTER has exactly the slots BEFORE has
 * (including any already-empty ones). "Remove" opens a slot, "Add" fills an
 * open slot, "Replace" is remove + add in one step.
 */
const PublicRosterSimulatorView = {
  // ── View-local state — in memory only, never persisted ────────────────
  _seasonId: null,
  _participantId: null,
  _before: null,     // frozen array of frozen entry snapshots (real roster)
  _beforeSig: '',    // signature of _before, to detect real-roster changes
  _after: null,      // plain array of plain entries (editable clone)
  _picker: null,     // { slotIndex, query, pool } while the picker is open
  _candidates: [],   // picker candidates, rebuilt when the picker opens/renders
  _notice: '',
  _container: null,
  _focusPicker: false,

  // ═══ Pure helpers (no DOM, no LeagueData) ═════════════════════════════

  /** Plain, frozen copy of only the display fields of a player. */
  _snapshotPlayer(p) {
    if (!p) return null;
    return Object.freeze({
      id: p.id,
      name: p.name,
      position: p.position,
      overall: p.overall,
      pool: p.pool,
      variantGroup: p.variantGroup,
    });
  },

  /** Plain, frozen copy of a roster entry as returned by getRosterSummary. */
  _snapshotEntry(e) {
    return Object.freeze({
      playerId: e.playerId ?? null,
      source: e.source || null,
      draftSlot: e.draftSlot ?? null,
      isJoker: !!e.isJoker,
      jokerPosition: e.jokerPosition,
      classification: e.classification ?? null,
      effectivePosition: e.effectivePosition ?? null,
      player: this._snapshotPlayer(e.player),
    });
  },

  _buildBefore(entries) {
    return Object.freeze((entries || []).map((e) => this._snapshotEntry(e)));
  },

  /** Same rule as getRosterSummary's totalRating: sum of player.overall. */
  _sumOvr(entries) {
    return entries.reduce((sum, e) => sum + (e.player?.overall ?? 0), 0);
  },

  _isVacant(entry) {
    return !entry || !entry.player;
  },

  _vacantSlot(draftSlot) {
    return {
      playerId: null,
      source: 'empty',
      draftSlot,
      isJoker: false,
      jokerPosition: undefined,
      classification: null,
      effectivePosition: null,
      player: null,
    };
  },

  _cloneForAfter(before) {
    return before.map((e) => ({ ...e }));
  },

  _formatSigned(n) {
    return n > 0 ? `+${n}` : n < 0 ? `-${Math.abs(n)}` : '0';
  },

  /**
   * Net roster change by player id (never by name — variants can share a
   * name). Says nothing about WHAT transaction the change would be.
   */
  _computeDiff(before, after) {
    const beforeIds = new Set(before.filter((e) => e.player).map((e) => e.playerId));
    const afterIds = new Set(after.filter((e) => e.player).map((e) => e.playerId));
    const removed = before.filter((e) => e.player && !afterIds.has(e.playerId));
    const added = after.filter((e) => e.player && !beforeIds.has(e.playerId));
    const ovrBefore = this._sumOvr(before);
    const ovrAfter = this._sumOvr(after);
    return { removed, added, ovrBefore, ovrAfter, ovrChange: ovrAfter - ovrBefore };
  },

  /** Case-insensitive name/position match + pool filter, same idea as the public Players search. */
  _filterCandidates(candidates, afterEntries, { query = '', pool = '' } = {}) {
    const inAfter = new Set(afterEntries.filter((e) => e.player).map((e) => e.playerId));
    const q = String(query).trim().toLowerCase();
    return candidates.filter((c) => {
      if (inAfter.has(c.id)) return false;
      if (pool && c.pool !== pool) return false;
      if (!q) return true;
      return (c.name || '').toLowerCase().includes(q)
        || (c.position || '').toLowerCase().includes(q);
    });
  },

  // ═══ Data reads (LeagueData, read-only) ═══════════════════════════════

  /** Players the picker offers: nobody's-roster pool + players removed from this BEFORE roster. */
  _buildCandidates(seasonId, summary) {
    const owned = new Set();
    summary.forEach((s) => s.rosterEntries.forEach((e) => { if (e.playerId) owned.add(e.playerId); }));

    const byId = new Map();
    LeagueData.getSwapEligibleReplacements(seasonId).forEach((p) => {
      if (owned.has(p.id)) return; // covers pre-initialization drafts too
      byId.set(p.id, {
        id: p.id, name: p.name, position: p.position, overall: p.overall,
        pool: p.pool, variantGroup: p.variantGroup,
        classification: p.classification ?? null, wasOnRoster: false,
      });
    });
    // Players from the real roster, so a removed player can be added back.
    (this._before || []).forEach((e) => {
      if (!e.player) return;
      byId.set(e.playerId, { ...e.player, classification: e.classification, wasOnRoster: true });
    });

    return [...byId.values()].sort((a, b) =>
      (b.overall ?? 0) - (a.overall ?? 0) || String(a.name).localeCompare(String(b.name)));
  },

  // ═══ State transitions ════════════════════════════════════════════════

  _currentSummary() {
    return this._seasonId ? LeagueData.getRosterSummary(this._seasonId) : [];
  },

  _loadManager(participantId, summary) {
    const item = summary.find((s) => s.participant.id === participantId);
    if (!item) {
      this._participantId = null;
      this._before = null;
      this._after = null;
      this._beforeSig = '';
      this._picker = null;
      return false;
    }
    this._participantId = participantId;
    this._before = this._buildBefore(item.rosterEntries);
    this._beforeSig = JSON.stringify(this._before);
    this._after = this._cloneForAfter(this._before);
    this._picker = null;
    return true;
  },

  /** Picks the manager whose real roster is simulated ('' clears). Rebuilds BEFORE/AFTER fresh. */
  selectManager(participantId) {
    this._notice = '';
    this._picker = null;
    if (!participantId) return this._loadManager(null, []);
    return this._loadManager(participantId, this._currentSummary());
  },

  /** Vacates the AFTER slot at `index`. Returns true if a player was removed. */
  removeAt(index) {
    if (!this._after || this._isVacant(this._after[index])) return false;
    this._after[index] = this._vacantSlot(this._after[index].draftSlot);
    this._notice = '';
    return true;
  },

  /**
   * Puts a pool/removed player into AFTER slot `index` (filling an open slot,
   * or replacing its current occupant). No rule checks — Phase 1.
   */
  placePlayerAt(index, playerId) {
    if (!this._after || !this._after[index]) return { ok: false, reason: 'no-slot' };
    if (this._after[index].playerId === playerId && this._after[index].player) {
      return { ok: false, reason: 'already-in-slot' };
    }
    if (this._after.some((e, i) => i !== index && e.player && e.playerId === playerId)) {
      return { ok: false, reason: 'already-on-roster' };
    }
    const cand = this._buildCandidates(this._seasonId, this._currentSummary())
      .find((c) => c.id === playerId);
    if (!cand) return { ok: false, reason: 'not-available' };

    const draftSlot = this._after[index].draftSlot;
    const original = this._before.find((e) => e.player && e.playerId === playerId);
    this._after[index] = original
      ? { ...original, draftSlot } // back from the real roster: Joker/tag/etc. restored
      : {
        playerId: cand.id,
        source: 'simulated',
        draftSlot,
        isJoker: false,
        jokerPosition: undefined,
        classification: cand.classification ?? null,
        effectivePosition: cand.position ?? null,
        player: this._snapshotPlayer(cand),
      };
    this._notice = '';
    return { ok: true };
  },

  /** Restores AFTER to exactly match BEFORE. */
  reset() {
    if (!this._before) return false;
    this._after = this._cloneForAfter(this._before);
    this._picker = null;
    this._notice = '';
    return true;
  },

  getDiff() {
    if (!this._before || !this._after) return null;
    return this._computeDiff(this._before, this._after);
  },

  // ═══ Rendering ════════════════════════════════════════════════════════

  render(container) {
    this._container = container;

    const seasonId = LeagueData.getCurrentSeasonId();
    const season = seasonId ? LeagueData.getSeason(seasonId) : null;
    if (!season) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">📋</div>
          <h2>No Active Season</h2>
          <p>Check back once the commissioner has set up a season.</p>
        </div>`;
      return;
    }

    if (this._seasonId !== seasonId) {
      this._seasonId = seasonId;
      this._participantId = null;
      this._before = null;
      this._after = null;
      this._beforeSig = '';
      this._picker = null;
      this._notice = '';
    }

    const summary = LeagueData.getRosterSummary(seasonId);
    if (!summary.length) {
      container.innerHTML = `
        <div class="rsim-view">
          ${this._renderTitle(season)}
          <div class="empty-state">
            <div class="empty-icon">👥</div>
            <h2>No Teams Yet</h2>
            <p>Teams will appear here once the commissioner sets up the season.</p>
          </div>
        </div>`;
      return;
    }

    this._syncWithRealRoster(summary);

    const assignments = LeagueData.getNBATeamAssignments(seasonId) || {};
    if (this._picker) this._candidates = this._buildCandidates(seasonId, summary);

    container.innerHTML = `
      <div class="rsim-view">
        ${this._renderTitle(season)}
        ${this._renderManagerRow(summary, assignments)}
        ${this._notice ? `<div class="rsim-notice" role="status">${escapeHtml(this._notice)}</div>` : ''}
        ${this._participantId ? this._renderSimulation() : `
          <div class="empty-state">
            <div class="empty-icon">🧪</div>
            <h2>Pick a manager to start</h2>
            <p>Their current roster loads as BEFORE, with an editable copy as AFTER. Nothing you try here is saved.</p>
          </div>`}
        ${this._picker ? this._renderPicker() : ''}
      </div>`;

    this._bind(container);
    if (this._picker && this._focusPicker) {
      this._focusPicker = false;
      const input = container.querySelector('#rsimPickerSearch');
      if (input && input.focus) input.focus();
    }
  },

  /**
   * BEFORE is always re-read from live data. If the REAL roster of the
   * selected manager changed underneath the simulation (an admin saved a
   * trade, a rating refresh...), the old AFTER no longer starts from the
   * truth — reset it instead of silently simulating from a stale base.
   */
  _syncWithRealRoster(summary) {
    if (!this._participantId) return;
    const item = summary.find((s) => s.participant.id === this._participantId);
    if (!item) { // manager no longer exists in this season
      this._loadManager(null, []);
      return;
    }
    const fresh = this._buildBefore(item.rosterEntries);
    const sig = JSON.stringify(fresh);
    if (!this._before || sig !== this._beforeSig) {
      const hadEdits = !!this._after && !!this._before &&
        JSON.stringify(this._after) !== JSON.stringify(this._cloneForAfter(this._before));
      this._before = fresh;
      this._beforeSig = sig;
      this._after = this._cloneForAfter(fresh);
      this._picker = null;
      if (hadEdits) this._notice = 'The real roster changed, so your simulation was reset to the latest roster.';
    }
  },

  _renderTitle(season) {
    return `
      <div class="rsim-header">
        <h1 class="all-rosters-title">Roster Simulator</h1>
        <span class="rsim-pill">Simulation only — nothing is saved</span>
        <span class="rsim-season muted">${escapeHtml(season.name || '')}</span>
      </div>`;
  },

  _renderManagerRow(summary, assignments) {
    const badge = this._participantId
      ? `<span class="rsim-team">${teamBadge(assignments[this._participantId], { size: 'md', showName: true })}</span>`
      : '';
    return `
      <div class="rsim-manager-row">
        <label class="all-rosters-season-label" for="rsimManagerSelect">
          Manager:
          <select id="rsimManagerSelect" class="all-rosters-season-picker">
            <option value="">— Select manager —</option>
            ${summary.map((s) => `<option value="${escapeHtml(s.participant.id)}" ${s.participant.id === this._participantId ? 'selected' : ''}>${escapeHtml(s.participant.name)}</option>`).join('')}
          </select>
        </label>
        ${badge}
      </div>`;
  },

  _renderSimulation() {
    const diff = this._computeDiff(this._before, this._after);
    const changeCls = diff.ovrChange > 0 ? 'rsim-pos' : diff.ovrChange < 0 ? 'rsim-neg' : '';
    const hasChanges = diff.removed.length > 0 || diff.added.length > 0;
    const beforeIds = new Set(this._before.filter((e) => e.player).map((e) => e.playerId));

    return `
      <div class="rsim-grid-host">
      <div class="rsim-grid">
        <section class="rsim-card" aria-label="Before — actual current roster">
          <div class="rsim-card-head">
            <div>
              <div class="rsim-eyebrow">BEFORE</div>
              <div class="rsim-card-title">Actual Current Roster</div>
            </div>
            <span class="rsim-lock" title="Read-only — this is the real roster">🔒 Locked</span>
          </div>
          ${this._renderTable(this._before, { editable: false, beforeEntries: this._before, beforeIds })}
        </section>

        <section class="rsim-card rsim-card--after" aria-label="After — your simulated roster">
          <div class="rsim-card-head">
            <div>
              <div class="rsim-eyebrow rsim-eyebrow--after">AFTER</div>
              <div class="rsim-card-title">Your Simulated Roster</div>
            </div>
            <span class="rsim-lock muted">Editable</span>
          </div>
          ${this._renderTable(this._after, { editable: true, beforeEntries: this._before, beforeIds })}
          <p class="rsim-foot muted">Tags show each player's existing classification. Remove a player to open a slot, then add from the pool.</p>
        </section>
      </div>
      </div>

      <div class="rsim-stats">
        <div class="rsim-stat"><div class="rsim-stat-label">OVR BEFORE</div><div class="rsim-stat-num">${diff.ovrBefore}</div></div>
        <div class="rsim-stat"><div class="rsim-stat-label">OVR AFTER</div><div class="rsim-stat-num">${diff.ovrAfter}</div></div>
        <div class="rsim-stat"><div class="rsim-stat-label">OVR CHANGE</div><div class="rsim-stat-num ${changeCls}" id="rsimOvrChange">${this._formatSigned(diff.ovrChange)}</div></div>
      </div>

      <section class="rsim-card rsim-changes" aria-label="Changes">
        <div class="rsim-card-title">CHANGES</div>
        ${hasChanges ? `
          <div class="rsim-change-block">
            <div class="rsim-change-label">REMOVED</div>
            ${diff.removed.length ? diff.removed.map((e) => this._renderChangeLine(e, '-')).join('') : '<div class="muted rsim-change-none">None</div>'}
          </div>
          <div class="rsim-change-block">
            <div class="rsim-change-label">ADDED</div>
            ${diff.added.length ? diff.added.map((e) => this._renderChangeLine(e, '+')).join('') : '<div class="muted rsim-change-none">None</div>'}
          </div>
          <div class="rsim-change-ovr">OVR CHANGE: <strong class="${changeCls}">${this._formatSigned(diff.ovrChange)}</strong></div>
        ` : `<p class="muted rsim-nochange">No changes yet — remove, add or replace a player in AFTER to start.</p>`}
        <div class="rsim-actions-bar">
          <button type="button" class="rsim-btn" disabled aria-disabled="true" title="Transaction builder coming next" id="rsimCopyDiscord">Copy Transaction to Discord</button>
          <span class="rsim-soon muted">Transaction builder coming next</span>
          <button type="button" class="rsim-btn rsim-btn-reset" data-rsim-action="reset" id="rsimReset" ${hasChanges ? '' : 'disabled aria-disabled="true"'}>Reset Simulation</button>
        </div>
      </section>`;
  },

  _renderChangeLine(entry, sign) {
    const p = entry.player;
    const pos = entry.effectivePosition || p.position || '—';
    const signCls = sign === '+' ? 'rsim-pos' : 'rsim-neg';
    return `
      <div class="rsim-change-line">
        <span class="rsim-sign ${signCls}">${sign === '+' ? '+' : '−'}</span>
        <span class="rsim-change-name">${escapeHtml(p.name)}</span> — ${escapeHtml(pos)} — ${p.overall}
        <span class="muted rsim-change-pool">${poolLabel(p.pool)}</span>
        ${entry.isJoker || entry.classification ? classificationBadge(entry.isJoker ? 'PINK' : entry.classification) : ''}
      </div>`;
  },

  _renderTable(entries, { editable, beforeEntries, beforeIds }) {
    const rows = entries.map((e, i) => {
      const p = e.player;
      const slotLabel = e.draftSlot != null ? e.draftSlot : '—';

      if (!p) {
        if (!editable) {
          return `
            <tr class="roster-row-empty">
              <td>${slotLabel}</td>
              <td colspan="5" class="muted"><em>${e.source === 'empty' ? 'EMPTY — draft slot vacated' : '(removed)'}</em></td>
            </tr>`;
        }
        const was = beforeEntries[i] && beforeEntries[i].player;
        return `
          <tr class="rsim-row-open">
            <td>${slotLabel}</td>
            <td colspan="6">
              <div class="rsim-open">
                <em class="muted">Open slot${was ? ` — removed ${escapeHtml(was.name)}` : ''}</em>
                <button type="button" class="rsim-btn rsim-btn-primary" data-rsim-action="open-picker" data-slot="${i}">Add player</button>
              </div>
            </td>
          </tr>`;
      }

      const isNew = editable && !beforeIds.has(e.playerId);
      return `
        <tr class="${isNew ? 'rsim-row-new' : ''}">
          <td>${slotLabel}</td>
          <td>${escapeHtml(p.name)}${isNew ? ' <span class="rsim-new">NEW</span>' : ''}<span class="rsim-name-pool muted">${poolLabel(p.pool)}</span></td>
          <td class="rsim-col-pool">${poolLabel(p.pool)}</td>
          <td>${classificationBadge(e.isJoker ? 'PINK' : e.classification)}</td>
          <td class="rsim-col-pos">${escapeHtml(e.effectivePosition || p.position || '—')}${e.isJoker ? ' <span title="Joker-assigned position">🃏</span>' : ''}</td>
          <td class="ovr">${p.overall}</td>
          ${editable ? `
          <td class="rsim-actions">
            <button type="button" class="rsim-btn" data-rsim-action="open-picker" data-slot="${i}" aria-label="Replace ${escapeHtml(p.name)}" title="Replace"><span class="rsim-lbl">Replace</span><span class="rsim-ico" aria-hidden="true">⇄</span></button>
            <button type="button" class="rsim-btn rsim-btn-danger" data-rsim-action="remove" data-slot="${i}" aria-label="Remove ${escapeHtml(p.name)}" title="Remove"><span class="rsim-lbl">Remove</span><span class="rsim-ico" aria-hidden="true">✕</span></button>
          </td>` : ''}
        </tr>`;
    }).join('');

    return `
      <div class="table-scroll">
        <table class="roster-table rsim-table">
          <thead>
            <tr>
              <th><span class="rsim-h-full">Pick #</span><span class="rsim-h-short">#</span></th><th>Player</th><th class="rsim-col-pool">Pool</th><th>Color</th><th>Pos</th><th>OVR</th>${editable ? '<th><span class="rsim-sr">Actions</span></th>' : ''}
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  },

  // ── Player picker (modal) ─────────────────────────────────────────────

  _renderPicker() {
    const slot = this._after[this._picker.slotIndex];
    const replacing = slot && slot.player;
    const pools = [...new Set(this._candidates.map((c) => c.pool).filter(Boolean))];
    return `
      <div class="rsim-picker-backdrop" data-rsim-backdrop="1">
        <div class="rsim-picker" role="dialog" aria-modal="true" aria-label="${replacing ? 'Replace player' : 'Add player'}">
          <div class="rsim-picker-head">
            <div class="rsim-card-title">${replacing ? `Replace ${escapeHtml(slot.player.name)}` : 'Add a player'}</div>
            <button type="button" class="rsim-btn" data-rsim-action="close-picker" aria-label="Close">✕</button>
          </div>
          <div class="rsim-picker-controls">
            <input type="text" id="rsimPickerSearch" class="input search-input rsim-picker-search"
              placeholder="Search name or position…" value="${escapeHtml(this._picker.query)}" autocomplete="off">
            <select id="rsimPickerPool" class="all-rosters-season-picker">
              <option value="">All pools</option>
              ${pools.map((pl) => `<option value="${escapeHtml(pl)}" ${pl === this._picker.pool ? 'selected' : ''}>${poolLabel(pl)}</option>`).join('')}
            </select>
          </div>
          <div class="rsim-picker-list" id="rsimPickerList">${this._renderPickerList()}</div>
        </div>
      </div>`;
  },

  _renderPickerList() {
    const MAX = 60;
    const matches = this._filterCandidates(this._candidates, this._after, this._picker);
    if (!matches.length) return '<div class="muted rsim-picker-empty">No matching players.</div>';
    const shown = matches.slice(0, MAX);
    return shown.map((c) => `
      <button type="button" class="rsim-cand" data-rsim-action="pick-player" data-player-id="${escapeHtml(c.id)}">
        <span class="rsim-cand-name">${escapeHtml(c.name)}${c.wasOnRoster ? ' <span class="rsim-was">was on roster</span>' : ''}</span>
        <span class="rsim-cand-pos">${escapeHtml(c.position || '—')}</span>
        <span class="rsim-cand-ovr ovr">${c.overall}</span>
        <span class="rsim-cand-pool muted">${poolLabel(c.pool)}</span>
        <span class="rsim-cand-tag">${classificationBadge(c.classification)}</span>
      </button>`).join('') +
      (matches.length > MAX ? `<div class="muted rsim-picker-more">Showing the top ${MAX} of ${matches.length} — refine your search to see others.</div>` : '');
  },

  _updatePickerList() {
    const list = this._container && this._container.querySelector('#rsimPickerList');
    if (list) list.innerHTML = this._renderPickerList();
  },

  // ═══ Events ═══════════════════════════════════════════════════════════

  _rerender() {
    if (this._container) this.render(this._container);
  },

  openPicker(slotIndex) {
    if (!this._after || !this._after[slotIndex]) return false;
    this._picker = { slotIndex, query: '', pool: '' };
    this._candidates = this._buildCandidates(this._seasonId, this._currentSummary());
    this._focusPicker = true;
    return true;
  },

  closePicker() {
    this._picker = null;
  },

  _bind(container) {
    const root = container.querySelector('.rsim-view');
    if (!root) return;

    // Fresh root every render, so these listeners can never pile up.
    root.addEventListener('change', (e) => {
      const t = e.target;
      if (t.id === 'rsimManagerSelect') {
        this.selectManager(t.value);
        this._rerender();
      } else if (t.id === 'rsimPickerPool' && this._picker) {
        this._picker.pool = t.value;
        this._updatePickerList();
      }
    });

    root.addEventListener('input', (e) => {
      if (e.target.id === 'rsimPickerSearch' && this._picker) {
        this._picker.query = e.target.value;
        this._updatePickerList();
      }
    });

    root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this._picker) {
        this.closePicker();
        this._rerender();
      }
    });

    root.addEventListener('click', (e) => {
      const t = e.target;
      if (t.dataset && t.dataset.rsimBackdrop) { // click on the dim area outside the dialog
        this.closePicker();
        this._rerender();
        return;
      }
      const el = t.closest && t.closest('[data-rsim-action]');
      if (!el || el.disabled) return;
      const action = el.dataset.rsimAction;
      const slot = el.dataset.slot != null ? Number(el.dataset.slot) : null;

      if (action === 'remove') this.removeAt(slot);
      else if (action === 'open-picker') this.openPicker(slot);
      else if (action === 'close-picker') this.closePicker();
      else if (action === 'pick-player') {
        const res = this._picker
          ? this.placePlayerAt(this._picker.slotIndex, el.dataset.playerId)
          : { ok: false };
        this.closePicker();
        if (!res.ok && res.reason === 'not-available') this._notice = 'That player is no longer available.';
      } else if (action === 'reset') this.reset();
      else return;
      this._rerender();
    });
  },
};
