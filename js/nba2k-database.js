/**
 * admin/nba2k-database.js — NBA 2K26 Player Database Browser
 * (Phase 2: browse/search/filter/detail. Phase 3: promote-to-Draft-Pool.)
 *
 * PURPOSE
 * Admin-only view over the `nba2k_players` Firestore collection created in
 * Phase 1. Phase 2 made this a read-only "scouting database" browser.
 * Phase 3 adds exactly one write path: promoting a selected NBA2K player
 * into the EXISTING Draft Pool player system (`league/main.players`) via
 * the existing `AdminActions.addPlayer()` — this file never writes to
 * `nba2k_players` itself, and never writes to `league/main` except
 * through that one existing, unmodified write pathway.
 *
 * SCOPE (Phase 2 — unchanged)
 * - Load all `nba2k_players` docs once per admin session (module-level
 *   cache), then search/filter/sort entirely client-side. No Firestore
 *   read is issued per keystroke or per filter change.
 * - Firestore is the only nba2k_players data source — the original JSON
 *   file is never touched here (that was Phase 1's import-only input).
 *
 * SCOPE (Phase 3 — new)
 * - "Add to Draft Pool" section at the bottom of the player detail view.
 * - Requires the commissioner to explicitly pick ONE position (from the
 *   player's `positions` array — never auto-selected) and ONE pool
 *   (Green/Blue — never auto-assigned), then confirm a summary before
 *   any write happens.
 * - Prevents double-promotion by checking `nba2kRef` on existing
 *   `league/main` players; prevents silent name collisions against
 *   players that predate this feature (which have no `nba2kRef`).
 * - Does NOT copy attributes/badges/physicals into `league/main` — only
 *   name, position (commissioner-chosen), overall, pool (commissioner-
 *   chosen), and the `nba2kRef` back-reference.
 * - Does NOT modify `nba2k_players/<slug>` in any way — promotion is a
 *   read of that document plus a write to `league/main` only.
 * - No pool-minimum-rating / Blue-composition enforcement is added here
 *   beyond what the existing single-player "Add Player" form already
 *   enforces (name required, overall 40–99) — `AdminActions.addPlayer()`
 *   itself has no additional validation today, and Phase 3 intentionally
 *   mirrors that existing behavior exactly rather than inventing new
 *   validation the rest of the app doesn't otherwise apply at add-time.
 *
 * ARCHITECTURE NOTE: all `nba2k_players` Firestore access stays
 * self-contained in this file (see Phase 2 rationale below). The Phase 3
 * promotion write goes through the existing, shared `AdminActions`/
 * `LeagueData` globals from data.js — the same objects every other admin
 * page already uses — never a new data-access path. The one change made
 * to data.js is additive: `createPlayer()`/`AdminActions.addPlayer()`
 * now accept an optional `nba2kRef` field that every existing caller
 * (CSV import, the manual Add Player form) simply never passes, so it's
 * `undefined` for every pre-existing player exactly like `variantGroup`
 * already is when omitted.
 *
 * `LeagueData.getAllPlayers()` reads from `FirebaseSync`'s live, already
 * real-time-synced local cache (see data.js) — it is a synchronous,
 * no-network call, and `FirebaseSync.save()` updates that cache
 * optimistically before the Firestore write even resolves. That means
 * every promo-status check in this file (open detail, row status pill,
 * pre-write re-check) is always working off current data with zero
 * extra fetches and zero artificial delays after a write.
 *
 * Original Phase 2 architecture note, still true: `LeagueData` is the
 * *public* read API shared with index.html, and `nba2k_players` is
 * intentionally admin-only, so its reads stay local to this file rather
 * than living on that shared object.
 *
 * Firestore rule this depends on (unchanged by this file):
 *   match /nba2k_players/{slug} {
 *     allow read, write: if request.auth != null;
 *   }
 */

