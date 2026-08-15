/**
 * admin.js — Admin application router
 *
 * All admin views are rendered here, behind the auth boundary.
 * Write operations always call AuthBoundary.requireAuth() before proceeding.
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
        // Mobile nav: close the collapsible menu after a link is picked
        // (pure UI state — the checkbox drives CSS only, see admin.css).
        const navToggle = document.getElementById('adminNavToggle');
        if (navToggle) navToggle.checked = false;
      });
    });

    // Login form
    const loginForm = document.getElementById('loginForm');
    if (loginForm) {
      loginForm.addEventListener('submit', async e => {
        e.preventDefault();
        const username = document.getElementById('loginUsername').value.trim();
        const password = document.getElementById('loginPassword').value;
        const errorEl = document.getElementById('loginError');
        errorEl.textContent = '';

        const result = await AuthBoundary.login(username, password);
        if (result.ok) {
          this._showAdminUI();
        } else {
          errorEl.textContent = result.error || 'Login failed.';
        }
      });
    }

    // Logout
    document.getElementById('btnLogout')?.addEventListener('click', () => {
      AuthBoundary.logout();
      this._showLoginUI();
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

document.addEventListener('DOMContentLoaded', () => {
  AdminApp.init();
  // Start at login screen
  AdminApp._showLoginUI();
});
