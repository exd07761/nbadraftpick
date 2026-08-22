/**
 * public-router.js — Public-facing app router.
 *
 * Handles navigation and view rendering for the public (read-only) page
 * only. No write operations occur here.
 *
 * IMPORTANT: This file references HomeView, ScheduleView, StandingsView,
 * PlayoffsView, PublicRosterView, PublicPlayersView (Phase 10), and
 * PublicDraftView (Phase 2 redesign — read-only spectator view of the
 * live draft; see js/views/draft.js), which are defined in js/views/*.js.
 * Only index.html loads those view files — admin.html must NOT include
 * this file, or the `routes` object below will throw a ReferenceError
 * for every view global it can't find.
 *
 * Depends on shared-utils.js being loaded first for escapeHtml/showToast/
 * formatStatus, but does not itself define any shared utilities — see
 * shared-utils.js for those.
 *
 * Bootstrap (Firebase integration): FirebaseSync (data.js) resolves
 * asynchronously on first page load — loadData() has nothing to return
 * before its first Firestore snapshot arrives, so the initial navigate()
 * call is held until FirebaseSync.init() resolves. See #bootLoading in
 * index.html.
 */

const routes = {
  home: HomeView,
  schedule: ScheduleView,
  standings: StandingsView,
  playoffs: PlayoffsView,
  rosters: PublicRosterView,
  players: PublicPlayersView,
  draft: PublicDraftView, // Phase 2 redesign — read-only, see js/views/draft.js
};

let currentRoute = null;

function navigate(route) {
  const view = routes[route];
  if (!view) return;

  currentRoute = route;

  // Update nav
  document.querySelectorAll('.nav-link').forEach(el => {
    el.classList.toggle('active', el.dataset.route === route);
  });

  // Update URL hash
  history.replaceState(null, '', `#${route}`);

  // Render view
  const container = document.getElementById('viewContainer');
  container.innerHTML = '';
  view.render(container);
}

document.addEventListener('DOMContentLoaded', async () => {
  // Nav click handlers
  document.querySelectorAll('.nav-link').forEach(el => {
    el.addEventListener('click', e => {
      e.preventDefault();
      navigate(el.dataset.route);
      // Mobile nav: close the collapsible menu after a link is picked
      // (pure UI state — the checkbox drives CSS only, see main.css).
      const navToggle = document.getElementById('navToggle');
      if (navToggle) navToggle.checked = false;
    });
  });

  const bootEl = document.getElementById('bootLoading');
  await FirebaseSync.init();
  if (bootEl) bootEl.classList.add('hidden');

  // Live updates: when an admin saves a change (a trade, a score, a new
  // draft pick...), Firestore pushes it here too — re-render whatever
  // public page is currently open so visitors see it without refreshing.
  FirebaseSync.onRemoteChange(() => {
    if (currentRoute) navigate(currentRoute);
  });

  // Route from hash or default
  const hash = location.hash.replace('#', '');
  navigate(routes[hash] ? hash : 'home');
});
