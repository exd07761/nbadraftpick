/**
 * views/hall-of-fame.js — Public Hall of Fame view.
 *
 * PUBLIC-ONLY, read-only, static historical archive of past NBA2K league
 * champions. Renders entirely from HallOfFameData (js/hall-of-fame-data.js)
 * — a plain in-memory array, not LeagueData. This view:
 *   - makes NO Supabase queries
 *   - makes NO Firestore/Firebase queries
 *   - makes NO RPC calls
 *   - does not read participant_id / player_id / current roster / draft data
 *
 * Each championship entry shows roster slots 1–5 by default; slots 6–10
 * are collapsed behind a per-entry "Show players 6–10" toggle. Expand
 * state is tracked per entry (keyed by array index) in view-local state,
 * the same pattern PublicRosterView uses for `_selectedSeasonId` — so
 * expanding one championship never affects any other, and state simply
 * resets (all collapsed) on navigating away and back, same as any other
 * view here.
 */
const HallOfFameView = {
  // Set of entry indices currently showing players 6–10. Plain view-local
  // UI state — nothing here is persisted or written anywhere.
  _expanded: new Set(),

  render(container) {
    const entries = (typeof HallOfFameData !== 'undefined' && Array.isArray(HallOfFameData))
      ? HallOfFameData
      : [];

    if (!entries.length) {
      container.innerHTML = `
        <div class="hof-view" style="max-width:none;">
          <h2 class="section-title">Hall of Fame</h2>
          <div class="empty-state">
            <div class="empty-icon">🏆</div>
            <h2>Hall of Fame</h2>
            <p>Champions will appear here once the archive is added.</p>
          </div>
        </div>`;
      return;
    }

    container.innerHTML = `
      <div class="hof-view" style="max-width:none;">
        <h2 class="section-title">Hall of Fame</h2>
        <div class="hof-list">
          ${entries.map((entry, i) => this._renderEntry(entry, i)).join('')}
        </div>
      </div>`;

    this._bindToggles(container, entries);
  },

  _renderEntry(entry, index) {
    const expanded = this._expanded.has(index);
    const roster = Array.isArray(entry.roster) ? entry.roster : [];
    const topFive = roster.filter(p => p.slot <= 5);
    const restFive = roster.filter(p => p.slot > 5);

    return `
      <div class="hof-card">
        <div class="hof-card-head">
          <span class="hof-season">${escapeHtml(entry.season || '')}</span>
          <span class="hof-champion">${escapeHtml(entry.champion || '')}</span>
          <span class="hof-champion-badge">CHAMPION</span>
        </div>

        <div class="hof-roster">
          ${topFive.map(p => this._renderRow(p)).join('')}
        </div>

        ${restFive.length ? `
        <div class="hof-roster hof-roster-extra" ${expanded ? '' : 'hidden'}>
          ${restFive.map(p => this._renderRow(p)).join('')}
        </div>
        <button type="button" class="hof-toggle-btn" data-hof-index="${index}" aria-expanded="${expanded}">
          ${expanded ? '▲ HIDE PLAYERS 6–10' : '▼ SHOW PLAYERS 6–10'}
        </button>` : ''}
      </div>`;
  },

  _renderRow(p) {
    return `
      <div class="hof-row">
        <span class="hof-row-slot">${escapeHtml(String(p.slot))}</span>
        <span class="hof-row-player">${escapeHtml(p.player || '')}</span>
        <span class="hof-row-pos">${escapeHtml(p.position || '')}</span>
        <span class="hof-row-ovr">${escapeHtml(String(p.ovr ?? ''))}</span>
      </div>`;
  },

  _bindToggles(container, entries) {
    container.querySelectorAll('.hof-toggle-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const index = Number(btn.dataset.hofIndex);
        if (this._expanded.has(index)) {
          this._expanded.delete(index);
        } else {
          this._expanded.add(index);
        }
        this.render(container);
      });
    });
  },
};
