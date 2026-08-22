/**
 * shell.js — Phase 2 shared navigation shell behavior.
 *
 * NEW FILE. Loaded by BOTH index.html and admin.html, after the existing
 * public-router.js / admin.js. This file does not modify, wrap, or
 * override anything those files define — it only:
 *   1. Toggles the mobile drawer open/closed and the desktop sidebar
 *      collapsed/expanded state (pure UI state, new elements only:
 *      #nbHamburgerBtn, #nbDrawerScrim, #nbDrawerClose,
 *      #nbSidebarCollapseBtn — none of these existed before).
 *   2. Keeps the mobile top bar's title in sync with whichever nav link
 *      is currently active, by *observing* the .active class the
 *      existing routers already set on .nav-link/.admin-nav-link —
 *      never setting that class itself, so it can't fight the router.
 *   3. Optionally shows a live "On the Clock" status pill in the top bar
 *      when a draft is in progress, using only existing LeagueData read
 *      functions (same ones admin/draft.js already calls) — no writes,
 *      no new Firestore access, and it no-ops entirely on pages/states
 *      where LeagueData isn't ready yet.
 *   4. Season selector (added pre-Phase-6, per spec §3.1/§9): on the
 *      admin page, #nbSeasonSelect is populated from
 *      LeagueData.getAllSeasons() and, on change, calls the exact same
 *      AdminActions.setCurrentSeason(id) the existing admin Seasons page
 *      already calls (see js/admin/seasons.js) — same
 *      AuthBoundary.requireAuth() guard, same re-render pattern
 *      (AdminApp.renderView(AdminApp._currentView)). No new
 *      season-management logic. On the public page, #nbSeasonLabel is a
 *      read-only text label only — see the review notes for why public
 *      doesn't get an interactive switcher (setCurrentSeason is a global,
 *      auth-gated write, not a per-visitor view preference).
 */
