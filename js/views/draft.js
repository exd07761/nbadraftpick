/**
 * views/draft.js — Phase 2/3 redesign: PUBLIC, READ-ONLY Draft spectator
 * view. New route (`draft`) on the public site — see js/public-router.js.
 *
 * ── Scope guardrails (per the approved spec, §1.2 / §4 / §8 / §9 of the
 *    implementation brief) ──────────────────────────────────────────────
 * - Read-only. Never calls AdminActions.makeDraftPick / undoLastDraftPick /
 *   markDraftComplete, never writes to Firestore, never imports or
 *   duplicates admin/draft.js's write paths.
 * - Uses ONLY existing LeagueData read functions — the exact same ones
 *   admin/draft.js already calls (getCurrentSeason, getPlayerDraftOrder,
 *   getDraftState, getDraftPoolStatus, getParticipantRoster) — so this
 *   view can never disagree with the admin board about what the draft
 *   state actually is. No second draft "system", no duplicated state.
 * - Live updates arrive the same way every other public page already
 *   gets them: public-router.js's FirebaseSync.onRemoteChange() calls
 *   this view's render() again on every remote change. Nothing new is
 *   wired up here for that.
 *
 * ── Mobile layout (priority surface — spec §5) ───────────────────────────
 * Below `--nb-breakpoint-tablet` (900px, matching shell.css) this renders
 * as the "glance zone" (Tier A/B/C, always visible, no scroll/tap needed)
 * followed by a tabbed Board / Order / History area. Tier A (who's
 * picking) is the single largest, boldest element on the page —
 * deliberately larger than any player name in the list below it.
 *
 * ── Desktop layout ────────────────────────────────────────────────────
 * At ≥900px the same three panels (Order / Board / History) render
 * simultaneously as a 3-column layout instead of tabs — see
 * css/draft-public.css's `@media (min-width: 900px)` block. This file
 * renders all three panels unconditionally; CSS alone decides whether
 * they appear as tabs or columns, so there's exactly one render path for
 * both breakpoints (no separate "mobile HTML" vs "desktop HTML").
 */
