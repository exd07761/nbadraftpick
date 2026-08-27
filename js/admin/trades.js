/**
 * admin/trades.js
 *
 * Phase 5 — Trading / Swap System.
 *
 * Covers: Trades, Swaps, Joker designation, Season Day control, Pot/fee
 * summary, and Transaction history — all as sub-panels of one admin view,
 * behind the auth boundary, same shell as every other admin view.
 *
 * Does NOT touch the Draft page, Team Assignment, Roster (Phase 4A), or the
 * public site. Requires season.rostersInitialized (see Rosters view) before
 * Trades/Swaps can be evaluated — Joker designation also requires it, since
 * it mutates currentRosters. The 10th-pick Blue fee is enforced inside
 * AdminActions.makeDraftPick itself (Draft page), not here.
 *
 * All reads go through LeagueData; all writes go through AdminActions
 * behind AuthBoundary.requireAuth(), same convention as every other admin
 * view.
 */
const AdminTradesView = {
  _tab: 'trade',

  // Trade builder state
  _tradeTeamA: '',
  _tradeOutA: [],
  _tradeTeamB: '',
  _tradeOutB: [],
  _tradePreview: null,

  // Swap builder state
  _swapTeam: '',
  _swapOutgoing: '',
  _swapIncomingId: '',
  _swapIsJoker: false,
  _swapJokerPosition: '',
  _swapPreview: null,

  // Joker builder state
  _jokerTeam: '',
  _jokerPlayer: '',
  _jokerPosition: '',

  render(container) {
    const season = LeagueData.getCurrentSeason();
    if (!season) {
      container.innerHTML = `<div class="empty-state"><p>No current season.</p></div>`;
      return;
    }

    if (!season.rostersInitialized) {
      container.innerHTML = `
        <div class="empty-state">
          <p>Initialize Current Rosters from the completed draft before trading or swapping.</p>
          <button class="btn btn-primary" data-action="goRoster">Go to Rosters</button>
        </div>`;
      container.querySelector('[data-action="goRoster"]').onclick = () => AdminApp.renderView('roster');
      return;
    }

    const state = LeagueData.getTransactionState(season.id);

    container.innerHTML = `
      <div class="admin-section">
        <div class="admin-section-header">
          <h2>Trades &amp; Swaps — ${escapeHtml(season.name)}</h2>
        </div>

        ${this._renderPotSummary(state)}

        <div class="trades-tabs">
          <button class="btn btn-sm ${this._tab === 'trade' ? 'btn-primary' : 'btn-ghost'}" data-tab="trade">Trade</button>
          <button class="btn btn-sm ${this._tab === 'swap' ? 'btn-primary' : 'btn-ghost'}" data-tab="swap">Swap</button>
          <button class="btn btn-sm ${this._tab === 'joker' ? 'btn-primary' : 'btn-ghost'}" data-tab="joker">Joker</button>
          <button class="btn btn-sm ${this._tab === 'history' ? 'btn-primary' : 'btn-ghost'}" data-tab="history">History</button>
          <button class="btn btn-sm ${this._tab === 'day' ? 'btn-primary' : 'btn-ghost'}" data-tab="day">Season Day</button>
        </div>

        <div id="tradesTabBody"></div>
      </div>`;

    container.querySelectorAll('[data-tab]').forEach((btn) => {
      btn.onclick = () => {
        this._tab = btn.dataset.tab;
        this.render(container);
      };
    });

    const body = container.querySelector('#tradesTabBody');
    if (this._tab === 'trade') this._renderTradeTab(body, season);
    else if (this._tab === 'swap') this._renderSwapTab(body, season);
    else if (this._tab === 'joker') this._renderJokerTab(body, season);
    else if (this._tab === 'history') this._renderHistoryTab(body, season);
    else if (this._tab === 'day') this._renderDayTab(body, season, container);
  },

  _renderPotSummary(state) {
    return `
      <div class="pot-summary-strip">
        <div><span class="pot-summary-label">Pot</span><span class="pot-summary-value">₱${state.pot}</span></div>
        <div><span class="pot-summary-label">Season Day</span><span class="pot-summary-value">${state.currentSeasonDay}</span></div>
        <div><span class="pot-summary-label">Trade fees</span><span class="pot-summary-value">${state.feeDoubled ? 'Doubled' : 'Normal'}</span></div>
        <div><span class="pot-summary-label">Transactions</span><span class="pot-summary-value">${state.transactionsLocked ? 'Closed' : 'Open'}</span></div>
      </div>`;
  },

  /**
   * @param excludeId — if set, that participant's <option> is rendered
   *   disabled (with a note) instead of omitted, so a participant already
   *   picked for the OTHER side of a trade can't also be picked for this
   *   side (e.g. Team A = Maka ⇒ Maka is disabled in the Team B list).
   *   Only passed by the Trade tab; Swap/Joker calls are unaffected.
   */
  _participantOptions(season, selectedId, excludeId) {
    const participants = LeagueData.getParticipants(season.id);
    return participants.map((p) => {
      const isExcluded = !!excludeId && p.id === excludeId;
      return `<option value="${p.id}" ${p.id === selectedId ? 'selected' : ''} ${isExcluded ? 'disabled' : ''}>${escapeHtml(p.name)}${isExcluded ? ' (already selected)' : ''}</option>`;
    }).join('');
  },

  _playerLabel(entry) {
    if (!entry.player) return '(unknown player)';
    const cls = entry.isJoker ? 'PINK' : entry.classification;
    const clsTag = cls ? ` [${cls}]` : '';
    const pos = entry.effectivePosition || entry.player.position;
    return `${entry.player.name} — ${pos}, ${entry.player.overall} OVR, ${entry.player.pool || 'unset'}${clsTag}`;
  },

  // ── TRADE TAB ────────────────────────────────────────────────────────────

  _renderTradeTab(body, season) {
    const rosterA = this._tradeTeamA ? LeagueData.getRosterForTransactions(season.id, this._tradeTeamA) : [];
    const rosterB = this._tradeTeamB ? LeagueData.getRosterForTransactions(season.id, this._tradeTeamB) : [];

    body.innerHTML = `
      <div class="card-form">
        <h3>Propose a Trade</h3>
        <div class="form-row">
          <div class="form-group">
            <label>Team A</label>
            <select class="input" id="tradeTeamASelect">
              <option value="">Select team…</option>
              ${this._participantOptions(season, this._tradeTeamA, this._tradeTeamB)}
            </select>
          </div>
          <div class="form-group">
            <label>Team B</label>
            <select class="input" id="tradeTeamBSelect">
              <option value="">Select team…</option>
              ${this._participantOptions(season, this._tradeTeamB, this._tradeTeamA)}
            </select>
          </div>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label>Team A sends</label>
            <select class="input" id="tradeOutASelect" multiple size="8" ${rosterA.length ? '' : 'disabled'}>
              ${rosterA.map((e) => `<option value="${e.playerId}" ${this._tradeOutA.includes(e.playerId) ? 'selected' : ''}>${escapeHtml(this._playerLabel(e))}</option>`).join('') || '<option disabled>Select Team A first</option>'}
            </select>
          </div>
          <div class="form-group">
            <label>Team B sends</label>
            <select class="input" id="tradeOutBSelect" multiple size="8" ${rosterB.length ? '' : 'disabled'}>
              ${rosterB.map((e) => `<option value="${e.playerId}" ${this._tradeOutB.includes(e.playerId) ? 'selected' : ''}>${escapeHtml(this._playerLabel(e))}</option>`).join('') || '<option disabled>Select Team B first</option>'}
            </select>
          </div>
        </div>
        <p class="helper-text">Hold Ctrl/Cmd to select multiple players on either side.</p>

        <button class="btn btn-ghost" id="btnPreviewTrade">Preview Trade</button>

        <div id="tradePreviewArea"></div>
      </div>`;

    body.querySelector('#tradeTeamASelect').value = this._tradeTeamA;
    body.querySelector('#tradeTeamBSelect').value = this._tradeTeamB;

    body.querySelector('#tradeTeamASelect').onchange = (e) => {
      this._tradeTeamA = e.target.value;
      this._tradeOutA = [];
      this._tradePreview = null;
      this._renderTradeTab(body, season);
    };
    body.querySelector('#tradeTeamBSelect').onchange = (e) => {
      this._tradeTeamB = e.target.value;
      this._tradeOutB = [];
      this._tradePreview = null;
      this._renderTradeTab(body, season);
    };
    body.querySelector('#tradeOutASelect').onchange = (e) => {
      this._tradeOutA = Array.from(e.target.selectedOptions).map((o) => o.value);
    };
    body.querySelector('#tradeOutBSelect').onchange = (e) => {
      this._tradeOutB = Array.from(e.target.selectedOptions).map((o) => o.value);
    };

    body.querySelector('#btnPreviewTrade').onclick = () => {
      if (!this._tradeTeamA || !this._tradeTeamB || !this._tradeOutA.length || !this._tradeOutB.length) {
        showToast('Select both teams and at least one player from each.', 'error');
        return;
      }
      if (this._tradeTeamA === this._tradeTeamB) {
        // Belt-and-suspenders: the dropdowns already disable picking the
        // same participant on both sides (see _participantOptions), and
        // evaluateTrade/commitTrade re-check this too — but catch it here
        // as well for immediate feedback instead of a generic invalid
        // preview.
        showToast('Team A and Team B must be different participants — a participant cannot trade with themselves.', 'error');
        return;
      }
      this._tradePreview = AdminActions.evaluateTrade(season.id, {
        teamA: this._tradeTeamA, playersOutA: this._tradeOutA,
        teamB: this._tradeTeamB, playersOutB: this._tradeOutB,
      });
      this._renderTradePreview(body, season);
    };

    if (this._tradePreview) this._renderTradePreview(body, season);
  },

  _renderTradePreview(body, season) {
    const preview = this._tradePreview;
    const area = body.querySelector('#tradePreviewArea');
    area.innerHTML = `
      <div class="validation-summary">
        <h4>Validation ${preview.valid ? '<span class="valid-badge">VALID</span>' : '<span class="invalid-badge">INVALID</span>'}</h4>
        <ul class="check-list">
          ${preview.checks.map((c) => `
            <li class="${c.valid ? 'check-pass' : 'check-fail'}">
              ${c.valid ? '✓' : '✕'} ${escapeHtml(c.label)}${c.reason ? ` — ${escapeHtml(c.reason)}` : ''}
            </li>`).join('')}
        </ul>
        <p class="helper-text">Fee: ₱${preview.fee}${preview.feeDoubled ? ' (doubled — Day 9-11)' : ''}</p>
        <button class="btn btn-primary" id="btnConfirmTrade" ${preview.valid ? '' : 'disabled'}>
          Confirm &amp; Commit Trade
        </button>
      </div>`;

    const btn = area.querySelector('#btnConfirmTrade');
    if (btn) {
      btn.onclick = () => {
        AuthBoundary.requireAuth();
        try {
          AdminActions.commitTrade(season.id, {
            teamA: this._tradeTeamA, playersOutA: this._tradeOutA,
            teamB: this._tradeTeamB, playersOutB: this._tradeOutB,
          });
          showToast('Trade committed.', 'success');
          this._tradeOutA = [];
          this._tradeOutB = [];
          this._tradePreview = null;
          this.render(body.closest('#adminViewContainer') || body.parentElement.parentElement);
        } catch (e) {
          showToast(e.message, 'error');
        }
      };
    }
  },

  // ── SWAP TAB ─────────────────────────────────────────────────────────────

  /**
   * UI-layer only: takes the EXISTING eligible-replacement list exactly as
   * returned by LeagueData.getSwapEligibleReplacements(seasonId, '') — no
   * change to that data-layer call or the availability rule it enforces —
   * and narrows/groups/sorts it for display:
   *
   *   existing eligible players → same position as outgoing → exclude the
   *   outgoing player itself → split by pool → sort each pool by
   *   overall DESC (name ASC tiebreak)
   *
   * Does not touch AdminActions/evaluateSwap/commitSwap in any way — this
   * only decides what the replacement list looks like before the admin
   * picks one and clicks Preview Swap, same as the old <select> did.
   */
  _buildReplacementGroups(allEligible, outgoingEntry) {
    if (!outgoingEntry || !outgoingEntry.player) {
      return { position: null, green: [], blue: [], other: [], total: 0 };
    }
    const position = outgoingEntry.player.position;
    const currentPlayerId = outgoingEntry.playerId;

    const samePosition = allEligible.filter((p) => p.position === position);
    // Belt-and-suspenders: getSwapEligibleReplacements already excludes every
    // currently-rostered player (including this one, since he's on his own
    // team's roster right now), so this filter should never actually remove
    // anyone in practice — kept explicit per the requirement so the UI is
    // still correct even if that upstream rule ever changes.
    const filtered = samePosition.filter((p) => p.id !== currentPlayerId);

    const sortByOvrThenName = (a, b) => (b.overall - a.overall) || a.name.localeCompare(b.name);
    const green = filtered.filter((p) => p.pool === 'green').sort(sortByOvrThenName);
    const blue = filtered.filter((p) => p.pool === 'blue').sort(sortByOvrThenName);
    // Players with no pool set at all are still eligible under the existing
    // rules and were still selectable in the old flat <select> — keep them
    // visible (in their own section) rather than silently dropping them.
    const other = filtered.filter((p) => p.pool !== 'green' && p.pool !== 'blue').sort(sortByOvrThenName);

    return { position, green, blue, other, total: filtered.length };
  },

  _renderReplacementRow(p) {
    const selected = p.id === this._swapIncomingId;
    return `
      <div class="swap-replacement-row ${selected ? 'is-selected' : ''}" data-select-replacement="${p.id}">
        <span class="swap-replacement-ovr">${p.overall}</span>
        <span class="swap-replacement-name">${escapeHtml(p.name)}</span>
        <span class="swap-replacement-pos">${escapeHtml(p.position)}</span>
        <button type="button" class="btn btn-sm ${selected ? 'btn-primary' : 'btn-ghost'}" data-select-replacement="${p.id}">
          ${selected ? 'SELECTED' : 'SELECT'}
        </button>
      </div>`;
  },

  _renderReplacementPoolSection(label, colorClass, players) {
    if (!players.length) return '';
    return `
      <div class="swap-pool-section">
        <div class="swap-pool-heading ${colorClass}">${label}</div>
        <div class="swap-replacement-list">
          ${players.map((p) => this._renderReplacementRow(p)).join('')}
        </div>
      </div>`;
  },

  _renderSwapTab(body, season) {
    const roster = this._swapTeam ? LeagueData.getRosterForTransactions(season.id, this._swapTeam) : [];
    const outgoingEntry = roster.find((e) => e.playerId === this._swapOutgoing);

    // Existing eligibility rule — untouched. UI-side grouping/filtering
    // happens only in _buildReplacementGroups, below.
    const allEligible = LeagueData.getSwapEligibleReplacements(season.id, '');
    const groups = this._buildReplacementGroups(allEligible, outgoingEntry);

    const currentPlayerCard = outgoingEntry && outgoingEntry.player ? `
      <div class="swap-current-block">
        <div class="swap-current-card">
          <div class="swap-current-label">Current Player</div>
          <div class="swap-current-ovr">${outgoingEntry.player.overall} OVR</div>
          <div class="swap-current-name">${escapeHtml(outgoingEntry.player.name)}</div>
          <div class="swap-current-meta">
            ${escapeHtml(outgoingEntry.player.position)} · ${(outgoingEntry.player.pool || 'unset').toUpperCase()} POOL
          </div>
        </div>
        <div class="swap-arrow">
          <span class="swap-arrow-icon">⇅</span>
          <span class="swap-arrow-label">Swap For</span>
        </div>
      </div>` : '';

    const replacementSection = !outgoingEntry ? `
      <p class="helper-text">Select an outgoing player above to see eligible replacements.</p>` : `
      <div class="swap-replacement-panel">
        <div class="swap-replacement-header">${escapeHtml(groups.position)} PLAYERS ONLY · ${groups.total} AVAILABLE</div>
        ${groups.total === 0 ? `
          <div class="swap-empty-state">
            <p class="swap-empty-title">NO AVAILABLE ${escapeHtml(groups.position)} PLAYERS</p>
            <p>There are currently no eligible ${escapeHtml(groups.position)} players available for this swap.</p>
          </div>` : `
          ${this._renderReplacementPoolSection('GREEN POOL', 'pool-heading-green', groups.green)}
          ${this._renderReplacementPoolSection('BLUE POOL', 'pool-heading-blue', groups.blue)}
          ${this._renderReplacementPoolSection('UNASSIGNED POOL', '', groups.other)}
        `}
      </div>`;

    body.innerHTML = `
      <div class="card-form">
        <h3>Propose a Swap</h3>
        <div class="form-row">
          <div class="form-group">
            <label>Team</label>
            <select class="input" id="swapTeamSelect">
              <option value="">Select team…</option>
              ${this._participantOptions(season, this._swapTeam)}
            </select>
          </div>
          <div class="form-group">
            <label>Outgoing player</label>
            <select class="input" id="swapOutgoingSelect" ${roster.length ? '' : 'disabled'}>
              <option value="">Select player…</option>
              ${roster.map((e) => `<option value="${e.playerId}" ${e.playerId === this._swapOutgoing ? 'selected' : ''}>${escapeHtml(this._playerLabel(e))}</option>`).join('')}
            </select>
          </div>
        </div>

        ${currentPlayerCard}
        ${replacementSection}

        <div class="form-row" style="margin-top: 1rem;">
          <div class="form-group">
            <label><input type="checkbox" id="swapIsJoker" ${this._swapIsJoker ? 'checked' : ''}> This is a Joker swap (₱300)</label>
            ${this._swapIsJoker ? `
              <label>Assigned position for new Joker</label>
              <select class="input" id="swapJokerPosition">
                <option value="">Select position…</option>
                ${['PG','SG','SF','PF','C'].map((p) => `<option value="${p}" ${p === this._swapJokerPosition ? 'selected' : ''}>${p}</option>`).join('')}
              </select>` : ''}
          </div>
        </div>

        <button class="btn btn-ghost" id="btnPreviewSwap">Preview Swap</button>
        <div id="swapPreviewArea"></div>
      </div>`;

    body.querySelector('#swapTeamSelect').value = this._swapTeam;
    body.querySelector('#swapTeamSelect').onchange = (e) => {
      this._swapTeam = e.target.value;
      this._swapOutgoing = '';
      this._swapIncomingId = '';
      this._swapPreview = null;
      this._renderSwapTab(body, season);
    };
    body.querySelector('#swapOutgoingSelect').onchange = (e) => {
      this._swapOutgoing = e.target.value;
      // The replacement list is position-specific, so a previously selected
      // replacement (for a different outgoing player's position) is no
      // longer valid — clear it rather than leaving a stale, invisible
      // selection behind.
      this._swapIncomingId = '';
      this._swapPreview = null;
      this._renderSwapTab(body, season);
    };
    body.querySelectorAll('[data-select-replacement]').forEach((el) => {
      el.onclick = () => {
        this._swapIncomingId = el.getAttribute('data-select-replacement');
        this._swapPreview = null;
        this._renderSwapTab(body, season);
      };
    });
    body.querySelector('#swapIsJoker').onchange = (e) => {
      this._swapIsJoker = e.target.checked;
      this._renderSwapTab(body, season);
    };
    const jokerPosSelect = body.querySelector('#swapJokerPosition');
    if (jokerPosSelect) {
      jokerPosSelect.onchange = (e) => { this._swapJokerPosition = e.target.value; };
    }

    body.querySelector('#btnPreviewSwap').onclick = () => {
      if (!this._swapTeam || !this._swapOutgoing || !this._swapIncomingId) {
        showToast('Select a team, outgoing player, and replacement.', 'error');
        return;
      }
      if (this._swapIsJoker && !this._swapJokerPosition) {
        showToast('A Joker swap needs an assigned position.', 'error');
        return;
      }
      this._swapPreview = AdminActions.evaluateSwap(season.id, {
        participantId: this._swapTeam,
        outgoingPlayerId: this._swapOutgoing,
        incomingPlayerId: this._swapIncomingId,
        isJokerSwap: this._swapIsJoker,
        jokerPosition: this._swapJokerPosition,
      });
      this._renderSwapPreview(body, season);
    };

    if (this._swapPreview) this._renderSwapPreview(body, season);
  },

  _renderSwapPreview(body, season) {
    const preview = this._swapPreview;
    const area = body.querySelector('#swapPreviewArea');
    area.innerHTML = `
      <div class="validation-summary">
        <h4>Validation ${preview.valid ? '<span class="valid-badge">VALID</span>' : '<span class="invalid-badge">INVALID</span>'}</h4>
        <ul class="check-list">
          ${preview.checks.map((c) => `
            <li class="${c.valid ? 'check-pass' : 'check-fail'}">
              ${c.valid ? '✓' : '✕'} ${escapeHtml(c.label)}${c.reason ? ` — ${escapeHtml(c.reason)}` : ''}
            </li>`).join('')}
        </ul>
        <p class="helper-text">Fee: ₱${preview.fee}</p>
        <button class="btn btn-primary" id="btnConfirmSwap" ${preview.valid ? '' : 'disabled'}>
          Confirm &amp; Commit Swap
        </button>
      </div>`;

    const btn = area.querySelector('#btnConfirmSwap');
    if (btn) {
      btn.onclick = () => {
        AuthBoundary.requireAuth();
        try {
          AdminActions.commitSwap(season.id, {
            participantId: this._swapTeam,
            outgoingPlayerId: this._swapOutgoing,
            incomingPlayerId: this._swapIncomingId,
            isJokerSwap: this._swapIsJoker,
            jokerPosition: this._swapJokerPosition,
          });
          showToast('Swap committed.', 'success');
          this._swapOutgoing = '';
          this._swapIncomingId = '';
          this._swapIsJoker = false;
          this._swapJokerPosition = '';
          this._swapPreview = null;
          this.render(body.closest('#adminViewContainer') || body.parentElement.parentElement);
        } catch (e) {
          showToast(e.message, 'error');
        }
      };
    }
  },

  // ── JOKER TAB ────────────────────────────────────────────────────────────

  _renderJokerTab(body, season) {
    const eligible = this._jokerTeam ? LeagueData.getJokerEligiblePlayers(season.id, this._jokerTeam) : [];
    const currentJoker = this._jokerTeam ? LeagueData.getJoker(season.id, this._jokerTeam) : null;

    body.innerHTML = `
      <div class="card-form">
        <h3>Designate Joker</h3>
        <p class="helper-text">
          Eligible from any of a participant's own picks #1–10.
          The Joker can be assigned any roster position, regardless of the card's natural position.
        </p>
        <div class="form-row">
          <div class="form-group">
            <label>Team</label>
            <select class="input" id="jokerTeamSelect">
              <option value="">Select team…</option>
              ${this._participantOptions(season, this._jokerTeam)}
            </select>
          </div>
          <div class="form-group">
            <label>Eligible player (picks #1-10)</label>
            <select class="input" id="jokerPlayerSelect" ${eligible.length ? '' : 'disabled'}>
              <option value="">Select player…</option>
              ${eligible.map((e) => `<option value="${e.playerId}" ${e.playerId === this._jokerPlayer ? 'selected' : ''}>${escapeHtml(e.player.name)} — pick #${e.ownPickNumber}, ${e.player.position}, ${e.player.overall} OVR</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="form-group">
          <label>Assigned position</label>
          <select class="input" id="jokerPositionSelect" style="max-width:160px">
            <option value="">Select position…</option>
            ${['PG','SG','SF','PF','C'].map((p) => `<option value="${p}" ${p === this._jokerPosition ? 'selected' : ''}>${p}</option>`).join('')}
          </select>
        </div>
        ${currentJoker ? `<p class="helper-text">Current Joker: ${escapeHtml(currentJoker.player?.name || '')} (${currentJoker.jokerPosition})</p>` : ''}
        <p id="jokerError" class="error-text"></p>
        <button class="btn btn-primary" id="btnDesignateJoker">Designate Joker</button>
      </div>`;

    body.querySelector('#jokerTeamSelect').value = this._jokerTeam;
    body.querySelector('#jokerTeamSelect').onchange = (e) => {
      this._jokerTeam = e.target.value;
      this._jokerPlayer = '';
      this._renderJokerTab(body, season);
    };
    body.querySelector('#jokerPlayerSelect').onchange = (e) => { this._jokerPlayer = e.target.value; };
    body.querySelector('#jokerPositionSelect').onchange = (e) => { this._jokerPosition = e.target.value; };

    body.querySelector('#btnDesignateJoker').onclick = () => {
      AuthBoundary.requireAuth();
      const errEl = body.querySelector('#jokerError');
      if (!this._jokerTeam || !this._jokerPlayer || !this._jokerPosition) {
        errEl.textContent = 'Select a team, an eligible player, and a position.';
        return;
      }
      try {
        AdminActions.designateJoker(season.id, this._jokerTeam, this._jokerPlayer, this._jokerPosition);
        showToast('Joker designated.', 'success');
        this._jokerPlayer = '';
        this._jokerPosition = '';
        this.render(body.closest('#adminViewContainer') || body.parentElement.parentElement);
      } catch (e) {
        errEl.textContent = e.message;
      }
    };
  },

  // ── HISTORY TAB ──────────────────────────────────────────────────────────

  _renderHistoryTab(body, season) {
    const history = LeagueData.getTransactionHistory(season.id);
    const participants = LeagueData.getParticipants(season.id);
    const nameOf = (id) => participants.find((p) => p.id === id)?.name || '—';

    body.innerHTML = `
      <div class="admin-section" style="padding:0;border:none;background:none">
        ${!history.length ? '<div class="empty-state"><p>No transactions recorded yet.</p></div>' : `
        <div class="table-scroll">
        <table class="admin-table">
          <thead>
            <tr>
              <th>Day</th><th>Type</th><th>Team(s)</th><th>Out</th><th>In</th><th>Fee</th><th>Timestamp</th>
            </tr>
          </thead>
          <tbody>
            ${history.map((t) => `
              <tr>
                <td>${t.seasonDay}</td>
                <td>${escapeHtml(t.type)}</td>
                <td>${escapeHtml(nameOf(t.teamA))}${t.teamB ? ' ↔ ' + escapeHtml(nameOf(t.teamB)) : ''}</td>
                <td>${t.playersOut.map((p) => escapeHtml(p.name || '')).join(', ') || '—'}</td>
                <td>${t.playersIn.map((p) => escapeHtml(p.name || '')).join(', ') || '—'}</td>
                <td>₱${t.fee ?? t.amount ?? 0}${t.feeDoubled ? ' (2x)' : ''}</td>
                <td>${new Date(t.timestamp).toLocaleString()}</td>
              </tr>`).join('')}
          </tbody>
        </table>
        </div>`}
      </div>`;
  },

  // ── SEASON DAY TAB ───────────────────────────────────────────────────────

  _renderDayTab(body, season, container) {
    body.innerHTML = `
      <div class="card-form">
        <h3>Season Day</h3>
        <p class="helper-text">
          Manually set by the commissioner — never derived from the calendar. Days 9-11 double trade fees
          (never swap fees). Days 12-13 close all trades and swaps.
        </p>
        <div class="form-row">
          <div class="form-group">
            <label for="seasonDayInput">Current Day</label>
            <input type="number" id="seasonDayInput" class="input" min="1" value="${season.currentSeasonDay ?? 1}" style="width:120px">
          </div>
          <div class="form-group" style="align-self:flex-end">
            <button class="btn btn-primary" id="btnSaveDay">Update Day</button>
          </div>
        </div>
        <p id="dayError" class="error-text"></p>
      </div>`;

    body.querySelector('#btnSaveDay').onclick = () => {
      AuthBoundary.requireAuth();
      const errEl = body.querySelector('#dayError');
      try {
        AdminActions.setSeasonDay(season.id, body.querySelector('#seasonDayInput').value);
        showToast('Season Day updated.', 'success');
        this.render(container);
      } catch (e) {
        errEl.textContent = e.message;
      }
    };
  },
};
