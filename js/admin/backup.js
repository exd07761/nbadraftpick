/**
 * admin/backup.js — Supabase Backup admin view
 *
 * "Download Full Supabase JSON" — reads the league's Supabase tables
 * directly, in the browser, using the signed-in Admin's session (the same
 * SupabaseQuery layer the rest of the Admin uses), and downloads the
 * result as a JSON file. No Cloud Function, no Cloud Storage, no
 * server-side backup history — see BACKUP_RESTORE.md for how this relates
 * to the separate local CLI backup (`npm run backup`, which is unaffected
 * by this file).
 *
 * Datasets (a hand-maintained list — if a new table needs backing up it
 * must be added here, or this browser backup will silently miss it):
 *   - league_state   — single row, id = 'main' (the full league JSON)
 *   - nba2k_players  — every row, ordered by slug
 *   - nba2k27_pool   — every row, ordered by nba2k_ref
 *
 * Supabase/PostgREST returns at most 1000 rows per request, so the two
 * multi-row tables are paginated with the same .order().range() loop used
 * by Nba2kDatabaseView._ensureLoaded() in js/admin/nba2k-database.js.
 * Supabase rows are already JSON-compatible, so no type-preserving
 * serialization is needed.
 *
 * This view intentionally has no restore control and no backup-history
 * list. The local `npm run restore` CLI reads the legacy Firestore backup
 * format and does NOT understand this file. There's no server-side record
 * of past browser-downloaded backups either — each one only ever exists
 * in browser memory during generation and then as the downloaded file;
 * nothing is uploaded anywhere.
 */
const AdminBackupView = (() => {
  const BACKUP_FORMAT = 'supabase-json-v1';
  const BACKUP_TABLES = ['league_state', 'nba2k_players', 'nba2k27_pool'];
  const LEAGUE_STATE_ID = 'main';
  const PAGE_SIZE = 1000;

  let _running = false;

  function pad(n) { return String(n).padStart(2, '0'); }

  function buildFilename(d = new Date()) {
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-` +
                  `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    // Already filesystem-safe by construction (digits and hyphens only),
    // but guard explicitly in case the format above ever changes.
    return `supabase-backup-${stamp.replace(/[^a-zA-Z0-9_-]/g, '')}.json`;
  }

  /** Reads the canonical league_state row (id = 'main'). Throws if it is missing or empty. */
  async function readLeagueState() {
    const rows = await SupabaseQuery.select('league_state', qb =>
      qb.eq('id', LEAGUE_STATE_ID)
    );
    const row = rows && rows[0];
    if (!row || row.data === null || typeof row.data !== 'object') {
      throw new Error('The league state (league_state / main) was not found or is empty. If this is unexpected, confirm you are signed in with the right account and try again.');
    }
    return row;
  }

  /**
   * Reads EVERY row of a table. PostgREST returns at most 1000 rows per
   * request, so this pages with .order().range() until a short page comes
   * back (same pattern as Nba2kDatabaseView._ensureLoaded()).
   */
  async function loadAll(table, orderColumn) {
    const rows = [];
    let offset = 0;

    while (true) {
      const page = await SupabaseQuery.select(table, qb =>
        qb
          .order(orderColumn, { ascending: true })
          .range(offset, offset + PAGE_SIZE - 1)
      );

      rows.push(...page);

      if (page.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }

    return rows;
  }

  /**
   * Reads every backed-up table and assembles one backup object.
   *
   * Throws on any read failure rather than returning a partial result —
   * callers must not treat a caught error here as "backup succeeded."
   */
  async function buildBackup() {
    const leagueState = await readLeagueState();
    const nba2kPlayers = await loadAll('nba2k_players', 'slug');
    const nba2k27Pool = await loadAll('nba2k27_pool', 'nba2k_ref');

    return {
      metadata: {
        format: BACKUP_FORMAT,
        createdAt: new Date().toISOString(),
        tables: BACKUP_TABLES,
      },
      league_state: leagueState,
      nba2k_players: nba2kPlayers,
      nba2k27_pool: nba2k27Pool,
    };
  }

  function downloadJson(obj, filename) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    try {
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /** Keeps the message shown to the admin human-readable and non-sensitive (no raw error objects, no stack traces). */
  function friendlyError(err) {
    const message = String((err && err.message) || '').trim();
    const lower = message.toLowerCase();
    if (lower.includes('permission denied') || lower.includes('jwt') || lower.includes('not authorized') || lower.includes('row-level security')) {
      return "Permission denied — your account isn't authorized to read this data. Try signing out and back in.";
    }
    if (lower.includes('failed to fetch') || lower.includes('networkerror') || lower.includes('network request failed')) {
      return 'Could not reach Supabase. Check your connection and try again.';
    }
    return message || 'Unknown error.';
  }

  return {
    render(container) {
      container.innerHTML = `
        <div class="admin-section">
          <div class="admin-section-header">
            <h2>Supabase Backup</h2>
          </div>
          <p class="backup-intro">
            Downloads a complete JSON copy of the league state, the NBA 2K
            player database, and the NBA 2K27 pool from Supabase. Reads
            directly from Supabase using your signed-in session — nothing
            is uploaded anywhere, and no Cloud Function or Cloud Storage
            is involved.
          </p>

          <div id="backupResult"></div>

          <button type="button" class="btn btn-primary" id="btnDownloadBackup">Download Full Supabase JSON</button>
        </div>`;

      container.querySelector('#btnDownloadBackup').onclick = () => this._runBackup(container);
    },

    async _runBackup(container) {
      if (_running) return; // guards this one button against a double-click; not a security boundary
      const resultEl = container.querySelector('#backupResult');
      const btn = container.querySelector('#btnDownloadBackup');

      try {
        AuthBoundary.requireAuth();
      } catch (err) {
        resultEl.innerHTML = `
          <div class="backup-result backup-result-error">
            <strong>✕ Backup failed</strong>
            <div>${escapeHtml(err.message || 'Not signed in.')}</div>
          </div>`;
        return;
      }

      _running = true;
      btn.disabled = true;
      btn.textContent = 'Preparing Backup…';
      resultEl.innerHTML = '';

      const startedAt = performance.now();
      try {
        const backup = await buildBackup();

        const filename = buildFilename();
        downloadJson(backup, filename);

        const elapsedSec = ((performance.now() - startedAt) / 1000).toFixed(1);
        resultEl.innerHTML = `
          <div class="backup-result backup-result-success">
            <strong>✓ Backup downloaded successfully</strong>
            <div>League state: 1 row</div>
            <div>NBA 2K players: ${backup.nba2k_players.length}</div>
            <div>NBA 2K27 pool: ${backup.nba2k27_pool.length}</div>
            <div>File: ${escapeHtml(filename)}</div>
            <div>Time: ${elapsedSec}s</div>
          </div>`;
        showToast('Backup downloaded.', 'success');
      } catch (err) {
        resultEl.innerHTML = `
          <div class="backup-result backup-result-error">
            <strong>✕ Backup failed</strong>
            <div>${escapeHtml(friendlyError(err))}</div>
          </div>`;
        showToast('Backup failed.', 'error');
      } finally {
        _running = false;
        btn.disabled = false;
        btn.textContent = 'Download Full Supabase JSON';
      }
    },
  };
})();