// Attribute display metadata: source field name -> label, grouped into
// the five sections requested. Exactly the 35 stored attribute keys —
// nothing added, nothing renamed in storage, this is presentation only.
const NBA2K_ATTRIBUTE_GROUPS = [
  {
    title: 'Finishing',
    keys: [
      ['closeShot', 'Close Shot'],
      ['layup', 'Driving Layup'],
      ['drivingDunk', 'Driving Dunk'],
      ['standingDunk', 'Standing Dunk'],
      ['postHook', 'Post Hook'],
      ['postFade', 'Post Fade'],
      ['postControl', 'Post Control'],
      ['drawFoul', 'Draw Foul'],
      ['hands', 'Hands'],
    ],
  },
  {
    title: 'Shooting',
    keys: [
      ['midRangeShot', 'Mid-Range Shot'],
      ['threePointShot', 'Three-Point Shot'],
      ['freeThrow', 'Free Throw'],
      ['shotIQ', 'Shot IQ'],
      ['offensiveConsistency', 'Offensive Consistency'],
    ],
  },
  {
    title: 'Playmaking',
    keys: [
      ['passAccuracy', 'Pass Accuracy'],
      ['ballHandle', 'Ball Handle'],
      ['speedWithBall', 'Speed With Ball'],
      ['passIQ', 'Pass IQ'],
      ['passVision', 'Pass Vision'],
    ],
  },
  {
    title: 'Physicals',
    keys: [
      ['speed', 'Speed'],
      ['agility', 'Agility'],
      ['strength', 'Strength'],
      ['vertical', 'Vertical'],
      ['stamina', 'Stamina'],
      ['hustle', 'Hustle'],
      ['overallDurability', 'Overall Durability'],
    ],
  },
  {
    title: 'Defense / Rebounding',
    keys: [
      ['interiorDefense', 'Interior Defense'],
      ['perimeterDefense', 'Perimeter Defense'],
      ['steal', 'Steal'],
      ['block', 'Block'],
      ['helpDefenseIQ', 'Help Defense IQ'],
      ['passPerception', 'Pass Perception'],
      ['defensiveConsistency', 'Defensive Consistency'],
      ['offensiveRebound', 'Offensive Rebound'],
      ['defensiveRebound', 'Defensive Rebound'],
    ],
  },
];

const NBA2K_BADGE_TIER_ORDER = ['Legendary', 'Hall of Fame', 'Gold', 'Silver', 'Bronze'];

const NBA2K_OVERALL_FILTERS = [
  { value: '', label: 'All Overalls' },
  { value: '90', label: '90+' },
  { value: '85', label: '85+' },
  { value: '80', label: '80+' },
  { value: '75', label: '75+' },
];

function nba2kOvrTierClass(ovr) {
  return ovr >= 90 ? 'pos-ovr-elite' : ovr >= 80 ? 'pos-ovr-good' : 'pos-ovr-role';
}

function nba2kAttrTierClass(v) {
  return v >= 90 ? 'nba2k-attr-elite' : v >= 80 ? 'nba2k-attr-good' : v >= 70 ? 'nba2k-attr-mid' : 'nba2k-attr-low';
}

