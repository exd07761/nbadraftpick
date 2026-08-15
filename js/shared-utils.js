/**
 * shared-utils.js — Utilities used by BOTH index.html (public) and
 * admin.html (admin).
 *
 * This file must never reference anything public-router-specific
 * (routes, navigate, view objects like HomeView/ScheduleView/etc.) — those
 * live in public-router.js, which only index.html loads. Keeping this
 * split means admin.html can safely include this file without pulling
 * in view globals it never defines.
 */

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatStatus(status) {
  const map = {
    setup: 'Setup',
    draft: 'Draft',
    team_assignment: 'Team Assignment',
    regular_season: 'Regular Season',
    playoffs: 'Playoffs',
    complete: 'Complete',
  };
  return map[status] || status;
}

/**
 * teamBadge(abbr, options) — shared team-identity component, used
 * everywhere an NBA team appears (Home, Rosters, Schedule, Standings,
 * Draft, Players, Playoffs, Team Assignment, Admin Schedule). There is no
 * standalone public "Teams" page as of Phase 10.4 — Teams and Rosters
 * were consolidated into the public Rosters page (views/roster.js).
 *
 * Renders the team's local SVG logo (NBA_TEAMS[].logo, added Phase 10.2 —
 * self-contained files under assets/logos/, no external URLs/CDNs/hotlinks)
 * when one is set. If a team has no `logo` value, or the image fails to
 * load for any reason, an inline `onerror` swaps in the original colored-
 * initials badge — no broken-image icon is ever shown, and this fallback
 * needs no separate JS wiring per caller.
 *
 * Reads team data from LeagueData.getNBATeam() (data.js), which is static
 * reference data only. This never determines or implies team OWNERSHIP —
 * participant -> team ownership always comes from
 * LeagueData.getNBATeamAssignments(), looked up by the caller.
 *
 * @param {string} abbr - NBA team abbreviation, or falsy for an unassigned slot.
 * @param {object} options
 *   size: 'sm' | 'md' | 'lg'  (default 'md')
 *   showName: boolean          — append full team name text after the badge
 *   className: string          — extra class(es) on the wrapper
 */
function teamBadge(abbr, options = {}) {
  const { size = 'md', showName = false, className = '' } = options;
  const team = abbr ? LeagueData.getNBATeam(abbr) : null;

  if (!team) {
    return `
      <span class="team-identity team-identity-${size} ${className}">
        <span class="team-badge team-badge-${size} team-badge-empty" aria-hidden="true">—</span>
        ${showName ? `<span class="team-identity-name team-identity-name-empty">Unassigned</span>` : ''}
      </span>`;
  }

  const textColor = badgeTextColor(team.color);
  const fallbackBadge = `
      <span class="team-badge team-badge-${size} team-logo-fallback" style="display:none; background:${team.color}; color:${textColor}; box-shadow: inset 0 0 0 2px ${team.colorAlt}66;">
        ${escapeHtml(team.abbr)}
      </span>`;
  const logoMark = team.logo
    ? `<img class="team-logo-img team-logo-img-${size}" src="${escapeHtml(team.logo)}" alt="${escapeHtml(team.abbr)}"
         loading="lazy" width="${_badgePx(size)}" height="${_badgePx(size)}"
         onerror="this.onerror=null;this.style.display='none';this.nextElementSibling.style.display='inline-flex';">${fallbackBadge}`
    : `<span class="team-badge team-badge-${size}" style="background:${team.color}; color:${textColor}; box-shadow: inset 0 0 0 2px ${team.colorAlt}66;">
        ${escapeHtml(team.abbr)}
      </span>`;

  return `
    <span class="team-identity team-identity-${size} ${className}" title="${escapeHtml(team.name)}">
      ${logoMark}
      ${showName ? `<span class="team-identity-name">${escapeHtml(team.name)}</span>` : `<span class="team-identity-abbr">${escapeHtml(team.abbr)}</span>`}
    </span>`;
}

function _badgePx(size) {
  return { sm: 22, md: 34, lg: 56 }[size] || 34;
}

/** Picks black or white text for readable contrast against a hex background. */
function badgeTextColor(hex) {
  if (!hex || hex[0] !== '#') return '#fff';
  const h = hex.slice(1);
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? '#14161b' : '#ffffff';
}

/**
 * positionPoolGrid(entries, pool, options) — Phase 10.1 shared player-pool
 * table component (2K-Ratings-style position columns), used by the public
 * Players page, the admin Players page, AND the admin Draft page (Phase
 * 10.3) so all three share one visual language. Groups by CORE_POSITIONS
 * (PG/SG/SF/PF/C, data.js) — any player whose position isn't one of those
 * five is grouped into an "OTHER" column rather than dropped, so nothing
 * becomes invisible due to bad data.
 *
 * @param {Array<{player: object, status?: 'available'|'drafted'|'variant-locked'|'position-locked'|'no-position'}>} entries
 * @param {'green'|'blue'} pool
 * @param {object} options
 *   mode: 'view' (default) | 'manage' | 'draft'
 *     'view'   — read-only (public Players page)
 *     'manage' — adds a delete "×" per row (admin Players page; caller wires the click)
 *     'draft'  — 'available' rows are clickable (data-action="selectPlayer"),
 *                and all four non-available statuses get a visible tag
 *                (Drafted / Variant Taken / Locked / No Position) — used by
 *                the admin Draft page. Caller wires the click.
 *   admin: boolean (legacy alias for mode:'manage', kept for existing callers)
 *   sortMode: 'ovr-desc' | 'ovr-asc' | 'name-asc'  (default 'ovr-desc')
 */
