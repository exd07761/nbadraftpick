/**
 * admin/nba2k27-live-import.js — NBA 2K27 Live API Update Importer
 *
 * PURPOSE
 * A NEW, separate admin workflow for refreshing `nba2k_players` overall/
 * badges from the NBA2K27 Live API's three local JSON exports, and for
 * onboarding brand-new (overall >= 74) players into both `nba2k_players`
 * and `nba2k27_pool`. This file is entirely additive — it does not
 * modify, replace, or share any code path with `js/admin/nba2k-import.js`
 * (the original NBA2K26-era full-upsert importer), or
 * `js/admin/nba2k-database.js` (the browser / promotion / pool-management
 * admin view). These workflows remain separate.
 *
 * SOURCE FILES (never committed to the repo — provided locally via file
 * picker each time, exactly like the original importer's UX)
 *   nba2k27-current.json   (teamType 'curr' records)
 *   nba2k27-classic.json   (teamType 'class' records)
 *   nba2k27-alltime.json   (teamType 'allt' records)
 * Each file's envelope: { success, data: [...], meta }. This importer
 * accepts 1-3 files via a single multi-file picker and classifies every
 * record by its OWN `teamType` field rather than trusting the filename —
 * more robust if files are renamed or a single file ever contains a
 * mixed batch. Every record carries a literal `slug` field (this is a
 * DIFFERENT source shape from the old NBA2K26 dataset, which had no
 * `slug` field and instead derived one from `playerUrl` — see
 * nba2k-import.js's `_slugFromPlayerUrl`. This importer never derives a
 * slug from a URL; it trusts the source's own `slug` field as the
 * Firestore document ID, exactly as directed.).
 *
 * CORE SAFETY RULES (the entire reason this is a separate workflow
 * instead of an extension of the old one, which does a full
 * `{ merge: false }` overwrite on every run):
 *
 *   EXISTING nba2k_players/<slug> (slug already present in the
 *   collection at preview time):
 *     - Only `overall` and `badges` are ever candidates for a write.
 *     - A write is issued ONLY when the normalized incoming `overall`
 *       and/or `badges` actually differ from what's stored (canonical
 *       comparison — badge list order never counts as a "change"). If
 *       neither differs: zero writes, not even a no-op touch.
 *     - When a write IS needed: `batch.update(ref, { overall, badges })`
 *       — NEVER `.set()`. `.update()` is structurally incapable of
 *       touching any field not named in its payload, so `positions`,
 *       `attributes`, `playerUrl`, `teamImg`, everything else on the
 *       document (including anything a future admin tool might add) is
 *       guaranteed untouched no matter what.
 *     - This applies uniformly regardless of overall (a 73/74-rated
 *       existing player is still updated exactly like any other).
 *
 *   EXISTING PLAYER'S nba2k27_pool/<slug> — ABSOLUTE PROTECTION:
 *     - ZERO writes, ever, for any slug that already exists in
 *       `nba2k_players` — even if that slug has NO nba2k27_pool document
 *       at all, even if its teamType/overall/badges changed, even if its
 *       overall is now below 74. This importer NEVER creates, corrects,
 *       or touches a pool document for an existing player. (Contrast
 *       `Nba2kDatabaseView._runInitialization()` in nba2k-database.js,
 *       which intentionally backfills pool docs for existing players —
 *       that is a DIFFERENT, unmodified feature; this importer simply
 *       never does that.)
 *     - This also means `position`, `nameOverride`, `overallOverride`,
 *       `teamOverride`, `variantGroupId`, `variantLabel` on any existing
 *       pool document are always left completely alone — this importer
 *       never issues a write that could touch them.
 *
 *   GENUINELY NEW slug (not present in `nba2k_players` at preview time):
 *     - overall >= 74: create `nba2k_players/<slug>` using the EXACT
 *       same normalization/schema/badge-dedupe pipeline as
 *       nba2k-import.js (ported verbatim below — see
 *       `_normalizeRecord()`), then create `nba2k27_pool/<slug>` with
 *       exactly `{ nba2kRef, pool, position: 'UNASSIGNED', selectedAt,
 *       updatedAt }` — `selectedAt`/`updatedAt` use the same
 *       `new Date().toISOString()` convention nba2k-database.js's own
 *       pool-creation paths already use (Phase 7 "Add to 2K27 Pool",
 *       Phase 10 "Initialize 2K27 Pool") — never Firestore
 *       serverTimestamp() for these two fields.
 *     - overall <= 73: skipped completely — neither document is created.
 *     - Unrecognized/missing teamType: pool cannot be derived (this
 *       importer never guesses a pool, matching
 *       `nba2k27PoolForTeamType()`'s own contract in nba2k-database.js)
 *       — neither document is created, regardless of overall.
 *     - Defensive guard: even when a brand-new player qualifies, if a
 *       `nba2k27_pool/<slug>` document *somehow* already exists (e.g.
 *       an orphaned doc from manual admin action), this importer will still
 *       create the player doc but will NOT touch that existing pool
 *       doc — never risk overwriting stray but real curated data.
 *
 *   DUPLICATE SLUGS: first occurrence across the combined three files
 *   wins. Any later record sharing that slug is flagged and completely
 *   excluded from processing — it can never overwrite or merge with the
 *   first.
 *
 *   RERUN SAFETY: importing the exact same three files again produces
 *   zero writes to unchanged existing players, zero writes to any
 *   existing pool document, and zero duplicate pool documents (already
 *   covered by "genuinely new slug" above — a slug that got a pool doc
 *   on a prior run is no longer "new" on the next run, since it now
 *   exists in `nba2k_players`).
 *
 * FIRESTORE READ STRATEGY
 * Reads the ENTIRE `nba2k_players` and `nba2k27_pool` collections once
 * per preview (two plain `.get()` calls) — this mirrors the established
 * convention already used throughout this codebase for these two
 * collections (`LiveNba2k27PoolCache.ensureLoaded()` in js/data.js and
 * `Nba2kDatabaseView`'s own initial load), both of which already load
 * both collections whole at their current ~2,000-document scale rather
 * than issuing per-slug lookups. No writes happen during preview.
 *
 * WRITE / BATCH STRATEGY
 * Three independent op lists, each chunked at the Firestore hard cap of
 * 500 ops/batch, committed in this order (players before their pool docs,
 * so nba2k27_pool's implicit "must reference an existing nba2k_players slug"
 * invariant is never violated even transiently):
 *   Phase A — existing-player `overall`/`badges` updates (`.update()`)
 *   Phase B — new-player `nba2k_players` creates (`.set()`, brand new
 *             docs only — never overwrites an existing one)
 *   Phase C — new-player `nba2k27_pool` creates (`.set()`)
 *
 * SCOPE / NON-GOALS
 * Never reads or writes `league/main`, never calls
 * `AdminActions.addPlayer()`/`createPlayer()`, never touches any
 * Supabase table. All Firestore access is self-contained in this file.
 */
