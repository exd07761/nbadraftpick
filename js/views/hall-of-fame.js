/**
 * views/hall-of-fame.js — Public Hall of Fame view.
 *
 * PUBLIC-ONLY, read-only historical archive of past NBA2K league
 * champions, loaded from Supabase (`public.hall_of_fame`) via the same
 * plain-SELECT read pattern js/admin/hall-of-fame.js already uses
 * (SupabaseQuery.select('hall_of_fame', ...)) — table-level SELECT is
 * already open to anon/authenticated (Phase 6.11), so no read RPC is
 * needed and none is used here. This view:
 *   - makes ONE read: SupabaseQuery.select('hall_of_fame', ...)
 *   - makes NO write calls, NO RPC calls
 *   - does not read participant_id / player_id / current roster / draft
 *     data — a Hall of Fame roster row is exactly {slot, player,
 *     position, ovr}, free-text historical values, never a foreign key
 *
 * The router (js/public-router.js) calls `view.render(container)`
 * without awaiting it, so `render()` stays synchronous: it paints a
 * loading state immediately, then `_loadAndRenderEntries()` (async)
 * fetches from Supabase and repaints once the data resolves — the same
 * two-step shape js/admin/hall-of-fame.js's render()/_loadAndRenderList()
 * already uses.
 *
 * Each championship entry shows roster slots 1–5 by default; slots 6–10
 * are collapsed behind a per-entry "Show players 6–10" toggle. Expand
 * state is tracked per entry (keyed by array index) in view-local state,
 * the same pattern PublicRosterView uses for `_selectedSeasonId` — so
 * expanding one championship never affects any other, and state simply
 * resets (all collapsed) on navigating away and back, same as any other
 * view here.
 *
 * NOTE: js/hall-of-fame-data.js (the static placeholder array) is no
 * longer read by this view. It has intentionally been left in place
 * (not deleted) per current instructions; nothing here references it.
 */
const HallOfFameView = {
  // Set of entry indices currently showing players 6–10. Plain view-local
  // UI state — nothing here is persisted or written anywhere.
  _expanded: new Set(),

  render(container) {
    container.innerHTML = `
      <div class="hof-view" style="max-width:none;">
        <h2 class="section-title">Hall of Fame</h2>
        <div id="hofPublicMount"><p class="helper-text">Loading…</p></div>
      </div>`;

    this._expanded = new Set();
    this._loadAndRenderEntries(container);
  },

  async _loadAndRenderEntries(container) {
    const mount = container.querySelector('#hofPublicMount');
    if (!mount) return; // view navigated away before the read resolved

    let rows;
    try {
      rows = await SupabaseQuery.select('hall_of_fame', (qb) =>
        qb.order('created_at', { ascending: true })
      );
    } catch (e) {
      mount.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">🏆</div>
          <h2>Hall of Fame</h2>
          <p>Champions will appear here once the archive is added.</p>
        </div>`;
      return;
    }

    const entries = Array.isArray(rows)
      ? rows.map((row) => ({
          season: row.season_name,
          champion: row.champion_name,
          roster: row.roster,
        }))
      : [];

    if (!entries.length) {
      mount.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">🏆</div>
          <h2>Hall of Fame</h2>
          <p>Champions will appear here once the archive is added.</p>
        </div>`;
      return;
    }

    mount.innerHTML = `
      <div class="hof-list">
        ${entries.map((entry, i) => this._renderEntry(entry, i)).join('')}
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
        // Re-render from the same already-fetched `entries` — no need to
        // hit Supabase again just to toggle a collapse state.
        const mount = container.querySelector('#hofPublicMount');
        if (!mount) return;
        mount.innerHTML = `
          <div class="hof-list">
            ${entries.map((entry, i) => this._renderEntry(entry, i)).join('')}
          </div>`;
        this._bindToggles(container, entries);
      });
    });
  },
};
