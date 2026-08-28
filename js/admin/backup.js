/**
 * admin/backup.js — Firestore Backup admin view
 *
 * "Download Full Firestore JSON" — reads Firestore directly, in the
 * browser, using the signed-in Admin's Firebase Web SDK session, and
 * downloads the result as a JSON file. No Cloud Function, no Cloud
 * Storage, no server-side backup history — see BACKUP_RESTORE.md for the
 * full architecture writeup and how this relates to the separate local
 * CLI backup (`npm run backup`, which remains the Admin-SDK-based, fully
 * generic backup mechanism and is unaffected by this file).
 *
 * ── WHY THIS CAN'T GENERICALLY DISCOVER COLLECTIONS ─────────────────────
 * The local CLI backup (scripts/lib/backup-core.js) discovers every root
 * collection and recursively every subcollection via the Admin SDK's
 * db.listCollections() / docRef.listCollections(). The Firebase WEB SDK
 * used here has no equivalent of that method at all — collection
 * discovery is an Admin-SDK-only, service-account-privileged operation,
 * not something Firestore Security Rules can expose to a signed-in
 * client. That's a hard platform limitation, not an oversight, so this
 * feature cannot "discover" collections the way the CLI does.
 *
 * Instead, KNOWN_ROOT_COLLECTIONS below is a hand-maintained list,
 * confirmed by reading the app's actual Firestore reads/writes:
 *   - "league"        (js/data.js)             — single doc, "main"
 *   - "nba2k_players" (js/nba2k-database.js,
 *                       js/admin/nba2k-import.js) — many docs, keyed by slug
 * Neither has any subcollection anywhere in this codebase today (league/
 * main is deliberately kept as one flat document — see js/data.js's
 * comment above FirebaseSync — and nba2k_players documents are flat
 * player records). If a new top-level collection or a subcollection is
 * ever added, THIS LIST must be updated by hand, or this browser backup
 * will silently miss it. The Admin UI says as much rather than implying
 * "Download Full Firestore JSON" is as complete/future-proof as the CLI
 * backup.
 *
 * This view intentionally has no restore control and no backup-history
 * list — restoring stays a local-only `npm run restore` operation, and
 * there's no server-side record of past browser-downloaded backups (each
 * one only ever exists in browser memory during generation and then as
 * the downloaded file — nothing is uploaded anywhere).
 */
