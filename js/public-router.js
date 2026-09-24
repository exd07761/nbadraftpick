/**
 * public-router.js — Public-facing app router.
 *
 * Handles navigation and view rendering for the public (read-only) page
 * only. No write operations occur here.
 *
 * IMPORTANT: This file references HomeView, ScheduleView, StandingsView,
 * PlayoffsView, PublicRosterView, PublicPlayersView (Phase 10), and
 * PublicDraftView (Phase 2 redesign — read-only spectator view of the
 * live draft; see js/views/draft.js), and PublicNba2k27View (Phase 11 —
 * read-only NBA 2K27 player view; see js/views/nba2k27.js), and
 * PublicRosterSimulatorView (Roster Simulator Phase 1 — a temporary,
 * in-memory what-if roster; see js/views/roster-simulator.js), which are
 * defined in js/views/*.js. Only index.html loads those view files —
 * admin.html must NOT include this file, or the `routes` object below
 * will throw a ReferenceError for every view global it can't find.
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
  nba2k27: PublicNba2k27View, // Phase 11 — read-only, see js/views/nba2k27.js
  'roster-simulator': PublicRosterSimulatorView, // Roster Simulator Phase 1 — client-side only, no writes; see js/views/roster-simulator.js
};

let currentRoute = null;

let supabaseRealtimeChannel = null;

function initSupabaseRealtime() {
  if (!SupabaseClient) return;

  supabaseRealtimeChannel = SupabaseClient
    .channel('public-roster-updates')
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'roster_entries',
      },
      () => {
        if (currentRoute) navigate(currentRoute);
      }
    )
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'draft_picks',
      },
      () => {
        if (currentRoute) navigate(currentRoute);
      }
    )
    .subscribe((status) => {
      console.log('[SupabaseRealtime] Public roster channel:', status);
    });
}

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
  // LiveNba2k27PoolCache.ensureLoaded() joins the same boot gate as
  // FirebaseSync.init() (NBA2K27 live-pool redesign, js/data.js) so the
  // public Draft/Roster/Players pages can resolve a live-pool-scoped
  // season's players the moment they first render, with no per-view
  // loading state of their own. Logged, not fatal, on failure — the rest
  // of the public site (schedule, standings, financial...) doesn't depend
  // on it and shouldn't be blocked by it.
  await Promise.all([
    FirebaseSync.init(),
    LiveNba2k27PoolCache.ensureLoaded().catch((err) => {
      console.error('[public-router] Failed to load the live NBA2K27 pool:', err);
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
      console.error('[public-router] Failed to load the Supabase live NBA2K27 pool:', err);
    }),
  ]);
  if (bootEl) bootEl.classList.add('hidden');

  // Live updates: when an admin saves a change (a trade, a score, a new
  // draft pick...), Firestore pushes it here too — re-render whatever
  // public page is currently open so visitors see it without refreshing.
  FirebaseSync.onRemoteChange(() => {
    if (currentRoute) navigate(currentRoute);
  });
  initSupabaseRealtime();

  // Route from hash or default
  const hash = location.hash.replace('#', '');
  navigate(routes[hash] ? hash : 'home');
});
