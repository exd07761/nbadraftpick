#!/usr/bin/env node
/**
 * scripts/restore.js
 *
 * Restores a backup produced by backup.js back into Firestore.
 *
 * SAFETY: by default this is a DRY RUN. It reads the backup, reports
 * exactly what it WOULD do (target project, document counts, which
 * documents already exist and would be overwritten), and writes NOTHING.
 * Only with --confirm does it actually perform writes.
 *
 * Usage:
 *   node scripts/restore.js backups/<folder>              (dry run)
 *   node scripts/restore.js backups/<folder> --confirm     (actually writes)
 *   npm run restore -- backups/<folder> --confirm
 *
 * Writes use batched Firestore writes (500 ops/batch, the Admin SDK
 * limit) and merge:false (an explicit "set", overwriting any existing
 * document at that ID with EXACTLY the backed-up data) — a restore is
 * supposed to put things back the way they were, not merge with
 * whatever's there now.
 */

const fs = require('fs');
const path = require('path');
const { initAdmin, admin } = require('./lib/init-admin');
const { deserializeDocData } = require('./lib/firestore-serialize');

const BATCH_LIMIT = 500;

function loadBackup(backupDir) {
  const metadataPath = path.join(backupDir, 'metadata.json');
  if (!fs.existsSync(metadataPath)) {
    throw new Error(`Not a valid backup directory (no metadata.json found): ${backupDir}`);
  }
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));

  const firestoreDir = path.join(backupDir, 'firestore');
  if (!fs.existsSync(firestoreDir) || !fs.statSync(firestoreDir).isDirectory()) {
    throw new Error(`Not a valid backup directory (metadata.json exists, but no firestore/ folder found): ${backupDir}`);
  }

  const collections = {}; // collectionPath -> [{id, data}]
  for (const file of fs.readdirSync(firestoreDir)) {
    if (!file.endsWith('.json')) continue;
    const collectionPath = file.slice(0, -'.json'.length).split('__').join('/');
    collections[collectionPath] = JSON.parse(fs.readFileSync(path.join(firestoreDir, file), 'utf8'));
  }
  return { metadata, collections };
}

async function checkExisting(db, collections) {
  const existing = {}; // collectionPath -> count of doc IDs that already exist
  for (const [collectionPath, entries] of Object.entries(collections)) {
    let count = 0;
    for (const entry of entries) {
      const ref = db.collection(collectionPath).doc(entry.id);
      const snap = await ref.get();
      if (snap.exists) count++;
    }
    existing[collectionPath] = count;
  }
  return existing;
}

async function performRestore(db, collections, log) {
  let batch = db.batch();
  let opsInBatch = 0;
  let totalWritten = 0;

  const flush = async () => {
    if (opsInBatch === 0) return;
    await batch.commit();
    batch = db.batch();
    opsInBatch = 0;
  };

  for (const [collectionPath, entries] of Object.entries(collections)) {
    log(`  restoring ${collectionPath} (${entries.length} doc${entries.length === 1 ? '' : 's'}) ...`);
    for (const entry of entries) {
      const ref = db.collection(collectionPath).doc(entry.id);
      const data = deserializeDocData(entry.data, db);
      batch.set(ref, data); // merge:false — full overwrite, matches backup exactly
      opsInBatch++;
      totalWritten++;
      if (opsInBatch >= BATCH_LIMIT) await flush();
    }
  }
  await flush();
  return totalWritten;
}

async function runRestore({ backupDir, confirm, db: injectedDb, projectId: injectedProjectId }) {
  if (!backupDir) {
    console.error('Usage: node scripts/restore.js <backup-dir> [--confirm]');
    process.exit(1);
  }
  if (!fs.existsSync(backupDir)) {
    console.error(`Backup directory not found: ${backupDir}`);
    process.exit(1);
  }

  // injectedDb/injectedProjectId: see the matching comment in backup.js —
  // test-only seam, unused by the real CLI path below.
  let db, targetProjectId, usingEmulator;
  if (injectedDb) {
    db = injectedDb;
    targetProjectId = injectedProjectId || '(test)';
    usingEmulator = true;
  } else {
    const app = initAdmin();
    db = admin.firestore();
    targetProjectId = app.options.projectId || '(unknown)';
    usingEmulator = !!process.env.FIRESTORE_EMULATOR_HOST;
  }

  const { metadata, collections } = loadBackup(backupDir);
  const totalDocs = Object.values(collections).reduce((a, b) => a + b.length, 0);

  console.log(`\n${'='.repeat(60)}`);
  console.log('RESTORE PLAN');
  console.log('='.repeat(60));
  console.log(`Backup:              ${path.resolve(backupDir)}`);
  console.log(`Backup taken from:   ${metadata.projectId}${metadata.usingEmulator ? ' (was an emulator run)' : ''}`);
  console.log(`Backup created at:   ${metadata.finishedAt}`);
  console.log(`Restore target:      ${targetProjectId}${usingEmulator ? ' (EMULATOR — not production)' : ''}`);
  console.log(`Documents to write:  ${totalDocs} across ${Object.keys(collections).length} collection path(s)`);
  for (const [p, entries] of Object.entries(collections)) {
    console.log(`  - ${p}: ${entries.length}`);
  }

  if (!usingEmulator && metadata.projectId !== targetProjectId) {
    console.log(`\n*** WARNING: backup was taken from project "${metadata.projectId}" but you are`);
    console.log(`*** currently authenticated against project "${targetProjectId}". Double-check`);
    console.log(`*** GOOGLE_APPLICATION_CREDENTIALS is pointing at the credential you intend.`);
  }

  console.log('\nChecking which target documents already exist (would be overwritten) ...');
  const existing = await checkExisting(db, collections);
  const totalExisting = Object.values(existing).reduce((a, b) => a + b, 0);
  console.log(`Documents that already exist at the target and WOULD BE OVERWRITTEN: ${totalExisting}`);
  for (const [p, n] of Object.entries(existing)) {
    if (n > 0) console.log(`  - ${p}: ${n} existing document(s) would be overwritten`);
  }

  console.log('='.repeat(60));

  if (!confirm) {
    console.log('\nDRY RUN ONLY — no data was written.');
    console.log('Re-run with --confirm to actually perform this restore:');
    console.log(`  node scripts/restore.js ${backupDir} --confirm\n`);
    return { dryRun: true, totalDocs, totalExisting };
  }

  console.log('\n--confirm was passed. Writing now ...\n');
  const written = await performRestore(db, collections, msg => console.log(msg));
  console.log(`\nRestore complete: ${written} document(s) written to project "${targetProjectId}".\n`);
  return { dryRun: false, totalDocs: written, totalExisting };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const confirm = args.includes('--confirm');
  const backupDir = args.find(a => a !== '--confirm');
  runRestore({ backupDir, confirm }).catch(err => {
    console.error('Unexpected error:', err);
    process.exit(1);
  });
}

module.exports = { runRestore };
