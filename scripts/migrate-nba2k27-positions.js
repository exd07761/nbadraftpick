#!/usr/bin/env node
/**
 * scripts/migrate-nba2k27-positions.js
 *
 * One-time backfill: copies any position curated in the legacy
 * `nba2k27_positions/<slug>` collection into the now-canonical
 * `nba2k27_pool/<slug>.position` field, ahead of retiring the legacy
 * collection (retirement is a separate, later step — this script never
 * deletes anything).
 *
 * SAFETY RULES (all enforced below, not just documented):
 *   - Only copies when a matching `nba2k27_pool/<slug>` document already
 *     exists. A legacy position with no pool doc to attach to is
 *     reported as "missing pool document", never guessed at or used to
 *     create one (creating pool docs is Nba2k27PoolView's "Initialize
 *     2K27 Pool" job, not this script's).
 *   - Only copies a legacy value that is one of the five real positions
 *     (PG/SG/SF/PF/C) — never 'UNASSIGNED' (there is nothing to migrate:
 *     the pool doc's own position already defaults to that), and never
 *     anything else invalid.
 *   - NEVER overwrites an already-assigned (valid) position on the pool
 *     document. If `nba2k27_pool/<slug>.position` is already PG/SG/SF/
 *     PF/C, that value wins — it is presumed to be the more recent,
 *     authoritative one (the sorter writes there directly now), and the
 *     legacy value is reported as "skipped — already assigned", not
 *     written.
 *   - Every write updates ONLY `position`/`updatedAt` via a merge — it
 *     is structurally incapable of touching `nba2kRef`/`pool`/
 *     `selectedAt`/anything else already on the document.
 *   - Never touches `nba2k_players`, `league/main`, or the legacy
 *     `nba2k27_positions` collection itself (read-only source) — this
 *     script performs exactly one kind of write:
 *     `nba2k27_pool/<slug>.update({ position, updatedAt })`.
 *   - Dry-run by default. Only with --confirm does it actually write —
 *     same convention as scripts/restore.js in this repo.
 *
 * Usage:
 *   node scripts/migrate-nba2k27-positions.js              (dry run — reports only)
 *   node scripts/migrate-nba2k27-positions.js --confirm     (actually writes)
 *
 * Reports, either way:
 *   - number migrated (would-migrate, in dry-run)
 *   - number skipped because already assigned
 *   - number missing pool documents
 *   - number invalid positions
 */

const { initAdmin, admin } = require('./lib/init-admin');

const VALID_MIGRATABLE_POSITIONS = ['PG', 'SG', 'SF', 'PF', 'C'];

/**
 * Pure decision function — given one legacy doc's raw `position` value
 * and the matching pool doc (or null/undefined if none exists), decides
 * exactly what should happen. No Firestore calls in here at all, so
 * this is directly unit-testable (see tests_p12) without a fake
 * Firestore for every case.
 */
function decideMigration(legacyPosition, poolDoc) {
  if (!poolDoc) return { action: 'missing-pool-doc' };
  if (!VALID_MIGRATABLE_POSITIONS.includes(legacyPosition)) return { action: 'invalid-position' };
  const currentPoolPosition = poolDoc.position;
  const alreadyAssigned = VALID_MIGRATABLE_POSITIONS.includes(currentPoolPosition);
  if (alreadyAssigned) return { action: 'skipped-already-assigned' };
  return { action: 'migrate', position: legacyPosition };
}

async function runMigration({ confirm, db: injectedDb, projectId: injectedProjectId } = {}) {
  // injectedDb/injectedProjectId exist solely so this function can be
  // exercised in tests against a fake Firestore, matching the exact
  // same injectable-db pattern scripts/backup.js already uses. The CLI
  // path below never sets these.
  let db, projectId;
  if (injectedDb) {
    db = injectedDb;
    projectId = injectedProjectId || '(test)';
  } else {
    const app = initAdmin();
    db = admin.firestore();
    projectId = app.options.projectId || '(unknown)';
  }

  console.log(`Project: ${projectId}`);
  console.log('Reading nba2k27_positions (legacy) and nba2k27_pool (canonical) ...\n');

  const [legacySnap, poolSnap] = await Promise.all([
    db.collection('nba2k27_positions').get(),
    db.collection('nba2k27_pool').get(),
  ]);

  const poolDocs = {};
  poolSnap.docs.forEach(d => { poolDocs[d.id] = d.data(); });

  const toWrite = []; // [{slug, position}]
  let skippedAlreadyAssigned = 0;
  let missingPoolDoc = 0;
  let invalidPosition = 0;

  legacySnap.docs.forEach(d => {
    const slug = d.id;
    const legacyPosition = (d.data() || {}).position;
    const decision = decideMigration(legacyPosition, poolDocs[slug]);
    switch (decision.action) {
      case 'migrate':
        toWrite.push({ slug, position: decision.position });
        break;
      case 'skipped-already-assigned':
        skippedAlreadyAssigned++;
        break;
      case 'missing-pool-doc':
        missingPoolDoc++;
        break;
      case 'invalid-position':
        invalidPosition++;
        break;
      default:
        break;
    }
  });

  console.log(`Legacy nba2k27_positions documents scanned: ${legacySnap.size}`);
  console.log(`  Would migrate${confirm ? 'd' : ''}                 : ${toWrite.length}`);
  console.log(`  Skipped — already assigned      : ${skippedAlreadyAssigned}`);
  console.log(`  Skipped — missing pool document  : ${missingPoolDoc}`);
  console.log(`  Skipped — invalid position value : ${invalidPosition}`);

  if (!confirm) {
    console.log('\nDry run only — no writes performed.');
    console.log('Re-run with --confirm to actually perform this migration:');
    console.log('  node scripts/migrate-nba2k27-positions.js --confirm\n');
    return { dryRun: true, migrated: toWrite.length, skippedAlreadyAssigned, missingPoolDoc, invalidPosition };
  }

  console.log('\n--confirm was passed. Writing now ...\n');

  const nowIso = new Date().toISOString();
  let written = 0;
  // Chunked, matching the batched-write convention already used by
  // Nba2k27PoolView._runInitialization (Firestore batches cap at 500
  // writes) — this script never assumes a small dataset.
  for (let i = 0; i < toWrite.length; i += 450) {
    const chunk = toWrite.slice(i, i + 450);
    const batch = db.batch();
    chunk.forEach(item => {
      // Merge-only — touches ONLY position/updatedAt, exactly like the
      // sorter's own write path. Never re-derives or touches pool,
      // nba2kRef, or selectedAt.
      batch.set(db.collection('nba2k27_pool').doc(item.slug), { position: item.position, updatedAt: nowIso }, { merge: true });
    });
    await batch.commit();
    written += chunk.length;
  }

  console.log(`Done. ${written} position(s) migrated into nba2k27_pool.\n`);
  return { dryRun: false, migrated: written, skippedAlreadyAssigned, missingPoolDoc, invalidPosition };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const confirm = args.includes('--confirm');
  runMigration({ confirm }).catch(err => {
    console.error('Migration failed:', err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { runMigration, decideMigration, VALID_MIGRATABLE_POSITIONS };
