/**
 * views/home.js — Public home / league homepage.
 *
 * Phase 10 made this the site's showcase page; the "premium homepage" pass
 * recomposed it as a league landing page (hero → current season → season info
 * → schedule → standings → participants → league info). It is a PRESENTATION
 * change only: every number here still comes from an existing LeagueData read
 * method, nothing is invented, and when a season has no schedule/standings/
 * playoffs data yet the relevant section is simply omitted rather than faked.
 *
 * Read-only additions vs. the previous version (no writes, no new data source):
 *   - season.financialSettings.{entryFee,freeTrades,freeSwaps} and
 *     season.ratingCap (info tiles; each tile only renders if it is a number)
 *   - playoffs.champion of the current season, or of the most recent earlier
 *     season that has one (champion / defending-champion plate)
 *   - LeagueData.getNBATeam(abbr).color/colorAlt (static reference data) as a
 *     subtle accent on participant cards
 * Schedule cards only know "Final" and "Scheduled": the data model has no live
 * state, clock or game time, so none is shown.
 */
const HomeView = {
  render(container) {
    const season = LeagueData.getCurrentSeason();
    const allSeasons = LeagueData.getAllSeasons();

    if (!season && allSeasons.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">🏀</div>
          <h2>No Season Yet</h2>
          <p>The league commissioner hasn't set up a season yet. Check back soon.</p>
        </div>`;
      return;
    }

    const s = season || allSeasons[0];
    const participants = LeagueData.getParticipants(s.id);
    const assignments = LeagueData.getNBATeamAssignments(s.id);
    const allPlayers = LeagueData.getAllPlayers();
    const greenCount = allPlayers.filter(p => p.pool === 'green').length;
    const blueCount = allPlayers.filter(p => p.pool === 'blue').length;
    const whiteCount = allPlayers.filter(p => p.pool === 'white').length;

    const stats = LeagueData.getTeamStatistics(s.id);
    const playoffs = LeagueData.getPlayoffs(s.id);
    const scheduleRounds = LeagueData.getSchedule(s.id);
    const nextRound = this._pickPreviewRound(scheduleRounds);

    // Phase 6 addition: live Draft status, read-only (LeagueData.getDraftState
    // is the exact same read the public Draft page and admin board already
    // use — no new data source, no write). Only shown while the season is
    // actually in its draft phase and a pick is still pending.
    const draftOrder = LeagueData.getPlayerDraftOrder(s.id);
    const draftState = (s.status === 'draft' && draftOrder.length) ? LeagueData.getDraftState(s.id) : null;
    const draftLive = draftState && !draftState.draftComplete && draftState.currentParticipantId;

    const plate = this._championPlate(s, playoffs, allSeasons);
    const tiles = this._infoTiles(s, participants.length);
    const standingsRows = this._rankedTop(stats, 8);
    const standingsLeft = standingsRows.slice(0, 4);
    const standingsRight = standingsRows.slice(4, 8);
    const participantCards = this._participantOrder(participants, stats);

    container.innerHTML = `
      <div class="hp-home">

        <section class="hp-hero" aria-label="League">
          <div class="hp-hero-art" aria-hidden="true"><span class="hp-hero-fx"></span></div>
          <div class="hp-wrap hp-hero-inner">
            <div class="hp-hero-copy">
              <span class="hp-hero-eyebrow">${escapeHtml(formatStatus(s.status))}</span>
              <div class="hp-hero-mark">NBA <span>2K</span> ASPAKAN</div>
            </div>
          </div>
        </section>

        ${draftLive ? `
          <a href="#draft" class="dash-draft-live hp-live" data-route="draft">
            <span class="dash-draft-live-dot"></span>
            <span class="dash-draft-live-text">
              <span class="dash-draft-live-eyebrow">Draft in progress · Round ${draftState.currentRound} · Pick ${draftState.currentPickOverall}</span>
              <span class="dash-draft-live-name">${escapeHtml(draftState.currentParticipant?.name || 'On the clock')}</span>
            </span>
            <span class="dash-draft-live-cta">Watch Live →</span>
          </a>` : ''}

        <section class="hp-season" aria-labelledby="hpSeasonName">
          <div class="hp-wrap hp-season-grid">
            <div class="hp-season-main">
              <div class="hp-season-head">
                <span class="hp-kicker">Current Season</span>
                <h1 class="hp-season-name" id="hpSeasonName">${escapeHtml(s.name)}</h1>
                <p class="hp-season-meta">
                  <span class="status-chip status-${s.status}">${formatStatus(s.status)}</span>
                  <span>${participants.length} team${participants.length !== 1 ? 's' : ''}</span>
                </p>
              </div>
              ${tiles.length ? `
              <ul class="hp-tiles">
                ${tiles.map(t => `
                  <li class="hp-tile">
                    <span class="hp-tile-icon" aria-hidden="true">${t.icon}</span>
                    <span class="hp-tile-value">${escapeHtml(String(t.value))}</span>
                    <span class="hp-tile-label">${escapeHtml(t.label)}</span>
                  </li>`).join('')}
              </ul>` : ''}
            </div>
            ${plate ? `
            <aside class="hp-plate" aria-label="${escapeHtml(plate.label)}">
              <span class="hp-plate-label">${escapeHtml(plate.label)}</span>
              <span class="hp-plate-trophy" aria-hidden="true">${this._icons.trophy}</span>
              <span class="hp-plate-body">
                ${plate.abbr ? teamBadge(plate.abbr, { size: 'lg' }) : ''}
                <span class="hp-plate-name">${escapeHtml(plate.name)}</span>
                <span class="hp-plate-sub">${escapeHtml(plate.seasonName)}</span>
              </span>
            </aside>` : ''}
          </div>
        </section>

        ${nextRound ? `
        <section class="hp-section hp-schedule" aria-labelledby="hpScheduleTitle">
          <div class="hp-wrap">
            <div class="hp-section-head">
              <h2 class="hp-section-title" id="hpScheduleTitle">Schedule <span class="hp-section-sub">${nextRound.allCompleted ? 'Latest results' : 'Upcoming'} · Round ${nextRound.round}</span></h2>
              <div class="hp-head-actions">
                ${this._arrows('schedule')}
                <a class="hp-link section-link nav-link" data-route="schedule" href="#schedule">View full schedule →</a>
              </div>
            </div>
            <div class="hp-strip hp-schedule-strip" data-hp-strip tabindex="0" role="region" aria-label="Schedule, Round ${nextRound.round}">
              ${nextRound.matchups.slice(0, 5).map(m => this._scheduleCard(s, m)).join('')}
            </div>
          </div>
        </section>` : ''}

        ${stats.length ? `
        <section class="hp-section hp-standings" aria-labelledby="hpStandingsTitle">
          <div class="hp-wrap">
            <div class="hp-section-head">
              <h2 class="hp-section-title" id="hpStandingsTitle">Standings</h2>
              <div class="hp-head-actions">
                <a class="hp-link section-link nav-link" data-route="standings" href="#standings">View full standings →</a>
              </div>
            </div>
            <div class="hp-standings-grid">
              ${this._standingsPanel(standingsLeft)}
              ${standingsRight.length ? this._standingsPanel(standingsRight) : ''}
            </div>
          </div>
        </section>` : ''}

        ${participants.length ? `
        <section class="hp-section hp-participants" aria-labelledby="hpParticipantsTitle">
          <div class="hp-wrap">
            <div class="hp-section-head">
              <h2 class="hp-section-title" id="hpParticipantsTitle">Participants</h2>
              <div class="hp-head-actions">
                ${this._arrows('participants')}
                <a class="hp-link section-link nav-link" data-route="rosters" href="#rosters">View all participants →</a>
              </div>
            </div>
            <div class="hp-strip hp-participant-strip" data-hp-strip tabindex="0" role="region" aria-label="Participants">
              ${participantCards.map(c => this._participantCard(c, assignments)).join('')}
            </div>
          </div>
        </section>` : ''}

        <section class="hp-section hp-info" aria-labelledby="hpInfoTitle">
          <div class="hp-wrap">
            <div class="hp-section-head">
              <h2 class="hp-section-title" id="hpInfoTitle">League Info</h2>
            </div>

            <ul class="hp-intel">
              <li class="hp-intel-item"><span class="hp-intel-num">${participants.length}</span><span class="hp-intel-label">Teams</span></li>
              <li class="hp-intel-item"><span class="hp-intel-num">${LeagueData.getDraftPicks(s.id).length}</span><span class="hp-intel-label">Draft Picks Made</span></li>
              <li class="hp-intel-item"><span class="hp-intel-num">${Object.keys(assignments).length}</span><span class="hp-intel-label">Teams Assigned</span></li>
              <li class="hp-intel-item"><span class="hp-intel-num is-green">${greenCount}</span><span class="hp-intel-label">Green Pool Players</span></li>
              <li class="hp-intel-item"><span class="hp-intel-num is-blue">${blueCount}</span><span class="hp-intel-label">Blue Pool Players</span></li>
              <li class="hp-intel-item"><span class="hp-intel-num is-white">${whiteCount}</span><span class="hp-intel-label">White Pool Players</span></li>
            </ul>

            ${(playoffs || allSeasons.length > 1) ? `
            <div class="hp-info-grid">
              ${playoffs ? `
              <div class="hp-panel">
                <div class="hp-panel-head">
                  <h3 class="hp-panel-title">Playoffs</h3>
                  <a class="hp-link section-link nav-link" data-route="playoffs" href="#playoffs">Bracket →</a>
                </div>
                ${playoffs.champion
                  ? `<div class="hp-champion-banner">${this._icons.trophy}<span>${escapeHtml(s.participants[playoffs.champion]?.name || '')}</span></div>`
                  : `<p class="hp-muted">Bracket is set — ${this._playoffStatusLabel(playoffs.status)}.</p>`}
              </div>` : ''}

              ${allSeasons.length > 1 ? `
              <div class="hp-panel">
                <div class="hp-panel-head"><h3 class="hp-panel-title">All Seasons</h3></div>
                <div class="hp-seasons">
                  ${allSeasons.map(s2 => `
                    <div class="hp-season-row ${s2.id === s.id ? 'is-active' : ''}">
                      <span>${escapeHtml(s2.name)}</span>
                      <span class="status-chip status-${s2.status}">${formatStatus(s2.status)}</span>
                    </div>`).join('')}
                </div>
              </div>` : ''}
            </div>` : ''}
          </div>
        </section>
      </div>`;

    // Section-link nav items reuse the same client-side router as the main nav.
    container.querySelectorAll('.section-link[data-route], .dash-draft-live[data-route]').forEach(el => {
      el.addEventListener('click', e => { e.preventDefault(); navigate(el.dataset.route); });
    });

    container.querySelectorAll('[data-hp-strip]').forEach(strip => this._wireStrip(strip));
  },

  // ── Presentation helpers (no data access beyond what render() already read) ──

  _icons: {
    users: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" focusable="false"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    coins: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" focusable="false"><ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.66 3.58 3 8 3s8-1.34 8-3V6"/><path d="M4 12v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6"/></svg>',
    trades: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" focusable="false"><path d="m16 3 4 4-4 4"/><path d="M20 7H4"/><path d="m8 21-4-4 4-4"/><path d="M4 17h16"/></svg>',
    swaps: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" focusable="false"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>',
    cap: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" focusable="false"><path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/></svg>',
    stage: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" focusable="false"><path d="m12 3 9 4.5-9 4.5-9-4.5z"/><path d="m3 12 9 4.5 9-4.5"/><path d="m3 16.5 9 4.5 9-4.5"/></svg>',
    trophy: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" focusable="false" aria-hidden="true"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-1.04 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98 1.04 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/></svg>',
    prev: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" focusable="false" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>',
    next: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" focusable="false" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>',
  },

  // Season info tiles: only values that actually exist on the season are shown.
  _infoTiles(s, participantCount) {
    const isNum = v => typeof v === 'number' && Number.isFinite(v);
    const fin = s.financialSettings || {};
    const tiles = [{ icon: this._icons.users, value: participantCount, label: 'Participants' }];
    if (isNum(fin.entryFee)) tiles.push({ icon: this._icons.coins, value: `₱${fin.entryFee.toLocaleString('en-US')}`, label: 'Entry Fee' });
    if (isNum(fin.freeTrades)) tiles.push({ icon: this._icons.trades, value: fin.freeTrades, label: 'Free Trades' });
    if (isNum(fin.freeSwaps)) tiles.push({ icon: this._icons.swaps, value: fin.freeSwaps, label: 'Free Swaps' });
    if (isNum(s.ratingCap)) tiles.push({ icon: this._icons.cap, value: s.ratingCap, label: 'Rating Cap' });
    if (s.scheduleFormat === 'groupStage' && s.groupStageState && isNum(s.groupStageState.stage)) {
      tiles.push({ icon: this._icons.stage, value: `Stage ${s.groupStageState.stage}`, label: 'Current Stage' });
    }
    return tiles;
  },

  // Champion of this season if crowned; otherwise the champion of the most
  // recent earlier season in the database that has one. Null when neither
  // exists — nothing is shown rather than a placeholder.
  _championPlate(s, playoffs, allSeasons) {
    const build = (label, season, champId) => {
      const name = season.participants?.[champId]?.name;
      if (!name) return null;
      return { label, name, abbr: season.nbaTeamAssignments?.[champId] || null, seasonName: season.name };
    };
    if (playoffs && playoffs.champion) {
      const own = build('Champion', s, playoffs.champion);
      if (own) return own;
    }
    // getAllSeasons() is newest-first, so everything after the current season is older.
    const idx = allSeasons.findIndex(x => x.id === s.id);
    if (idx === -1) return null;
    for (const older of allSeasons.slice(idx + 1)) {
      const po = LeagueData.getPlayoffs(older.id);
      if (po && po.champion) {
        const prev = build('Defending Champion', older, po.champion);
        if (prev) return prev;
      }
    }
    return null;
  },

  // Standings order first (when games exist), then any participant not in the
  // standings list, so nobody is dropped from the strip.
  _participantOrder(participants, stats) {
    const byId = new Map(participants.map(p => [p.id, p]));
    const seen = new Set();
    const out = [];
    stats.forEach(row => {
      const p = byId.get(row.participantId);
      if (!p) return;
      seen.add(p.id);
      out.push({ participant: p, row });
    });
    participants.forEach(p => { if (!seen.has(p.id)) out.push({ participant: p, row: null }); });
    return out;
  },

  _arrows(which) {
    return `
      <div class="hp-arrows" data-hp-arrows>
        <button type="button" class="hp-arrow" data-hp-dir="-1" aria-label="Scroll ${which} back">${this._icons.prev}</button>
        <button type="button" class="hp-arrow" data-hp-dir="1" aria-label="Scroll ${which} forward">${this._icons.next}</button>
      </div>`;
  },

  // Arrow buttons + disabled state for a horizontally scrolling strip.
  // Pure UI: scrolls the element, touches no data. Listeners live on nodes
  // that are replaced on every re-render, so nothing leaks.
  _wireStrip(strip) {
    const head = strip.closest('.hp-section');
    const arrows = head ? head.querySelector('[data-hp-arrows]') : null;
    if (!arrows) return;
    const [prev, next] = arrows.querySelectorAll('.hp-arrow');
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const update = () => {
      const max = strip.scrollWidth - strip.clientWidth;
      const scrollable = max > 2;
      arrows.classList.toggle('is-hidden', !scrollable);
      prev.disabled = !scrollable || strip.scrollLeft <= 2;
      next.disabled = !scrollable || strip.scrollLeft >= max - 2;
    };
    arrows.addEventListener('click', e => {
      const btn = e.target.closest('.hp-arrow');
      if (!btn || btn.disabled) return;
      strip.scrollBy({ left: Number(btn.dataset.hpDir) * strip.clientWidth * 0.85, behavior: reduce ? 'auto' : 'smooth' });
    });
    strip.addEventListener('scroll', update, { passive: true });
    if ('ResizeObserver' in window) new ResizeObserver(update).observe(strip);
    else window.addEventListener('resize', update);
    update();
  },

  _standingsPanel(rows) {
    return `
      <div class="hp-panel hp-standings-panel">
        <div class="hp-st-row hp-st-head" aria-hidden="true">
          <span>#</span><span></span><span>Participant</span><span>W</span><span>L</span><span>+/-</span><span>PCT</span>
        </div>
        ${rows.map(row => {
          const pd = row.pointDifferential;
          return `
          <div class="hp-st-row ${row.rank === 1 ? 'is-leader' : ''}">
            <span class="hp-rank ${row.rank <= 4 ? 'is-top4' : ''} ${row.rank === 1 ? 'is-first' : ''}">${row.rank}</span>
            ${teamBadge(row.nbaTeam, { size: 'sm' })}
            <span class="hp-st-name">${escapeHtml(row.participantName || '—')}</span>
            <span class="hp-st-num">${row.wins}</span>
            <span class="hp-st-num">${row.losses}</span>
            <span class="hp-st-num ${pd > 0 ? 'is-pos' : pd < 0 ? 'is-neg' : ''}">${pd > 0 ? '+' : ''}${pd}</span>
            <span class="hp-st-pct">${(row.winPct * 100).toFixed(1)}%</span>
          </div>`;
        }).join('')}
      </div>`;
  },

  _participantCard({ participant: p, row }, assignments) {
    const abbr = assignments[p.id];
    const team = abbr ? LeagueData.getNBATeam(abbr) : null;
    const hex = c => (typeof c === 'string' && /^#[0-9a-f]{3,8}$/i.test(c)) ? c : null;
    const color = team ? hex(team.color) : null;
    const alt = team ? hex(team.colorAlt) : null;
    const style = color ? ` style="--hp-team:${color};${alt ? `--hp-team-alt:${alt};` : ''}"` : '';
    const played = row && row.gamesPlayed > 0;
    return `
      <article class="hp-pcard"${style}>
        <span class="hp-pcard-logo">${teamBadge(abbr, { size: 'lg' })}</span>
        <span class="hp-pcard-name">${escapeHtml(p.name)}</span>
        ${played
          ? `<span class="hp-pcard-record">${row.wins}-${row.losses}</span>`
          : `<span class="hp-pcard-team">${team ? escapeHtml(team.name) : 'No team assigned'}</span>`}
      </article>`;
  },

  // Picks the most relevant round to preview: the first round with any
  // not-yet-completed real matchup, or the final round if everything is done.
  _pickPreviewRound(rounds) {
    if (!rounds.length) return null;
    const inProgress = rounds.find(r => r.matchups.some(m => m.teamB !== null && m.status !== 'completed'));
    if (inProgress) return { ...inProgress, allCompleted: false };
    const last = rounds[rounds.length - 1];
    return { ...last, allCompleted: true };
  },

  _rankedTop(stats, n) {
    let rank = 0;
    return stats.slice(0, n).map((s, i) => {
      const prev = stats[i - 1];
      const isTie = prev && prev.winPct === s.winPct && prev.pointDifferential === s.pointDifferential;
      if (!isTie) rank = i + 1;
      return { ...s, rank };
    });
  },

  _playoffStatusLabel(status) {
    const map = {
      seeded: 'Round 1 not yet started',
      round1_in_progress: 'Round 1 in progress',
      round2_in_progress: 'Round 2 in progress',
      finals_semifinals_complete: 'Semifinals complete',
      finals_in_progress: 'Semifinals in progress',
      championship_in_progress: 'Championship in progress',
    };
    return map[status] || status;
  },

  // One schedule card. Status is only ever Final or Scheduled (m.status).
  _scheduleCard(season, m) {
    const nameFor = pid => pid ? escapeHtml(season.participants[pid]?.name || '') : '';
    const abbrFor = pid => pid ? season.nbaTeamAssignments[pid] : null;

    if (m.teamB === null) {
      return `
        <article class="hp-game is-bye">
          <div class="hp-game-top"><span class="hp-game-status is-bye">BYE</span></div>
          <div class="hp-game-bye">
            ${teamBadge(abbrFor(m.teamA), { size: 'lg' })}
            <span class="hp-side-name">${nameFor(m.teamA)}</span>
            <span class="hp-game-note">Sits out this round</span>
          </div>
        </article>`;
    }

    const isCompleted = m.status === 'completed';
    const { leftId, rightId, leftScore, rightScore, leftIsWinner, rightIsWinner, hasHomeCourt } = matchupHomeAway(m);
    const chip = [m.stage ? `Stage ${m.stage}` : '', m.group ? `Group ${m.group}` : '', m.conference ? `Conference ${m.conference}` : '']
      .filter(Boolean).join(' · ');

    return `
      <article class="hp-game ${isCompleted ? 'is-final' : 'is-scheduled'}">
        <div class="hp-game-top">
          <span class="hp-game-status ${isCompleted ? 'is-final' : 'is-scheduled'}">${isCompleted ? 'Final' : 'Scheduled'}</span>
          ${chip ? `<span class="hp-game-chip">${escapeHtml(chip)}</span>` : ''}
        </div>
        <div class="hp-game-body">
          <div class="hp-side ${leftIsWinner ? 'is-winner' : ''}">
            ${teamBadge(abbrFor(leftId), { size: 'lg' })}
            <span class="hp-side-name">${nameFor(leftId)}</span>
            ${hasHomeCourt ? '<span class="hp-home-tag" title="Home court">Home</span>' : ''}
          </div>
          <div class="hp-mid">
            ${isCompleted
              ? `<span class="hp-score"><b class="${leftIsWinner ? 'is-winner' : ''}">${leftScore}</b><i>–</i><b class="${rightIsWinner ? 'is-winner' : ''}">${rightScore}</b></span>`
              : '<span class="hp-vs">VS</span>'}
          </div>
          <div class="hp-side ${rightIsWinner ? 'is-winner' : ''}">
            ${teamBadge(abbrFor(rightId), { size: 'lg' })}
            <span class="hp-side-name">${nameFor(rightId)}</span>
          </div>
        </div>
      </article>`;
  },
};
