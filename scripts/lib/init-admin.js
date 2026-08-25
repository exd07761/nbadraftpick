/**
 * scripts/lib/init-admin.js
 *
 * Shared, secure Firebase Admin SDK bootstrap for backup.js / restore.js.
 *
 * SECURITY — this is the only place credentials are touched:
 *   - Never hardcodes a service-account key or path in this repo.
 *   - Uses Application Default Credentials resolution, in order:
 *       1. GOOGLE_APPLICATION_CREDENTIALS env var (path to a service-
 *          account JSON key file you download from the Firebase Console
 *          and keep OUTSIDE this repo, or inside it but git-ignored —
 *          see .gitignore's `*.serviceAccountKey.json` / `service-account*.json`
 *          patterns).
 *       2. FIRESTORE_EMULATOR_HOST env var, for local testing against the
 *          Firestore emulator — no real credentials needed at all in this
 *          mode (this is how this system was verified — see the "Verification"
 *          section of BACKUP_RESTORE.md).
 *   - If neither is set, fails immediately with a clear explanation
 *     instead of silently trying (and failing more confusingly) to reach
 *     a real project with no credentials.
 *   - The service-account key itself is never printed, logged, copied, or
 *     transmitted anywhere by these scripts.
 */

const admin = require('firebase-admin');
const fs = require('fs');

/**
 * Best-effort, local-only project ID discovery from the service-account
 * key file itself (GOOGLE_APPLICATION_CREDENTIALS). Every Firebase/GCP
 * service-account key has a `project_id` field — reading it directly is
 * the safest way to report the correct project: no extra dependency, no
 * extra network call/permission, and it's guaranteed to match whatever
 * credential Firestore itself will actually use, since it's the exact
 * same file. Failure here (missing/unreadable/malformed file) is
 * swallowed on purpose — this is only ever used for metadata/display,
 * never to gate whether the backup runs (see initAdmin() below).
 */
function readProjectIdFromServiceAccountFile(keyPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
    return parsed.project_id || null;
  } catch {
    return null;
  }
}

function initAdmin() {
  if (admin.apps.length) return admin.app();

  const usingEmulator = !!process.env.FIRESTORE_EMULATOR_HOST;
  const usingServiceAccount = !!process.env.GOOGLE_APPLICATION_CREDENTIALS;

  if (!usingEmulator && !usingServiceAccount) {
    console.error(
      '\nERROR: No Firebase Admin credentials found.\n\n' +
      'This script refuses to guess — set ONE of:\n\n' +
      '  GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/serviceAccountKey.json\n' +
      '    (download from Firebase Console -> Project Settings -> Service\n' +
      '     accounts -> Generate new private key. NEVER commit this file —\n' +
      '     see .gitignore. Keep it outside the repo if possible.)\n\n' +
      '  FIRESTORE_EMULATOR_HOST=localhost:8080\n' +
      '    (to run against the local Firestore emulator instead of a real\n' +
      '     project — see BACKUP_RESTORE.md \'Testing without touching\n' +
      '     production\' for how to set this up.)\n'
    );
    process.exit(1);
  }

  const initOpts = {};
  if (process.env.FIREBASE_PROJECT_ID) {
    // Explicit override always wins if you've set it.
    initOpts.projectId = process.env.FIREBASE_PROJECT_ID;
  } else if (usingServiceAccount) {
    // The fix: derive it from the same key file already in use, instead
    // of leaving it undefined (which previously showed up as
    // metadata.projectId: "(unknown)", even though the backup itself was
    // targeting the correct project all along).
    const fromFile = readProjectIdFromServiceAccountFile(process.env.GOOGLE_APPLICATION_CREDENTIALS);
    if (fromFile) initOpts.projectId = fromFile;
  } else if (usingEmulator) {
    // The emulator needs *a* project id even though it's fake/local.
    initOpts.projectId = 'nbadraftpick';
  }

  admin.initializeApp(initOpts);
  return admin.app();
}

module.exports = { initAdmin, admin };
