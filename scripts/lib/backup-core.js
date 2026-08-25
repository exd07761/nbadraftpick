/**
 * scripts/lib/backup-core.js
 *
 * The actual "walk every collection/subcollection and serialize every
 * document" logic — extracted out of scripts/backup.js so it can be
 * reused, unchanged, by the new Cloud Function (functions/index.js)
 * instead of being duplicated. This module has NO knowledge of where
 * the result ends up (local disk vs Cloud Storage) — it just returns an
 * in-memory structure; the caller decides how to persist it.
 *
 * scripts/backup.js (local CLI, writes to disk) and functions/index.js
 * (Cloud Function, writes to Cloud Storage) both call
 * collectAllCollections() and get identical discovery/serialization
 * behavior — same pagination, same recursive subcollection walk, same
 * Firestore-native-type handling — from this one place.
 */

const { serializeDocData } = require('./firestore-serialize');

const PAGE_SIZE = 500;

/** Reads every document in a collection, paginated, order-stable (cursor by __name__). */
async function readAllDocs(collectionRef) {
  const docs = [];
  let cursor = null;
  for (;;) {
    let q = collectionRef.orderBy('__name__').limit(PAGE_SIZE);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    if (snap.empty) break;
    docs.push(...snap.docs);
    if (snap.docs.length < PAGE_SIZE) break;
    cursor = snap.docs[snap.docs.length - 1];
  }
  return docs;
}

/**
 * Recursively walks a collection: reads all its docs, records them, then
 * recurses into each doc's subcollections (if any), to unlimited depth.
 * collectionPathParts tracks the full path so subcollections get their
 * own entry keyed by their full path (e.g. "league/main/auditLog").
 */
async function walkCollection(collectionRef, collectionPathParts, out, counts, log) {
  const fullPath = collectionPathParts.join('/');
  log(`  reading ${fullPath} ...`);
  const docs = await readAllDocs(collectionRef);

  out[fullPath] = docs.map(doc => ({ id: doc.id, data: serializeDocData(doc.data(), collectionRef.firestore) }));
  counts[fullPath] = docs.length;
  log(`  ${fullPath}: ${docs.length} document${docs.length === 1 ? '' : 's'}`);

  for (const doc of docs) {
    const subcols = await doc.ref.listCollections();
    for (const subcol of subcols) {
      await walkCollection(subcol, [...collectionPathParts, doc.id, subcol.id], out, counts, log);
    }
  }
}

/**
 * Discovers and reads EVERY root collection and recursively every
 * subcollection, generically (via listCollections() — nothing
 * hardcoded), and returns:
 *   { collections: { "<path>": [{id, data}, ...] }, counts: { "<path>": n }, totalDocuments }
 * Never writes/updates/deletes anything — purely a read.
 *
 * `log(message)` is called for progress lines; pass a no-op if you don't
 * want console output (e.g. inside a Cloud Function, where you'd pass
 * something that writes to functions.logger instead).
 */
async function collectAllCollections(db, log = () => {}) {
  const collections = {};
  const counts = {};

  const rootCollections = await db.listCollections();
  if (!rootCollections.length) {
    log('WARNING: no root-level collections found. Nothing to back up — is this the right project/credentials?');
  }
  for (const col of rootCollections) {
    await walkCollection(col, [col.id], collections, counts, log);
  }

  const totalDocuments = Object.values(counts).reduce((a, b) => a + b, 0);
  return { collections, counts, totalDocuments };
}

module.exports = { PAGE_SIZE, readAllDocs, walkCollection, collectAllCollections };
