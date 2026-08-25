# Firestore Backup & Restore

This app stores its entire state in one Firestore document
(`league/main` — see `js/data.js`), read by the frontend directly via the
Firebase client SDK. The backup/restore system started as local-only CLI
scripts (no frontend changes at all); it now also includes a "Backup
Firestore" button in the Admin panel, backed by a Cloud Function — see
"Admin Panel backup button — architecture" below for that part
specifically. The frontend changes for that are minimal and listed under
"Files modified".

The backup script itself does **not** hardcode the `league/main` path —
it discovers every root collection and recursively walks every
subcollection via `listCollections()`, so it stays correct even if more
collections get added later.

## Files created

CLI backup/restore (original):
- `scripts/backup.js` — exports all Firestore data to a timestamped folder.
- `scripts/restore.js` — restores a backup folder back into Firestore (dry-run by default).
- `scripts/lib/firestore-serialize.js` — shared type-preserving (de)serialization used by both.
- `scripts/lib/init-admin.js` — shared, secure credential loading.
- `scripts/lib/backup-core.js` — the collection-discovery/walk logic, extracted out of `backup.js` so the Cloud Function (below) can reuse it unchanged instead of duplicating it.
- `package.json` — `npm run backup` / `npm run restore` commands.
- `.gitignore` — added (didn't exist before).
- `BACKUP_RESTORE.md` — this file.

Admin Panel "Backup Firestore" button (Cloud Functions):
- `functions/index.js` — the two callable Cloud Functions (`backupFirestore`, `getBackupHistory`).
- `functions/package.json` — Cloud Functions' own dependencies (`firebase-admin`, `firebase-functions`).
- `functions/lib/` — **generated**, not hand-written: a synced copy of `scripts/lib/firestore-serialize.js` + `backup-core.js`, regenerated automatically before every deploy (see "Why `functions/lib` exists" below). Git-ignored.
- `scripts/sync-functions-lib.js` — does that syncing; also runnable manually via `npm run sync-functions-lib`.
- `firebase.json`, `.firebaserc` — Firebase project config (`nbadraftpick`) and the Cloud Functions source directory + predeploy hook.
- `js/admin/backup.js` — the Admin panel view (button, result display, backup history table).

## Files modified

- `js/admin.js` — registered the new `backup` route.
- `admin.html` — added the "Backup" sidebar link, the `firebase-functions-compat.js` script tag, and `<script src="js/admin/backup.js">`.
- `css/admin.css` — added `.backup-*` styles, using the same design tokens (`var(--text)`, `var(--green)`, etc.) as the rest of the admin panel.

Nothing else in the frontend changed — draft/roster/schedule/etc. views, Firestore security rules, and the public site are all untouched.

## Admin Panel backup button — architecture

```
Admin clicks "Create Backup"
        │
        │  firebase.functions().httpsCallable('backupFirestore')()
        │  (Firebase Functions client SDK — automatically attaches the
        │   signed-in admin's Firebase Auth ID token; no credential of
        │   any kind lives in js/admin/backup.js)
        ▼
Cloud Function: backupFirestore  (functions/index.js)
        │  1. requireAuth(request) — verified server-side by the
        │     Callable Functions framework before this code even runs;
        │     rejects with 'unauthenticated' if there's no valid token
        │  2. acquireLock(db) — Firestore-transaction-based lock, so two
        │     near-simultaneous clicks can't start two backups
        │  3. collectAllCollections(db, log)  — functions/lib/backup-core.js,
        │     the SAME function scripts/backup.js uses locally
        │  4. writes firestore-backups/<slug>/... to Cloud Storage
        │  5. writes a metadata-only history record to Firestore
        │     (_internal/backupHistory/runs/<slug>) — never the actual
        │     backed-up content
        │  6. releaseLock(db) (always — even on failure)
        ▼
Response: { success, totalDocuments, totalCollectionPaths, durationMs }
        ▼
js/admin/backup.js renders the result / refreshes the history table
```

`admin.initializeApp()` in `functions/index.js` is called with **zero
arguments** — in the Cloud Functions execution environment, that uses the
function's attached runtime service account, an identity Google Cloud
manages and injects automatically. There is no private-key file anywhere
in this path (unlike the local CLI's `GOOGLE_APPLICATION_CREDENTIALS`
flow) — nothing exists that could accidentally be exposed, committed, or
served to a browser, because nothing like that exists here at all.

**Authorization**: this app has exactly one role — any signed-in Firebase
Auth user is the commissioner/admin (see `js/admin/auth-boundary.js`;
enforced identically today via `firestore.rules`' `request.auth != null`).
`requireAuth()` in `functions/index.js` is that exact same check, applied
server-side. There's no separate roles/permissions system in this project
to integrate with — if one is added later, it would extend that one
function.

**Why `functions/lib` exists (not just `require('../scripts/lib')`
directly)**: `firebase deploy` only uploads the contents of the
`functions` source directory — it has no access to sibling directories
like `scripts/lib` in Cloud Build's environment. An earlier version of
this used a `file:../scripts/lib` npm dependency, which `npm install`
resolves as a symlink pointing outside `functions/` — that symlink would
be broken as soon as it left this machine. `scripts/lib` remains the one
place you actually edit; `functions/lib` is a disposable copy of it,
regenerated automatically by firebase.json's `predeploy` hook before every
deploy (and via `npm run sync-functions-lib` any other time you want it
fresh, e.g. for local emulator testing).

**Backup storage**: Cloud Storage, under `firestore-backups/<timestamp>/`
— same layout/`metadata.json` shape as the local CLI backup, just in a
bucket instead of on disk. Only reachable by someone with access to the
Firebase project's Cloud Storage (i.e. project members with the right
IAM role) or, from the app's own perspective, from server-side code
running with the function's service account — never from the browser.

**Duplicate-request protection (Phase 7)**: a Firestore-transaction-based
lock (`_internal/backupLock`), not the frontend button-disable alone. A
lock older than 10 minutes is treated as stale/available again, so one
crashed run can't permanently wedge the feature.

**Restore**: intentionally NOT exposed in the Admin panel. `npm run
restore` remains the only way to restore, run locally by someone with a
real service-account key — see "Running a restore" above. A website
restore button is meaningfully higher-risk than a backup button and is
out of scope here on purpose.

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
As currently deployed, that's the one collection this app actually uses:
- `league` (1 document: `main`, containing all seasons/players/settings).

If you ever add more top-level collections or subcollections, they'll be
picked up automatically on the next backup run — no script changes needed.

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
- The frontend for the CLI/local backup path is completely unmodified —
  it still only ever talks to Firestore through the public client SDK /
  API key already in `js/firebase-config.js`, which was always meant to
  be public (it's restricted by `firestore.rules`, not secrecy). The
  Admin panel's "Backup Firestore" button (see the architecture section
  above) is the one frontend addition, and it never touches Firestore
  directly at all — it only calls a Cloud Function through the Functions
  client SDK, which attaches the user's own ID token, nothing more.

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

**Cloud Function** (`functions/index.js`) — **not yet deployed, so this
could only be tested at the logic level**, against the same kind of fake
Firestore plus a fake Cloud Storage bucket, exercising the real,
unmodified `runBackupCore`/`getHistoryCore`/`acquireLock`/`releaseLock`/
`requireAuth` functions directly:

- ✅ An unauthenticated request (`request.auth` missing or null) is
  rejected with `HttpsError('unauthenticated', ...)`.
- ✅ An authenticated request succeeds and extracts the correct `uid`.
- ✅ Backup discovers `league/main`, a synthetic 30-document collection
  (proving no hardcoding), and a subcollection — all in one run.
- ✅ Output is written to Cloud Storage under the documented
  `firestore-backups/<timestamp>/` prefix, with content identical to what
  the local CLI backup would produce for the same data.
- ✅ The Firestore history record contains status/counts/timing only —
  never the actual backed-up content.
- ✅ `getBackupHistory` returns runs newest-first.
- ✅ A second backup attempt while one is "in progress" is correctly
  rejected (`HttpsError('already-exists', ...)`) — the concurrency lock
  works.
- ✅ A backup that fails partway (simulated Firestore read failure)
  writes **zero** files to Storage, records a `status: 'failed'` history
  entry (never a false `'success'`), surfaces only a generic error
  message to the caller, and still releases the lock.

**What this does NOT prove**, and I want to be direct about it: none of
this exercises Google's actual Callable-Functions auth verification,
real network/IAM behavior, real Cloud Storage permissions, or the real
`onCall` wrapper — those only exist once this is actually deployed. The
`_testables` exports in `functions/index.js` exist specifically so this
logic could be tested before that point, but "logic is correct" and
"deployed and working in production" are different claims, and I'm only
making the first one. Deployment (and that final confirmation) is up to
you, per Phase 12/9's explicit instruction to stop and wait for approval
first.