const Nba2k27LiveImportView = {
  COLLECTION_PLAYERS: 'nba2k_players',
  COLLECTION_POOL: 'nba2k27_pool',
  BATCH_LIMIT: 500, // Firestore hard cap on ops per batch
  NEW_PLAYER_MIN_OVERALL: 74,

  _lastParsed: null,
  _running: false,

  render(container) {
    container.innerHTML = `
      <div class="admin-section">
        <div class="admin-section-header">
          <h2>NBA 2K27 Live API Update</h2>
        </div>
        <p class="helper-text">
          Select up to three local NBA2K27 Live API export files
          (<code>nba2k27-current.json</code>, <code>nba2k27-classic.json</code>,
          <code>nba2k27-alltime.json</code> — <code>{ success, data: [...], meta }</code>
          envelope, records classified by their own <code>teamType</code>).
          Existing players only ever get <code>overall</code>/<code>badges</code>
          updated when those actually changed. New players with overall &ge;
          ${this.NEW_PLAYER_MIN_OVERALL} are added to the pool as UNASSIGNED;
          overall &le; ${this.NEW_PLAYER_MIN_OVERALL - 1} is skipped entirely.
          Existing pool selections, positions, and manual overrides are never touched.
        </p>

        <div class="csv-drop-zone" id="nba27LiveDropZone">
          <span id="nba27LiveFileLabel">Drop JSON file(s) here or</span>
          <label class="btn btn-ghost file-label">
            Browse
            <input type="file" id="nba27LiveFileInput" accept=".json,application/json" multiple class="hidden-input">
          </label>
        </div>

        <div id="nba27LivePreview"></div>

        <div class="form-actions">
          <button type="button" class="btn btn-primary hidden" id="btnNba27LiveApply">Apply Changes</button>
          <button type="button" class="btn btn-ghost hidden" id="btnNba27LiveCancel">Cancel</button>
        </div>

        <div id="nba27LiveResult"></div>
      </div>`;

    const fileInput = container.querySelector('#nba27LiveFileInput');
    const dropZone = container.querySelector('#nba27LiveDropZone');

    fileInput.onchange = e => this._handleFiles(container, Array.from(e.target.files || []));

    dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
    dropZone.addEventListener('drop', e => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
      this._handleFiles(container, Array.from((e.dataTransfer && e.dataTransfer.files) || []));
    });

    container.querySelector('#btnNba27LiveCancel').onclick = () => this._resetPreview(container);
    container.querySelector('#btnNba27LiveApply').onclick = () => this._runApply(container);
  },

  _resetPreview(container) {
    this._lastParsed = null;
    const label = container.querySelector('#nba27LiveFileLabel');
    if (label) label.textContent = 'Drop JSON file(s) here or';
    const preview = container.querySelector('#nba27LivePreview');
    if (preview) preview.innerHTML = '';
    const applyBtn = container.querySelector('#btnNba27LiveApply');
    if (applyBtn) applyBtn.classList.add('hidden');
    const cancelBtn = container.querySelector('#btnNba27LiveCancel');
    if (cancelBtn) cancelBtn.classList.add('hidden');
    const fileInput = container.querySelector('#nba27LiveFileInput');
    if (fileInput) fileInput.value = '';
  },

  /**
   * Reads and parses every selected file, validates each top-level
   * envelope ({ success, data: Array }), and combines every valid file's
   * `data` array into one flat list before handing off to
   * `_validateAndPreview`. A file that fails to parse or doesn't match
   * the envelope is reported but doesn't abort the other files.
   */
  async _handleFiles(container, files) {
    if (!files || !files.length) return;
    const label = container.querySelector('#nba27LiveFileLabel');
    if (label) label.textContent = files.map(f => f.name).join(', ');
    const resultEl = container.querySelector('#nba27LiveResult');
    if (resultEl) resultEl.innerHTML = '';

    const previewEl = container.querySelector('#nba27LivePreview');
    if (previewEl) previewEl.innerHTML = `<p class="helper-text">Reading file(s)…</p>`;

    const combinedRaw = [];
    const fileErrors = [];
    for (const file of files) {
      try {
        const text = await file.text();
        const json = JSON.parse(text);
        if (!json || !Array.isArray(json.data)) {
          fileErrors.push(`"${file.name}" — expected a top-level "data" array (envelope: { success, data, meta }); this file was skipped entirely.`);
          continue;
        }
        for (const rec of json.data) combinedRaw.push(rec);
      } catch (e) {
        fileErrors.push(`"${file.name}" — could not read/parse: ${e.message || 'invalid JSON'}.`);
      }
    }

    if (!combinedRaw.length) {
      if (previewEl) {
        previewEl.innerHTML = `
          <div class="backup-result backup-result-error">
            <strong>✕ No valid records found</strong>
            ${fileErrors.length ? `<ul class="helper-text">${fileErrors.map(e => `<li>${escapeHtml(e)}</li>`).join('')}</ul>` : ''}
          </div>`;
      }
      return;
    }

    await this._validateAndPreview(container, combinedRaw, fileErrors);
  },

  /**
   * Validates + normalizes the combined raw records, diffs them against
   * the full current `nba2k_players`/`nba2k27_pool` collections, and
   * builds the write plan for `_runApply` — entirely WITHOUT writing
   * anything. Safe to call directly (e.g. from tests) with a
   * pre-combined array, bypassing the file-picker UI.
   */
  async _validateAndPreview(container, combinedRaw, fileErrors) {
    const previewEl = container.querySelector('#nba27LivePreview');
    const invalid = [];
    const duplicates = [];
    const seenSlugs = new Map(); // slug -> name, first occurrence wins
    const teamTypeCounts = { curr: 0, class: 0, allt: 0, unknown: 0 };
    const normalized = [];

    for (const raw of combinedRaw) {
      if (!raw || typeof raw !== 'object') {
        invalid.push('Skipped a record — not an object.');
        continue;
      }

      const name = typeof raw.name === 'string' ? raw.name.trim() : '';
      const team = typeof raw.team === 'string' ? raw.team.trim() : '';
      const teamType = raw.teamType;
      const overall = raw.overall;
      const attributes = raw.attributes;
      const slug = typeof raw.slug === 'string' ? raw.slug.trim() : '';

      const missingRequired = [];
      if (!slug) missingRequired.push('slug');
      if (!name) missingRequired.push('name');
      if (!team) missingRequired.push('team');
      if (!teamType) missingRequired.push('teamType');
      if (overall === undefined || overall === null || isNaN(Number(overall))) missingRequired.push('overall');
      if (!attributes || typeof attributes !== 'object') missingRequired.push('attributes');

      if (missingRequired.length) {
        invalid.push(`Skipped "${name || '(unnamed record)'}" — missing required field(s): ${missingRequired.join(', ')}.`);
        continue;
      }

      if (!_nba2k27LiveImportSlugValid(slug)) {
        invalid.push(`Skipped "${name}" — slug "${slug}" is not a valid Firestore document ID.`);
        continue;
      }

      if (seenSlugs.has(slug)) {
        duplicates.push(`Duplicate slug "${slug}" ("${name}") — first occurrence ("${seenSlugs.get(slug)}") kept, this record excluded.`);
        continue;
      }
      seenSlugs.set(slug, name);

      if (teamType === 'curr' || teamType === 'class' || teamType === 'allt') {
        teamTypeCounts[teamType]++;
      } else {
        teamTypeCounts.unknown++;
      }

      // positions: same normalization convention as nba2k-import.js
      // (source-eligibility array; missing/non-array -> []).
      let positions = raw.positions;
      if (!Array.isArray(positions)) positions = [];

      // badges: EXACT same normalization/dedupe convention as
      // nba2k-import.js — dedupe by (name + tier + category), keep
      // legendary/hallOfFame/gold/silver/bronze/total from source as-is.
      const rawBadges = raw.badges && typeof raw.badges === 'object' ? raw.badges : {};
      const badgeList = Array.isArray(rawBadges.list) ? rawBadges.list : [];
      const seenBadgeKeys = new Set();
      const dedupedBadges = [];
      for (const b of badgeList) {
        if (!b || typeof b !== 'object') continue;
        const key = `${b.name}|${b.tier}|${b.category}`;
        if (seenBadgeKeys.has(key)) continue;
        seenBadgeKeys.add(key);
        dedupedBadges.push(b);
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
        teamType,
        overall: Number(overall),
        badges,
        // Full nba2k_players schema — identical field set to
        // nba2k-import.js's normalized doc literal. Only used if this
        // record turns out to be a genuinely NEW player.
        fullDoc: {
          name,
          team,
          teamType,
          overall: Number(overall),
          positions,
          height: raw.height ?? null,
          weight: raw.weight ?? null,
          wingspan: raw.wingspan ?? null,
          build: raw.build ?? null,
          playerUrl: typeof raw.playerUrl === 'string' ? raw.playerUrl.trim() : null,
          playerImage: raw.playerImage ?? null,
          teamImg: raw.teamImg ?? null,
          attributes,
          badges,
          lastUpdated: raw.lastUpdated ?? null,
          importedAt: firebase.firestore.FieldValue.serverTimestamp(),
        },
      });
    }

    let existingPlayers, existingPoolSlugs;
    try {
      ({ players: existingPlayers, poolSlugs: existingPoolSlugs } = await this._fetchExistingCollections());
    } catch (e) {
      if (previewEl) {
        previewEl.innerHTML = `
          <div class="backup-result backup-result-error">
            <strong>✕ Could not read existing NBA2K27 data</strong>
            <div>${escapeHtml(e.message || 'Firestore read failed.')}</div>
          </div>`;
      }
      const applyBtn = container.querySelector('#btnNba27LiveApply');
      if (applyBtn) applyBtn.classList.add('hidden');
      return;
    }

    const existingUpdates = [];
    const newPlayerCreates = [];
    const newPoolCreates = [];
    const sampleChanges = [];
    const sampleNewPlayers = [];
    let existingMatched = 0, ratingChanges = 0, badgeChanges = 0, unchanged = 0;
    let newEligible = 0, newSkippedLowOverall = 0, newSkippedUnknownTeamType = 0;

    for (const n of normalized) {
      const existingDoc = existingPlayers[n.slug];

      if (existingDoc) {
        existingMatched++;
        const storedOverall = Number(existingDoc.overall);
        const ratingChanged = storedOverall !== n.overall;
        const badgeChanged = _nba2k27LiveImportCanonicalBadges(existingDoc.badges || {}) !== _nba2k27LiveImportCanonicalBadges(n.badges);

        if (ratingChanged) ratingChanges++;
        if (badgeChanged) badgeChanges++;

        if (ratingChanged || badgeChanged) {
          existingUpdates.push({ slug: n.slug, overall: n.overall, badges: n.badges });
          if (sampleChanges.length < 20) {
            sampleChanges.push({
              slug: n.slug,
              name: n.fullDoc.name,
              oldOverall: existingDoc.overall,
              newOverall: n.overall,
              ratingChanged,
              badgeChanged,
            });
          }
        } else {
          unchanged++;
        }

        // ABSOLUTE nba2k27_pool protection — never touch it for an
        // existing player, no matter what changed above.
        continue;
      }

      // Genuinely new slug.
      if (n.teamType !== 'curr' && n.teamType !== 'class' && n.teamType !== 'allt') {
        newSkippedUnknownTeamType++;
        continue; // pool cannot be derived — never guess, create nothing
      }
      if (n.overall <= Nba2k27LiveImportView.NEW_PLAYER_MIN_OVERALL - 1) {
        newSkippedLowOverall++;
        continue;
      }

      newEligible++;
      newPlayerCreates.push({ slug: n.slug, doc: n.fullDoc });

      if (!existingPoolSlugs.has(n.slug)) {
        const mappedPool = nba2k27PoolForTeamType(n.teamType); // global from nba2k-database.js
        const nowIso = new Date().toISOString(); // same convention as nba2k-database.js's own pool writes
        newPoolCreates.push({
          slug: n.slug,
          doc: {
            nba2kRef: n.slug,
            pool: mappedPool,
            position: 'UNASSIGNED',
            selectedAt: nowIso,
            updatedAt: nowIso,
          },
        });
      }

      if (sampleNewPlayers.length < 20) {
        sampleNewPlayers.push({ slug: n.slug, name: n.fullDoc.name, overall: n.overall, teamType: n.teamType });
      }
    }

    this._lastParsed = {
      sourceTotal: combinedRaw.length,
      teamTypeCounts,
      existingMatched,
      ratingChanges,
      badgeChanges,
      unchanged,
      newEligible,
      newSkippedLowOverall,
      newSkippedUnknownTeamType,
      invalidCount: invalid.length,
      duplicateCount: duplicates.length,
      invalid,
      duplicates,
      fileErrors: fileErrors || [],
      existingUpdates,
      newPlayerCreates,
      newPoolCreates,
      sampleChanges,
      sampleNewPlayers,
    };

    if (previewEl) this._renderPreview(container);
  },

  _renderPreview(container) {
    const previewEl = container.querySelector('#nba27LivePreview');
    if (!previewEl || !this._lastParsed) return;
    const p = this._lastParsed;

    previewEl.innerHTML = `
      <div class="backup-latest">
        <div><span class="backup-latest-label">Source total:</span> ${p.sourceTotal}</div>
        <div><span class="backup-latest-label">Current:</span> ${p.teamTypeCounts.curr}</div>
        <div><span class="backup-latest-label">Classics:</span> ${p.teamTypeCounts.class}</div>
        <div><span class="backup-latest-label">All-Time:</span> ${p.teamTypeCounts.allt}</div>
        <div><span class="backup-latest-label">Unknown teamType:</span> ${p.teamTypeCounts.unknown}</div>
        <div><span class="backup-latest-label">Existing matched:</span> ${p.existingMatched}</div>
        <div><span class="backup-latest-label">Existing — rating changes:</span> ${p.ratingChanges}</div>
        <div><span class="backup-latest-label">Existing — badge changes:</span> ${p.badgeChanges}</div>
        <div><span class="backup-latest-label">Existing — unchanged:</span> ${p.unchanged}</div>
        <div><span class="backup-latest-label">New players (&ge;${this.NEW_PLAYER_MIN_OVERALL}):</span> ${p.newEligible}</div>
        <div><span class="backup-latest-label">New players skipped (&le;${this.NEW_PLAYER_MIN_OVERALL - 1}):</span> ${p.newSkippedLowOverall}</div>
        <div><span class="backup-latest-label">New players skipped (unknown teamType):</span> ${p.newSkippedUnknownTeamType}</div>
        <div><span class="backup-latest-label">Invalid records:</span> ${p.invalidCount}</div>
        <div><span class="backup-latest-label">Duplicate slugs:</span> ${p.duplicateCount}</div>
      </div>
      ${p.fileErrors.length ? `
        <details open style="margin-top:0.75rem;">
          <summary class="helper-text" style="cursor:pointer;">File-level issues (${p.fileErrors.length})</summary>
          <ul class="helper-text">${p.fileErrors.map(e => `<li>${escapeHtml(e)}</li>`).join('')}</ul>
        </details>` : ''}
      ${p.invalid.length ? `
        <details style="margin-top:0.75rem;">
          <summary class="helper-text" style="cursor:pointer;">Invalid records (${p.invalid.length})</summary>
          <ul class="helper-text">${p.invalid.slice(0, 200).map(w => `<li>${escapeHtml(w)}</li>`).join('')}</ul>
        </details>` : ''}
      ${p.duplicates.length ? `
        <details style="margin-top:0.75rem;">
          <summary class="helper-text" style="cursor:pointer;">Duplicate slugs (${p.duplicates.length})</summary>
          <ul class="helper-text">${p.duplicates.slice(0, 200).map(w => `<li>${escapeHtml(w)}</li>`).join('')}</ul>
        </details>` : ''}
      ${p.sampleChanges.length ? `
        <details style="margin-top:0.75rem;">
          <summary class="helper-text" style="cursor:pointer;">Sample existing-player changes (${p.sampleChanges.length} shown)</summary>
          <ul class="helper-text">${p.sampleChanges.map(c => `<li>${escapeHtml(c.name)} (${escapeHtml(c.slug)}) — overall ${escapeHtml(String(c.oldOverall))} → ${escapeHtml(String(c.newOverall))}${c.badgeChanged ? ', badges changed' : ''}</li>`).join('')}</ul>
        </details>` : ''}
      ${p.sampleNewPlayers.length ? `
        <details style="margin-top:0.75rem;">
          <summary class="helper-text" style="cursor:pointer;">Sample new players (${p.sampleNewPlayers.length} shown)</summary>
          <ul class="helper-text">${p.sampleNewPlayers.map(n => `<li>${escapeHtml(n.name)} (${escapeHtml(n.slug)}) — overall ${escapeHtml(String(n.overall))}, ${escapeHtml(nba2k27PoolLabel(nba2k27PoolForTeamType(n.teamType)) || '—')} pool</li>`).join('')}</ul>
        </details>` : ''}
    `;

    const applyBtn = container.querySelector('#btnNba27LiveApply');
    const cancelBtn = container.querySelector('#btnNba27LiveCancel');
    const totalOps = p.existingUpdates.length + p.newPlayerCreates.length + p.newPoolCreates.length;
    if (applyBtn) {
      if (totalOps > 0) {
        applyBtn.classList.remove('hidden');
        applyBtn.textContent = `Apply (${p.existingUpdates.length} update(s), ${p.newPlayerCreates.length} new player(s))`;
      } else {
        applyBtn.classList.add('hidden');
      }
    }
    if (cancelBtn) cancelBtn.classList.remove('hidden');
  },

  /**
   * Reads the ENTIRE `nba2k_players` and `nba2k27_pool` collections once
   * (read-only) — same convention already established elsewhere in this
   * codebase for these two collections at their current scale.
   */
  async _fetchExistingCollections() {
    const [playersSnap, poolSnap] = await Promise.all([
      firebase.firestore().collection(this.COLLECTION_PLAYERS).get(),
      firebase.firestore().collection(this.COLLECTION_POOL).get(),
    ]);
    const players = {};
    playersSnap.forEach(doc => { players[doc.id] = doc.data(); });
    const poolSlugs = new Set();
    poolSnap.forEach(doc => poolSlugs.add(doc.id));
    return { players, poolSlugs };
  },

  /**
   * Commits the write plan built by `_validateAndPreview`. Three
   * independent, dynamically-chunked (<=500 ops) batch phases, committed
   * in order: existing-player updates, new-player creates, new pool
   * creates. Safe to call directly (e.g. from tests).
   */
  async _runApply(container) {
    if (this._running || !this._lastParsed) return;
    if (typeof AuthBoundary !== 'undefined') AuthBoundary.requireAuth();

    const { existingUpdates, newPlayerCreates, newPoolCreates } = this._lastParsed;
    const totalOps = existingUpdates.length + newPlayerCreates.length + newPoolCreates.length;
    if (!totalOps) return;

    this._running = true;
    const applyBtn = container.querySelector('#btnNba27LiveApply');
    const resultEl = container.querySelector('#nba27LiveResult');
    if (applyBtn) { applyBtn.disabled = true; applyBtn.textContent = 'Applying…'; }
    if (resultEl) resultEl.innerHTML = '';

    let updatedCount = 0, createdPlayerCount = 0, createdPoolCount = 0;

    try {
      const db = firebase.firestore();

      // Phase A — existing players: .update() ONLY, never .set().
      for (let i = 0; i < existingUpdates.length; i += this.BATCH_LIMIT) {
        const chunk = existingUpdates.slice(i, i + this.BATCH_LIMIT);
        const batch = db.batch();
        for (const item of chunk) {
          const ref = db.collection(this.COLLECTION_PLAYERS).doc(item.slug);
          batch.update(ref, { overall: item.overall, badges: item.badges });
        }
        await batch.commit();
        updatedCount += chunk.length;
      }

      // Phase B — brand-new nba2k_players docs.
      for (let i = 0; i < newPlayerCreates.length; i += this.BATCH_LIMIT) {
        const chunk = newPlayerCreates.slice(i, i + this.BATCH_LIMIT);
        const batch = db.batch();
        for (const item of chunk) {
          const ref = db.collection(this.COLLECTION_PLAYERS).doc(item.slug);
          batch.set(ref, item.doc); // brand-new doc — no existing data to preserve
        }
        await batch.commit();
        createdPlayerCount += chunk.length;
      }

      // Phase C — brand-new nba2k27_pool docs (players always land first).
      for (let i = 0; i < newPoolCreates.length; i += this.BATCH_LIMIT) {
        const chunk = newPoolCreates.slice(i, i + this.BATCH_LIMIT);
        const batch = db.batch();
        for (const item of chunk) {
          const ref = db.collection(this.COLLECTION_POOL).doc(item.slug);
          batch.set(ref, item.doc);
        }
        await batch.commit();
        createdPoolCount += chunk.length;
      }

      if (resultEl) {
        resultEl.innerHTML = `
          <div class="backup-result backup-result-success">
            <strong>✓ Apply completed</strong>
            <div>Existing players updated: ${updatedCount}</div>
            <div>New players created: ${createdPlayerCount}</div>
            <div>New pool documents created: ${createdPoolCount}</div>
          </div>`;
      }
      if (typeof showToast === 'function') showToast('NBA 2K27 Live API Update applied.', 'success');
      if (applyBtn) applyBtn.classList.add('hidden');
    } catch (e) {
      if (resultEl) {
        resultEl.innerHTML = `
          <div class="backup-result backup-result-error">
            <strong>✕ Apply failed</strong>
            <div>${escapeHtml(e.message || 'Unknown error.')}</div>
            <div>Existing players updated before failure: ${updatedCount}</div>
            <div>New players created: ${createdPlayerCount}</div>
            <div>New pool documents created: ${createdPoolCount}</div>
          </div>`;
      }
      if (typeof showToast === 'function') showToast('NBA 2K27 Live API Update failed.', 'error');
    } finally {
      this._running = false;
      if (applyBtn) applyBtn.disabled = false;
    }
  },
};

