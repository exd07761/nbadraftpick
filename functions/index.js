/**
 * functions/index.js
 *
 * Two callable Cloud Functions, both requiring a valid Firebase Auth ID
 * token (verified automatically by the Callable Functions framework
 * before this code ever runs — see "Security" note below):
 *
 *   backupFirestore   — runs a full Firestore backup (same discovery/
 *                        serialization logic as `npm run backup`, via
 *                        functions/lib/backup-core.js — a synced copy of
 *                        scripts/lib/backup-core.js; see the "Shared
 *                        logic" note below) and writes it to Cloud
 *                        Storage instead of local disk.
 *
 *   getBackupHistory  — read-only: returns the most recent backup runs'
 *                        status/metadata (NOT their content) for the
 *                        Admin panel's "Last backup" / history display.
 *
 * The core logic of each (runBackupCore / getHistoryCore) is written as
 * a plain function taking an explicit {db, bucket, uid} rather than
 * reaching for admin.firestore()/admin.storage() directly — the exports
 * at the bottom are thin onCall(...) adapters that supply the real ones.
 * This isn't just for testability (though it is what let this be
 * exercised against a fake Firestore/Storage without touching anything
 * real — see /home/claude/emulator-test/, not part of this repo): it's
 * also just a cleaner separation between "Cloud Functions glue" and
 * "what this actually does."
 *
 * SECURITY — why the service-account credential never reaches the
 * browser: admin.initializeApp() below is called with ZERO arguments.
 * In the Cloud Functions/Cloud Run execution environment, that
 * automatically uses the function's attached runtime service account —
 * an identity Google Cloud manages and injects into the execution
 * environment itself. There is no private-key FILE at all in this
 * deployment path (unlike the local CLI's GOOGLE_APPLICATION_CREDENTIALS
 * flow) — nothing to accidentally expose, commit, or serve, because
 * nothing like that exists here. The browser only ever talks to this
 * function through the Firebase Functions client SDK, which sends the
 * user's own Firebase Auth ID token — never any server credential.
 *
 * AUTHORIZATION — this app has exactly one role: any signed-in Firebase
 * Auth user is the commissioner/admin (see js/admin/auth-boundary.js;
 * enforced identically today via firestore.rules' `request.auth !=
 * null`). Checking `request.auth` here is that exact same rule, applied
 * server-side. There is no separate roles/permissions system in this
 * project to integrate with — if one is added later, it would extend
 * the check in requireAuth() below.
 * SHARED LOGIC — this function's actual backup/discovery logic
 * (collectAllCollections) lives in scripts/lib/backup-core.js, the exact
 * same file the local CLI (`npm run backup`) uses, so both stay
 * identical by construction rather than by developer discipline. But
 * Cloud Functions deployment only uploads the `functions/` source
 * directory (see firebase.json) — it cannot reach a sibling `scripts/`
 * directory outside it. So functions/lib/ is a synced COPY of
 * scripts/lib/, regenerated automatically before every deploy by
 * firebase.json's functions.predeploy hook (scripts/sync-functions-lib.js).
 * scripts/lib remains the single edited source; functions/lib is
 * generated and git-ignored — never hand-edit functions/lib directly.
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions');
const admin = require('firebase-admin');
const { collectAllCollections } = require('./lib/backup-core');

admin.initializeApp();

const LOCK_DOC_PATH = '_internal/backupLock';
const HISTORY_COLLECTION_PATH = '_internal/backupHistory/runs';
const LOCK_STALE_AFTER_MS = 10 * 60 * 1000; // 10 min — self-heals if a previous run crashed without releasing the lock

function timestampSlug(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_` +
         `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function requireAuth(request) {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in required.');
  }
  return request.auth;
}

/**
 * Firestore-transaction-based lock (Phase 7: prevent duplicate concurrent
 * backups) — deliberately simple: one document, one transaction. If a
 * lock is already held and is recent, the second request is rejected
 * outright rather than queued, so two admins clicking "Create Backup"
 * within the same few seconds can't both kick off a run. A stale lock
 * (older than LOCK_STALE_AFTER_MS — e.g. a previous invocation crashed
 * without reaching the `finally` release) is treated as available again,
 * so one failure can't permanently wedge the feature.
 */
async function acquireLock(db) {
  const lockRef = db.doc(LOCK_DOC_PATH);
  return db.runTransaction(async tx => {
    const snap = await tx.get(lockRef);
    if (snap.exists) {
      const runningSince = snap.data().runningSince?.toMillis?.() ?? 0;
      if (Date.now() - runningSince < LOCK_STALE_AFTER_MS) {
        return false;
      }
    }
    tx.set(lockRef, { runningSince: admin.firestore.Timestamp.now() });
    return true;
  });
}

