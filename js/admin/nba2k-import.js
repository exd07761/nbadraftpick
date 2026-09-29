/**
 * admin/nba2k-import.js — NBA 2K26 Database import
 * (Phase 1: Current players only. Phase 4: expanded to Current + Classics
 * + All-Time — the complete NBA2KAPI dataset across all three categories.)
 *
 * PURPOSE
 * One-time/repeatable admin tool that reads an NBA2KAPI-style JSON dump
 * (locally, via a file picker — nothing is uploaded anywhere but this
 * browser tab), normalizes a handful of known source data-quality
 * issues, and upserts one row per player into a *separate* Supabase
 * table:
 *
 *     public.nba2k_players (slug is the primary key)
 *
 * PHASE 8.3 CHANGE
 * Persistence moved from Firestore to Supabase: existing-slug detection
 * now reads public.nba2k_players directly (no more 30-item chunking —
 * that was a Firestore `in`-query limit, not a Postgres one, though a
 * defensive chunk size is still used for the read; see
 * _fetchExistingPlayers), and the actual write goes through the
 * `bulk_upsert_nba2k_players` Supabase RPC (SECURITY DEFINER,
 * commissioner-gated) instead of firebase.firestore().batch(). Every
 * other part of this file — validation, slug derivation, badge
 * de-duplication, the create/update preview, the import UI — is
 * unchanged. See _runImport() and _toRpcPlayer() for the write path, and
 * supabase/migrations/20260928150000_phase8_3_nba2k_players_bulk_import_rpc.sql
 * for the RPC itself.
 *
 * PHASE 4 CHANGE (the only behavioral change from Phase 1)
 * The `teamType === 'curr'` filter that limited this importer to current
 * players has been removed — it now imports all three source categories
 * (`curr`, `class`, `allt`) using the exact same per-player validation/
 * normalization pipeline Phase 1 already established. Nothing else about
 * that pipeline changed: verified against the real dataset available at
 * the time that Classic and All-Time records have zero missing
 * name/playerUrl/team/overall/attributes fields, and that the combined
 * set of records across all three categories produced zero slug
 * collisions — so the existing slug-as-primary-key upsert scheme needed
 * no adjustment to scale from Current-only to all three categories. This
 * was a point-in-time check against the dataset available at Phase 4;
 * it is not a currently-enforced invariant, so this file does not assume
 * any particular record count going forward.
 *
 * `teamType` is stored verbatim (`curr`/`class`/`allt`) — never renamed
 * to `green`/`blue`. Pool eligibility is a read-only *label* the
 * database browser derives from it (see nba2k-database.js) — this
 * importer has no concept of pools and never writes to `league/main`.
 *
 * SCOPE / NON-GOALS (unchanged since Phase 1)
 * This file NEVER reads or writes `league/main` — it does not touch
 * LeagueData, AdminActions, createPlayer(), addPlayer(), the CSV
 * importer, or any draft/roster/trade/pool logic anywhere in data.js.
 * The NBA2K player database and the app's existing player database
 * remain two entirely independent collections/identity-spaces.
 *
 * All Supabase access for this table is self-contained in this file,
 * via the shared SupabaseQuery helper (mirrors js/admin/backup.js, which
 * also talks to its own backend directly rather than routing through
 * data.js).
 *
 * SECURITY (Phase 8.3)
 * public.nba2k_players has no INSERT/UPDATE/DELETE row-level-security
 * policy for any role — the ONLY way to write to this table is the
 * `bulk_upsert_nba2k_players` RPC, which calls
 * public.require_commissioner() first. This is a real tightening from
 * the old Firestore rule (`allow read, write: if request.auth != null`),
 * which allowed any authenticated user, not just commissioners, to run
 * this importer. The existing-slug read (_fetchExistingPlayers) is not
 * commissioner-gated — it uses the table's own `conditional_read` SELECT
 * policy, matching the openness of the old read behavior.
 *
 * SLUG / DOCUMENT ID
 * The document ID is the last path segment of `playerUrl`
 * (e.g. "https://www.2kratings.com/trae-young" -> "trae-young").
 * Verified against the full dataset available at Phase 4 (all three
 * categories combined): every URL matched a clean `2kratings.com/<slug>`
 * shape, and every slug was globally unique — no Classic/All-Time record
 * collided with an existing Current slug or with each other. This was a
 * point-in-time check, not an ongoing guarantee about the dataset's
 * size or contents. See _slugFromPlayerUrl() for the exact rule and its
 * fallback.
 */