const AdminBackupView = (() => {
  const KNOWN_ROOT_COLLECTIONS = ['league', 'nba2k_players'];

  let _running = false;

  function pad(n) { return String(n).padStart(2, '0'); }

  function buildFilename(d = new Date()) {
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-` +
                  `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    // Already filesystem-safe by construction (digits and hyphens only),
    // but guard explicitly in case the format above ever changes.
    return `firestore-backup-${stamp.replace(/[^a-zA-Z0-9_-]/g, '')}.json`;
  }

  // ── Browser-compatible Firestore type-preserving serializer ───────────
  // Conceptually the same tagged-value format as
  // scripts/lib/firestore-serialize.js ({ __type: "timestamp" | "geopoint"
  // | "bytes" | "ref", ... }), so a value round-trips to the same JSON
  // shape either way — but written against the browser "compat" SDK's
  // classes (firebase.firestore.Timestamp/GeoPoint/Blob/DocumentReference)
  // instead of the Node-only Admin SDK classes that file uses, since the
  // two are different classes despite the same field types and that file
  // cannot run in a browser as-is.
  function serializeValue(value) {
    if (value === null || value === undefined) return null;

    if (value instanceof firebase.firestore.Timestamp) {
      return { __type: 'timestamp', seconds: value.seconds, nanoseconds: value.nanoseconds };
    }
    if (value instanceof firebase.firestore.GeoPoint) {
      return { __type: 'geopoint', latitude: value.latitude, longitude: value.longitude };
    }
    // Bytes: the Web SDK represents Firestore `bytes` fields as
    // firebase.firestore.Blob (unlike the Admin SDK's native Buffer).
    if (value instanceof firebase.firestore.Blob) {
      return { __type: 'bytes', base64: value.toBase64() };
    }
    if (value instanceof firebase.firestore.DocumentReference) {
      return { __type: 'ref', path: value.path };
    }
    if (Array.isArray(value)) {
      return value.map(serializeValue);
    }
    if (typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = serializeValue(v);
      return out;
    }
    return value; // string / number / boolean
  }

  function serializeDocData(data) {
    const out = {};
    for (const [k, v] of Object.entries(data || {})) out[k] = serializeValue(v);
    return out;
  }

  /** Reads every document in one known root collection (flat — no subcollection walk; see file header). */
  async function readRootCollection(name) {
    const snap = await firebase.firestore().collection(name).get();
    return snap.docs.map(doc => ({
      path: `${name}/${doc.id}`,
      data: serializeDocData(doc.data()),
    }));
  }

  /**
   * Reads every known collection and assembles one backup object.
   * Path-based document format (rather than nested collections →
   * documents → subcollections) so there's never ambiguity between a
   * document ID and a collection name, and so it stays unambiguous even
   * if a subcollection is added under one of these paths later.
   *
   * Throws on any read failure rather than returning a partial result —
   * callers must not treat a caught error here as "backup succeeded."
   */
  async function buildBackup() {
    const documents = [];
    for (const name of KNOWN_ROOT_COLLECTIONS) {
      const docs = await readRootCollection(name);
      documents.push(...docs);
    }

    const collectionPathCount = KNOWN_ROOT_COLLECTIONS.length;

    return {
      metadata: {
        format: 'firestore-json-v1',
        projectId: (firebase.app().options && firebase.app().options.projectId) || '(unknown)',
        createdAt: new Date().toISOString(),
        documentCount: documents.length,
        collectionPathCount,
        knownRootCollections: KNOWN_ROOT_COLLECTIONS,
      },
      documents,
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

  /** Firestore errors carry a `.code`; keep the message shown to the admin safe/non-sensitive either way. */
  function friendlyError(err) {
    if (err && err.code === 'permission-denied') {
      return "Permission denied — your account isn't authorized to read this data.";
    }
    if (err && err.code === 'unavailable') {
      return 'Firestore is currently unavailable. Check your connection and try again.';
    }
    if (err && err.code === 'unauthenticated') {
      return 'You need to be signed in to back up Firestore.';
    }
    return (err && err.message) || 'Unknown error.';
  }

  return {
    render(container) {
      container.innerHTML = `
        <div class="admin-section">
          <div class="admin-section-header">
            <h2>Firestore Backup</h2>
          </div>
          <p class="backup-intro">
            Downloads a complete JSON copy of the Firestore data currently
            accessible to the Admin. Reads directly from Firestore using
            your signed-in session — nothing is uploaded anywhere, and no
            Cloud Function or Cloud Storage is involved.
          </p>

          <div id="backupResult"></div>

          <button type="button" class="btn btn-primary" id="btnDownloadBackup">Download Full Firestore JSON</button>
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

        if (backup.documents.length === 0) {
          // Do not download/claim success for an empty result — likely
          // signals a permissions or connectivity problem rather than a
          // genuinely empty database.
          throw new Error('No documents were found. If this is unexpected, confirm you are signed in with the right account and try again.');
        }

        const filename = buildFilename();
        downloadJson(backup, filename);

        const elapsedSec = ((performance.now() - startedAt) / 1000).toFixed(1);
        resultEl.innerHTML = `
          <div class="backup-result backup-result-success">
            <strong>✓ Backup downloaded successfully</strong>
            <div>Documents: ${backup.metadata.documentCount}</div>
            <div>Collection paths: ${backup.metadata.collectionPathCount}</div>
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
        btn.textContent = 'Download Full Firestore JSON';
      }
    },
  };
})();