(function () {
  function onReady(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  onReady(() => {
    const shell = document.querySelector('.nb-shell');
    if (!shell) return; // page hasn't adopted the new shell markup

    const hamburger = document.getElementById('nbHamburgerBtn');
    const scrim = document.getElementById('nbDrawerScrim');
    const drawerClose = document.getElementById('nbDrawerClose');
    const collapseBtn = document.getElementById('nbSidebarCollapseBtn');
    const topbarTitle = document.getElementById('nbTopbarTitle');
    const topbarStatus = document.getElementById('nbTopbarStatus');
    const seasonSelect = document.getElementById('nbSeasonSelect'); // admin only
    const seasonLabel = document.getElementById('nbSeasonLabel');   // public only

    // ── Mobile drawer open/close ──────────────────────────────────────────
    const openDrawer = () => shell.classList.add('nb-drawer-open');
    const closeDrawer = () => shell.classList.remove('nb-drawer-open');

    hamburger?.addEventListener('click', openDrawer);
    scrim?.addEventListener('click', closeDrawer);
    drawerClose?.addEventListener('click', closeDrawer);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeDrawer();
    });
    // Close the drawer whenever a nav link inside it is used — the link's
    // own click handler (in public-router.js/admin.js) still fires
    // normally; this just also closes the drawer afterward.
    shell.querySelectorAll('.nav-link, .admin-nav-link').forEach((link) => {
      link.addEventListener('click', closeDrawer);
    });

    // ── Desktop sidebar collapse ────────────────────────────────────────
    collapseBtn?.addEventListener('click', () => {
      shell.classList.toggle('nb-collapsed');
    });

    // ── Keep the mobile top bar title in sync with the active nav link ──
    // Observed rather than driven: the existing routers own .active.
    if (topbarTitle) {
      const syncTitle = () => {
        const active = shell.querySelector('.nav-link.active, .admin-nav-link.active');
        if (active) {
          const label = active.querySelector('.nb-link-label')?.textContent || active.textContent;
          topbarTitle.textContent = label.trim();
        }
      };
      syncTitle();
      new MutationObserver(syncTitle).observe(shell, {
        attributes: true,
        attributeFilter: ['class'],
        subtree: true,
      });
    }

    // ── Live "On the Clock" status pill (read-only, best-effort) ───────
    // Only runs if this page has already loaded LeagueData (data.js) —
    // true on both index.html and admin.html — and a season exists.
    function updateStatusPill() {
      if (!topbarStatus) return;
      if (typeof LeagueData === 'undefined' || !LeagueData.getCurrentSeason) return;
      try {
        const season = LeagueData.getCurrentSeason();
        if (!season) { topbarStatus.innerHTML = ''; return; }
        const state = LeagueData.getDraftState(season.id);
        if (state && !state.draftComplete && state.currentParticipant) {
          const name = (state.currentParticipant.name || 'Someone').split(' ')[0];
          topbarStatus.innerHTML =
            `<a href="#draft" data-nb-status-link="1">` +
            `<span class="nb-topbar-status-dot"></span>On the Clock: ${name}</a>`;
          const link = topbarStatus.querySelector('[data-nb-status-link]');
          // Reuses the exact same route the sidebar/drawer Draft link uses —
          // does not create a second navigation path.
          link.addEventListener('click', (e) => {
            e.preventDefault();
            document.querySelector('.nav-link[data-route="draft"], .admin-nav-link[data-view="draft"]')?.click();
          });
        } else {
          topbarStatus.innerHTML = '';
        }
      } catch (e) {
        // Best-effort only — never break the page over the status pill.
      }
    }

    updateStatusPill();
    setInterval(updateStatusPill, 5000);
    if (typeof FirebaseSync !== 'undefined' && FirebaseSync.onRemoteChange) {
      FirebaseSync.onRemoteChange(updateStatusPill);
    }

    // ── Season selector ─────────────────────────────────────────────────
    function updateSeasonWidget() {
      if (!seasonSelect && !seasonLabel) return;
      if (typeof LeagueData === 'undefined' || !LeagueData.getAllSeasons) return;
      try {
        const current = LeagueData.getCurrentSeason ? LeagueData.getCurrentSeason() : null;

        if (seasonLabel) {
          // Public: read-only, just reflects whatever is currently live.
          seasonLabel.textContent = current ? current.name : 'No season yet';
        }

        if (seasonSelect) {
          // Admin: functional — rebuild options only when the season list
          // itself actually changed, so an open dropdown / mid-interaction
          // isn't clobbered on every 5s poll or live-sync tick.
          const seasons = LeagueData.getAllSeasons();
          const optionsKey = seasons.map((s) => s.id).join(',') + '|' + (current ? current.id : '');
          if (seasonSelect.dataset.nbOptionsKey !== optionsKey) {
            seasonSelect.innerHTML = seasons
              .map((s) => `<option value="${s.id}" ${current && s.id === current.id ? 'selected' : ''}>${s.name}</option>`)
              .join('');
            seasonSelect.dataset.nbOptionsKey = optionsKey;
          }
        }
      } catch (e) {
        // Best-effort only — never break the page over the season widget.
      }
    }

    if (seasonSelect) {
      seasonSelect.addEventListener('change', () => {
        const id = seasonSelect.value;
        try {
          if (typeof AuthBoundary !== 'undefined') AuthBoundary.requireAuth();
          AdminActions.setCurrentSeason(id);
          if (typeof showToast === 'function') showToast('Current season updated.', 'success');
          // Same re-render pattern AdminApp already uses for its own
          // live-sync handler — refresh whatever admin view is open now.
          if (typeof AdminApp !== 'undefined') AdminApp.renderView(AdminApp._currentView);
          updateSeasonWidget();
        } catch (e) {
          if (typeof showToast === 'function') showToast(e.message, 'error');
          updateSeasonWidget(); // revert the <select> to the actual current season
        }
      });
    }

    updateSeasonWidget();
    setInterval(updateSeasonWidget, 5000);
    if (typeof FirebaseSync !== 'undefined' && FirebaseSync.onRemoteChange) {
      FirebaseSync.onRemoteChange(updateSeasonWidget);
    }
  });
})();