const Nba2kImport = {
  TABLE: 'nba2k_players',
  // Phase 8.3: Postgres/Supabase has no Firestore-style hard per-batch
  // op cap (that 500 was a Firestore limit). This value is intentionally
  // conservative rather than assumed-safe at the old Firestore number —
  // an untested single RPC call carrying the full ~2,000-player payload
  // (each with a sizeable attributes/badges jsonb blob, easily 2-3 KB of
  // JSON per player) risks an undiscovered request-size or
  // statement-timeout limit on the very first real run. 100 keeps each
  // call's payload comfortably small (well under a few hundred KB) and
  // still only needs ~20 sequential calls for the full dataset. Can be
  // tuned upward once a real run is observed to succeed comfortably.
  BATCH_LIMIT: 100,

  _lastParsed: null, // { toCreate: [...], toUpdate: [...], warnings: [...], errors: [...], sourceTotal, currTotal }
  _running: false,

  render(container) {
    container.innerHTML = `
      <div class="admin-section">
        <div class="admin-section-header">
          <h2>NBA 2K Player Database Import</h2>
        </div>
        <p class="helper-text">
          Imports the supplied NBA2K player JSON dataset (<code>nba2k-all-players.json</code>,
          covering Current, Classics, and All-Time players) into a separate
          <code>nba2k_players</code> Supabase table — this is a standalone
          reference database. It does not touch the existing Players page, pools,
          draft, rosters, or trades. Pool assignment only happens through the
          existing per-player promotion workflow in the NBA 2K Player Database browser.
        </p>

        <div class="csv-drop-zone" id="nba2kDropZone">
          <span id="nba2kFileLabel">Drop JSON file here or</span>
          <label class="btn btn-ghost file-label">
            Browse
            <input type="file" id="nba2kFileInput" accept=".json,application/json" class="hidden-input">
          </label>
        </div>

        <div id="nba2kPreview"></div>

        <div class="form-actions">
          <button type="button" class="btn btn-primary hidden" id="btnNba2kConfirm">Confirm Import</button>
          <button type="button" class="btn btn-ghost hidden" id="btnNba2kCancel">Cancel</button>
        </div>

        <div id="nba2kResult"></div>
      </div>`;

    const fileInput = container.querySelector('#nba2kFileInput');
    const dropZone = container.querySelector('#nba2kDropZone');

    fileInput.onchange = e => this._handleFile(container, e.target.files[0]);

    dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
    dropZone.addEventListener('drop', e => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
      const file = e.dataTransfer.files[0];
      if (file) this._handleFile(container, file);
    });

    container.querySelector('#btnNba2kCancel').onclick = () => this._resetPreview(container);
    container.querySelector('#btnNba2kConfirm').onclick = () => this._runImport(container);
  },

  _resetPreview(container) {
    this._lastParsed = null;
    container.querySelector('#nba2kFileLabel').textContent = 'Drop JSON file here or';
    container.querySelector('#nba2kPreview').innerHTML = '';
    container.querySelector('#btnNba2kConfirm').classList.add('hidden');
    container.querySelector('#btnNba2kCancel').classList.add('hidden');
    container.querySelector('#nba2kFileInput').value = '';
  },

  async _handleFile(container, file) {
    if (!file) return;
    container.querySelector('#nba2kFileLabel').textContent = file.name;
    container.querySelector('#nba2kResult').innerHTML = '';

    const previewEl = container.querySelector('#nba2kPreview');
    previewEl.innerHTML = `<p class="helper-text">Reading file…</p>`;

    try {
      const text = await file.text();
      const json = JSON.parse(text);
      await this._validateAndPreview(container, json);
    } catch (e) {
      previewEl.innerHTML = `
        <div class="backup-result backup-result-error">
          <strong>✕ Could not read file</strong>
          <div>${escapeHtml(e.message || 'Invalid JSON.')}</div>
        </div>`;
      container.querySelector('#btnNba2kConfirm').classList.add('hidden');
      container.querySelector('#btnNba2kCancel').classList.remove('hidden');
    }
  },

  /**
   * Validates the uploaded JSON, normalizes known data-quality issues for
   * every player (Current, Classics, and All-Time alike — Phase 4 removed
   * the Phase 1 `teamType === 'curr'` filter), and diffs against existing
   * Firestore docs to compute create/update counts — all WITHOUT writing
   * anything.
   */
  async _validateAndPreview(container, json) {
    const previewEl = container.querySelector('#nba2kPreview');
    const errors = [];
    const warnings = [];

    if (!json || !Array.isArray(json.players)) {
      previewEl.innerHTML = `
        <div class="backup-result backup-result-error">
          <strong>✕ Invalid file</strong>
          <div>Expected a top-level "players" array — this doesn't look like an NBA2KAPI dump.</div>
        </div>`;
      container.querySelector('#btnNba2kConfirm').classList.add('hidden');
      container.querySelector('#btnNba2kCancel').classList.remove('hidden');
      return;
    }

    const sourceTotal = json.players.length;
    // Phase 4: import every record regardless of teamType. `teamType` is
    // preserved verbatim on each document (see the doc literal below) —
    // this loop no longer filters by it at all.
    const allRaw = json.players.filter(p => p && typeof p === 'object');

    // Per-player validation. A missing REQUIRED field skips that one
    // player (with an error) rather than aborting the whole import.
    // Missing OPTIONAL fields (positions, badges.list) are normalized
    // and recorded as warnings, not errors.
    const seenSlugs = new Map(); // slug -> name, to catch in-file collisions
    const normalized = [];
    const categoryCounts = { curr: 0, class: 0, allt: 0, other: 0 };
    let excludedByOverall = 0; // Phase 8.3.1: records outside 75-99, tracked separately from errors/warnings

    for (const raw of allRaw) {
      const name = typeof raw.name === 'string' ? raw.name.trim() : '';
      const playerUrl = typeof raw.playerUrl === 'string' ? raw.playerUrl.trim() : '';
      const team = typeof raw.team === 'string' ? raw.team.trim() : '';
      const overall = raw.overall;
      const attributes = raw.attributes;
      const teamType = raw.teamType;

      const missingRequired = [];
      if (!name) missingRequired.push('name');
      if (!playerUrl) missingRequired.push('playerUrl');
      if (!team) missingRequired.push('team');
      if (!teamType) missingRequired.push('teamType');
      if (overall === undefined || overall === null || isNaN(Number(overall))) missingRequired.push('overall');
      if (!attributes || typeof attributes !== 'object') missingRequired.push('attributes');

      if (missingRequired.length) {
        errors.push(`Skipped "${name || '(unnamed record)'}" — missing required field(s): ${missingRequired.join(', ')}.`);
        continue;
      }

      // Phase 8.3.1: only 75 <= overall <= 99 is imported into
      // nba2k_players. This is NEW filtering — no OVR range check
      // existed in this file before this phase; the fresh NBA2KAPI
      // datasets contain many records outside this range that must
      // never reach the RPC. Excluded records are neither an error nor
      // a warning (nothing is wrong with them) — they're simply out of
      // scope for this table, tracked separately in excludedByOverall.
      const overallNum = Number(overall);
      if (overallNum < 75 || overallNum > 99) {
        excludedByOverall++;
        continue;
      }

      const slug = this._slugFromPlayerUrl(playerUrl);
      if (!slug) {
        errors.push(`Skipped "${name}" — could not derive a document ID slug from playerUrl "${playerUrl}".`);
        continue;
      }
      if (seenSlugs.has(slug)) {
        errors.push(`Skipped "${name}" — duplicate slug "${slug}" in this file (already used by "${seenSlugs.get(slug)}").`);
        continue;
      }
      seenSlugs.set(slug, name);

      if (teamType === 'curr' || teamType === 'class' || teamType === 'allt') {
        categoryCounts[teamType]++;
      } else {
        categoryCounts.other++;
        warnings.push(`"${name}" has an unrecognized teamType "${String(teamType)}" — imported as-is, but it won't appear under Current/Classics/All-Time in the database browser's category filter.`);
      }

      // positions: array in source; missing entirely for at least one
      // known record (Nique Clifford) — normalize to [].
      let positions = raw.positions;
      if (!Array.isArray(positions)) {
        warnings.push(`"${name}" has no positions listed — stored as an empty list.`);
        positions = [];
      }

      // badges: object always present in source, but badges.list is
      // entirely absent for some records rather than being an empty
      // array. Phase 8.3.1-B: an explicit `badges.list: []` IS a valid,
      // intentional source value (Array.isArray([]) === true) — only a
      // MISSING or non-array badges.list is treated as "no source data,"
      // which _toRpcPlayer uses to decide whether to preserve an
      // existing player's current badges instead of overwriting them
      // with this normalized-empty placeholder. hasValidSourceBadgeList
      // is carried on the doc so that decision can be made later,
      // without needing to know here whether this slug is new or existing.
      const rawBadges = raw.badges && typeof raw.badges === 'object' ? raw.badges : {};
      const hasValidSourceBadgeList = Array.isArray(rawBadges.list);
      let badgeList = hasValidSourceBadgeList ? rawBadges.list : [];
      if (!hasValidSourceBadgeList) {
        warnings.push(`"${name}" has no valid badges.list from the source — if this player already exists, their current badge data will be preserved; otherwise they'll be imported with an empty badge list. The player will still be imported either way.`);
      }

      // De-duplicate badges by (name + tier + category) — the source
      // lists every badge twice for the large majority of players across
      // all three categories. total / legendary / hallOfFame / gold /
      // silver / bronze counts from the source are preserved as-is
      // (verified during inspection to already match the DEDUPED list,
      // not the raw doubled one).
      const seenBadgeKeys = new Set();
      const dedupedBadges = [];
      for (const b of badgeList) {
        if (!b || typeof b !== 'object') continue;
        const key = `${b.name}|${b.tier}|${b.category}`;
        if (seenBadgeKeys.has(key)) continue;
        seenBadgeKeys.add(key);
        dedupedBadges.push(b);
      }
      if (dedupedBadges.length !== badgeList.length) {
        warnings.push(`"${name}" had ${badgeList.length - dedupedBadges.length} duplicate badge entr${badgeList.length - dedupedBadges.length === 1 ? 'y' : 'ies'} removed.`);
      }
      // Only meaningful when the source actually provided a list — with
      // no list at all, comparing an empty placeholder against a nonzero
      // `total` would just be noise on top of the warning already logged
      // above, for every affected record.
      if (hasValidSourceBadgeList && dedupedBadges.length !== Number(rawBadges.total || 0)) {
        warnings.push(`"${name}" badge total (${rawBadges.total ?? 0}) doesn't match the deduplicated badge count (${dedupedBadges.length}) — stored as-is from source; not auto-corrected.`);
      }

      const badges = {
        legendary: rawBadges.legendary ?? 0,
        hallOfFame: rawBadges.hallOfFame ?? 0,
        gold: rawBadges.gold ?? 0,
        silver: rawBadges.silver ?? 0,
        bronze: rawBadges.bronze ?? 0,
        total: rawBadges.total ?? 0,
        list: dedupedBadges,
      };

      normalized.push({
        slug,
        doc: {
          name,
          team,
          teamType, // preserved verbatim — 'curr' | 'class' | 'allt', never renamed to green/blue
          overall: overallNum,
          positions,
          height: raw.height ?? null,
          weight: raw.weight ?? null,
          wingspan: raw.wingspan ?? null,
          build: raw.build ?? null,
          playerUrl,
          playerImage: raw.playerImage ?? null,
          teamImg: raw.teamImg ?? null,
          attributes,
          badges,
          hasValidSourceBadgeList, // Phase 8.3.1-B — see _toRpcPlayer
          lastUpdated: raw.lastUpdated ?? null,
          // Phase 8.3: importedAt is no longer set here — the
          // bulk_upsert_nba2k_players RPC always stamps it server-side
          // with now(), the same way selected_at/updated_at are handled
          // by every other write RPC in this migration.
        },
      });
    }

    // Diff against existing Supabase rows to split create vs. update.
    // Chunked defensively (see _fetchExistingPlayers) — read-only, no
    // writes happen here. Phase 8.3.1: also captures each existing row's
    // current name/positions, needed at import time to preserve them
    // (see _toRpcPlayer) — stored on _lastParsed below rather than
    // re-fetched in _runImport, avoiding a second redundant read.
    let existingPlayers;
    try {
      existingPlayers = await this._fetchExistingPlayers(normalized.map(n => n.slug));
    } catch (e) {
      previewEl.innerHTML = `
        <div class="backup-result backup-result-error">
          <strong>✕ Could not check existing NBA2K players</strong>
          <div>${escapeHtml(e.message || 'Supabase read failed.')}</div>
          <div style="margin-top:0.5rem;">Confirm you're signed in and the <code>nba2k_players</code> table is reachable.</div>
        </div>`;
      container.querySelector('#btnNba2kConfirm').classList.add('hidden');
      container.querySelector('#btnNba2kCancel').classList.remove('hidden');
      return;
    }

    const toCreate = normalized.filter(n => !existingPlayers.has(n.slug));
    const toUpdate = normalized.filter(n => existingPlayers.has(n.slug));

    this._lastParsed = {
      sourceTotal,
      importTotal: allRaw.length,
      categoryCounts,
      excludedByOverall,
      existingPlayers,
      toCreate,
      toUpdate,
      warnings,
      errors,
    };

    previewEl.innerHTML = `
      <div class="backup-latest">
        <div><span class="backup-latest-label">Source records:</span> ${sourceTotal}</div>
        <div><span class="backup-latest-label">Current:</span> ${categoryCounts.curr}</div>
        <div><span class="backup-latest-label">Classics:</span> ${categoryCounts.class}</div>
        <div><span class="backup-latest-label">All-Time:</span> ${categoryCounts.allt}</div>
        ${categoryCounts.other ? `<div><span class="backup-latest-label">Other/unrecognized teamType:</span> ${categoryCounts.other}</div>` : ''}
        <div><span class="backup-latest-label">Existing:</span> ${existingPlayers.size}</div>
        <div><span class="backup-latest-label">New:</span> ${toCreate.length}</div>
        <div><span class="backup-latest-label">Updates:</span> ${toUpdate.length}</div>
        <div><span class="backup-latest-label">Excluded (OVR outside 75–99):</span> ${excludedByOverall}</div>
        <div><span class="backup-latest-label">Validation warnings:</span> ${warnings.length}</div>
        <div><span class="backup-latest-label">Validation errors:</span> ${errors.length}</div>
      </div>
      <p class="helper-text" style="margin-top:0.5rem;">
        For existing players, <code>name</code> and <code>positions</code> are preserved from the
        current database record and will NOT be overwritten by this dataset — every other field
        updates from the source data. New players use the source data as-is, positions included.
        <code>badges</code> updates normally when the source provides a badge list (including an
        explicit empty one) — only a genuinely missing/invalid source badge list falls back to
        preserving an existing player's current badges instead of clearing them.
      </p>
      ${warnings.length ? `
        <details style="margin-top:0.75rem;">
          <summary class="helper-text" style="cursor:pointer;">Show ${warnings.length} warning(s) (non-fatal — these players will still be imported)</summary>
          <ul class="helper-text">${warnings.slice(0, 200).map(w => `<li>${escapeHtml(w)}</li>`).join('')}</ul>
          ${warnings.length > 200 ? `<p class="helper-text">…and ${warnings.length - 200} more.</p>` : ''}
        </details>` : ''}
      ${errors.length ? `
        <details open style="margin-top:0.75rem;">
          <summary class="helper-text" style="cursor:pointer;">Show ${errors.length} error(s) (these players will be skipped, not imported)</summary>
          <ul class="helper-text">${errors.slice(0, 200).map(w => `<li>${escapeHtml(w)}</li>`).join('')}</ul>
          ${errors.length > 200 ? `<p class="helper-text">…and ${errors.length - 200} more.</p>` : ''}
        </details>` : ''}
    `;

    const confirmBtn = container.querySelector('#btnNba2kConfirm');
    if (toCreate.length + toUpdate.length > 0) {
      confirmBtn.classList.remove('hidden');
      confirmBtn.textContent = `Import ${toCreate.length + toUpdate.length} Player(s)`;
    } else {
      confirmBtn.classList.add('hidden');
    }
    container.querySelector('#btnNba2kCancel').classList.remove('hidden');
  },

  /**
   * Reads which of the given slugs already exist in nba2k_players, along
   * with each one's CURRENT `name`, `positions`, and `badges`. Read-only
   * — used to classify create vs. update in the preview (via the
   * returned Map's `.has()`/`.size`, a drop-in replacement for the Set
   * this used to return), and reused again at write time to preserve
   * `name`/`positions` unconditionally (Phase 8.3.1), and `badges`
   * conditionally when the source has no valid badges.list (Phase
   * 8.3.1-B — see _toRpcPlayer for both). Phase 8.3: reads Supabase
   * directly via the shared SupabaseQuery helper, under the table's
   * existing `conditional_read` SELECT policy — no commissioner gate
   * needed for a read, matching the openness of the old Firestore rule
   * for this same operation. Postgres/PostgREST has no Firestore-style
   * 30-item `in`-query cap, but `.in()` is sent as a GET query-string
   * filter, so a defensive chunk size is still used to avoid an
   * oversized URL for the full ~2,000-slug case — 200 is comfortably
   * under typical URL/header length limits while still far above
   * Firestore's old 30-item cap.
   */
  async _fetchExistingPlayers(slugs) {
    const existing = new Map();
    const CHUNK = 200;
    for (let i = 0; i < slugs.length; i += CHUNK) {
      const chunk = slugs.slice(i, i + CHUNK);
      if (!chunk.length) continue;
      const rows = await SupabaseQuery.select(this.TABLE, qb =>
        qb.select('slug, name, positions, badges').in('slug', chunk)
      );
      rows.forEach(row => existing.set(row.slug, { name: row.name, positions: row.positions, badges: row.badges }));
    }
    return existing;
  },

  // Phase 8.3: maps a validated/normalized preview item (still the same
  // camelCase `{ slug, doc: {...} }` shape _validateAndPreview() has
  // always produced — unchanged, per the requirement to preserve
  // existing validation/preview behavior) into the snake_case parameter
  // shape bulk_upsert_nba2k_players() expects. `imported_at` is
  // deliberately NOT included — the RPC always sets it server-side via
  // now().
  //
  // Phase 8.3.1: `existingPlayers` (the Map from _fetchExistingPlayers,
  // stored on _lastParsed) is optional — omitted or not containing this
  // slug means a genuinely new player, so the API's own `name`/
  // `positions` are used unmodified (including unusual All-Time source
  // positions like ["C","N"] — no position-cleaning is invented here).
  // For a slug that DOES already exist, `name`/`positions` are pulled
  // from the existing DB row instead of the fresh API doc — the RPC
  // itself always does a full-column overwrite, so this substitution has
  // to happen here, before the write, to keep those two fields
  // authoritative to the local database rather than the API. Every other
  // field always comes from the fresh API data, for both new and
  // existing players.
  //
  // Phase 8.3.1-B: `badges` gets its OWN, narrower rule — unlike name/
  // positions, it is NOT unconditionally preserved. It's only pulled
  // from the existing DB row when BOTH (a) the player already exists AND
  // (b) doc.hasValidSourceBadgeList is false, meaning the source had no
  // badges.list at all (or a non-array one) for this record — not merely
  // an explicit empty list, which IS treated as real source data and
  // updates the player to zero badges, same as any other API field. A
  // genuinely new player always uses doc.badges as built by
  // _validateAndPreview, which is already a canonical (possibly empty)
  // structure regardless of source validity — never blocked on this.
  _toRpcPlayer(item, existingPlayers) {
    const doc = item.doc;
    const existing = existingPlayers ? existingPlayers.get(item.slug) : undefined;
    const preserveBadges = !!existing && !doc.hasValidSourceBadgeList;
    return {
      slug: item.slug,
      name: existing ? existing.name : doc.name,
      team: doc.team,
      team_type: doc.teamType,
      overall: doc.overall,
      positions: existing ? existing.positions : doc.positions,
      height: doc.height,
      weight: doc.weight,
      wingspan: doc.wingspan,
      build: doc.build,
      player_url: doc.playerUrl,
      player_image: doc.playerImage,
      team_img: doc.teamImg,
      attributes: doc.attributes,
      badges: preserveBadges ? existing.badges : doc.badges,
      last_updated: doc.lastUpdated,
    };
  },

  // Phase 8.3: maps the "PREFIX: message" errors raised by
  // bulk_upsert_nba2k_players() (same convention as every other RPC in
  // this migration) to a friendly, UI-safe message — never surfaces a
  // raw Postgres/RPC error.
  _mapImportRpcError(err) {
    const message = err && err.message ? err.message : '';

    if (message.includes('UNAUTHENTICATED') || message.includes('UNAUTHORIZED')) {
      return "You don't have permission to import NBA2K players — commissioner access is required.";
    }
    if (message.includes('INVALID_PAYLOAD')) {
      return 'Could not import — the data sent to the server was malformed. Please try again.';
    }
    return message || 'Unknown error.';
  },

  async _runImport(container) {
    if (this._running || !this._lastParsed) return;
    AuthBoundary.requireAuth();

    const { toCreate, toUpdate, warnings, errors, sourceTotal, importTotal, categoryCounts, excludedByOverall } = this._lastParsed;
    const all = [...toCreate, ...toUpdate];

    if (!all.length) return;

    this._running = true;
    const confirmBtn = container.querySelector('#btnNba2kConfirm');
    const resultEl = container.querySelector('#nba2kResult');
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Importing…';
    resultEl.innerHTML = '';

    try {
      let processed = 0;

      // Phase 8.3: targeted bulk write via RPC, chunked client-side.
      // Postgres/Supabase has no Firestore-style hard per-batch op cap,
      // but BATCH_LIMIT is intentionally conservative rather than
      // assumed-safe at the old Firestore number — see its declaration
      // above for why. Never assumes any fixed dataset size; scales to
      // whatever the file has.
      for (let i = 0; i < all.length; i += this.BATCH_LIMIT) {
        const chunk = all.slice(i, i + this.BATCH_LIMIT);
        const payload = chunk.map(item => this._toRpcPlayer(item, this._lastParsed.existingPlayers));
        // Full upsert — source is authoritative per re-import. The RPC's
        // ON CONFLICT DO UPDATE explicitly re-sets every imported
        // column, matching Firestore's old merge:false "never leaves a
        // stale value behind" behavior.
        await SupabaseQuery.callWriteRpc('bulk_upsert_nba2k_players', { p_players: payload });
        processed += chunk.length;
      }

      resultEl.innerHTML = `
        <div class="backup-result backup-result-success">
          <strong>✓ Import completed</strong>
          <div>Total processed: ${processed}</div>
          <div>Created: ${toCreate.length}</div>
          <div>Updated: ${toUpdate.length}</div>
          <div>Skipped (validation errors): ${errors.length}</div>
          <div>Excluded (OVR outside 75–99): ${excludedByOverall}</div>
          <div>Warnings (non-fatal): ${warnings.length}</div>
          <div style="margin-top:0.5rem;">Breakdown — Current: ${categoryCounts.curr} · Classics: ${categoryCounts.class} · All-Time: ${categoryCounts.allt}${categoryCounts.other ? ` · Other: ${categoryCounts.other}` : ''}</div>
          <div>Source records in file: ${sourceTotal}</div>
        </div>`;
      showToast('NBA 2K player database import completed.', 'success');
      confirmBtn.classList.add('hidden');
    } catch (e) {
      resultEl.innerHTML = `
        <div class="backup-result backup-result-error">
          <strong>✕ Import failed</strong>
          <div>${escapeHtml(this._mapImportRpcError(e))}</div>
        </div>`;
      showToast('NBA 2K player import failed.', 'error');
    } finally {
      this._running = false;
      confirmBtn.disabled = false;
    }
  },

  /**
   * Derives a slug (used as the nba2k_players primary key) from a
   * 2kratings.com player URL.
   * Verified against the full dataset available at Phase 4 (Current +
   * Classics + All-Time combined): every URL matched
   * `https://www.2kratings.com/<slug>` (optionally with a trailing
   * slash) with an already-unique, lowercase, hyphenated slug — zero
   * collisions across all three categories at that time. This is a
   * point-in-time observation, not an assumption baked into the code —
   * the fallback path below exists precisely for any dataset (past or
   * future) that doesn't follow that exact shape.
   */
  _slugFromPlayerUrl(url) {
    try {
      const path = new URL(url).pathname; // strips query string/host safely
      const segments = path.split('/').filter(Boolean);
      const last = segments[segments.length - 1];
      if (!last) return null;
      // Kept conservative (no "/", not ".", not "..") from this slug's
      // original days as a Firestore document ID; still a reasonable,
      // safe shape for a Postgres primary key value, so the check is
      // left as-is.
      const slug = last.trim().toLowerCase();
      if (!slug || slug === '.' || slug === '..' || slug.includes('/')) return null;
      return slug;
    } catch (e) {
      return null;
    }
  },
};