const PublicDraftView = {
  _tab: 'board',            // 'board' | 'order' | 'history'  (mobile tab state only)
  _filter: '',
  _activePool: 'green',

  render(container) {
    const season = LeagueData.getCurrentSeason();
    if (!season) {
      container.innerHTML = `<div class="empty-state"><p>No season is set up yet.</p></div>`;
      return;
    }

    const draftOrder = LeagueData.getPlayerDraftOrder(season.id);
    if (!draftOrder.length) {
      container.innerHTML = `<div class="empty-state"><p>The draft order hasn't been set yet. Check back once the commissioner starts the draft.</p></div>`;
      return;
    }

    const state = LeagueData.getDraftState(season.id);
    const poolStatus = LeagueData.getDraftPoolStatus(season.id, state.currentParticipantId);

    container.innerHTML = `
      <div class="dft-view">
        ${this._renderGlanceZone(season, state)}

        <div class="dft-tabs">
          <button type="button" class="dft-tab ${this._tab === 'board' ? 'active' : ''}" data-tab="board">Available Players</button>
          <button type="button" class="dft-tab ${this._tab === 'order' ? 'active' : ''}" data-tab="order">Draft Order</button>
          <button type="button" class="dft-tab ${this._tab === 'history' ? 'active' : ''}" data-tab="history">Draft Info</button>
        </div>

        <div class="dft-panels">
          <section class="dft-panel dft-panel-order ${this._tab === 'order' ? 'active' : ''}" data-panel="order">
            ${this._renderOrderPanel(season, state, draftOrder)}
          </section>

          <section class="dft-panel dft-panel-board ${this._tab === 'board' ? 'active' : ''}" data-panel="board">
            ${this._renderBoardPanel(poolStatus)}
          </section>

          <section class="dft-panel dft-panel-history ${this._tab === 'history' ? 'active' : ''}" data-panel="history">
            ${this._renderInfoPanel(season, state, draftOrder)}
          </section>
        </div>
      </div>`;

    this._bind(container, season, state, poolStatus);
  },

  // ── Glance zone: Tier A (who's picking) / Tier B (round · pick · progress)
  // / Tier C (last pick) — spec §5.0/§5.1. Kept deliberately sparse: no
  // search, no filters, no player list share this space. ─────────────────
  _renderGlanceZone(season, state) {
    if (state.draftComplete) {
      return `
        <div class="dft-glance dft-glance-complete">
          <div class="dft-glance-complete-title">Draft Complete</div>
          <div class="dft-glance-complete-sub">${state.totalPicksMade} pick${state.totalPicksMade !== 1 ? 's' : ''} made</div>
        </div>`;
    }

    const abbr = state.currentParticipantId ? season.nbaTeamAssignments[state.currentParticipantId] : null;
    const totalExpectedPicks = state.n * MAX_ROSTER_SIZE;
    const progressPct = totalExpectedPicks ? Math.min(100, Math.round((state.totalPicksMade / totalExpectedPicks) * 100)) : 0;
    const lastPick = state.picks.length ? state.picks[state.picks.length - 1] : null;

    return `
      <div class="dft-glance">
        <div class="dft-tier-a">
          ${state.currentParticipantId ? `
            ${teamBadge(abbr, { size: 'lg' })}
            <span class="dft-tier-a-identity">
              <span class="dft-tier-a-eyebrow">On the Clock</span>
              <span class="dft-tier-a-name">${escapeHtml(state.currentParticipant?.name || 'Unknown')}</span>
            </span>
          ` : `<span class="dft-tier-a-name dft-muted">No player pool remaining</span>`}
        </div>

        <div class="dft-tier-b">
          <span class="dft-pick-chip">Round ${state.currentRound ?? '—'}</span>
          <span class="dft-pick-chip">Pick ${state.currentPickOverall ?? '—'} overall</span>
          <div class="dft-progress-wrap">
            <div class="dft-progress-numbers">
              <span class="dft-progress-label">Draft Progress</span>
              <span class="dft-progress-fraction">${state.totalPicksMade} / ${totalExpectedPicks}</span>
              <span class="dft-progress-pct">${progressPct}%</span>
            </div>
            <div class="dft-progress-track" title="${state.totalPicksMade} of ${totalExpectedPicks} picks made">
              <div class="dft-progress-fill" style="width:${progressPct}%"></div>
            </div>
          </div>
        </div>

        <div class="dft-tier-c">
          ${lastPick ? this._renderLastPick(season, lastPick) : `<span class="dft-muted">No picks made yet</span>`}
        </div>
      </div>`;
  },

  _renderLastPick(season, pick) {
    const player = LeagueData.getPlayer(pick.playerId);
    if (!player) return '';
    const participant = season.participants[pick.participantId];
    return `
      <span class="dft-lastpick-label">Just Picked</span>
      <span class="dft-lastpick-name">${escapeHtml(player.name)}</span>
      <span class="dft-lastpick-meta">${player.position || '—'} · ${player.overall ?? '—'} OVR</span>
      <span class="dft-lastpick-by">by ${escapeHtml(participant?.name || 'Unknown')}</span>`;
  },

  // ── Shared upcoming-picks calculation — same snake-order math
  // getDraftState already computes, extracted so both the Order panel
  // (full list) and the new Info panel's "Up Next" preview (short list,
  // starting one pick later) can use it without duplicating the round/
  // snake-order logic. No behavior change from the original inline
  // version in _renderOrderPanel. ─────────────────────────────────────
  _computeUpcoming(season, state, count, skip = 0) {
    const n = state.n;
    const upcoming = [];
    const total = Math.min(count, n * MAX_ROSTER_SIZE - state.totalPicksMade - skip);
    for (let i = 0; i < total; i++) {
      const idx = state.totalPicksMade + skip + i;
      const round = Math.floor(idx / n) + 1;
      const posInRound = idx % n;
      const isEvenRound = round % 2 === 0;
      const orderIndex = isEvenRound ? n - 1 - posInRound : posInRound;
      const participantId = season.playerDraftOrder[orderIndex];
      upcoming.push({ pickOverall: idx + 1, round, participant: season.participants[participantId], abbr: season.nbaTeamAssignments[participantId] });
    }
    return upcoming;
  },

  // ── Order panel: upcoming picks, computed the same snake-order way
  // getDraftState already does — display-only, never fed back into any
  // write path. ─────────────────────────────────────────────────────────
  _renderOrderPanel(season, state, draftOrder) {
    if (state.draftComplete) {
      return `<p class="dft-muted" style="padding:0.5rem 0;">Draft complete — no picks remaining.</p>`;
    }
    const upcoming = this._computeUpcoming(season, state, 12);

    return `
      <div class="dft-order-list">
        ${upcoming.map((u, i) => `
          <div class="dft-order-row ${i === 0 ? 'dft-order-row-current' : ''}">
            <span class="dft-order-pick">#${u.pickOverall}</span>
            ${teamBadge(u.abbr, { size: 'sm' })}
            <span class="dft-order-name">${escapeHtml(u.participant?.name || 'Unknown')}</span>
            <span class="dft-order-round">R${u.round}</span>
          </div>`).join('')}
      </div>`;
  },

  // ── Board panel: now shares the exact same pool-tabs + search +
  // position-column grid as the public Players page (positionPoolGrid,
  // shared-utils.js), instead of a separate flat filtered list — per
  // request, one player-pool look across the whole public site so this
  // panel isn't a second, differently-organized "player database" next
  // to the real one. Draft-in-progress status (Drafted / Variant Taken /
  // Locked tags) still comes from getDraftPoolStatus, same as before —
  // only the layout changed, not what it knows. ─────────────────────────
  _renderBoardPanel(poolStatus) {
    return `
      <div class="dft-board-controls">
        <input type="text" id="dftSearch" class="input search-input" placeholder="Search players by name or position…" value="${escapeHtml(this._filter)}">
      </div>
      <div class="pool-tabs">
        <button type="button" class="pool-tab pool-tab-green ${this._activePool === 'green' ? 'active' : ''}" data-pool="green">
          <span class="pool-dot"></span> Green Pool <span class="pool-tab-count">(Active Players)</span>
        </button>
        <button type="button" class="pool-tab pool-tab-blue ${this._activePool === 'blue' ? 'active' : ''}" data-pool="blue">
          <span class="pool-dot"></span> Blue Pool <span class="pool-tab-count">(Legends & Primes)</span>
        </button>
      </div>
      <div id="dftPlayerGrid">
        ${this._renderGrid(poolStatus)}
      </div>
      <div class="dft-board-legend">
        <span class="dft-board-legend-item"><span class="dft-board-legend-dot dft-board-legend-dot-drafted"></span>Drafted</span>
        <span class="dft-board-legend-item"><span class="dft-board-legend-dot dft-board-legend-dot-picked"></span>Just Picked</span>
      </div>`;
  },

  _renderGrid(poolStatus) {
    const q = this._filter.trim().toLowerCase();
    const entries = poolStatus
      .filter(({ player }) => player.pool === this._activePool)
      .filter(({ player }) => !q || player.name.toLowerCase().includes(q) || (player.position || '').toLowerCase().includes(q));
    return positionPoolGrid(entries, this._activePool, { mode: 'view', sortMode: 'ovr-desc' });
  },

  // ── Info panel (was "History"): the reference redesign asks for a
  // compact "Up Next" + "Recently Picked" glance area instead of a single
  // long chronological log filling this whole column. Rather than
  // replace the existing full history, this prepends the two new
  // sections in front of it — _renderHistoryPanel below is completely
  // unchanged and still shows the full pick log, just lower in this
  // same scrollable column (.dft-panel-history already has
  // max-height:70vh + overflow-y:auto on desktop — see draft-public.css)
  // instead of being removed. No data this reads isn't already computed
  // elsewhere on this page (state.picks, _computeUpcoming). ─────────────
  _renderInfoPanel(season, state, draftOrder) {
    if (state.draftComplete) {
      return this._renderHistoryPanel(season, state);
    }
    // Skip 1: the very next pick is already the page's Tier A "On the
    // Clock" + the Order panel's top row — "Up Next" previews what's
    // AFTER that, matching the reference's #69.. list (which starts one
    // past the current #68 pick).
    const upNext = this._computeUpcoming(season, state, 6, 1);
    const lastPick = state.picks.length ? state.picks[state.picks.length - 1] : null;

    return `
      ${upNext.length ? `
        <div class="dft-info-heading">Up Next</div>
        <div class="dft-order-list dft-upnext-list">
          ${upNext.map(u => `
            <div class="dft-order-row">
              <span class="dft-order-pick">#${u.pickOverall}</span>
              ${teamBadge(u.abbr, { size: 'sm' })}
              <span class="dft-order-name">${escapeHtml(u.participant?.name || 'Unknown')}</span>
              <span class="dft-order-round">R${u.round}</span>
            </div>`).join('')}
        </div>` : ''}

      ${lastPick ? `
        <div class="dft-info-heading">Recently Picked</div>
        <div class="dft-recent-pick-card">${this._renderLastPick(season, lastPick)}</div>` : ''}

      <div class="dft-info-heading">Full History</div>
      ${this._renderHistoryPanel(season, state)}`;
  },

  // ── History panel: full chronological pick log — tier-3 info per spec,
  // reads the same append-only season.playerDraftPicks log the admin
  // Draft Roster panel does. ───────────────────────────────────────────
  _renderHistoryPanel(season, state) {
    if (!state.picks.length) {
      return `<p class="dft-muted" style="padding:0.5rem 0;">No picks made yet.</p>`;
    }
    return `
      <div class="dft-history-list">
        ${state.picks.slice().reverse().map(pick => {
          const player = LeagueData.getPlayer(pick.playerId);
          const participant = season.participants[pick.participantId];
          if (!player) return '';
          return `
            <div class="dft-history-row">
              <span class="dft-history-pick">#${pick.pick}</span>
              <span class="dft-history-name">${escapeHtml(player.name)}</span>
              <span class="dft-history-meta">${player.position || '—'} · ${player.overall ?? '—'}</span>
              <span class="dft-history-by">${escapeHtml(participant?.name || 'Unknown')}</span>
            </div>`;
        }).join('')}
      </div>`;
  },

  // ── Marks the most recently picked player's row in the position grid
  // (if it's on-screen in the currently active pool) so it's visually
  // recognizable at a glance, same way the reference redesign highlights
  // a row — reuses state.picks (already computed), no new data read. ───
  _markLastPickRow(container, state) {
    const grid = container.querySelector('#dftPlayerGrid');
    if (!grid) return;
    grid.querySelectorAll('.pos-table-row.just-picked').forEach(el => el.classList.remove('just-picked'));
    const lastPick = state.picks.length ? state.picks[state.picks.length - 1] : null;
    if (!lastPick) return;
    grid.querySelector(`.pos-table-row[data-player-id="${lastPick.playerId}"]`)?.classList.add('just-picked');
  },

  _bind(container, season, state, poolStatus) {
    // Mobile tab switching (CSS ignores this on desktop — see draft-public.css)
    container.querySelectorAll('.dft-tab').forEach(tab => {
      tab.onclick = () => {
        this._tab = tab.dataset.tab;
        container.querySelectorAll('.dft-tab').forEach(t => t.classList.toggle('active', t === tab));
        container.querySelectorAll('.dft-panel').forEach(p => p.classList.toggle('active', p.dataset.panel === this._tab));
      };
    });

    const refreshGrid = () => {
      container.querySelector('#dftPlayerGrid').innerHTML = this._renderGrid(poolStatus);
      this._markLastPickRow(container, state);
    };

    container.querySelector('#dftSearch')?.addEventListener('input', e => {
      this._filter = e.target.value;
      refreshGrid();
    });

    container.querySelectorAll('.dft-panel-board .pool-tab').forEach(tab => {
      tab.onclick = () => {
        this._activePool = tab.dataset.pool;
        container.querySelectorAll('.dft-panel-board .pool-tab').forEach(t => t.classList.toggle('active', t === tab));
        refreshGrid();
      };
    });

    this._markLastPickRow(container, state);
  },
};
