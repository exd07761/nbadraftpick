/**
 * admin/backup.js — Firestore Backup admin view
 *
 * Calls the two callable Cloud Functions in functions/index.js
 * (backupFirestore, getBackupHistory) via the Firebase Functions client
 * SDK. That SDK automatically attaches the signed-in admin's Firebase
 * Auth ID token to every call — no credential of any kind lives in this
 * file or anywhere else in the frontend; the privileged Admin SDK work
 * happens entirely in the Cloud Function. See functions/index.js's
 * top-of-file comment for the full security explanation.
 *
 * This does NOT include a restore control — restoring stays a local-only
 * `npm run restore` operation for now (see BACKUP_RESTORE.md), same as
 * before this view existed.
 */
const AdminBackupView = {
  _running: false,

  render(container) {
    container.innerHTML = `
      <div class="admin-section">
        <div class="admin-section-header">
          <h2>Firestore Backup</h2>
        </div>
        <p class="backup-intro">
          Exports every collection in Firestore — including any added after
          this page was built — to Cloud Storage. This does not change or
          delete anything in Firestore itself.
        </p>

        <div id="backupResult"></div>

        <button type="button" class="btn btn-primary" id="btnCreateBackup">Create Backup</button>
      </div>

      <div class="admin-section">
        <div class="admin-section-header">
          <h2>Backup History</h2>
        </div>
        <div id="backupHistoryContainer">
          <p class="backup-muted">Loading…</p>
        </div>
      </div>`;

    container.querySelector('#btnCreateBackup').onclick = () => this._runBackup(container);

    this._loadHistory(container);
  },

  async _runBackup(container) {
    if (this._running) return; // frontend-side guard (Phase 6) — the
    // Cloud Function has its own independent lock server-side (Phase 7),
    // this is just to stop this one button from firing twice, not the
    // real protection.
    AuthBoundary.requireAuth();

    this._running = true;
    const btn = container.querySelector('#btnCreateBackup');
    const resultEl = container.querySelector('#backupResult');
    btn.disabled = true;
    btn.textContent = 'Creating backup…';
    resultEl.innerHTML = '';

    try {
      const backupFirestore = firebase.functions().httpsCallable('backupFirestore');
      const { data } = await backupFirestore();
      resultEl.innerHTML = `
        <div class="backup-result backup-result-success">
          <strong>✓ Backup completed successfully</strong>
          <div>Documents backed up: ${data.totalDocuments}</div>
          <div>Backup time: ${(data.durationMs / 1000).toFixed(1)} seconds</div>
        </div>`;
      showToast('Backup completed.', 'success');
      this._loadHistory(container);
    } catch (err) {
      // err.message here is whatever the Cloud Function's HttpsError said
      // (a deliberately generic, non-sensitive message — see
      // functions/index.js) — safe to show as-is.
      resultEl.innerHTML = `
        <div class="backup-result backup-result-error">
          <strong>✕ Backup failed</strong>
          <div>${escapeHtml(err.message || 'Unknown error.')}</div>
        </div>`;
      showToast('Backup failed.', 'error');
    } finally {
      this._running = false;
      btn.disabled = false;
      btn.textContent = 'Create Backup';
    }
  },

  async _loadHistory(container) {
    const historyEl = container.querySelector('#backupHistoryContainer');
    if (!historyEl) return; // view may have been navigated away from already

    try {
      const getBackupHistory = firebase.functions().httpsCallable('getBackupHistory');
      const { data } = await getBackupHistory();
      const runs = data.runs || [];

      if (!runs.length) {
        historyEl.innerHTML = `<p class="backup-muted">No backups yet.</p>`;
        return;
      }

      const latest = runs[0];
      const statusLabel = s => s === 'success' ? '✓ Successful' : (s === 'failed' ? '✕ Failed' : s);

      historyEl.innerHTML = `
        <div class="backup-latest">
          <div><span class="backup-latest-label">Last backup:</span> ${latest.finishedAt ? new Date(latest.finishedAt).toLocaleString() : '—'}</div>
          <div><span class="backup-latest-label">Documents:</span> ${latest.totalDocuments ?? '—'}</div>
          <div><span class="backup-latest-label">Status:</span> ${statusLabel(latest.status)}</div>
        </div>
        <div class="table-scroll">
          <table class="admin-table">
            <thead><tr><th>Date</th><th>Documents</th><th>Status</th></tr></thead>
            <tbody>
              ${runs.map(r => `
                <tr>
                  <td>${r.finishedAt ? new Date(r.finishedAt).toLocaleString() : '—'}</td>
                  <td>${r.totalDocuments ?? '—'}</td>
                  <td>${statusLabel(r.status)}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>`;
    } catch (err) {
      historyEl.innerHTML = `<p class="backup-muted">Couldn't load backup history: ${escapeHtml(err.message || 'unknown error')}</p>`;
    }
  },
};
