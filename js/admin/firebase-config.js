/**
 * firebase-config.js
 *
 * Firebase project configuration and SDK initialization.
 *
 * MUST load before js/data.js and js/admin/auth-boundary.js — both use the
 * `firebase` global this file sets up (via the Firebase "compat" SDK, which
 * keeps the classic `firebase.xxx()` global API this whole app already uses
 * everywhere else — no ES modules / bundler needed).
 *
 * ── SETUP ────────────────────────────────────────────────────────────────
 * Replace every value in FIREBASE_CONFIG below with your own project's
 * config: Firebase Console → Project settings (gear icon) → General →
 * "Your apps" → the web app (</>) → SDK setup and configuration → Config.
 *
 * These values are NOT secret — they identify your project, they don't
 * grant access to it. Access control is enforced entirely by Firestore
 * Security Rules (see firestore.rules) and Firebase Authentication, not by
 * hiding this file. It's safe to commit as-is once filled in.
 *
 * See FIREBASE_SETUP.md for the full one-time console setup (enabling
 * Firestore, enabling Email/Password sign-in, creating the commissioner
 * account, deploying firestore.rules).
 */

const FIREBASE_CONFIG = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.firebasestorage.app",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID",
};

firebase.initializeApp(FIREBASE_CONFIG);

// IMPORTANT — do not remove: this app's data layer (Phase 5's Joker
// designation, specifically) writes an explicit `undefined` value for a
// field on non-Joker roster entries, matching how JSON.stringify has
// always silently dropped it under the old localStorage storage. Without
// this setting, Firestore's default behavior is to THROW on any undefined
// field anywhere in the object graph — this restores the original
// (silently-drop-it) behavior instead, so nothing in data.js had to change
// to accommodate Firestore's stricter default.
firebase.firestore().settings({ ignoreUndefinedProperties: true });
