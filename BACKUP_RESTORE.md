# Firestore Backup & Restore

This app uses two Firestore root collections today (see "What's backed
up" below): `league` (its entire application state, in one document,
`league/main` — see `js/data.js`) and `nba2k_players` (the imported NBA
2K player database — see `js/nba2k-database.js` /
`js/admin/nba2k-import.js`). There are two independent backup mechanisms:

### Local CLI Backup

```bash
npm run backup
```

This remains the full Admin SDK backup mechanism described throughout
this document, and continues to use the existing service-account
authentication. It discovers every root collection and recursively walks
every subcollection via the Admin SDK's `listCollections()` — nothing is
hardcoded — so it stays correct even if more collections get added
later.

### Admin Panel Backup

```text
Admin → Backup → Download Full Firestore JSON
```

This is a browser-generated JSON backup, using the authenticated Firebase
**Web** SDK — it does not use Cloud Functions or Cloud Storage (an
earlier version did; that architecture was removed — see "Admin Panel
backup — architecture" below). It is limited to whatever data the
signed-in Admin can read through Firestore Security Rules, and — because
the Web SDK has no equivalent of the Admin SDK's `listCollections()` — to
a hand-maintained list of known collections (`js/admin/backup.js`) rather
than genuine generic discovery. It is **not** identical to a Firebase
Console native export, and is called a **Firestore JSON backup** here
rather than that, since it isn't the native export format. See "Admin
Panel backup — architecture" for the full limitation writeup.

## Files created

CLI backup/restore (original):
- `scripts/backup.js` — exports all Firestore data to a timestamped folder.
- `scripts/restore.js` — restores a backup folder back into Firestore (dry-run by default).
- `scripts/lib/firestore-serialize.js` — shared type-preserving (de)serialization used by both.
- `scripts/lib/init-admin.js` — shared, secure credential loading.
- `scripts/lib/backup-core.js` — the collection-discovery/walk logic, extracted out of `backup.js` as its own module (originally so a now-removed Cloud Function could also reuse it — see "Admin Panel backup — architecture" below for the current, Cloud-Function-free architecture).
- `package.json` — `npm run backup` / `npm run restore` commands.
- `.gitignore` — added (didn't exist before).
- `BACKUP_RESTORE.md` — this file.

Admin Panel "Download Full Firestore JSON" button (browser-only, current):
- `js/admin/backup.js` — the Admin panel view: the button, a hand-maintained list of known root collections, a browser-compatible Firestore-native-type serializer, and the Blob-based download. See its file header comment for the full design rationale.

Removed (previous Cloud Function architecture — no longer part of this
project): `functions/index.js`, `functions/package.json`, `functions/lib/`
(generated), `scripts/sync-functions-lib.js`, `firebase.json`. Nothing
else in the project depended on the `functions/` directory or on
`firebase.json`, so both were deleted outright rather than partially
cleaned up.

## Files modified

- `js/admin.js` — registered the `backup` route (unchanged by this revision).
- `admin.html` — removed the now-unused `firebase-functions-compat.js` script tag (the Admin panel backup no longer calls any Cloud Function).
- `css/admin.css` — removed `.backup-latest`/`.backup-latest-label` (the backup-history table they styled no longer exists); kept `.backup-intro`/`.backup-muted`/`.backup-result*`, which the current view still uses.
- `package.json` — removed the `sync-functions-lib` script (its target file no longer exists).
- `scripts/lib/backup-core.js` — updated its header comment only (no logic change) to stop referencing the now-removed Cloud Function.

Nothing else in the frontend changed — draft/roster/schedule/etc. views, Firestore security rules, and the public site are all untouched. The CLI backup/restore system (`scripts/backup.js`, `scripts/restore.js`, `scripts/lib/firestore-serialize.js`, `scripts/lib/init-admin.js`) is functionally unchanged.

## Admin Panel backup — architecture

```
Admin clicks "Download Full Firestore JSON"
        │
        │  AuthBoundary.requireAuth() — fast client-side check
        │  (js/admin/backup.js)
        ▼
For each name in KNOWN_ROOT_COLLECTIONS (currently ["league", "nba2k_players"]):
        │  firebase.firestore().collection(name).get()
        │  (Firebase Web SDK — reads only what Firestore Security Rules
        │   allow the signed-in admin to read; no credential beyond the
        │   admin's own Firebase Auth session is involved anywhere)
        ▼
Every document serialized (Timestamp/GeoPoint/Bytes/DocumentReference
preserved as tagged values, same {"__type": ...} shape the CLI backup
uses) and collected into one { metadata, documents: [{path, data}, ...] } object
        ▼
Blob + <a download> — the file downloads directly to the admin's computer;
nothing is uploaded anywhere, and nothing is written to Firestore
        ▼
js/admin/backup.js renders the result (document count, collection-path
count, filename, elapsed time) or a non-sensitive error message
```

**Why this can't genuinely discover collections the way the CLI does**:
the CLI (and the former Cloud Function) can call `db.listCollections()` /
`docRef.listCollections()` because the Admin SDK runs with privileged
(service-account) access. The Firebase **Web** SDK has no equivalent of
that method at all — collection discovery isn't something Firestore
Security Rules can expose to a signed-in client, by design. So
`KNOWN_ROOT_COLLECTIONS` in `js/admin/backup.js` is a hand-maintained
list, confirmed against this codebase's actual Firestore reads at the
time this was written. **If a new top-level collection or a subcollection
is ever added to this app, that list must be updated by hand**, or the
browser backup will silently miss it — this limitation is called out in
that file's header comment and is why this feature is described as a
"Firestore JSON backup" rather than a complete/generic export.

**Authorization**: same single-role model as everywhere else in this app
— any signed-in Firebase Auth user is the commissioner/admin (see
`js/admin/auth-boundary.js`), enforced by `firestore.rules`
(`request.auth != null`). The browser backup reads through that same
boundary; it has no elevated access beyond what the signed-in admin
already has via the public client SDK.

**No history, no lock, no restore**: this view has no backup-history
list (nothing server-side records past browser-downloaded backups — each
one exists only in browser memory during generation and then as the
downloaded file) and no duplicate-request lock (only a same-tab
button-disable while a download is in progress). Restore remains
intentionally NOT exposed in the Admin panel; `npm run restore` is still
the only way to restore, same as before this revision.

## Running a backup

```bash
mkdir -p secrets   # if you don't already have this — see "Authentication" below
export GOOGLE_APPLICATION_CREDENTIALS=$(pwd)/secrets/serviceAccountKey.json
npm run backup
# or: npm run backup -- --out /some/other/directory
```

Output goes to `backups/<YYYY-MM-DD_HHMMSS>/`:

```
backups/2026-08-23_155750/
  firestore/
    league.json                     # root collection "league"
    league__main__auditLog.json     # subcollection league/main/auditLog (if any)
  metadata.json                     # project id, doc counts, timing
```

Each collection/subcollection path becomes its own JSON file (an array of
`{id, data}` entries). `data` has been run through the serializer, so
Timestamps/GeoPoints/Bytes/References survive as tagged values like
`{"__type": "timestamp", "seconds": ..., "nanoseconds": ...}` instead of
being silently flattened to strings.

Every run creates a **new** timestamped folder. Nothing is ever deleted or
overwritten, and the backup only ever *reads* from Firestore.

## Running a restore

```bash
# 1. Dry run (default) — reports what WOULD happen, writes nothing:
node scripts/restore.js backups/2026-08-23_155750

# 2. Only once you're sure, actually write:
npm run restore -- backups/2026-08-23_155750 --confirm
```

The dry run prints:
- which backup and which target project are involved,
- exactly how many documents in each collection would be written,
- how many of those documents **already exist** at the target and would
  be **overwritten**,
- a warning if the backup's original project ID doesn't match the
  project your current credentials point at.

Nothing is written unless `--confirm` is passed explicitly.

## Where backups are stored

`backups/` in the project root (git-ignored — see below). Each run is its
own timestamped subfolder; nothing here is ever deleted automatically.

## What's backed up

Everything Firestore has, discovered generically rather than hardcoded.
As currently deployed, this app uses two root collections:
- `league` (1 document: `main`, containing all seasons/players/settings).
- `nba2k_players` (one document per imported NBA 2K player, keyed by slug).

If you ever add more top-level collections or subcollections, they'll be
picked up automatically on the next **CLI** backup run — no script
changes needed. The separate Admin Panel browser backup does NOT get
this for free — see "Admin Panel backup — architecture" above.

## Authentication

Uses the Firebase **Admin SDK** (server-side, full read/write access —
this is intentionally different from the public site's client SDK, which
is scoped down by `firestore.rules`). Credentials are resolved from
environment variables only, in this order:

1. `GOOGLE_APPLICATION_CREDENTIALS=/path/to/serviceAccountKey.json` — a
   service-account key you generate yourself from **Firebase Console →
   Project Settings → Service Accounts → Generate new private key**. This
   repo never has this key baked in, and `scripts/lib/init-admin.js`
   never logs, prints, or transmits it.

   Recommended: put it in `secrets/` at the project root (e.g.
   `secrets/serviceAccountKey.json`) — that whole directory is
   git-ignored regardless of filename, as a backstop beyond the
   filename-pattern rules also in `.gitignore`.
2. `FIRESTORE_EMULATOR_HOST=localhost:8080` — for testing against a local
   emulator with no real credentials at all.

If neither is set, the scripts refuse to run and explain exactly what to
set, rather than failing with a confusing low-level network error.

## Scheduling automatic backups later

A few options, roughly in order of how much infrastructure they need:

- **Cron on any machine that has the service-account key**: 
  `0 3 * * * cd /path/to/repo && GOOGLE_APPLICATION_CREDENTIALS=/secure/path/key.json npm run backup`
- **GitHub Actions**, scheduled (`on: schedule`), with the service-account
  key stored as a GitHub Actions *secret* (never in the repo) and written
  to a temp file at job start, then `npm run backup`, then upload the
  `backups/` folder as a workflow artifact (or push it to private cloud
  storage — GitHub Actions artifacts expire).
- **A small Cloud Function on a Pub/Sub or Cloud Scheduler trigger**,
  running the same backup logic natively inside GCP, writing to a Cloud
  Storage bucket instead of local disk — the more "properly hosted"
  version of this, but more setup than the two options above.

None of this is wired up yet since it wasn't asked for beyond "how could
I do this later" — happy to implement whichever of these fits your actual
hosting situation if you want it done.

## Security considerations

- Service-account keys are never committed — `.gitignore` blocks
  `*serviceAccountKey*.json`, `service-account*.json`,
  `firebase-adminsdk*.json`, and `.env`, **and** ignores the whole
  `secrets/` directory regardless of what you name the file inside it —
  two independent layers, since filename-pattern rules alone are only as
  good as remembering to follow the naming convention.
- `backups/` is git-ignored too — a backup folder is a full copy of your
  production data and shouldn't end up in version control either.
- The Admin SDK bypasses `firestore.rules` entirely (that's normal and
  necessary for a backup tool) — which is exactly why the credential
  file is the sensitive thing being protected here, not the rules.
  Nothing about your actual `firestore.rules` (managed via the Firebase
  Console, per the existing project setup) was touched or needs to be.
- Restore defaults to a dry run; the destructive path requires the
  literal `--confirm` flag, and always reports the target project and
  overwrite count first.
- The Admin panel's "Download Full Firestore JSON" button (see "Admin
  Panel backup — architecture" above) reads Firestore directly through
  the same public client SDK / API key already in `js/firebase-config.js`
  (meant to be public; restricted by `firestore.rules`, not secrecy) that
  the rest of the app already uses — it adds no new credential, endpoint,
  or elevated access of any kind. The downloaded file only ever goes to
  the admin's own computer; nothing is uploaded anywhere.

## Verification results

**CLI backup/restore** (`npm run backup` / `npm run restore`):

You've since confirmed a real backup completed successfully against the
live `nbadraftpick` project — that's the authoritative verification for
this half of the system, and something only you could actually do (see
the project-ID investigation earlier in this doc's history for the one
bug that surfaced from that real run, since fixed).

Beyond that, I ran the actual backup and restore logic — not just a
syntax check — against realistic seeded data in an in-memory fake
implementing the Firestore Admin SDK surface these scripts call (real
`storage.googleapis.com` emulator download is blocked by this sandbox's
network rules). All of the following passed:

- ✅ Backup correctly discovers and reads root collections and recursively
  discovered subcollections (tested with a synthetic subcollection this
  app doesn't currently have, to confirm the walker is genuinely generic).
- ✅ Pagination works: a 550-document collection (over the 500-doc page
  size) backed up completely and correctly.
- ✅ Nested objects and arrays (including mixed-type arrays with strings,
  numbers, booleans, and null) round-trip exactly.
- ✅ All four Firestore-native types round-trip exactly: Timestamp
  (verified via `.isEqual()`), GeoPoint (exact lat/lng), Bytes (exact
  content, as a Buffer — the Admin SDK's actual representation), and
  DocumentReference (exact path).
- ✅ Backup never writes anything — confirmed zero writes to the source
  during a backup run.
- ✅ Restore's dry run reports the correct document counts and correctly
  identifies pre-existing documents that would be overwritten, while
  writing zero documents.
- ✅ Restore with `--confirm` writes every document, using batched writes
  that correctly split at the Admin SDK's 500-operation-per-batch limit.
- ✅ Restored data is a byte-for-byte match against the original,
  including every native type.
- ✅ Re-ran this entire suite again after extracting `backup-core.js` out
  of `backup.js` (for the Cloud Function to share) — no regression.

**Admin Panel browser backup** (`js/admin/backup.js`) — the previous
Cloud Function architecture described in earlier revisions of this
document has been removed entirely (see "Admin Panel backup —
architecture" above) and replaced with this browser-only mechanism. Its
logic (serialization, filename generation, and the overall flow) was
reviewed by inspection and by running the pure functions (the
Timestamp/GeoPoint/Bytes/DocumentReference serializer, and the filename
builder) outside a browser against representative inputs — a real
end-to-end run (loading the Admin panel in an authenticated browser
session, clicking the button, and inspecting the downloaded file against
live Firestore data) has **not** been performed as part of this revision,
since that requires an actual signed-in session against the deployed
project. Treat "the code is correct" and "verified end-to-end against
production" as separate claims; only the first is made here.

**Known limitations of the browser-based backup**, stated plainly rather
than implied:
- It cannot discover collections/subcollections the way the CLI backup
  does — it only reads `KNOWN_ROOT_COLLECTIONS` in `js/admin/backup.js`,
  currently `["league", "nba2k_players"]`. A collection or subcollection
  added to the app without updating that list will be silently missed by
  this feature (though still caught by the CLI backup, which discovers
  generically).
- It is limited to whatever the signed-in admin's Firestore Security
  Rules allow them to read — same boundary the rest of the app already
  operates under, not a new restriction, but worth stating since it's a
  different privilege level than the CLI backup's Admin SDK access.
- It has no backup-history record and no concurrency lock — see "No
  history, no lock, no restore" above.

