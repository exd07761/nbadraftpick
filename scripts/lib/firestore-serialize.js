/**
 * scripts/lib/firestore-serialize.js
 *
 * Converts Firestore Admin SDK values <-> plain-JSON-safe values, without
 * losing Firestore-native types along the way (Timestamp, GeoPoint,
 * DocumentReference, Bytes). Used by both backup.js (serialize) and
 * restore.js (deserialize) so the round-trip is guaranteed symmetric.
 *
 * Plain JSON has no concept of these types, so each one is encoded as a
 * small tagged object: { __type: "...", ... }. A real Firestore document
 * is very unlikely to naturally contain a field shaped exactly like that,
 * but as a guard, deserialize() only treats an object as a tagged value if
 * its __type is one it recognizes — anything else round-trips as a plain
 * object.
 */

const admin = require('firebase-admin');

function serializeValue(value, db) {
  if (value === null || value === undefined) return null;

  // Timestamp
  if (value instanceof admin.firestore.Timestamp) {
    return { __type: 'timestamp', seconds: value.seconds, nanoseconds: value.nanoseconds };
  }

  // GeoPoint
  if (value instanceof admin.firestore.GeoPoint) {
    return { __type: 'geopoint', latitude: value.latitude, longitude: value.longitude };
  }

  // Bytes — the Admin SDK (Node) represents Firestore `bytes` fields as
  // native Buffer objects, not a wrapper class (that's a client/web-SDK-
  // only concept — admin.firestore.Bytes does not exist server-side).
  if (Buffer.isBuffer(value)) {
    return { __type: 'bytes', base64: value.toString('base64') };
  }

  // DocumentReference — store the path; re-resolved against the target
  // project's db at restore time, since a reference is only meaningful
  // relative to *some* Firestore instance. Checked both by instanceof
  // (the normal case) and by shape (a real Admin SDK DocumentReference
  // always exposes .path/.id/.firestore) as a defensive fallback —
  // cheap, and guards against edge cases across SDK versions where
  // instanceof against this exact class reference might not match.
  const looksLikeDocRef = value && typeof value.path === 'string' && typeof value.id === 'string' && value.firestore;
  if (value instanceof admin.firestore.DocumentReference || looksLikeDocRef) {
    return { __type: 'ref', path: value.path };
  }

  // Arrays
  if (Array.isArray(value)) {
    return value.map(v => serializeValue(v, db));
  }

  // Plain objects (includes nested maps)
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = serializeValue(v, db);
    }
    return out;
  }

  // string / number / boolean — JSON-safe as-is
  return value;
}

function deserializeValue(value, db) {
  if (value === null || value === undefined) return value;

  if (Array.isArray(value)) {
    return value.map(v => deserializeValue(v, db));
  }

  if (typeof value === 'object') {
    if (value.__type === 'timestamp') {
      return new admin.firestore.Timestamp(value.seconds, value.nanoseconds);
    }
    if (value.__type === 'geopoint') {
      return new admin.firestore.GeoPoint(value.latitude, value.longitude);
    }
    if (value.__type === 'bytes') {
      return Buffer.from(value.base64, 'base64');
    }
    if (value.__type === 'ref') {
      return db.doc(value.path);
    }
    // Plain nested object
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = deserializeValue(v, db);
    }
    return out;
  }

  return value;
}

/** Serializes a full document's data() object field-by-field. */
function serializeDocData(data, db) {
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    out[k] = serializeValue(v, db);
  }
  return out;
}

/** Deserializes a full document's data() object field-by-field. */
function deserializeDocData(data, db) {
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    out[k] = deserializeValue(v, db);
  }
  return out;
}

module.exports = { serializeValue, deserializeValue, serializeDocData, deserializeDocData };
