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

  _participantOptions(season, selectedId) {
    const participants = LeagueData.getParticipants(season.id);
    return participants.map(
      (p) => `<option value="${p.id}" ${p.id === selectedId ? 'selected' : ''}>${escapeHtml(p.name)}</option>`
    ).join('');
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
              ${this._participantOptions(season, this._tradeTeamA)}
            </select>
          </div>
          <div class="form-group">
            <label>Team B</label>
            <select class="input" id="tradeTeamBSelect">
              <option value="">Select team…</option>
              ${this._participantOptions(season, this._tradeTeamB)}
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

  _renderSwapTab(body, season) {
    const roster = this._swapTeam ? LeagueData.getRosterForTransactions(season.id, this._swapTeam) : [];
    const outgoingEntry = roster.find((e) => e.playerId === this._swapOutgoing);
    const pool = outgoingEntry?.player?.pool || '';
    const replacements = LeagueData.getSwapEligibleReplacements(season.id, '');

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

        <div class="form-row">
          <div class="form-group">
            <label>Replacement (free agent)</label>
            <select class="input" id="swapIncomingSelect">
              <option value="">Select replacement…</option>
              ${replacements.map((p) => `<option value="${p.id}" ${p.id === this._swapIncomingId ? 'selected' : ''}>${escapeHtml(p.name)} — ${p.position}, ${p.overall} OVR, ${p.pool || 'unset'}</option>`).join('')}
            </select>
          </div>
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
      this._swapPreview = null;
      this._renderSwapTab(body, season);
    };
    body.querySelector('#swapOutgoingSelect').onchange = (e) => {
      this._swapOutgoing = e.target.value;
      this._swapPreview = null;
    };
    body.querySelector('#swapIncomingSelect').onchange = (e) => {
      this._swapIncomingId = e.target.value;
      this._swapPreview = null;
    };
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
          Eligible only from a participant's own picks #6–10, after they've completed their first 5 picks.
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
            <label>Eligible player (picks #6-10)</label>
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
                <td>₱${t.fee}${t.feeDoubled ? ' (2x)' : ''}</td>
                <td>${new Date(t.timestamp).toLocaleString()}</td>
              </tr>`).join('')}
          </tbody>
        </table>`}
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