const Nba2kDatabaseView = {
  // Session-level cache: populated once, reused across every render() call
  // for the lifetime of this page load (admin.js re-renders views often —
  // e.g. on every FirebaseSync remote-change — so re-fetching on every
  // render would defeat the "load once" requirement).
  _players: null,
  _loadPromise: null,
  _loadError: null,

  _search: '',
  _filterPos: '',
  _filterTeam: '',
  _filterOvr: '',
  _sortMode: 'ovr-desc',

  render(container) {
    if (this._players) {
      this._renderShell(container);
    } else {
      container.innerHTML = `
        <div class="admin-section">
          <div class="admin-section-header"><h2>NBA 2K26 Database</h2></div>
          <p class="backup-muted">Loading NBA 2K26 players…</p>
        </div>`;
      this._load(container);
    }
  },

  async _load(container) {
    if (!this._loadPromise) {
      this._loadPromise = firebase.firestore().collection('nba2k_players').get()
        .then(snap => {
          this._players = snap.docs.map(d => ({ id: d.id, ...d.data() }));
          this._loadError = null;
        })
        .catch(err => {
          this._players = null;
          // Never surface raw Firebase error text to the admin.
          this._loadError = err && err.code === 'permission-denied'
            ? "You don't have permission to access the NBA 2K26 database."
            : 'Unable to load the NBA 2K26 database.';
        })
        .finally(() => { this._loadPromise = null; });
    }
    await this._loadPromise;
    // The admin may have navigated to a different view while this was
    // in flight — only render if this view's container is still live.
    if (document.body.contains(container)) {
      this._renderShell(container);
    }
  },

  _renderShell(container) {
    if (this._loadError) {
      container.innerHTML = `
        <div class="admin-section">
          <div class="admin-section-header"><h2>NBA 2K26 Database</h2></div>
          <div class="backup-result backup-result-error">${escapeHtml(this._loadError)}</div>
        </div>`;
      return;
    }

    const players = this._players || [];
    const positions = [...new Set(players.flatMap(p => Array.isArray(p.positions) ? p.positions : []))].sort();
    const teams = [...new Set(players.map(p => p.team).filter(Boolean))].sort();

    container.innerHTML = `
      <div class="admin-section nba2k-db">
        <div class="admin-section-header">
          <h2>NBA 2K26 Database</h2>
        </div>
        <p class="nba2k-db-subtitle">
          Current NBA Players
          <span class="player-count">${players.length} Players</span>
        </p>

        ${players.length === 0 ? `
          <p class="backup-muted">No NBA 2K26 players found.</p>
        ` : `
          <div class="table-controls nba2k-controls">
            <input type="text" id="nba2kSearch" class="input search-input"
              placeholder="Search players…" value="${escapeHtml(this._search)}">

            <select id="nba2kPosFilter" class="input">
              <option value="">All Positions</option>
              ${positions.map(p => `<option value="${escapeHtml(p)}" ${this._filterPos === p ? 'selected' : ''}>${escapeHtml(p)}</option>`).join('')}
            </select>

            <select id="nba2kTeamFilter" class="input">
              <option value="">All Teams</option>
              ${teams.map(t => `<option value="${escapeHtml(t)}" ${this._filterTeam === t ? 'selected' : ''}>${escapeHtml(t)}</option>`).join('')}
            </select>

            <select id="nba2kOvrFilter" class="input">
              ${NBA2K_OVERALL_FILTERS.map(o => `<option value="${o.value}" ${this._filterOvr === o.value ? 'selected' : ''}>${o.label}</option>`).join('')}
            </select>

            <select id="nba2kSort" class="input" style="max-width:200px;">
              <option value="ovr-desc" ${this._sortMode === 'ovr-desc' ? 'selected' : ''}>Sort: OVR (High–Low)</option>
              <option value="ovr-asc" ${this._sortMode === 'ovr-asc' ? 'selected' : ''}>Sort: OVR (Low–High)</option>
              <option value="name-asc" ${this._sortMode === 'name-asc' ? 'selected' : ''}>Sort: Name (A–Z)</option>
              <option value="team-asc" ${this._sortMode === 'team-asc' ? 'selected' : ''}>Sort: Team (A–Z)</option>
            </select>
          </div>

          <div id="nba2kListWrap"></div>
        `}
      </div>
      <div id="nba2kDetailMount"></div>`;

    if (players.length === 0) return;

    container.querySelector('#nba2kSearch').oninput = e => { this._search = e.target.value; this._refreshList(container); };
    container.querySelector('#nba2kPosFilter').onchange = e => { this._filterPos = e.target.value; this._refreshList(container); };
    container.querySelector('#nba2kTeamFilter').onchange = e => { this._filterTeam = e.target.value; this._refreshList(container); };
    container.querySelector('#nba2kOvrFilter').onchange = e => { this._filterOvr = e.target.value; this._refreshList(container); };
    container.querySelector('#nba2kSort').onchange = e => { this._sortMode = e.target.value; this._refreshList(container); };

    this._refreshList(container);
  },

  _getVisiblePlayers() {
    const q = this._search.trim().toLowerCase();
    const minOvr = this._filterOvr ? Number(this._filterOvr) : null;

    let list = (this._players || []).filter(p => {
      if (q) {
        const hay = `${p.name || ''} ${p.team || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (this._filterPos) {
        const positions = Array.isArray(p.positions) ? p.positions : [];
        if (!positions.includes(this._filterPos)) return false;
      }
      if (this._filterTeam && p.team !== this._filterTeam) return false;
      if (minOvr !== null && !(Number(p.overall) >= minOvr)) return false;
      return true;
    });

    list = list.slice().sort((a, b) => {
      switch (this._sortMode) {
        case 'ovr-asc': return (a.overall ?? 0) - (b.overall ?? 0);
        case 'name-asc': return (a.name || '').localeCompare(b.name || '');
        case 'team-asc': return (a.team || '').localeCompare(b.team || '') || (b.overall ?? 0) - (a.overall ?? 0);
        case 'ovr-desc':
        default: return (b.overall ?? 0) - (a.overall ?? 0);
      }
    });

    return list;
  },

  _refreshList(container) {
    const wrap = container.querySelector('#nba2kListWrap');
    if (!wrap) return;
    const visible = this._getVisiblePlayers();

    if (!visible.length) {
      wrap.innerHTML = `<p class="backup-muted">No players match these filters.</p>`;
      return;
    }

    wrap.innerHTML = `
      <table class="admin-table nba2k-table">
        <thead>
          <tr>
            <th>Player</th>
            <th>OVR</th>
            <th>Position</th>
            <th>Team</th>
          </tr>
        </thead>
        <tbody>
          ${visible.map(p => this._renderRow(p)).join('')}
        </tbody>
      </table>`;

    wrap.querySelectorAll('[data-slug]').forEach(row => {
      const open = () => this._openDetail(container, row.dataset.slug);
      row.addEventListener('click', open);
      row.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    });
  },

  // ── Phase 3: promotion status/lookup helpers ──────────────────────────
  // Both read from LeagueData.getAllPlayers(), which is a synchronous,
  // no-network read of the already-live-synced local league cache (see
  // file header) — safe to call on every row render and every detail
  // open without worrying about staleness or extra Firestore traffic.

  _findPromotedEntry(slug) {
    return LeagueData.getAllPlayers().find(p => p.nba2kRef === slug) || null;
  },

  _findNameConflict(name) {
    const key = normalizePlayerName(name);
    return LeagueData.getAllPlayers().find(p => !p.nba2kRef && normalizePlayerName(p.name) === key) || null;
  },

  _renderRow(p) {
    const positions = Array.isArray(p.positions) && p.positions.length ? p.positions.join(', ') : '—';
    const ovr = Number(p.overall) || 0;
    const promoted = this._findPromotedEntry(p.id);
    const statusHtml = promoted
      ? `<span class="nba2k-status-pill nba2k-status-pill-${promoted.pool || 'none'}">In Draft Pool${promoted.pool ? ` · ${promoted.pool === 'green' ? 'Green' : 'Blue'}` : ''}</span>`
      : '';
    return `
      <tr data-slug="${escapeHtml(p.id)}" class="nba2k-row" tabindex="0" role="button" aria-label="View ${escapeHtml(p.name)} details">
        <td data-label="Player" class="nba2k-cell-player">${escapeHtml(p.name)}${statusHtml}</td>
        <td data-label="OVR" class="nba2k-cell-ovr"><span class="pos-ovr ${nba2kOvrTierClass(ovr)}">${ovr}</span></td>
        <td data-label="Position">${escapeHtml(positions)}</td>
        <td data-label="Team">${escapeHtml(p.team || '—')}</td>
      </tr>`;
  },

  _openDetail(container, slug) {
    const player = (this._players || []).find(p => p.id === slug);
    if (!player) return;

    const mount = container.querySelector('#nba2kDetailMount') || document.getElementById('nba2kDetailMount');
    if (!mount) return;

    const positions = Array.isArray(player.positions) && player.positions.length ? player.positions.join(', ') : '—';
    const ovr = Number(player.overall) || 0;
    const initials = (player.name || '?').split(/\s+/).map(w => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();

    const attrSections = NBA2K_ATTRIBUTE_GROUPS.map(group => {
      const rows = group.keys.map(([key, label]) => {
        const raw = player.attributes ? player.attributes[key] : undefined;
        const v = Number(raw);
        const hasValue = raw !== undefined && raw !== null && !isNaN(v);
        const pct = hasValue ? Math.max(0, Math.min(100, (v / 99) * 100)) : 0;
        return `
          <div class="nba2k-attr-row">
            <span class="nba2k-attr-label">${escapeHtml(label)}</span>
            <div class="nba2k-attr-bar-track">
              <div class="nba2k-attr-bar-fill ${hasValue ? nba2kAttrTierClass(v) : ''}" style="width:${pct}%"></div>
            </div>
            <span class="nba2k-attr-value">${hasValue ? v : '—'}</span>
          </div>`;
      }).join('');
      return `
        <div class="nba2k-attr-section">
          <h4>${escapeHtml(group.title)}</h4>
          ${rows}
        </div>`;
    }).join('');

    const badgeList = (player.badges && Array.isArray(player.badges.list)) ? player.badges.list : [];
    const badgesByTier = {};
    for (const b of badgeList) {
      if (!b || !b.tier) continue;
      (badgesByTier[b.tier] = badgesByTier[b.tier] || []).push(b);
    }
    const badgeSections = NBA2K_BADGE_TIER_ORDER
      .filter(tier => badgesByTier[tier] && badgesByTier[tier].length)
      .map(tier => `
        <div class="nba2k-badge-group">
          <h5 class="nba2k-badge-tier nba2k-badge-tier-${tier.toLowerCase().replace(/\s+/g, '-')}">${escapeHtml(tier)}</h5>
          <div class="nba2k-badge-chips">
            ${badgesByTier[tier].map(b => `<span class="nba2k-badge-chip" title="${escapeHtml(b.category || '')}">${escapeHtml(b.name)}</span>`).join('')}
          </div>
        </div>`).join('');

    mount.innerHTML = `
      <div class="modal-overlay" id="nba2kDetailOverlay">
        <div class="modal-card nba2k-detail-modal">
          <button type="button" class="nba2k-detail-close" id="nba2kDetailClose" aria-label="Close">×</button>

          <div class="nba2k-detail-header">
            <div class="nba2k-avatar">
              ${player.playerImage ? `<img src="${escapeHtml(player.playerImage)}" alt="" onerror="this.remove()">` : ''}
              <span class="nba2k-avatar-fallback">${escapeHtml(initials)}</span>
            </div>
            <div class="nba2k-detail-header-info">
              <div class="nba2k-detail-name">${escapeHtml(player.name)}</div>
              <div class="nba2k-detail-meta">
                <span class="pos-ovr ${nba2kOvrTierClass(ovr)} nba2k-detail-ovr">${ovr} OVR</span>
                <span>${escapeHtml(player.team || '—')}</span>
                <span>${escapeHtml(positions)}</span>
              </div>
              <div class="nba2k-detail-physicals">
                ${player.build ? `<span>${escapeHtml(player.build)}</span>` : ''}
                ${player.height ? `<span>${escapeHtml(player.height)}</span>` : ''}
                ${player.weight ? `<span>${escapeHtml(player.weight)}</span>` : ''}
                ${player.wingspan ? `<span>Wingspan ${escapeHtml(player.wingspan)}</span>` : ''}
              </div>
            </div>
          </div>

          <div class="nba2k-detail-body">
            <div class="nba2k-attr-groups">${attrSections}</div>

            <div class="nba2k-badges-section">
              <h4>Badges</h4>
              ${badgeSections || '<p class="backup-muted">No badges</p>'}
            </div>
          </div>

          ${this._renderPromotionSection(player)}
        </div>
      </div>`;

    const close = () => { mount.innerHTML = ''; };
    document.getElementById('nba2kDetailClose').onclick = close;
    document.getElementById('nba2kDetailOverlay').addEventListener('click', e => {
      if (e.target.id === 'nba2kDetailOverlay') close();
    });

    this._bindPromotionEvents(container, mount, player);
  },

  // ── Phase 3: "Add to Draft Pool" section ──────────────────────────────
  // Renders one of three mutually exclusive states for the selected
  // NBA2K player: already promoted (status only, no form), a name
  // conflict with a pre-existing non-NBA2K player (warning only, no
  // form), or the promotion form itself.
  _renderPromotionSection(player) {
    const promoted = this._findPromotedEntry(player.id);
    if (promoted) {
      const poolLabel = promoted.pool === 'green' ? 'Green Pool' : promoted.pool === 'blue' ? 'Blue Pool' : 'no pool set';
      return `
        <div class="nba2k-promo nba2k-promo-status">
          <div class="nba2k-promo-eyebrow">In Draft Pool</div>
          <div class="nba2k-promo-pool-label">${escapeHtml(poolLabel)}</div>
          <p class="helper-text">Draft Pool Position: ${escapeHtml(promoted.position || '—')} · NBA2K Reference: <code>${escapeHtml(player.id)}</code></p>
        </div>`;
    }

    const conflict = this._findNameConflict(player.name);
    if (conflict) {
      return `
        <div class="nba2k-promo">
          <div class="backup-result backup-result-error">
            <strong>An existing Draft Pool player with this name already exists.</strong>
            <div>${escapeHtml(conflict.name)} — ${escapeHtml(conflict.position || 'no position')}, ${escapeHtml(String(conflict.overall ?? '—'))} OVR${conflict.pool ? `, ${conflict.pool === 'green' ? 'Green' : 'Blue'} Pool` : ', no pool set'}.</div>
            <div style="margin-top:0.4rem;">Resolve this manually on the Players page before promoting — no player was created.</div>
          </div>
        </div>`;
    }

    const sourcePositions = Array.isArray(player.positions) ? player.positions.filter(Boolean) : [];
    const noPositions = sourcePositions.length === 0;
    // Fall back to the same manual 5-position list the existing Add
    // Player form offers, only when the source has none — never an
    // automatic pick when the source DOES have positions.
    const positionOptions = noPositions ? ['PG', 'SG', 'SF', 'PF', 'C'] : sourcePositions;

    return `
      <div class="nba2k-promo">
        <h4>Add to Draft Pool</h4>
        ${noPositions ? `<p class="backup-result backup-result-error" style="margin-bottom:0.75rem;">This player has no NBA2K positions on record — choose a Draft Pool position manually.</p>` : ''}

        <div class="nba2k-promo-row">
          <label for="nba2kPromoPosition">Position</label>
          <select id="nba2kPromoPosition" class="input">
            <option value="">—</option>
            ${positionOptions.map(pos => `<option value="${escapeHtml(pos)}">${escapeHtml(pos)}</option>`).join('')}
          </select>
        </div>

        <div class="nba2k-promo-row">
          <label>Pool</label>
          <div class="nba2k-promo-radios">
            <label><input type="radio" name="nba2kPromoPool" value="green"> Green Pool</label>
            <label><input type="radio" name="nba2kPromoPool" value="blue"> Blue Pool</label>
          </div>
        </div>

        <button type="button" class="btn btn-primary" id="nba2kPromoOpenConfirm" disabled>Add to Draft Pool</button>

        <div id="nba2kPromoConfirm" class="hidden"></div>
      </div>`;
  },

  _bindPromotionEvents(container, mount, player) {
    const posEl = mount.querySelector('#nba2kPromoPosition');
    const confirmBtn = mount.querySelector('#nba2kPromoOpenConfirm');
    if (!posEl || !confirmBtn) return; // already-promoted or conflict state — nothing to wire

    const poolRadios = () => [...mount.querySelectorAll('input[name="nba2kPromoPool"]')];
    const selectedPool = () => (poolRadios().find(r => r.checked) || {}).value || '';

    const updateEnabled = () => {
      confirmBtn.disabled = !(posEl.value && selectedPool());
    };
    posEl.onchange = updateEnabled;
    poolRadios().forEach(r => { r.onchange = updateEnabled; });

    confirmBtn.onclick = () => {
      const position = posEl.value;
      const pool = selectedPool();
      if (!position || !pool) return; // belt-and-suspenders; button is disabled otherwise

      const confirmEl = mount.querySelector('#nba2kPromoConfirm');
      const poolLabel = pool === 'green' ? 'Green' : 'Blue';
      confirmEl.classList.remove('hidden');
      confirmEl.innerHTML = `
        <div class="nba2k-promo-confirm-card">
          <div class="nba2k-promo-eyebrow">Add Player to Draft Pool</div>
          <div class="nba2k-promo-confirm-row"><span>Player</span><strong>${escapeHtml(player.name)}</strong></div>
          <div class="nba2k-promo-confirm-row"><span>NBA 2K26 OVR</span><strong>${escapeHtml(String(player.overall ?? '—'))}</strong></div>
          <div class="nba2k-promo-confirm-row"><span>Position</span><strong>${escapeHtml(position)}</strong></div>
          <div class="nba2k-promo-confirm-row"><span>Pool</span><strong>${escapeHtml(poolLabel)}</strong></div>
          <div class="nba2k-promo-confirm-row"><span>Source</span><strong>NBA2K26 Database</strong></div>
          <div class="nba2k-promo-confirm-row"><span>NBA2K Reference</span><strong><code>${escapeHtml(player.id)}</code></strong></div>
          <div class="form-actions">
            <button type="button" class="btn btn-primary" id="nba2kPromoConfirmBtn">Add Player</button>
            <button type="button" class="btn btn-ghost" id="nba2kPromoCancelBtn">Cancel</button>
          </div>
        </div>`;

      confirmEl.querySelector('#nba2kPromoCancelBtn').onclick = () => {
        confirmEl.classList.add('hidden');
        confirmEl.innerHTML = '';
      };

      confirmEl.querySelector('#nba2kPromoConfirmBtn').onclick = () => {
        AuthBoundary.requireAuth();

        // Re-check against the freshest available data immediately before
        // writing — LeagueData.getAllPlayers() is a synchronous read of
        // the live-synced local cache, so this costs nothing and closes
        // the window between opening this detail view and confirming.
        if (this._findPromotedEntry(player.id)) {
          confirmEl.innerHTML = `<div class="backup-result backup-result-error">This player was already added to the Draft Pool (in another tab/session) — no duplicate was created.</div>`;
          setTimeout(() => this._openDetail(container, player.id), 1200);
          return;
        }
        const nowConflict = this._findNameConflict(player.name);
        if (nowConflict) {
          confirmEl.innerHTML = `<div class="backup-result backup-result-error">An existing Draft Pool player with this name already exists — no duplicate was created.</div>`;
          setTimeout(() => this._openDetail(container, player.id), 1200);
          return;
        }

        AdminActions.addPlayer({
          name: player.name,
          position,
          overall: Number(player.overall) || 0,
          pool,
          nba2kRef: player.id,
        });

        showToast(`${player.name} added to ${poolLabel} Pool.`, 'success');

        // Reflect the new status without a page reload: re-render this
        // detail view (now shows "In Draft Pool" with the position/ref
        // recorded above) and the underlying table row (status pill).
        // This re-render replaces mount.innerHTML entirely, so there is
        // no separate "success" block left behind to go stale.
        this._openDetail(container, player.id);
        this._refreshList(container);
      };
    };
  },
};
