/**
 * nba2k27-position-sort.js
 *
 * NBA 2K27 Position Sorting Mode — a fast, one-position-at-a-time
 * workstation for manually assigning a single canonical draft position
 * (PG/SG/SF/PF/C/UNASSIGNED) to NBA 2K27 players.
 *
 * FIREBASE-ONLY, NOT PART OF THE SUPABASE MIGRATION.
 * This view reads/writes Firestore directly (firebase.firestore()),
 * exactly like Nba2kDatabaseView/Nba2k27PoolView in the same admin
 * suite. Nothing in js/data.js, the Supabase read layer, or any RPC is
 * touched by this file.
 *
 * ── 2K27 POOL ⇄ POSITION UNIFICATION (supersedes the original design) ───
 * This file originally wrote a curated position to its own sibling
 * collection, `nba2k27_positions/<slug>`, deliberately kept separate
 * from `nba2k27_pool` (see git history for the full original rationale
 * — the short version: nba2k-import.js's commit path does a full
 * `{ merge: false }` overwrite of `nba2k_players` on every re-import,
 * so nothing curated could safely live on THAT document, and
 * `nba2k27_pool` had no `position` field yet at the time).
 *
 * `nba2k27_pool/<slug>` now carries a `position` field alongside its
 * existing `pool`/`nba2kRef`/`selectedAt` (see NBA2K27_POOL_POSITION_
 * VALUES / nba2k27PoolPositionOf() in nba2k-database.js, loaded before
 * this file — same admin.html script order Nba2k27PoolView already
 * relies on). This file has been repointed to read and write THAT
 * field instead:
 *   - It no longer writes to `nba2k27_positions` at all.
 *   - `_ensureLoaded()` now loads `nba2k27_pool` (not `nba2k27_positions`)
 *     as its second collection.
 *   - `_assign()` writes via `.set(doc, { merge: true })` on
 *     `nba2k27_pool/<slug>`, touching ONLY `position`/`updatedAt` when a
 *     doc already exists (the normal case once "Initialize 2K27 Pool"
 *     has been run for every player) — merge is structurally incapable
 *     of overwriting `nba2kRef`/`pool`/`selectedAt` when they aren't in
 *     the payload. If a player somehow has no `nba2k27_pool` doc yet
 *     (added after the last Initialize run), a full doc is created —
 *     this is a create, not an overwrite, so nothing pre-existing is
 *     ever at risk either way.
 *   - Pool is NEVER chosen here — it is always re-derived from the
 *     player's own `teamType` via `nba2k27PoolForTeamType()`, exactly
 *     like every other 2K27 pool write in this admin suite. The only
 *     manual classification this file ever performs is position.
 *   - 'UNASSIGNED' is now a real, explicitly assignable value (via the
 *     UNASSIGNED button or the U key) — not just "no doc yet". This
 *     lets an assignment be explicitly reverted, which the original
 *     collection-per-field design had no way to express.
 *
 * `nba2k27_positions` (the old collection) is legacy/transitional only
 * as of this change — see `scripts/migrate-nba2k27-positions.js` for
 * the one-time backfill of any positions curated there before this
 * repoint, into `nba2k27_pool.position`. It is not deleted or written
 * to by this file anymore, and its Firestore rule (if one exists) is
 * left alone until the collection is retired in a later cleanup.
 *
 * ── 2K26 HISTORICAL SAFETY ───────────────────────────────────────────────
 * This file never reads or writes `seasons`, `participants`,
 * `players` (the fantasy draft pool), `league/main`, or anything scoped
 * by season_id. It only touches `nba2k_players` (read-only) and
 * `nba2k27_pool` (read/write). No 2K26 roster or history is reachable
 * from any code path in this file.
 *
 * ── UNTESTABLE-AGAINST-LIVE-FIREBASE LIMITATION (disclosed up front) ────
 * Unlike the Supabase work in this project, there is no tool access to
 * a real Firestore project from this environment at all (no credentials,
 * no network route, no query console). Every Firestore call below was
 * written to match the exact conventions already proven in
 * Nba2kDatabaseView/Nba2k27PoolView in this same codebase, and is
 * covered by tests_p12/ (vm-sandboxed fake Firestore, same harness
 * pattern as tests_p7–p11), but has not been run against a live
 * Firestore database. A real smoke test in your own Firebase project is
 * required before trusting this in production.
 */