function positionPoolGrid(entries, pool, options = {}) {
  const { admin = false, sortMode = 'ovr-desc' } = options;
  const mode = options.mode || (admin ? 'manage' : 'view');

  const byPos = {};
  CORE_POSITIONS.forEach((pos) => { byPos[pos] = []; });
  const other = [];
  entries.forEach((e) => {
    const pos = e.player.position;
    (CORE_POSITIONS.includes(pos) ? byPos[pos] : other).push(e);
  });

  const sorter = {
    'ovr-desc': (a, b) => (b.player.overall ?? 0) - (a.player.overall ?? 0),
    'ovr-asc': (a, b) => (a.player.overall ?? 0) - (b.player.overall ?? 0),
    'name-asc': (a, b) => a.player.name.localeCompare(b.player.name),
  }[sortMode] || ((a, b) => (b.player.overall ?? 0) - (a.player.overall ?? 0));

  CORE_POSITIONS.forEach((pos) => byPos[pos].sort(sorter));
  other.sort(sorter);

  const cols = CORE_POSITIONS.map((pos) => _positionPoolColumn(pos, byPos[pos], pool, mode));
  if (other.length) cols.push(_positionPoolColumn('OTHER', other, pool, mode));

  if (entries.length === 0) {
    return `<p class="muted" style="padding: 1.5rem 0;">No players in this pool yet.</p>`;
  }
  return `<div class="pos-table-grid">${cols.join('')}</div>`;
}

function _positionPoolColumn(posLabel, rows, pool, mode) {
  const admin = mode === 'manage';
  return `
    <div class="pos-table pos-table-${pool} ${admin ? 'pos-table-admin' : ''}">
      <div class="pos-table-head">${escapeHtml(posLabel)}</div>
      <div class="pos-table-columns-head">
        <span>#</span><span>PLAYER</span><span>OVR</span>${admin ? '<span></span>' : ''}
      </div>
      <div class="pos-table-body">
        ${rows.length === 0
          ? `<div class="pos-table-empty">No players</div>`
          : rows.map((e, i) => _positionPoolRow(e, i + 1, mode)).join('')}
      </div>
    </div>`;
}

const _DRAFT_STATUS_LABELS = {
  'drafted': 'Drafted',
  'variant-locked': 'Variant Taken',
  'position-locked': 'Locked',
  'no-position': 'No Position',
};

function _positionPoolRow(entry, rank, mode) {
  const { player, status } = entry;
  const admin = mode === 'manage';
  const isDrafted = status === 'drafted';
  // 'locked' visual (dimmed, tag, not struck through) covers every
  // non-available, non-drafted status — variant-locked, position-locked,
  // and no-position — so a new status added later still degrades safely
  // to "clearly unavailable" instead of silently looking available.
  const isLocked = status && status !== 'available' && status !== 'drafted';
  const isDraftable = mode === 'draft' && status === 'available';
  const ovr = player.overall ?? 0;
  const tier = ovr >= 90 ? 'pos-ovr-elite' : ovr >= 80 ? 'pos-ovr-good' : 'pos-ovr-role';
  const statusTag = mode === 'draft' && _DRAFT_STATUS_LABELS[status]
    ? `<span class="pos-drafted-tag ${status === 'position-locked' || status === 'no-position' ? 'pos-locked-tag' : ''}">${_DRAFT_STATUS_LABELS[status]}</span>`
    : isDrafted ? `<span class="pos-drafted-tag">Drafted</span>`
    : isLocked ? `<span class="pos-drafted-tag pos-locked-tag">Variant taken</span>`
    : '';

  return `
    <div class="pos-table-row ${isDrafted ? 'drafted' : ''} ${isLocked ? 'locked' : ''} ${isDraftable ? 'selectable' : ''}"
         data-player-id="${player.id}"
         ${isDraftable ? `data-action="selectPlayer" role="button" tabindex="0"` : ''}>
      <span class="pos-rank">${rank}</span>
      <span class="pos-name" title="${escapeHtml(player.name)}${player.variantGroup ? ' · ' + escapeHtml(player.variantGroup) : ''}">
        ${escapeHtml(player.name)}
        ${statusTag}
      </span>
      <span class="pos-ovr ${isDrafted ? '' : tier}">${ovr}</span>
      ${admin ? `<button type="button" class="pos-row-delete" data-action="deletePlayer" data-id="${player.id}" data-name="${escapeHtml(player.name)}" title="Delete ${escapeHtml(player.name)}">×</button>` : ''}
    </div>`;
}

function showToast(message, type = 'info') {
  const existing = document.getElementById('toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.id = 'toast';
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.classList.add('toast-visible'), 10);
  setTimeout(() => {
    toast.classList.remove('toast-visible');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}
