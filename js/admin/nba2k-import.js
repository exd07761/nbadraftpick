/**
 * admin/nba2k-import.js — NBA 2K26 Database import
 * (Phase 1: Current players only. Phase 4: expanded to Current + Classics
 * + All-Time — the complete 1,757-player NBA2KAPI dataset.)
 *
 * PURPOSE
 * One-time/repeatable admin tool that reads an NBA2KAPI-style JSON dump
 * (locally, via a file picker — nothing is uploaded anywhere but this
 * browser tab), normalizes a handful of known source data-quality
 * issues, and writes one document per player to a *separate* Firestore
 * collection:
 *
 *     nba2k_players/<slug>
 *
 * PHASE 4 CHANGE (the only behavioral change from Phase 1)
 * The `teamType === 'curr'` filter that limited this importer to current
 * players has been removed — it now imports all three source categories
 * (`curr`, `class`, `allt`) using the exact same per-player validation/
 * normalization pipeline Phase 1 already established. Nothing else about
 * that pipeline changed: verified against the real dataset that Classic
 * and All-Time records have zero missing name/playerUrl/team/overall/
 * attributes fields, and that all 1,757 records (across all three
 * categories combined) produce zero slug collisions — so the existing
 * slug-as-document-ID upsert scheme needed no adjustment to scale from
 * 528 to 1,757 documents.
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
 * All Firestore access for this collection is self-contained in this
 * file (mirrors js/admin/backup.js, which also talks to its own backend
 * directly rather than routing through data.js).
 *
 * SECURITY
 * This collection's Firestore rules are NOT part of this repo (rules
 * are managed in the Firebase Console — see BACKUP_RESTORE.md). Per the
 * Phase 4 spec, the existing rule (`allow read, write: if request.auth
 * != null;`) is left exactly as-is — no rule change was made or needed.
 *
 * SLUG / DOCUMENT ID
 * The document ID is the last path segment of `playerUrl`
 * (e.g. "https://www.2kratings.com/trae-young" -> "trae-young").
 * Verified against the FULL 1,757-record dataset (all three categories
 * combined): every URL matches a clean `2kratings.com/<slug>` shape,
 * and all 1,757 slugs are globally unique — no Classic/All-Time record
 * collides with an existing Current slug or with each other. See
 * _slugFromPlayerUrl() for the exact rule and its fallback.
 */