// The five real, assignable draft positions — 'UNASSIGNED' is also a
// valid, explicitly-storable value (see nba2k27PoolPositionValid() in
// nba2k-database.js) but is deliberately NOT in this list: it is
// rendered as its own distinct button everywhere this list drives the
// UI, never folded into "just another position" in the button row.
const NBA2K27_SORT_POSITIONS = ['PG', 'SG', 'SF', 'PF', 'C'];

const Nba2k27PositionSortView = {
  _players: null, // [{id, ...nba2k_players fields}] — same shape as Nba2kDatabaseView._players
  _curated: null, // { [slug]: { nba2kRef, pool, position, selectedAt, updatedAt } } — from nba2k27_pool
  _loadPromise: null,
  _loadError: null,

  _activePosition: 'PG',
  _queue: [], // slugs of UNASSIGNED players matching the active position + filters, in display order
  _cursor: 0, // index into _queue of the player currently on screen

  _search: '',
  _filterCategory: '', // '' = All, else 'curr' | 'class' | 'allt' (same vocabulary as Nba2kDatabaseView)
  _filterTeam: '',
  _filterOvr: '', // same convention as Nba2kDatabaseView._filterOvr — a NBA2K_OVERALL_FILTERS value

  _keydownHandler: null,

  render(container) {
    if (this._players) {
      this._renderShell(container);
    } else {
      container.innerHTML = `
        <div class="admin-section">
          <div class="admin-section-header"><h2>NBA 2K27 Position Sorting</h2></div>
          <p class="backup-muted">Loading NBA 2K27 players…</p>
        </div>`;
      this._load(container);
    }
  },

  _ensureLoaded() {
    if (this._players) return Promise.resolve();
    if (!this._loadPromise) {
      this._loadPromise = Promise.all([
        firebase.firestore().collection('nba2k_players').get(),
        firebase.firestore().collection('nba2k27_pool').get(),
      ])
        .then(([playersSnap, poolSnap]) => {
          this._players = playersSnap.docs.map(d => ({ id: d.id, ...d.data() }));
          this._curated = {};
          poolSnap.docs.forEach(d => { this._curated[d.id] = d.data(); });
          this._loadError = null;
        })
        .catch(err => {
          this._players = null;
          this._curated = null;
          this._loadError = err && err.code === 'permission-denied'
            ? "You don't have permission to access the NBA 2K27 database."
            : 'Unable to load the NBA 2K27 database.';
        })
        .finally(() => { this._loadPromise = null; });
    }
    return this._loadPromise;
  },

  async _load(container) {
    await this._ensureLoaded();
    if (document.body.contains(container)) {
      this._rebuildQueue();
      this._renderShell(container);
    }
  },

  // Single defensive read-through for "what position is this player at
  // right now" — a player with no nba2k27_pool doc yet (e.g. added after
  // the last "Initialize 2K27 Pool" run) reads exactly the same as one
  // whose doc explicitly holds 'UNASSIGNED'. Never read `this._curated
  // [slug].position` directly anywhere else in this file — always go
  // through this so the two cases can never silently diverge.
  _positionOf(slug) {
    return nba2k27PoolPositionOf(this._curated[slug]);
  },

  // Read-only, locked display of which pool this player's teamType maps
  // to — NEVER a manual choice anywhere in this file (see file header,
  // "Pool is NEVER chosen here").
  _poolOf(player) {
    return nba2k27PoolForTeamType(player.teamType);
  },

  // ── Queue construction: every player currently UNASSIGNED (per
  // _positionOf), matching the active position's natural-eligibility
  // hint (if positions data exists) plus category/team/overall/search
  // filters. A player with no source `positions` data at all is still
  // included (never silently hidden) — the active position button is
  // simply a starting filter to help you find likely candidates faster,
  // not a hard eligibility gate, since the whole point of this workflow
  // is YOU are the authority on the real position, not the imported
  // data. ─────────────────────────────────────────────────────────────
  _rebuildQueue(preserveCursorSlug) {
    const players = this._players || [];
    const term = this._search.trim().toLowerCase();

    this._queue = players
      .filter(p => this._positionOf(p.id) === 'UNASSIGNED') // unassigned only
      .filter(p => !this._filterCategory || p.teamType === this._filterCategory)
      .filter(p => !this._filterTeam || p.team === this._filterTeam)
      .filter(p => !this._filterOvr || this._matchesOverallFilter(p.overall, this._filterOvr))
      .filter(p => !term || (p.name || '').toLowerCase().includes(term))
      .sort((a, b) => (b.overall || 0) - (a.overall || 0))
      .map(p => p.id);

    if (preserveCursorSlug) {
      const idx = this._queue.indexOf(preserveCursorSlug);
      this._cursor = idx >= 0 ? idx : 0;
    } else {
      this._cursor = 0;
    }
  },

  _matchesOverallFilter(overall, filterValue) {
    // Matches Nba2kDatabaseView's own convention exactly (see
    // _getVisiblePlayers in nba2k-database.js): NBA2K_OVERALL_FILTERS'
    // `value` is a minimum-OVR threshold string (e.g. '90' means "90+"),
    // not a range and not an object with its own test() method.
    if (!filterValue) return true;
    const minOvr = Number(filterValue);
    return typeof overall === 'number' && overall >= minOvr;
  },

  _currentPlayer() {
    const slug = this._queue[this._cursor];
    return slug ? (this._players || []).find(p => p.id === slug) : null;
  },

  // ── Assignment: one Firestore write, no confirmation, then auto-advance
  // (except for UNASSIGNED, which stays in the queue — see below).
  async _assign(position) {
    const player = this._currentPlayer();
    if (!player) return;
    if (!nba2k27PoolPositionValid(position)) return;

    const now = new Date().toISOString();
    const existing = this._curated[player.id];
    // Merge-only write. When a nba2k27_pool doc already exists (the
    // normal case once "Initialize 2K27 Pool" has been run for every
    // player), this payload contains ONLY `position`/`updatedAt` — it is
    // structurally incapable of overwriting `nba2kRef`/`pool`/
    // `selectedAt`/anything else, because they are simply never included.
    // If no doc exists yet (e.g. this player was added to nba2k_players
    // after the last Initialize run), a full doc is created instead —
    // that's a create, not an overwrite, so nothing pre-existing is ever
    // at risk either way. Pool is always freshly re-derived from
    // teamType here, never carried over as a stale value and never a
    // manual choice.
    const payload = existing
      ? { position, updatedAt: now }
      : { nba2kRef: player.id, pool: this._poolOf(player), selectedAt: now, position, updatedAt: now };

    try {
      AuthBoundary.requireAuth(); // throws if not authenticated — matches every other write in this admin suite
      await firebase.firestore().collection('nba2k27_pool').doc(player.id).set(payload, { merge: true });
      this._curated[player.id] = { ...(existing || {}), ...payload };

      if (position === 'UNASSIGNED') {
        // Explicitly confirmed/reverted to UNASSIGNED — this player
        // stays in the queue (it's still exactly where it belongs).
      } else {
        // Remove from queue and stay on the same index (the next player
        // slides into this slot) — this IS the auto-advance ("Shai
        // leaves the UNASSIGNED queue").
        this._queue.splice(this._cursor, 1);
        if (this._cursor >= this._queue.length) this._cursor = Math.max(0, this._queue.length - 1);
      }
      this._renderShell(this._container);
    } catch (err) {
      this._flashError(
        err && err.code === 'permission-denied'
          ? "You don't have permission to save this."
          : (err && err.message === 'UNAUTHORIZED: Admin authentication required.'
              ? 'Please sign in again to continue.'
              : 'Could not save this assignment — please try again.')
      );
    }
  },

  _flashError(message) {
    const el = this._container && this._container.querySelector('#p27sortError');
    if (!el) return;
    el.textContent = message;
    el.style.display = '';
    setTimeout(() => { el.style.display = 'none'; }, 4000);
  },

  _prev() {
    if (this._cursor > 0) { this._cursor -= 1; this._renderShell(this._container); }
  },
  _next() {
    if (this._cursor < this._queue.length - 1) { this._cursor += 1; this._renderShell(this._container); }
  },

  _setActivePosition(pos) {
    this._activePosition = pos;
    this._rebuildQueue();
    this._renderShell(this._container);
  },

  _remainingCounts() {
    const players = this._players || [];
    let unassigned = 0;
    players.forEach(p => {
      if (this._positionOf(p.id) !== 'UNASSIGNED') return;
      unassigned += 1;
    });
    // Per-position remaining count = same "unassigned" pool, since the
    // active-position filter is a starting hint, not a hard partition
    // (see _rebuildQueue comment) — every unassigned player could in
    // principle be assigned to any position. Showing the single
    // unassigned total once, plus the active queue's own length, is
    // clearer than five duplicate counts of the same underlying pool.
    return { unassigned, activeQueueLength: this._queue.length };
  },

  _renderShell(container) {
    this._container = container;

    if (this._loadError) {
      container.innerHTML = `
        <div class="admin-section">
          <div class="admin-section-header"><h2>NBA 2K27 Position Sorting</h2></div>
          <div class="backup-result backup-result-error">${escapeHtml(this._loadError)}</div>
        </div>`;
      return;
    }

    const players = this._players || [];
    const teams = [...new Set(players.map(p => p.team).filter(Boolean))].sort();
    const player = this._currentPlayer();
    const counts = this._remainingCounts();

    container.innerHTML = `
      <div class="admin-section">
        <div class="admin-section-header"><h2>NBA 2K27 Position Sorting</h2></div>

        <div id="p27sortError" class="backup-result backup-result-error" style="display:none;"></div>

        <div class="p27sort-toolbar">
          ${NBA2K27_SORT_POSITIONS.map(pos => `
            <button type="button" class="btn btn-sm ${this._activePosition === pos ? 'btn-primary' : 'btn-secondary'}"
                    data-p27-select-pos="${pos}">${pos}</button>
          `).join('')}
          <button type="button" class="btn btn-sm ${this._activePosition === 'UNASSIGNED' ? 'btn-primary' : 'btn-secondary'}"
                  data-p27-select-pos="UNASSIGNED" title="Show every unassigned player, all positions">UNASSIGNED</button>
        </div>

        <div class="p27sort-filters">
          <input type="text" id="p27sortSearch" placeholder="Search by name…" value="${escapeHtml(this._search)}">
          <select id="p27sortCategory">
            <option value="">All (Current / Classics / All-Time)</option>
            <option value="curr" ${this._filterCategory === 'curr' ? 'selected' : ''}>Current</option>
            <option value="class" ${this._filterCategory === 'class' ? 'selected' : ''}>Classics</option>
            <option value="allt" ${this._filterCategory === 'allt' ? 'selected' : ''}>All-Time</option>
          </select>
          <select id="p27sortTeam">
            <option value="">All teams</option>
            ${teams.map(t => `<option value="${escapeHtml(t)}" ${this._filterTeam === t ? 'selected' : ''}>${escapeHtml(t)}</option>`).join('')}
          </select>
          <select id="p27sortOvr">
            <option value="">All overalls</option>
            ${(typeof NBA2K_OVERALL_FILTERS !== 'undefined' ? NBA2K_OVERALL_FILTERS : [])
              .map(f => `<option value="${f.value}" ${this._filterOvr === f.value ? 'selected' : ''}>${escapeHtml(f.label)}</option>`)
              .join('')}
          </select>
        </div>

        <p class="backup-muted">
          ${counts.unassigned} unassigned total &middot; ${counts.activeQueueLength} matching current filters
        </p>

        ${player ? `
          <div class="p27sort-card">
            <div class="p27sort-player-name">${escapeHtml(player.name || 'Unknown')}</div>
            <div class="p27sort-player-meta">
              ${escapeHtml(player.team || '—')} &middot; OVR ${player.overall != null ? player.overall : '—'} &middot; ${escapeHtml(nba2kCategoryLabel(player.teamType))}
              &middot; Pool: ${nba2k27PoolDot(this._poolOf(player))} ${escapeHtml(nba2k27PoolLabel(this._poolOf(player)) || '—')}
              <span class="backup-muted">(auto, from source category)</span>
            </div>

            <div class="p27sort-assign-row">
              ${NBA2K27_SORT_POSITIONS.map(pos => `
                <button type="button" class="btn btn-lg" data-p27-assign="${pos}">${pos}</button>
              `).join('')}
              <button type="button" class="btn btn-lg btn-secondary" data-p27-assign="UNASSIGNED">UNASSIGNED</button>
            </div>

            <div class="p27sort-nav-row">
              <button type="button" class="btn btn-sm btn-secondary" id="p27sortPrev" ${this._cursor <= 0 ? 'disabled' : ''}>&larr; Previous</button>
              <span class="backup-muted">${this._cursor + 1} of ${this._queue.length}</span>
              <button type="button" class="btn btn-sm btn-secondary" id="p27sortNext" ${this._cursor >= this._queue.length - 1 ? 'disabled' : ''}>Next &rarr;</button>
            </div>
            <p class="backup-muted" style="font-size:0.85em;">Shortcuts: 1=PG 2=SG 3=SF 4=PF 5=C, U=UNASSIGNED, &larr;/&rarr;=previous/next</p>
          </div>
        ` : `
          <div class="p27sort-card">
            <p class="backup-muted">No unassigned players match the current filters.</p>
          </div>
        `}
      </div>`;

    this._bindEvents(container);
  },

  _bindEvents(container) {
    NBA2K27_SORT_POSITIONS.concat('UNASSIGNED').forEach(pos => {
      const btn = container.querySelector(`[data-p27-select-pos="${pos}"]`);
      if (btn) btn.addEventListener('click', () => this._setActivePosition(pos));
    });
    container.querySelectorAll('[data-p27-assign]').forEach(btn => {
      btn.addEventListener('click', () => this._assign(btn.dataset.p27Assign));
    });
    const prevBtn = container.querySelector('#p27sortPrev');
    if (prevBtn) prevBtn.addEventListener('click', () => this._prev());
    const nextBtn = container.querySelector('#p27sortNext');
    if (nextBtn) nextBtn.addEventListener('click', () => this._next());

    const searchInput = container.querySelector('#p27sortSearch');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        this._search = e.target.value;
        this._rebuildQueue();
        this._renderShell(container);
        // Restore focus + caret to the search box after the re-render
        // it just triggered, so typing multiple characters doesn't lose
        // focus on every keystroke.
        const restored = container.querySelector('#p27sortSearch');
        if (restored) { restored.focus(); restored.setSelectionRange(restored.value.length, restored.value.length); }
      });
    }
    const categorySelect = container.querySelector('#p27sortCategory');
    if (categorySelect) categorySelect.addEventListener('change', (e) => {
      this._filterCategory = e.target.value; this._rebuildQueue(); this._renderShell(container);
    });
    const teamSelect = container.querySelector('#p27sortTeam');
    if (teamSelect) teamSelect.addEventListener('change', (e) => {
      this._filterTeam = e.target.value; this._rebuildQueue(); this._renderShell(container);
    });
    const ovrSelect = container.querySelector('#p27sortOvr');
    if (ovrSelect) ovrSelect.addEventListener('change', (e) => {
      this._filterOvr = e.target.value; this._rebuildQueue(); this._renderShell(container);
    });
  },

  _handleKeydown(e) {
    // Never fire while the admin is actively typing anywhere (search box,
    // or any other input/textarea/select/contenteditable that might be
    // focused elsewhere in the admin shell).
    const tag = document.activeElement && document.activeElement.tagName;
    const isTyping = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
      || (document.activeElement && document.activeElement.isContentEditable);
    if (isTyping) return;
    // Only act while this view is actually the one on screen.
    if (!this._container || !document.body.contains(this._container)) return;

    const keyMap = { '1': 'PG', '2': 'SG', '3': 'SF', '4': 'PF', '5': 'C' };
    if (keyMap[e.key]) {
      e.preventDefault();
      this._assign(keyMap[e.key]);
    } else if (e.key === 'u' || e.key === 'U') {
      e.preventDefault();
      this._assign('UNASSIGNED'); // explicitly confirm/revert — stays in the queue, matching the assign button
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      this._prev();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      this._next();
    }
  },
};

// Install the keydown listener once, globally, guarded inside the
// handler itself (see _handleKeydown) so it's inert whenever this view
// isn't the one on screen — matching how a single global listener is
// safe to leave attached for the lifetime of the admin page.
Nba2k27PositionSortView._keydownHandler = (e) => Nba2k27PositionSortView._handleKeydown(e);
document.addEventListener('keydown', Nba2k27PositionSortView._keydownHandler);