/**
 * Firestore-doc-ID safety check for a literal `slug` field from the
 * source (same safety rule as nba2k-import.js's `_slugFromPlayerUrl`
 * fallback: no "/", not "." or "..", <=1500 bytes).
 */
function _nba2k27LiveImportSlugValid(slug) {
  if (!slug) return false;
  if (slug === '.' || slug === '..') return false;
  if (slug.includes('/')) return false;
  if (slug.length > 1500) return false;
  return true;
}

/**
 * Canonicalizes a `badges` object for equality comparison — sorts the
 * `list` array by (name|tier|category) so source reordering alone never
 * registers as a "change", and normalizes every count field the same way
 * the import/stored schema already does (missing -> 0).
 */
function _nba2k27LiveImportCanonicalBadges(badges) {
  const b = badges && typeof badges === 'object' ? badges : {};
  const list = Array.isArray(b.list) ? b.list : [];
  const sortedList = list
    .filter(x => x && typeof x === 'object')
    .map(x => ({ name: x.name, tier: x.tier, category: x.category }))
    .sort((a, c) => {
      const ka = `${a.name}|${a.tier}|${a.category}`;
      const kc = `${c.name}|${c.tier}|${c.category}`;
      return ka < kc ? -1 : ka > kc ? 1 : 0;
    });
  return JSON.stringify({
    legendary: b.legendary ?? 0,
    hallOfFame: b.hallOfFame ?? 0,
    gold: b.gold ?? 0,
    silver: b.silver ?? 0,
    bronze: b.bronze ?? 0,
    total: b.total ?? 0,
    list: sortedList,
  });
}