const Nba2kImport = {
  COLLECTION: 'nba2k_players',
  BATCH_LIMIT: 500, // Firestore hard cap on ops per batch

  _lastParsed: null, // { toCreate: [...], toUpdate: [...], warnings: [...], errors: [...], sourceTotal, currTotal }
  _running: false,

  render(container) {
    container.innerHTML = `
      <div class="admin-section">
        <div class="admin-section-header">
          <h2>NBA 2K26 Database Import</h2>
        </div>
        <p class="helper-text">
          Source: <code>nba2k-all-players.json</code>. Expected 1,757 total players
          (528 Current, 774 Classics, 455 All-Time). Imports into a separate
          <code>nba2k_players</code> Firestore collection — this is a standalone
          reference database. It does not touch the existing Players page, pools,
          draft, rosters, or trades. Pool assignment only happens through the
          existing per-player promotion workflow in the NBA 2K26 Database browser.
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
      // entirely absent for players with zero badges (badges.total: 0)
      // rather than being an empty array — normalize to [].
      const rawBadges = raw.badges && typeof raw.badges === 'object' ? raw.badges : {};
      let badgeList = Array.isArray(rawBadges.list) ? rawBadges.list : [];
      if (!Array.isArray(rawBadges.list)) {
        warnings.push(`"${name}" has no badges.list — stored as an empty list.`);
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
      if (dedupedBadges.length !== Number(rawBadges.total || 0)) {
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
          overall: Number(overall),
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
          lastUpdated: raw.lastUpdated ?? null,
          importedAt: firebase.firestore.FieldValue.serverTimestamp(),
        },
      });
    }

    // Diff against existing Firestore docs to split create vs. update.
    // Firestore 'in' queries cap at 30 values per query, so this is
    // chunked — read-only, no writes happen here.
    let existingSlugs;
    try {
      existingSlugs = await this._fetchExistingSlugs(normalized.map(n => n.slug));
    } catch (e) {
      previewEl.innerHTML = `
        <div class="backup-result backup-result-error">
          <strong>✕ Could not check existing NBA2K players</strong>
          <div>${escapeHtml(e.message || 'Firestore read failed.')}</div>
          <div style="margin-top:0.5rem;">This usually means the <code>nba2k_players</code> Firestore rule
          doesn't exist yet, or doesn't allow authenticated reads. See the setup notes for the rule to add.</div>
        </div>`;
      container.querySelector('#btnNba2kConfirm').classList.add('hidden');
      container.querySelector('#btnNba2kCancel').classList.remove('hidden');
      return;
    }

    const toCreate = normalized.filter(n => !existingSlugs.has(n.slug));
    const toUpdate = normalized.filter(n => existingSlugs.has(n.slug));

    this._lastParsed = {
      sourceTotal,
      importTotal: allRaw.length,
      categoryCounts,
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
        <div><span class="backup-latest-label">Existing:</span> ${existingSlugs.size}</div>
        <div><span class="backup-latest-label">New:</span> ${toCreate.length}</div>
        <div><span class="backup-latest-label">Updates:</span> ${toUpdate.length}</div>
        <div><span class="backup-latest-label">Validation warnings:</span> ${warnings.length}</div>
        <div><span class="backup-latest-label">Validation errors:</span> ${errors.length}</div>
      </div>
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
   * Reads which of the given slugs already exist in nba2k_players.
   * Read-only — used purely to classify create vs. update in the preview.
   */
  async _fetchExistingSlugs(slugs) {
    const existing = new Set();
    const col = firebase.firestore().collection(this.COLLECTION);
    const CHUNK = 30; // Firestore documentId() 'in' query cap
    for (let i = 0; i < slugs.length; i += CHUNK) {
      const chunk = slugs.slice(i, i + CHUNK);
      if (!chunk.length) continue;
      const snap = await col.where(firebase.firestore.FieldPath.documentId(), 'in', chunk).get();
      snap.forEach(doc => existing.add(doc.id));
    }
    return existing;
  },

  async _runImport(container) {
    if (this._running || !this._lastParsed) return;
    AuthBoundary.requireAuth();

    const { toCreate, toUpdate, warnings, errors, sourceTotal, importTotal, categoryCounts } = this._lastParsed;
    const all = [...toCreate, ...toUpdate];

    if (!all.length) return;

    this._running = true;
    const confirmBtn = container.querySelector('#btnNba2kConfirm');
    const resultEl = container.querySelector('#nba2kResult');
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Importing…';
    resultEl.innerHTML = '';

    try {
      const db = firebase.firestore();
      let processed = 0;

      // Dynamically chunk into batches of <= BATCH_LIMIT — never assumes
      // the 528 figure from inspection; scales to whatever the file has.
      for (let i = 0; i < all.length; i += this.BATCH_LIMIT) {
        const chunk = all.slice(i, i + this.BATCH_LIMIT);
        const batch = db.batch();
        for (const item of chunk) {
          const ref = db.collection(this.COLLECTION).doc(item.slug);
          batch.set(ref, item.doc, { merge: false }); // full upsert — source is authoritative per re-import
        }
        await batch.commit();
        processed += chunk.length;
      }

      resultEl.innerHTML = `
        <div class="backup-result backup-result-success">
          <strong>✓ Import completed</strong>
          <div>Total processed: ${processed}</div>
          <div>Created: ${toCreate.length}</div>
          <div>Updated: ${toUpdate.length}</div>
          <div>Skipped (validation errors): ${errors.length}</div>
          <div>Warnings (non-fatal): ${warnings.length}</div>
          <div style="margin-top:0.5rem;">Breakdown — Current: ${categoryCounts.curr} · Classics: ${categoryCounts.class} · All-Time: ${categoryCounts.allt}${categoryCounts.other ? ` · Other: ${categoryCounts.other}` : ''}</div>
          <div>Source records in file: ${sourceTotal}</div>
        </div>`;
      showToast('NBA 2K26 database import completed.', 'success');
      confirmBtn.classList.add('hidden');
    } catch (e) {
      resultEl.innerHTML = `
        <div class="backup-result backup-result-error">
          <strong>✕ Import failed</strong>
          <div>${escapeHtml(e.message || 'Unknown error.')}</div>
          <div style="margin-top:0.5rem;">If this is a permissions error, the <code>nba2k_players</code>
          Firestore rule likely isn't in place yet.</div>
        </div>`;
      showToast('NBA 2K player import failed.', 'error');
    } finally {
      this._running = false;
      confirmBtn.disabled = false;
    }
  },

  /**
   * Derives a Firestore-safe document ID from a 2kratings.com player URL.
   * Verified against the full 1,757-record dataset (Current + Classics +
   * All-Time combined): every URL matches `https://www.2kratings.com/<slug>`
   * (optionally with a trailing slash) with an already-unique, lowercase,
   * hyphenated slug — zero collisions across all three categories. The
   * fallback path below only matters for future snapshots that might not
   * follow that exact shape.
   */
  _slugFromPlayerUrl(url) {
    try {
      const path = new URL(url).pathname; // strips query string/host safely
      const segments = path.split('/').filter(Boolean);
      const last = segments[segments.length - 1];
      if (!last) return null;
      // Firestore doc IDs: no "/", not ".", not "..", <=1500 bytes.
      const slug = last.trim().toLowerCase();
      if (!slug || slug === '.' || slug === '..' || slug.includes('/')) return null;
      return slug;
    } catch (e) {
      return null;
    }
  },
};
