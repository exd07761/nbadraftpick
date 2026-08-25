#!/usr/bin/env node
/**
 * scripts/backup.js
 *
 * Exports the ENTIRE Firestore database for this project — every
 * root-level collection, and recursively every subcollection of every
 * document — into a timestamped local backup folder. Read-only: never
 * writes, updates, or deletes anything in Firestore.
 *
 * This app currently stores its whole state in a single document
 * (collection "league", doc "main" — see js/data.js), but this walker
 * does NOT hardcode that path. It discovers collections generically via
 * listCollections(), so it stays correct if more top-level collections
 * or subcollections are ever added later, and satisfies "export ALL
 * Firestore data" rather than one known path.
 *
 * Usage:
 *   npm run backup
 *   node scripts/backup.js
 *   node scripts/backup.js --out ./backups   (default: ./backups)
 *
 * Output:
 *   backups/<YYYY-MM-DD_HHMMSS>/
 *     firestore/<collection>/<subcollection-path...>.json   (one file per
 *       collection path — an array of {id, data} entries, data run
 *       through serializeDocData so Firestore-native types survive)
 *     metadata.json   (project id, run time, per-collection doc counts,
 *       total doc count, script version)
 *
 * PAGE_SIZE below batches reads so this doesn't try to pull an enormous
 * collection into memory / a single Firestore response in one shot.
 */

const fs = require('fs');
const path = require('path');
const { initAdmin, admin } = require('./lib/init-admin');
const { collectAllCollections } = require('./lib/backup-core');

function timestampSlug(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_` +
         `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function runBackup({ outDir = 'backups', db: injectedDb, projectId: injectedProjectId } = {}) {
  // injectedDb/injectedProjectId exist solely so this function can be
  // exercised in tests against a fake Firestore (see
  // /home/claude/emulator-test/ — not part of this repo) without needing
  // real credentials. The CLI path below never sets these; real usage
  // always resolves through initAdmin()/admin.firestore() as normal.
  let db, projectId, usingEmulator;
  if (injectedDb) {
    db = injectedDb;
    projectId = injectedProjectId || '(test)';
    usingEmulator = true;
  } else {
    const app = initAdmin();
    db = admin.firestore();
    projectId = app.options.projectId || '(unknown)';
    usingEmulator = !!process.env.FIRESTORE_EMULATOR_HOST;
  }

  const slug = timestampSlug();
  const backupDir = path.join(outDir, slug);
  const firestoreDir = path.join(backupDir, 'firestore');
  fs.mkdirSync(firestoreDir, { recursive: true });

  console.log(`\nBacking up Firestore project "${projectId}"${usingEmulator ? ' (EMULATOR — not production)' : ''}`);
  console.log(`Output: ${path.resolve(backupDir)}\n`);

  const startedAt = Date.now();
  let collections, counts, totalDocs;

  try {
    ({ collections, counts, totalDocuments: totalDocs } = await collectAllCollections(db, msg => console.log(msg)));

    // Disk writes are inside the same try block as the Firestore reads
    // above: a failure here (e.g. disk full, permissions) is just as
    // capable of leaving a partial, misleading backup directory behind
    // as a failure during reading is, so it gets the identical
    // cleanup-and-fail-loudly treatment rather than silently exiting
    // with some collection files written and others (or metadata.json)
    // missing.
    for (const [collectionPath, entries] of Object.entries(collections)) {
      const fileName = collectionPath.split('/').join('__') + '.json';
      fs.writeFileSync(path.join(firestoreDir, fileName), JSON.stringify(entries, null, 2), 'utf8');
    }
  } catch (err) {
    console.error('\nBACKUP FAILED:', err.message);
    console.error('No partial backup was left in place for this run.');
    // Clean up the partial directory so a failed run can't be mistaken for a good one.
    fs.rmSync(backupDir, { recursive: true, force: true });
    process.exit(1);
  }

  const metadata = {
    projectId,
    usingEmulator,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    collectionCounts: counts,
    totalDocuments: totalDocs,
    totalCollectionPaths: Object.keys(counts).length,
    scriptVersion: 1,
  };
  // metadata.json is written LAST and is what restore.js treats as the
  // marker of a complete, valid backup (see loadBackup() in restore.js).
  // If this write itself fails, the same cleanup applies.
  try {
    fs.writeFileSync(path.join(backupDir, 'metadata.json'), JSON.stringify(metadata, null, 2), 'utf8');
  } catch (err) {
    console.error('\nBACKUP FAILED while writing metadata.json:', err.message);
    fs.rmSync(backupDir, { recursive: true, force: true });
    process.exit(1);
  }

  console.log(`\nBackup complete: ${totalDocs} document(s) across ${Object.keys(counts).length} collection path(s).`);
  console.log(`Saved to: ${path.resolve(backupDir)}\n`);
  return { backupDir, metadata };
}

if (require.main === module) {
  const outArgIdx = process.argv.indexOf('--out');
  const outDir = outArgIdx !== -1 ? process.argv[outArgIdx + 1] : 'backups';
  runBackup({ outDir }).catch(err => {
    console.error('Unexpected error:', err);
    process.exit(1);
  });
}

module.exports = { runBackup };