async function releaseLock(db) {
  await db.doc(LOCK_DOC_PATH).delete().catch(err => {
    logger.error('Failed to release backup lock (will self-heal after staleness timeout):', err);
  });
}

/** The actual backup operation. db/bucket are injected explicitly — see file header. */
async function runBackupCore({ db, bucket, uid, log = () => {} }) {
  const acquired = await acquireLock(db);
  if (!acquired) {
    throw new HttpsError('already-exists', 'A backup is already in progress. Please wait for it to finish.');
  }

  const startedAt = Date.now();
  const slug = timestampSlug();
  const storagePrefix = `firestore-backups/${slug}`;

  try {
    const { collections, counts, totalDocuments } = await collectAllCollections(db, log);

    for (const [collectionPath, entries] of Object.entries(collections)) {
      const fileName = collectionPath.split('/').join('__') + '.json';
      await bucket.file(`${storagePrefix}/firestore/${fileName}`).save(
        JSON.stringify(entries, null, 2),
        { contentType: 'application/json' }
      );
    }

    const metadata = {
      projectId: process.env.GCLOUD_PROJECT || admin.app().options.projectId || '(unknown)',
      usingEmulator: false,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      collectionCounts: counts,
      totalDocuments,
      totalCollectionPaths: Object.keys(counts).length,
      scriptVersion: 1,
      triggeredByUid: uid,
    };
    // metadata.json written LAST, same convention as the local CLI backup —
    // its presence is what would mark this backup run as complete.
    await bucket.file(`${storagePrefix}/metadata.json`).save(
      JSON.stringify(metadata, null, 2),
      { contentType: 'application/json' }
    );

    // History record: status/counts ONLY, never the actual backed-up
    // content — matches the instruction not to store backup contents in
    // Firestore just for the Admin UI.
    await db.collection(HISTORY_COLLECTION_PATH).doc(slug).set({
      finishedAt: admin.firestore.Timestamp.now(),
      status: 'success',
      totalDocuments,
      totalCollectionPaths: Object.keys(counts).length,
      durationMs: Date.now() - startedAt,
      storagePath: storagePrefix,
      triggeredByUid: uid,
    });

    return {
      success: true,
      totalDocuments,
      totalCollectionPaths: Object.keys(counts).length,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    // Full detail server-side only (Cloud Functions logs — never sent to
    // the client). The record we keep also carries no internal detail.
    logger.error('Backup failed:', err);
    await db.collection(HISTORY_COLLECTION_PATH).doc(slug).set({
      finishedAt: admin.firestore.Timestamp.now(),
      status: 'failed',
      durationMs: Date.now() - startedAt,
      triggeredByUid: uid,
    }).catch(historyErr => logger.error('Additionally failed to record the failure in history:', historyErr));

    if (err instanceof HttpsError) throw err;
    throw new HttpsError('internal', 'Backup failed. Please try again or check with your administrator.');
  } finally {
    await releaseLock(db);
  }
}

/** Read-only history/status query. db is injected explicitly — see file header. */
async function getHistoryCore({ db, limit = 10 }) {
  const snap = await db.collection(HISTORY_COLLECTION_PATH)
    .orderBy('finishedAt', 'desc')
    .limit(limit)
    .get();

  const runs = snap.docs.map(doc => {
    const d = doc.data();
    return {
      id: doc.id,
      finishedAt: d.finishedAt?.toDate?.().toISOString() ?? null,
      status: d.status,
      totalDocuments: d.totalDocuments ?? null,
      totalCollectionPaths: d.totalCollectionPaths ?? null,
      durationMs: d.durationMs ?? null,
    };
  });

  return { runs };
}

exports.backupFirestore = onCall({ timeoutSeconds: 300, memory: '512MiB' }, async request => {
  const auth = requireAuth(request);
  return runBackupCore({
    db: admin.firestore(),
    bucket: admin.storage().bucket(),
    uid: auth.uid,
    log: msg => logger.info(msg),
  });
});

exports.getBackupHistory = onCall({ timeoutSeconds: 30 }, async request => {
  requireAuth(request);
  return getHistoryCore({ db: admin.firestore() });
});

// Exported for tests only (see /home/claude/emulator-test/) — not used by
// the onCall wrappers above, which always use the real admin SDK.
module.exports._testables = { runBackupCore, getHistoryCore, requireAuth, acquireLock, releaseLock };
