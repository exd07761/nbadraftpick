#!/usr/bin/env node
/**
 * scripts/sync-functions-lib.js
 *
 * Copies scripts/lib/{firestore-serialize.js, backup-core.js} into
 * functions/lib/, so functions/index.js can `require('./lib/...')` —
 * a plain relative path fully contained within the functions/ directory,
 * instead of the previous `"nbadraftpick-backup-lib": "file:../scripts/lib"`
 * dependency in functions/package.json.
 *
 * WHY: `npm install` resolves a `file:` dependency as a symlink (verified
 * locally: functions/node_modules/nbadraftpick-backup-lib ->
 * ../../scripts/lib). `firebase deploy` only uploads the contents of the
 * `functions` source directory (per firebase.json) — scripts/lib is
 * outside that tree, so the symlink target wouldn't exist in Cloud
 * Build's environment, and `npm install` there would fail trying to
 * resolve it. That would break deployment entirely.
 *
 * scripts/lib remains the single source of truth — this script is run
 * automatically by firebase.json's functions.predeploy hook before every
 * `firebase deploy`, so functions/lib is always a fresh, self-contained
 * copy at deploy time. It's also safe (and sometimes necessary, e.g. for
 * local `firebase emulators:start`) to run manually:
 *
 *   npm run sync-functions-lib
 *
 * functions/lib/ is git-ignored (see .gitignore) — it's a generated copy,
 * not something to hand-edit or track independently of scripts/lib.
 */

const fs = require('fs');
const path = require('path');

const FILES_TO_SYNC = ['firestore-serialize.js', 'backup-core.js'];
const SRC_DIR = path.join(__dirname, 'lib');
const DEST_DIR = path.join(__dirname, '..', 'functions', 'lib');

fs.mkdirSync(DEST_DIR, { recursive: true });

for (const file of FILES_TO_SYNC) {
  const srcPath = path.join(SRC_DIR, file);
  const destPath = path.join(DEST_DIR, file);
  if (!fs.existsSync(srcPath)) {
    console.error(`ERROR: expected source file not found: ${srcPath}`);
    process.exit(1);
  }
  fs.copyFileSync(srcPath, destPath);
  console.log(`  synced ${path.relative(process.cwd(), srcPath)} -> ${path.relative(process.cwd(), destPath)}`);
}

console.log('functions/lib is up to date with scripts/lib.');
