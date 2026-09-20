/**
 * admin.js — Admin application router
 *
 * All admin views are rendered here, behind the auth boundary.
 * Write operations always call AuthBoundary.requireAuth() before proceeding.
 *
 * Bootstrap sequence (Firebase integration): both the Firestore data sync
 * (FirebaseSync, in data.js) and Firebase Auth's initial session check
 * (AuthBoundary.ready(), in auth-boundary.js) are asynchronous on page
 * load — there is nothing meaningful to render until both resolve. See
 * the #bootLoading screen in admin.html, shown until then.
 */

const AdminApp = {
  _currentView: 'seasons',

  routes: {
    seasons: AdminSeasonsView,
    participants: AdminParticipantsView,
    players: AdminPlayersView,
    draftOrder: AdminDraftOrderView,
    draft: AdminDraftView,
    teamAssignment: AdminTeamAssignmentView,
    roster: AdminRosterView,
    schedule: AdminScheduleView,
    playoffs: AdminPlayoffsView,
    trades: AdminTradesView,
    financial: AdminFinancialView,
    backup: AdminBackupView,
    nba2kImport: Nba2kImport,
    nba2kDatabase: Nba2kDatabaseView,
    nba2k27Pool: Nba2k27PoolView,
    nba2k27PositionSort: Nba2k27PositionSortView,
  },

  renderView(viewName) {
    const view = this.routes[viewName];
    if (!view) return;
    this._currentView = viewName;

    document.querySelectorAll('.admin-nav-link').forEach(el => {
      el.classList.toggle('active', el.dataset.view === viewName);
    });

    const container = document.getElementById('adminViewContainer');
    container.innerHTML = '';
    view.render(container);
  },

  init() {
    // Nav clicks
    document.querySelectorAll('.admin-nav-link').forEach(el => {
      el.addEventListener('click', e => {
        e.preventDefault();
        this.renderView(el.dataset.view);
      });
    });

    // Login form
    const loginForm = document.getElementById('loginForm');
    if (loginForm) {
      loginForm.addEventListener('submit', async e => {
        e.preventDefault();
        const email = document.getElementById('loginUsername').value.trim();
        const password = document.getElementById('loginPassword').value;
        const errorEl = document.getElementById('loginError');
        errorEl.textContent = '';

        const result = await AuthBoundary.login(email, password);
        if (result.ok) {
          this._showAdminUI();
        } else {
          errorEl.textContent = result.error || 'Login failed.';
        }
      });
    }

    // Logout
    document.getElementById('btnLogout')?.addEventListener('click', async () => {
      await AuthBoundary.logout();
      this._showLoginUI();
    });

    // If the session ends elsewhere (e.g. token expiry, or signed out in
    // another tab), fall back to the login screen here too.
    AuthBoundary.onAuthStateChanged((user) => {
      if (!user && !document.getElementById('adminShell').classList.contains('hidden')) {
        this._showLoginUI();
      }
    });

    // Live multi-device sync: when another admin/device saves a change,
    // Firestore pushes it here — re-render whatever view is currently open
    // so it doesn't go stale until a manual refresh.
    FirebaseSync.onRemoteChange(() => {
      if (!document.getElementById('adminShell').classList.contains('hidden')) {
        this.renderView(this._currentView);
      }
    });
  },

  _showAdminUI() {
    document.getElementById('loginScreen').classList.add('hidden');
    document.getElementById('adminShell').classList.remove('hidden');
    const user = AuthBoundary.getCurrentUser();
    const el = document.getElementById('adminUsername');
    if (el) el.textContent = user?.username || 'Admin';
    this.renderView(this._currentView);
  },

  _showLoginUI() {
    document.getElementById('loginScreen').classList.remove('hidden');
    document.getElementById('adminShell').classList.add('hidden');
  },
};

document.addEventListener('DOMContentLoaded', async () => {
  const bootEl = document.getElementById('bootLoading');

  AdminApp.init();

  // Wait for both the Firestore data cache and Firebase Auth's initial
  // session check before showing anything — otherwise loadData() has
  // nothing to return yet, and we'd flash the login screen even for an
  // already-signed-in admin. LiveNba2k27PoolCache.ensureLoaded() joins
  // this same gate (NBA2K27 live-pool redesign, js/data.js) so that by
  // the time any view renders, a live-pool-scoped season's players are
  // already resolvable — no view file needs its own loading state for
  // this. A failure here is logged but does NOT block the rest of the
  // admin UI from loading (a non-2K27 task like Participants or Financial
  // shouldn't be blocked by a pool fetch it doesn't need); any view that
  // does need it (Draft/Roster/Seasons) will simply show no NBA2K27
  // players until a retry succeeds.
  const [, isSignedIn] = await Promise.all([
    FirebaseSync.init(),
    AuthBoundary.ready(),
    LiveNba2k27PoolCache.ensureLoaded().catch((err) => {
      console.error('[AdminApp] Failed to load the live NBA2K27 pool:', err);
    }),
    // Supabase live pool: this is the cache loadData() actually merges for a
    // live-scoped season (bafcde3 moved it off LiveNba2k27PoolCache above), so
    // it must be loaded before the first render. Hardened so it can never hurt
    // boot: bounded to 8s (a hung request must not hold the whole site hostage)
    // and wrapped in Promise.resolve().then() so a synchronous throw from
    // ensureLoaded() becomes a handled rejection instead of aborting boot.
    // Same promise the Draft views' guards share, so no duplicate request.
    Promise.race([
      Promise.resolve().then(() => SupabaseLiveNba2k27PoolCache.ensureLoaded()),
      new Promise((resolve) => setTimeout(resolve, 8000)),
    ]).catch((err) => {
      console.error('[AdminApp] Failed to load the Supabase live NBA2K27 pool:', err);
    }),
  ]);

  if (bootEl) bootEl.classList.add('hidden');

  if (isSignedIn) {
    AdminApp._showAdminUI();
  } else {
    AdminApp._showLoginUI();
  }
});
