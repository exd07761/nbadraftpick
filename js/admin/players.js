/**
 * admin/players.js — Players page (Phase 4: NBA 2K27 Pool only)
 *
 * Phase 4 — "Make Players 2K27-only": the Historical / Legacy Players
 * section (Add Player, CSV Import, per-record Edit/Delete, Delete All,
 * the All/Active/Archived edition filter, and the Green/Blue rating-tier
 * browse grid — everything introduced across the earlier "Audit Phase 2"
 * and "Duplicate-2K27-copies fix" work) has been intentionally REMOVED
 * from this page. This is a UI-only change:
 *   - No `league/main.players` record was deleted, migrated, archived,
 *     or rewritten. That data is completely untouched in Firestore.
 *   - `isLegacyEditionPlayer()`, the dedup logic, `getAllPlayers()`,
 *     `getAvailablePlayers()`, `getDraftPoolStatus()`,
 *     `getSwapEligibleReplacements()`, historical roster rendering
 *     (js/views/roster.js), and every draft/roster/trade/swap code path
 *     in js/data.js are all unaffected — none of them are called from
 *     here in a way anything else depended on, and none of them are
 *     touched by this rewrite.
 *   - The admin UI simply no longer offers a way to browse/add/import/
 *     edit/delete `league/main.players` records directly. If that
 *     capability is needed again later, it would need to be reintroduced
 *     deliberately — see the Phase 4 audit for what was removed and why
 *     removing it doesn't affect anything else.
 *
 * This page is now ONLY a mount point for the existing, unmodified
 * Nba2k27PoolView (js/admin/nba2k-database.js) — see _mountNba2k27Pool()
 * below. No new Firestore reads are introduced by this file: the one-time
 * nba2k27_pool/nba2k_players load already happens inside
 * Nba2k27PoolView.render() itself (via Nba2kDatabaseView._ensureLoaded()),
 * exactly as it did before this change and exactly as it does on the
 * standalone "NBA 2K27 Pool" nav item, which remains untouched and
 * reachable on its own.
 */

/**
 * ⚠ SECURITY NOTE — restored (bug fix; original value unchanged).
 *
 * This constant no longer guards anything in this file — the "Delete All
 * Players" feature it originally protected was removed above in Phase 4.
 * It is kept here, at its original value, solely because
 * js/admin/roster.js's Manual Roster Edit PIN step reuses it via shared
 * global script scope (admin.html loads this file before
 * js/admin/roster.js — see that file's own note on this same constant)
 * rather than defining a second PIN. Removing this line breaks Manual
 * Roster Edit's PIN verification with an uncaught ReferenceError, which
 * is exactly what happened when Phase 4 deleted it without updating
 * roster.js's dependency on it.
 *
 * Same caveat as everywhere else this pattern is used: a plain frontend
 * constant, trivially readable in dev tools, not a real security
 * boundary — the actual write gate remains Firebase Auth + firestore.rules
 * (AuthBoundary.requireAuth(), already required before this PIN step ever
 * appears).
 */
const _DELETE_ALL_PLAYERS_PIN = '7761';

const AdminPlayersView = {
  render(container) {
    container.innerHTML = `
      <div class="admin-section">
        <div class="admin-section-header">
          <h2>Players</h2>
        </div>

        <!-- NBA 2K27 Pool management, delegated to the EXISTING
             Nba2k27PoolView (js/admin/nba2k-database.js) — full render
             delegation, not a reimplementation. This mount div is the
             ONLY thing this file adds; everything inside it
             (Initialize/Validate/pool tabs/search/sort/grid, the
             #nba2k27mgmtEdit/#nba2k27mgmtConfirm mount points
             _openManualEdit()/_showRemoveConfirm() require, and the
             #nba2kDetailMount the shared detail modal needs) is created
             by Nba2k27PoolView._renderShell() itself, unmodified — see
             _mountNba2k27Pool() below. -->
        <div class="players-nba2k27-primary" id="playersNba2k27PoolMount"></div>
      </div>`;

    this._mountNba2k27Pool(container);
  },

  /**
   * Mounts the EXISTING Nba2k27PoolView unmodified into this page's own
   * `#playersNba2k27PoolMount` div. This is a full render delegation, not
   * a reimplementation: `_openManualEdit()`, `_showRemoveConfirm()`,
   * `_renderVariantGroupMembers()`, Initialize Pool, and Validate Pool
   * all run exactly as they already do on the standalone "NBA 2K27 Pool"
   * admin page, because this literally IS that same view object,
   * rendering into a div that happens to live inside Players' own
   * template instead of its own dedicated page. Nba2k27PoolView itself
   * is completely unmodified by this — see that file; nothing there
   * changed. No direct Firestore query of any kind (league/main.players,
   * nba2k_players, or nba2k27_pool) exists in this file — the read that
   * populates this section happens entirely inside Nba2k27PoolView.render()
   * itself, same as it always has.
   *
   * Not awaited, on purpose: `Nba2k27PoolView.render()` is `async` (it
   * calls `Nba2kDatabaseView._ensureLoaded()` internally the first time
   * any 2K27 admin view is opened this session, then resolves) — but
   * `AdminApp.renderView()` (js/admin.js) already calls every view's
   * `render()` the same fire-and-forget way when the standalone Pool
   * page is opened directly, so this matches that existing convention
   * exactly rather than inventing a new one.
   */
  _mountNba2k27Pool(container) {
    const mount = container.querySelector('#playersNba2k27PoolMount');
    if (!mount) return;
    // Defensive only — in the real app (admin.html) js/admin/nba2k-database.js
    // is always loaded alongside this file, so Nba2k27PoolView always
    // exists by the time render() actually runs (script tags load before
    // AdminApp ever calls a view's render()). This guard just keeps a
    // narrower test harness or an out-of-order load from throwing instead
    // of degrading to "no 2K27 pool section this render" — it never skips
    // real functionality in production.
    if (typeof Nba2k27PoolView === 'undefined') return;
    Nba2k27PoolView.render(mount);
  },
};
